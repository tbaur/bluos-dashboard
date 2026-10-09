export function IconPrev() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6h2v12H6V6zm3.5 6L18 18V6l-8.5 6z" fill="currentColor" />
    </svg>
  );
}

export function IconNext() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 6h2v12h-2V6zM6 18l8.5-6L6 6v12z" fill="currentColor" />
    </svg>
  );
}

export function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5L8 5.5z" fill="currentColor" />
    </svg>
  );
}

export function IconPause() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" fill="currentColor" />
    </svg>
  );
}

export function IconShuffle() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 7h3.5l2 3 1.6-2.4L9.2 5H4v2zm9.2 0 1.8 2.7L17 7h3v2h-2.2l-3.2 4.8L17.8 19H20v2h-3.5l-2.2-3.3L12.6 19H4v-2h7.2l2.1-3.2L10.8 9H4V7h9.2z"
        fill="currentColor"
      />
    </svg>
  );
}

export function IconRepeat({ one }: { one: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"
        fill="currentColor"
      />
      {one ? (
        <text x="12" y="14.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="currentColor">
          1
        </text>
      ) : null}
    </svg>
  );
}
