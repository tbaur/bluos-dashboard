import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { useLiveFleet } from '@/hooks/useLiveFleet';
import { type ConnectionState, useFleetStore } from '@/store/fleetStore';

const load = vi.fn();
const getSync = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    getSync: (...args: unknown[]) => getSync(...args),
  },
}));

function streamOf(chunks: string[], hold: Promise<void>) {
  const encoder = new TextEncoder();
  const pending = chunks.map((chunk) => encoder.encode(chunk));
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index < pending.length) {
            const value = pending[index];
            index += 1;
            return { done: false, value };
          }
          await hold;
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe('useLiveFleet', () => {
  beforeEach(() => {
    load.mockReset();
    getSync.mockReset();
    load.mockResolvedValue(undefined);
    getSync.mockResolvedValue({ groups: [], standalone_ids: [] });
    useFleetStore.setState({
      load,
      setFleet: vi.fn(),
      upsertDevice: vi.fn(),
      setConnection: vi.fn(),
      setSync: vi.fn(),
      connection: 'connecting',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the event stream without a token query and applies a fleet payload', async () => {
    const setFleet = vi.fn();
    const setSync = vi.fn();
    const setConnection = vi.fn();
    useFleetStore.setState({ setFleet, setSync, setConnection });
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf(
        [
          'data: {"type":"fleet","data":{"devices":[{"id":"a"}],"discovered_at":123,"sync":{"groups":[],"standalone_ids":["a"]}}}\n\n',
        ],
        hold,
      ),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useLiveFleet());
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe('/api/v1/events');
    expect(url).not.toContain('token=');
    expect(setFleet).toHaveBeenCalledWith([{ id: 'a' }], 123);
    expect(setSync).toHaveBeenCalledWith({ groups: [], standalone_ids: ['a'] });
    expect(setConnection).toHaveBeenCalledWith('live');

    setConnection.mockClear();
    unmount();
    release();
    await act(async () => {
      await Promise.resolve();
    });
    expect(setConnection).not.toHaveBeenCalled();
  });
});

/** A stream that delivers `chunks` and then ends, the way a dropped connection does. */
function endedStream(chunks: string[]) {
  return streamOf(chunks, Promise.resolve());
}

function openStream(chunks: string[] = []) {
  return { ok: true, body: streamOf(chunks, new Promise<void>(() => undefined)) };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useLiveFleet reconnects', () => {
  let setConnection: Mock<(state: ConnectionState) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    load.mockReset().mockResolvedValue(undefined);
    getSync.mockReset().mockResolvedValue({ groups: [], standalone_ids: [] });
    setConnection = vi.fn<(state: ConnectionState) => void>();
    useFleetStore.setState({
      load,
      setFleet: vi.fn(),
      upsertDevice: vi.fn(),
      setConnection,
      setSync: vi.fn(),
      setHealth: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const states = () => setConnection.mock.calls.map(([state]) => state);

  it('polls over REST while the stream is down and stops once it is back', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: endedStream([]) })
      .mockResolvedValueOnce(openStream());
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useLiveFleet());
    await advance(0);
    expect(states()).toEqual(['connecting', 'live', 'reconnecting']);
    expect(load).toHaveBeenCalledTimes(1);

    // First retry is 1s out. The REST poll runs every 5s until then.
    await advance(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(states().slice(-2)).toEqual(['reconnecting', 'live']);

    await advance(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('treats an error status as a drop and backs off', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue(openStream());
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useLiveFleet());
    await advance(0);
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second failure doubles the wait.
    await advance(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(states().at(-1)).toBe('live');
    unmount();
  });

  it('goes offline after eight failures, keeps polling, and retries a minute later', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useLiveFleet());
    await advance(0);
    // 1 + 2 + 4 + 8 + 16 + 30 + 30 seconds between the first eight attempts.
    await advance(91_000);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(states().at(-1)).toBe('offline');
    expect(load.mock.calls.length).toBeGreaterThan(10);

    await advance(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(9);
    unmount();
  });

  it('stops retrying and polling when the page unmounts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useLiveFleet());
    await advance(0);
    unmount();
    const calls = fetchMock.mock.calls.length;
    const loads = load.mock.calls.length;
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(load).toHaveBeenCalledTimes(loads);
  });
});

describe('useLiveFleet events', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies device and health events, reads frames split across chunks, and skips bad JSON', async () => {
    const upsertDevice = vi.fn();
    const setHealth = vi.fn();
    const setFleet = vi.fn();
    getSync.mockReset().mockResolvedValue({ groups: [], standalone_ids: ['a'] });
    const setSync = vi.fn();
    useFleetStore.setState({
      load: vi.fn().mockResolvedValue(undefined),
      setFleet,
      upsertDevice,
      setConnection: vi.fn(),
      setSync,
      setHealth,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        openStream([
          'data: {"type":"device","da',
          'ta":{"id":"a","volume":7}}\n\n',
          'data: not json\n\n',
          ': keepalive\n\n',
          'data: {"type":"fleet","data":{"devices":[],"health":{"drops":[]}}}\n\n',
        ]),
      ),
    );

    const { unmount } = renderHook(() => useLiveFleet());
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    expect(upsertDevice).toHaveBeenCalledWith({ id: 'a', volume: 7 });
    expect(setFleet).toHaveBeenCalledWith([], null);
    expect(setHealth).toHaveBeenCalledWith({ drops: [] });
    // A fleet event without a sync graph asks the API for one.
    expect(getSync).toHaveBeenCalled();
    expect(setSync).toHaveBeenCalledWith({ groups: [], standalone_ids: ['a'] });
    unmount();
  });
});
