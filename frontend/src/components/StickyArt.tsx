import { useState, type ReactNode } from 'react';
import { safeImageSrc } from '@/lib/artwork';

type StickyArtProps = {
  src: string;
  className?: string;
  empty: ReactNode;
};

/** Keep the last image when src blips empty (skip/back). Swap immediately for a new URL. */
export function StickyArt({ src, className, empty }: StickyArtProps) {
  const vetted = safeImageSrc(src);
  const [shown, setShown] = useState(vetted);
  if (vetted && vetted !== shown) {
    setShown(vetted);
  }

  if (!shown) return empty;
  return <img src={shown} alt="" className={className} />;
}
