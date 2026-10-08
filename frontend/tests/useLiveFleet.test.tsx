import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveFleet } from '@/hooks/useLiveFleet';
import { useFleetStore } from '@/store/fleetStore';

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
