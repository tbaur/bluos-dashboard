import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { apiToken } from '@/api/auth';
import { FleetPage } from '@/components/FleetPage';
import { HousePage } from '@/components/HousePage';
import { PlayerDetailPage } from '@/components/PlayerDetailPage';
import { ScrollToTop } from '@/components/ScrollToTop';
import { useLiveFleet } from '@/hooks/useLiveFleet';

export function App() {
  const [authed, setAuthed] = useState(Boolean(apiToken));
  if (!authed) return <SessionPrompt onReady={() => setAuthed(true)} />;
  return <Dashboard />;
}

function Dashboard() {
  // One live stream for the whole SPA. Pages must not open their own.
  useLiveFleet();

  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<FleetPage />} />
        <Route path="/house" element={<HousePage />} />
        <Route path="/player/:id" element={<PlayerDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

function SessionPrompt({ onReady }: { onReady: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancel = false;
    fetch('/api/v1/devices', {
      credentials: 'include',
      headers: { 'X-BSD-Request': '1' },
    })
      .then((response) => {
        if (cancel) return;
        if (response.status === 401) setChecking(false);
        else onReady();
      })
      .catch(() => {
        if (!cancel) onReady();
      });
    return () => {
      cancel = true;
    };
  }, [onReady]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    void fetch('/api/v1/session', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        'X-BSD-Request': '1',
      },
    }).then((response) => {
      if (response.ok) {
        setToken('');
        onReady();
        return;
      }
      setError('Token was not accepted');
    });
  };

  if (checking) return null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="brand">BluOS</h1>
        <p className="brand-sub">
          This dashboard is asking for its API token. Players on the same LAN do not use this token.
        </p>
      </header>
      <form className="panel" onSubmit={submit}>
        <label htmlFor="api-token">API token</label>
        <input
          id="api-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={!token.trim()}>
          Continue
        </button>
        {error ? <p className="card-meta">{error}</p> : null}
      </form>
    </div>
  );
}
