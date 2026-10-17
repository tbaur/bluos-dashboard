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

export function IconStop() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6h12v12H6V6z" fill="currentColor" />
    </svg>
  );
}

export function IconSpeaker({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
      {muted ? (
        <path
          d="m16 9.4 1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1L16 9.4z"
          fill="currentColor"
        />
      ) : (
        <path
          d="M15.5 8.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2l1.4-1.4zm2.8-2.8a9 9 0 0 1 0 12.6l-1.4-1.4a7 7 0 0 0 0-9.8l1.4-1.4z"
          fill="currentColor"
        />
      )}
    </svg>
  );
}

export function IconMenu({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {open ? (
        <path
          d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5z"
          fill="currentColor"
        />
      ) : (
        <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" fill="currentColor" />
      )}
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
