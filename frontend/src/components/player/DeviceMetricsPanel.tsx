import type { ReactNode } from 'react';
import type {
  DiagnoseResponse,
  FleetHealthResponse,
  PlayerStatus,
  UpgradeStatus,
} from '@/api/types';
import { PresenceBar } from '@/components/PresenceBar';
import { VolumeNudgeButtons } from '@/components/VolumeNudgeButtons';
import { formatDeviceHost } from '@/lib/endpoint';
import { formatDropLine, formatRelativeAge, latestDrop, presenceSegments } from '@/lib/health';
import { META_SEP } from '@/lib/meta';
import { formatPlayerUptime } from '@/lib/uptime';
import { useFleetStore } from '@/store/fleetStore';

/** Default circuit threshold when the health report has not arrived yet. */
const DEFAULT_CIRCUIT_THRESHOLD = 5;

function syncSummary(
  device: { sync_role: string; group: string; slaves: string[] },
  primaryName: string | null,
): string {
  if (device.sync_role === 'primary') {
    if (device.group) return `Leading ${device.group}`;
    const n = device.slaves.length;
    return n > 0 ? `Leading ${n} follower${n === 1 ? '' : 's'}` : 'Leading group';
  }
  if (device.sync_role === 'synced') {
    if (primaryName) return `Following ${primaryName}`;
    if (device.group) return `In ${device.group}`;
    return 'Following group';
  }
  return 'Standalone';
}

function firmwareSuffix(upgrade: UpgradeStatus | null): string {
  if (!upgrade) return '';
  if (!upgrade.ok) return `${META_SEP}check failed`;
  return upgrade.update_available ? `${META_SEP}update available` : `${META_SEP}up to date`;
}

interface DeviceMetricsPanelProps {
  device: PlayerStatus;
  role: string;
  primaryName: string | null;
  diag: DiagnoseResponse | null;
  upgrade: UpgradeStatus | null;
  health: FleetHealthResponse | null;
  activeInputName: string | null;
  onVolume: (level: number) => void;
  onToggleMute: () => void;
}

export function DeviceMetricsPanel(props: DeviceMetricsPanelProps) {
  const { device, onVolume, onToggleMute } = props;
  return (
    <section className="panel">
      <h2>Device</h2>
      <DeviceMetrics {...props} />
      <div className="dossier-volume">
        <h3>Device volume</h3>
        <div className="volume-row">
          <VolumeNudgeButtons value={device.volume} onChange={onVolume} />
          <input
            type="range"
            min={0}
            max={100}
            value={device.volume}
            aria-label="Device volume"
            onPointerDown={() => useFleetStore.getState().holdVolume(device.id)}
            onChange={(e) => onVolume(Number(e.target.value))}
          />
          <span className="volume-value">{device.volume}</span>
          <button type="button" className="btn" onClick={onToggleMute}>
            {device.muted ? 'Unmute' : 'Mute'}
          </button>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DeviceMetrics({
  device,
  role,
  primaryName,
  diag,
  upgrade,
  health,
  activeInputName,
}: DeviceMetricsPanelProps) {
  const nowSec = health?.observed_at ?? device.last_seen ?? 0;
  const lastDrop = health ? latestDrop(health, device.id) : null;
  const threshold = health?.circuit_failure_threshold ?? DEFAULT_CIRCUIT_THRESHOLD;
  const slowPoll = Boolean(health) && device.consecutive_failures >= threshold;
  return (
    <dl className="dossier-metrics">
      <Metric label="Volume">
        {device.volume}%{device.db ? `${META_SEP}${device.db} dB` : ''}
        {device.muted ? `${META_SEP}muted` : ''}
      </Metric>
      {health ? <PresenceMetric device={device} health={health} now={nowSec} /> : null}
      <Metric label="Last drop">{lastDrop ? formatDropLine(lastDrop) : '—'}</Metric>
      <Metric label="Failures">
        {device.consecutive_failures}
        {slowPoll ? `${META_SEP}slow-poll` : ''}
      </Metric>
      <Metric label="Last seen">{formatRelativeAge(device.last_seen, nowSec) || '—'}</Metric>
      <Metric label="Uptime">{formatPlayerUptime(diag?.uptime) || '—'}</Metric>
      <Metric label="Sync">{syncSummary({ ...device, sync_role: role }, primaryName)}</Metric>
      {diag?.signal_strength ? <Metric label="Wi‑Fi signal">{diag.signal_strength}</Metric> : null}
      <Metric label="Network">
        {diag?.network_name ? (
          <>
            {diag.network_name}
            {device.ip ? `${META_SEP}${formatDeviceHost(device)}` : ''}
          </>
        ) : (
          formatDeviceHost(device)
        )}
        {device.mac ? `${META_SEP}${device.mac}` : ''}
      </Metric>
      {diag?.total_songs != null && diag.total_songs !== '' ? (
        <Metric label="Library songs">{diag.total_songs}</Metric>
      ) : null}
      <div>
        <dt>Firmware</dt>
        <dd title={upgrade?.message || undefined}>
          {device.fw || diag?.web_fw || '—'}
          {firmwareSuffix(upgrade)}
        </dd>
      </div>
      {device.battery != null && device.battery !== '' && (
        <Metric label="Battery">{device.battery}%</Metric>
      )}
      {device.input_type_index && (
        <Metric label="Capture input">{activeInputName || device.input_type_index}</Metric>
      )}
    </dl>
  );
}

function PresenceMetric({
  device,
  health,
  now,
}: {
  device: PlayerStatus;
  health: FleetHealthResponse;
  now: number;
}) {
  const segments = presenceSegments({
    deviceId: device.id,
    firstOnlineAt: health.first_online[device.id],
    drops: health.drops,
    now,
    windowSeconds: health.presence_window_seconds,
  });
  return (
    <div className="presence-block">
      <dt>Last 12h</dt>
      <dd>
        <PresenceBar segments={segments} />
      </dd>
    </div>
  );
}
