import { useState, type ReactNode } from 'react';
import { safeImageSrc } from '@/lib/artwork';

type StickyArtProps = {
  src: string;
  className?: string;
  empty: ReactNode;
};

const ART_RETRY_LIMIT = 1;

/** Keep the last image when src blips empty (skip/back). Swap immediately for a new URL. */
export function StickyArt({ src, className, empty }: StickyArtProps) {
  const vetted = safeImageSrc(src);
  const [shown, setShown] = useState(vetted);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  if (vetted && vetted !== shown) {
    setShown(vetted);
    setAttempt(0);
    setFailed(false);
  }

  if (!shown || failed) return empty;

  // A named cover can 404, for example on a synced follower. Retry once, then show the empty state.
  const imageSrc = attempt > 0 ? `${shown}${shown.includes('?') ? '&' : '?'}retry=${attempt}` : shown;

  return (
    <img
      src={imageSrc}
      alt=""
      className={className}
      onError={() => {
        if (attempt < ART_RETRY_LIMIT) {
          setAttempt(attempt + 1);
          return;
        }
        setFailed(true);
      }}
    />
  );
}
