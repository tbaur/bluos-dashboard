import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLatestValueSender } from '@/lib/latestValueSender';

const INTERVAL = 120;

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued promise callbacks run without moving the clock. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('createLatestValueSender', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one at a time and only the newest value queued while busy', async () => {
    const calls: { value: number; done: ReturnType<typeof deferred> }[] = [];
    const sender = createLatestValueSender<number>({
      minIntervalMs: INTERVAL,
      send: (value) => {
        const done = deferred();
        calls.push({ value, done });
        return done.promise;
      },
    });

    sender.push(40);
    await settle();
    sender.push(41);
    sender.push(42);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(calls.map((c) => c.value)).toEqual([40]);

    calls[0].done.resolve();
    await settle();
    expect(calls.map((c) => c.value)).toEqual([40, 42]);
  });

  it('spaces sends by the interval so the API never sees two inside its limit', async () => {
    const started: number[] = [];
    const sender = createLatestValueSender<number>({
      minIntervalMs: INTERVAL,
      send: async () => {
        started.push(Date.now());
      },
    });

    sender.push(40);
    await settle();
    sender.push(45);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(started).toHaveLength(2);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(INTERVAL);
  });

  it('drops a repeat of the value just sent, such as a release right after the debounce', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const onIdle = vi.fn();
    const sender = createLatestValueSender<number>({ minIntervalMs: INTERVAL, send, onIdle });

    sender.push(50);
    await settle();
    sender.push(50);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(1);

    sender.push(50);
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a failed send', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const sender = createLatestValueSender<number>({ minIntervalMs: INTERVAL, send });

    sender.push(40);
    await settle();
    sender.push(44);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(send.mock.calls.map(([value]) => value)).toEqual([40, 44]);
  });

  it('sends nothing more after cancel', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const sender = createLatestValueSender<number>({ minIntervalMs: INTERVAL, send });

    sender.push(40);
    await settle();
    sender.push(44);
    sender.cancel();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
