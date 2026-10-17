import { useEffect, useId, useRef, useState } from 'react';
import { NavLink } from 'react-router';
import { IconMenu } from '@/components/house/HouseIcons';
import { discoveryLabel, playerCountLabel } from '@/lib/discovery';
import { useFleetStore } from '@/store/fleetStore';

const PAGES = [
  { to: '/', label: 'Fleet', end: true },
  { to: '/house', label: 'House', end: false },
] as const;

/**
 * Top-right menu for narrow screens: page links, rescan, and discovery details
 * that the desktop header shows inline. CSS hides it on wide layouts.
 */
export function AppMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="app-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="app-menu-btn"
        aria-label="Menu"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen((open) => !open)}
      >
        <IconMenu open={isOpen} />
      </button>
      {isOpen ? <AppMenuPanel id={panelId} onNavigate={() => setIsOpen(false)} /> : null}
    </div>
  );
}

function AppMenuPanel({ id, onNavigate }: { id: string; onNavigate: () => void }) {
  const deviceCount = useFleetStore((s) => s.devices.length);
  const refreshing = useFleetStore((s) => s.refreshing);
  const refresh = useFleetStore((s) => s.refresh);
  const discoveryMethod = useFleetStore((s) => s.discoveryMethod);
  const discovery = discoveryLabel(discoveryMethod);

  return (
    <div className="app-menu-panel" id={id}>
      <nav aria-label="Pages">
        <ul className="app-menu-links">
          {PAGES.map((page) => (
            <li key={page.to}>
              <NavLink to={page.to} end={page.end} className="app-menu-link" onClick={onNavigate}>
                {page.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="app-menu-scan">
        <button
          type="button"
          className="btn btn-primary"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? 'Scanning…' : 'Rescan network'}
        </button>
        <p className="app-menu-meta">
          {playerCountLabel(deviceCount)}
          {discovery ? ` found via ${discovery}` : ''}
        </p>
      </div>
    </div>
  );
}
