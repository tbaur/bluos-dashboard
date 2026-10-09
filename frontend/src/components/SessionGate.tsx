import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { apiToken } from '@/api/auth';
import { api } from '@/api/client';
import { ApiError } from '@/api/types';

/** How often to look for the API again while it is not answering. */
const RETRY_MS = 5000;

type GateState = 'checking' | 'ready' | 'token' | 'unreachable';

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** Ready when this browser can call the API, `token` on a 401, else `unreachable`. */
async function probe(): Promise<GateState> {
  try {
    await api.listDevices();
    return 'ready';
  } catch (err) {
    return isUnauthorized(err) ? 'token' : 'unreachable';
  }
}

/**
 * Trade a token built into the bundle for the session cookie first, because
 * cover art requests from <img> cannot send Authorization. A rejected bundle
 * token can just mean the server has no token set, so probe before asking.
 */
async function connect(): Promise<GateState> {
  if (!apiToken) return probe();
  try {
    await api.openSession(apiToken);
    return 'ready';
  } catch (err) {
    return isUnauthorized(err) ? probe() : 'unreachable';
  }
}

/** Renders `children` once the API accepts this browser; until then, the token form or a notice. */
export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking');
  const [retrying, setRetrying] = useState(false);
  const inFlight = useRef(false);

  const check = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRetrying(true);
    void connect()
      .then(setState)
      .finally(() => {
        inFlight.current = false;
        setRetrying(false);
      });
  }, []);

  useEffect(check, [check]);

  useEffect(() => {
    if (state !== 'unreachable') return undefined;
    const timer = window.setInterval(check, RETRY_MS);
    return () => window.clearInterval(timer);
  }, [state, check]);

  if (state === 'ready') return <>{children}</>;
  if (state === 'checking') return null;
  if (state === 'unreachable') return <UnreachableNotice busy={retrying} onRetry={check} />;
  return <TokenForm onAccepted={() => setState('ready')} />;
}

function GateCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="session-gate">
      <section className="panel session-card" aria-labelledby="session-title">
        <p className="session-brand">BluOS</p>
        <h1 id="session-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

function UnreachableNotice({ busy, onRetry }: { busy: boolean; onRetry: () => void }) {
  return (
    <GateCard title="Can’t reach the dashboard">
      <p className="session-copy">
        The page loaded, but the dashboard service is not answering. It may be starting up or
        restarting.
      </p>
      <p className="session-hint" aria-live="polite">
        {busy ? 'Checking…' : 'Trying again every few seconds.'}
      </p>
      <button type="button" className="btn session-submit" disabled={busy} onClick={onRetry}>
        Try again now
      </button>
    </GateCard>
  );
}

function TokenForm({ onAccepted }: { onAccepted: () => void }) {
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.openSession(value);
      onAccepted();
    } catch (err) {
      setError(
        isUnauthorized(err)
          ? 'That token does not match the one set on the server.'
          : 'Could not reach the dashboard. Check the connection and try again.',
      );
      setBusy(false);
      inputRef.current?.select();
    }
  };

  return (
    <GateCard title="Enter the dashboard token">
      <p className="session-copy">
        This dashboard is locked with an access token. Your players do not use it; only this
        page does.
      </p>
      <form className="session-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="api-token">API token</label>
        <div className="session-field" data-invalid={error ? 'true' : undefined}>
          <input
            ref={inputRef}
            id="api-token"
            type={visible ? 'text' : 'password'}
            autoComplete="current-password"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'api-token-error' : undefined}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-quiet session-reveal"
            aria-controls="api-token"
            onClick={() => setVisible((shown) => !shown)}
          >
            {visible ? 'Hide' : 'Show'}
          </button>
        </div>
        {error ? (
          <p id="api-token-error" className="session-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="btn btn-primary session-submit"
          disabled={!token.trim() || busy}
        >
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
      <p className="session-hint">
        It is the <code>BSD_API_TOKEN</code> value on the server. This browser stays signed in
        until it closes.
      </p>
    </GateCard>
  );
}
