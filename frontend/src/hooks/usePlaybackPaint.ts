import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { playbackPosition, shouldSnapPlayback } from '@/lib/playbackClock';

type Origin = { secs: number; at: number | null };

export type PlaybackPaint = {
  /** User dragged the playhead. Continue from here instead of the last poll. */
  adopt: (secs: number) => void;
  /** Drop time spent holding the playhead so playback does not jump on release. */
  release: () => void;
};

/**
 * Paint a transport position between status polls.
 * Polls arrive too rarely to move a progress bar on their own.
 */
export function usePlaybackPaint(
  sampleSecs: number,
  playing: boolean,
  paint: (rawSecs: number) => number,
  holdRef?: { readonly current: boolean },
): PlaybackPaint {
  const paintRef = useRef(paint);
  const originRef = useRef<Origin>({ secs: sampleSecs, at: null });
  const lastRef = useRef(sampleSecs);
  const playingRef = useRef(playing);

  useLayoutEffect(() => {
    paintRef.current = paint;
    playingRef.current = playing;
  });

  useLayoutEffect(() => {
    if (holdRef?.current) return;
    const now = performance.now();
    const predicted = playbackPosition(
      originRef.current.secs,
      originRef.current.at ?? now,
      now,
      originRef.current.at !== null && playingRef.current && !holdRef?.current,
    );
    if (originRef.current.at === null || shouldSnapPlayback(predicted, sampleSecs)) {
      originRef.current = { secs: sampleSecs, at: now };
      lastRef.current = paintRef.current(sampleSecs);
    }
  }, [holdRef, sampleSecs]);

  useEffect(() => {
    if (!playing) {
      originRef.current = { secs: lastRef.current, at: performance.now() };
      lastRef.current = paintRef.current(lastRef.current);
      return undefined;
    }
    originRef.current = { secs: lastRef.current, at: performance.now() };
    let frame = 0;
    const tick = (now: number) => {
      if (!holdRef?.current) {
        const originAt = originRef.current.at ?? now;
        lastRef.current = paintRef.current(
          playbackPosition(originRef.current.secs, originAt, now, true),
        );
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      originRef.current = { secs: lastRef.current, at: performance.now() };
    };
  }, [holdRef, playing]);

  const adopt = useCallback((secs: number) => {
    originRef.current = { secs, at: performance.now() };
    lastRef.current = paintRef.current(secs);
  }, []);
  const release = useCallback(() => {
    originRef.current = { secs: lastRef.current, at: performance.now() };
  }, []);
  return useMemo(() => ({ adopt, release }), [adopt, release]);
}
