/**
 * Spacing between writes from one control. The API answers 429 when the same
 * client POSTs to one path faster than BSD_API_RATE_LIMIT_SECONDS (50 ms by default).
 */
export const MIN_SEND_INTERVAL_MS = 120;

export interface LatestValueSender<T> {
  /** Queue a value. Only the newest queued value is sent. */
  push: (value: T) => void;
  /** Drop anything queued and stop timers, for unmount. */
  cancel: () => void;
}

interface SenderOptions<T> {
  send: (value: T) => Promise<unknown>;
  minIntervalMs?: number;
  /** Called once nothing is queued, in flight, or inside the spacing window. */
  onIdle?: () => void;
}

/**
 * Sends a stream of values (slider positions) one request at a time, at most once
 * per interval, newest value wins, and a repeat of the value just sent is dropped.
 */
export function createLatestValueSender<T>({
  send,
  minIntervalMs = MIN_SEND_INTERVAL_MS,
  onIdle,
}: SenderOptions<T>): LatestValueSender<T> {
  let queued: { value: T } | null = null;
  let lastSent: { value: T } | null = null;
  let inFlight = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const pump = (): void => {
    if (cancelled || inFlight || timer !== undefined) return;
    if (queued && lastSent && Object.is(queued.value, lastSent.value)) queued = null;
    const wait = lastStartedAt + minIntervalMs - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, wait);
      return;
    }
    if (!queued) {
      lastSent = null;
      onIdle?.();
      return;
    }
    const { value } = queued;
    queued = null;
    lastSent = { value };
    inFlight = true;
    lastStartedAt = Date.now();
    void Promise.resolve()
      .then(() => send(value))
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        pump();
      });
  };

  return {
    push: (value) => {
      queued = { value };
      pump();
    },
    cancel: () => {
      cancelled = true;
      queued = null;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
