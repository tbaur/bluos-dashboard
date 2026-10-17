import { discoveryLabel, playerCountLabel } from '@/lib/discovery';
import type { ConnectionState } from '@/store/fleetStore';

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  live: 'Live updates',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

interface StatusPillsProps {
  connection: ConnectionState;
  deviceCount: number;
  discoveryMethod: string;
  loading: boolean;
}

export function StatusPills({
  connection,
  deviceCount,
  discoveryMethod,
  loading,
}: StatusPillsProps) {
  const discovery = discoveryLabel(discoveryMethod);
  const playersLabel = loading ? 'Scanning…' : playerCountLabel(deviceCount);

  return (
    <div className="status-pills" role="status" aria-live="polite">
      <span
        className="pill pill-connection"
        data-state={connection}
        title="Realtime connection to the dashboard backend"
      >
        <span className="pill-dot" aria-hidden="true" />
        <span className="pill-label">{CONNECTION_LABEL[connection]}</span>
      </span>
      <span
        className="pill pill-fleet"
        title={
          discovery
            ? `Network discovery via ${discovery}`
            : 'Players currently on the LAN'
        }
      >
        {playersLabel}
        {discovery && !loading ? (
          <span className="pill-muted"> / via {discovery}</span>
        ) : null}
      </span>
    </div>
  );
}
