import { useEffect, useRef } from 'react';
import type { FleetHealthResponse, PlayerStatus, SyncState } from '@/api/types';
import { useFleetStore } from '@/store/fleetStore';
import { api } from '@/api/client';
import { apiToken } from '@/api/auth';

interface FleetEvent {
  type: string;
  data: unknown;
}

const MAX_RECONNECT_ATTEMPTS = 8;
const OFFLINE_RETRY_MS = 60_000;

function eventHeaders(): Headers {
  const headers = new Headers({
    Accept: 'text/event-stream',
    'X-BSD-Request': '1',
  });
  if (apiToken) headers.set('Authorization', `Bearer ${apiToken}`);
  return headers;
}

async function readServerEvents(
  response: Response,
  onMessage: (event: FleetEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        try {
          onMessage(JSON.parse(data) as FleetEvent);
        } catch {
          // ignore malformed
        }
      }
      split = buffer.indexOf('\n\n');
    }
  }
}

function connectWithBackoff(
  onMessage: (event: FleetEvent) => void,
  onState: (state: 'connecting' | 'live' | 'reconnecting' | 'offline') => void,
  signal: AbortSignal,
): void {
  let attempt = 0;
  let timer: number | undefined;
  let stream: AbortController | null = null;

  const cleanup = () => {
    if (timer) window.clearTimeout(timer);
    stream?.abort();
  };
  signal.addEventListener('abort', cleanup);

  const schedule = (delay: number) => {
    timer = window.setTimeout(open, delay);
  };

  const open = () => {
    if (signal.aborted) return;
    onState(attempt === 0 ? 'connecting' : 'reconnecting');
    stream = new AbortController();
    const linked = stream;
    void (async () => {
      try {
        const response = await fetch('/api/v1/events', {
          headers: eventHeaders(),
          credentials: 'include',
          signal: linked.signal,
        });
        if (signal.aborted || linked.signal.aborted) return;
        if (!response.ok) throw new Error(String(response.status));
        attempt = 0;
        onState('live');
        await readServerEvents(response, onMessage, linked.signal);
        if (signal.aborted || linked.signal.aborted) return;
        throw new Error('stream closed');
      } catch {
        if (signal.aborted || linked.signal.aborted) return;
        attempt += 1;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          onState('offline');
          attempt = 0;
          schedule(OFFLINE_RETRY_MS);
          return;
        }
        onState('reconnecting');
        const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 250;
        schedule(delay);
      }
    })();
  };

  open();
}

export function useLiveFleet(): void {
  const setFleet = useFleetStore((s) => s.setFleet);
  const upsertDevice = useFleetStore((s) => s.upsertDevice);
  const setConnection = useFleetStore((s) => s.setConnection);
  const setSync = useFleetStore((s) => s.setSync);
  const setHealth = useFleetStore((s) => s.setHealth);
  const load = useFleetStore((s) => s.load);
  const pollFallback = useRef<number | undefined>(undefined);

  useEffect(() => {
    void load();
    const controller = new AbortController();

    connectWithBackoff(
      (event) => {
        if (event.type === 'fleet') {
          const data = event.data as {
            devices: PlayerStatus[];
            discovered_at?: number | null;
            sync?: SyncState;
            health?: FleetHealthResponse;
          };
          setFleet(data.devices, data.discovered_at ?? null);
          if (data.sync) {
            setSync(data.sync);
          } else {
            void api.getSync().then(setSync).catch(() => undefined);
          }
          if (data.health) setHealth(data.health);
        } else if (event.type === 'device') {
          upsertDevice(event.data as PlayerStatus);
        }
      },
      (state) => {
        setConnection(state);
        if (state === 'reconnecting' || state === 'offline') {
          if (!pollFallback.current) {
            pollFallback.current = window.setInterval(() => {
              void load();
            }, 5000);
          }
        } else if (state === 'live' && pollFallback.current) {
          window.clearInterval(pollFallback.current);
          pollFallback.current = undefined;
        }
      },
      controller.signal,
    );

    return () => {
      controller.abort();
      if (pollFallback.current) window.clearInterval(pollFallback.current);
    };
  }, [load, setConnection, setFleet, setHealth, setSync, upsertDevice]);
}
