import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '@/api/client';
import type { PlayerStatus } from '@/api/types';
import { AdvancedPanel } from '@/components/player/AdvancedPanel';
import { DeviceMetricsPanel } from '@/components/player/DeviceMetricsPanel';
import { NowPlayingPanel } from '@/components/player/NowPlayingPanel';
import {
  useAdvancedDetails,
  useDeviceVolumeCommit,
  usePlayerQueue,
  usePlayerScrapes,
} from '@/hooks/usePlayerDetails';
import { deviceEndpoint, endpointsMatch, formatDeviceHardware } from '@/lib/endpoint';
import { joinMeta } from '@/lib/meta';
import { reorderQueue } from '@/lib/queue';
import { displaySyncRole } from '@/lib/syncGraph';
import { useFleetStore } from '@/store/fleetStore';

/**
 * One page instance per player. The router keeps the component mounted when
 * only :id changes (back/forward), and every list, scrape and open panel here
 * belongs to one player, so a new id starts from scratch.
 */
export function PlayerDetailPage() {
  const { id = '' } = useParams();
  return <PlayerDetail key={id} id={id} />;
}

function PlayerDetail({ id }: { id: string }) {
  const device = useFleetStore((s) => s.devices.find((d) => d.id === id));
  const devices = useFleetStore((s) => s.devices);
  const sync = useFleetStore((s) => s.sync);
  const control = useFleetStore((s) => s.control);
  const toggleMute = useFleetStore((s) => s.toggleMute);
  const health = useFleetStore((s) => s.health);

  const [detailError, setDetailError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { queue, setQueue } = usePlayerQueue(id, setDetailError);
  const { diag, upgrade, setUpgrade, interruptScrapes } = usePlayerScrapes(id);
  const advanced = useAdvancedDetails(id, advancedOpen, setDetailError);
  const commitDeviceVolume = useDeviceVolumeCommit(device?.id);

  if (!device) {
    return (
      <div className="app-shell">
        <Link to="/">← Fleet</Link>
        <div className="empty" style={{ marginTop: 16 }}>
          Player not found. It may have left the network.
        </div>
      </div>
    );
  }

  const role = displaySyncRole(device, sync);
  const primary = device.master
    ? devices.find((d) => endpointsMatch(deviceEndpoint(d), device.master))
    : null;
  const activeInputName = advanced.inputs.find((input) => input.selected)?.name ?? null;
  const upgradeView = upgrade && upgrade.device_id === id ? upgrade : null;

  const runDeviceControl = (action: () => Promise<void>, optimistic?: Partial<PlayerStatus>) => {
    interruptScrapes();
    void control(device.id, action, optimistic);
  };

  const moveQueue = (fromIndex: number, toIndex: number) => {
    if (!queue) return;
    interruptScrapes();
    setQueue(reorderQueue(queue, fromIndex, toIndex));
    void (async () => {
      await control(device.id, () => api.moveQueueItem(device.id, fromIndex, toIndex));
      try {
        setQueue(await api.getQueue(device.id));
      } catch {
        /* keep optimistic order */
      }
    })();
  };

  return (
    <div className="app-shell dossier">
      <PlayerHeader device={device} role={role} />
      {detailError && <div className="error-banner">{detailError}</div>}
      <PlayerToast />
      <NowPlayingPanel
        device={device}
        activeInputName={activeInputName}
        onControl={runDeviceControl}
      />
      <DeviceMetricsPanel
        device={device}
        role={role}
        primaryName={primary?.name ?? null}
        diag={diag}
        upgrade={upgradeView}
        health={health}
        activeInputName={activeInputName}
        onVolume={commitDeviceVolume}
        onToggleMute={() => void toggleMute(device.id)}
      />
      <AdvancedPanel
        device={device}
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        queue={queue}
        setQueue={setQueue}
        onMoveQueue={moveQueue}
        {...advanced}
        upgrade={upgradeView}
        setUpgrade={setUpgrade}
        onControl={runDeviceControl}
      />
    </div>
  );
}

function PlayerHeader({ device, role }: { device: PlayerStatus; role: string }) {
  return (
    <header className="dossier-header">
      <div>
        <Link to="/" className="card-meta">
          ← Fleet
        </Link>
        <h1 className="brand dossier-title">{device.name}</h1>
        <p className="brand-sub">
          {joinMeta(formatDeviceHardware(device), device.fw ? `fw ${device.fw}` : '')}
        </p>
      </div>
      <div className="dossier-header-badges">
        <span className="badge" data-role={device.status === 'online' ? 'primary' : undefined}>
          {device.stale ? 'stale' : device.status}
        </span>
        {role !== 'standalone' && (
          <span className="badge" data-role={role}>
            {role}
          </span>
        )}
      </div>
    </header>
  );
}

function PlayerToast() {
  const toast = useFleetStore((s) => s.toast);
  const setToast = useFleetStore((s) => s.setToast);
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      {toast}
      <div style={{ marginTop: 8 }}>
        <button type="button" className="btn" onClick={() => setToast(null)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
