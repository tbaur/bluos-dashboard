import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '@/api/client';
import type { FleetUpgradeResponse, UpgradeStatus } from '@/api/types';
import { ApiError } from '@/api/types';
import { FleetHealthLog } from '@/components/FleetHealthLog';
import { HouseRemote } from '@/components/HouseRemote';
import { compareFirmware } from '@/lib/firmware';
import { sortDevices } from '@/lib/fleetSort';
import { META_SEP } from '@/lib/meta';
import { useFleetStore } from '@/store/fleetStore';

export function HousePage() {
  const devices = useFleetStore((s) => s.devices);
  const sync = useFleetStore((s) => s.sync);
  const loading = useFleetStore((s) => s.loading);
  const refreshing = useFleetStore((s) => s.refreshing);
  const toast = useFleetStore((s) => s.toast);
  const setToast = useFleetStore((s) => s.setToast);
  const refresh = useFleetStore((s) => s.refresh);
  const reloadStatus = useFleetStore((s) => s.reloadStatus);
  const holdSync = useFleetStore((s) => s.holdSync);
  const setSync = useFleetStore((s) => s.setSync);
  const fleetRebootAll = useFleetStore((s) => s.fleetRebootAll);

  const [busy, setBusy] = useState<string | null>(null);
  const [upgradeReport, setUpgradeReport] = useState<FleetUpgradeResponse | null>(null);

  const groupCount = sync?.groups.length ?? 0;
  const sorted = useMemo(() => sortDevices(devices, 'name'), [devices]);

  const firmware = useMemo(() => {
    const versions = sorted.map((d) => d.fw).filter(Boolean);
    const unique = [...new Set(versions)].sort(compareFirmware);
    const newest = unique.length ? unique[unique.length - 1] : '';
    const byId = new Map<string, UpgradeStatus>();
    for (const row of upgradeReport?.results ?? []) {
      byId.set(row.device_id, row);
    }
    return { newest, byId };
  }, [sorted, upgradeReport]);

  const run = (key: string, action: () => Promise<void>) => {
    setBusy(key);
    void action().finally(() => setBusy(null));
  };

  const breakAll = async () => {
    try {
      const result = await api.syncBreak();
      setSync({
        groups: [],
        standalone_ids: useFleetStore.getState().devices.map((d) => d.id),
      });
      holdSync(6000);
      await reloadStatus();
      if (result.failed > 0) {
        setToast(`Ungrouped ${result.succeeded}; ${result.failed} failed`);
      }
    } catch (err) {
      setToast(
        err instanceof ApiError ? `${err.message} (${err.requestId})` : 'Break all failed',
      );
    }
  };

  const checkUpgrades = async () => {
    try {
      const report = await api.fleetUpgrades();
      setUpgradeReport(report);
      if (report.updates_available > 0) {
        setToast(
          `Firmware: ${report.updates_available} update${report.updates_available === 1 ? '' : 's'} available`,
        );
      } else if (report.failed > 0) {
        setToast(`Firmware check: ${report.checked} ok, ${report.failed} failed`);
      } else {
        setToast('Firmware: no updates available');
      }
    } catch (err) {
      setToast(
        err instanceof ApiError
          ? `${err.message} (${err.requestId})`
          : 'Firmware check failed',
      );
    }
  };

  if (loading && devices.length === 0) {
    return (
      <div className="app-shell">
        <Link to="/" className="card-meta">
          ← Fleet
        </Link>
        <div className="empty" style={{ marginTop: 16 }}>
          Discovering players…
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell dossier">
      <header className="dossier-header">
        <div>
          <Link to="/" className="card-meta">
            ← Fleet
          </Link>
          <h1 className="brand dossier-title">House</h1>
          <p className="brand-sub">Fleet maintenance, firmware, and the same remote as the live view.</p>
        </div>
        <div className="dossier-header-badges">
          <span className="badge" data-role="primary">
            {devices.length} device{devices.length === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      {toast ? (
        <div className="toast" role="status">
          {toast}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn" onClick={() => setToast(null)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {devices.length > 0 ? <HouseRemote variant="page" /> : null}
      {devices.length > 0 ? <FleetHealthLog /> : null}

      <section className="panel">
        <h2>Devices</h2>
        <ul className="house-room-list">
          {sorted.map((device) => {
            const row = firmware.byId.get(device.id);
            const behind = Boolean(
              firmware.newest && device.fw && compareFirmware(device.fw, firmware.newest) < 0,
            );
            let fwNote = '';
            if (row) {
              if (!row.ok) fwNote = 'check failed';
              else if (row.update_available) fwNote = 'update available';
              else fwNote = 'up to date';
            } else if (behind) {
              fwNote = 'behind house newest';
            }
            const meta = [
              device.status,
              device.state || null,
              `vol ${device.volume}`,
              device.fw ? `fw ${device.fw}` : 'fw ?',
              fwNote || null,
            ].filter(Boolean);
            return (
              <li key={device.id}>
                <Link to={`/player/${device.id}`}>
                  <span>{device.name}</span>
                  <span className="card-meta">{meta.join(META_SEP)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="fleet-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || devices.length === 0}
            onClick={() => run('upgrade', checkUpgrades)}
          >
            {busy === 'upgrade' ? 'Checking…' : 'Check all for upgrades'}
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Groups</h2>
        <p className="card-meta" style={{ marginBottom: 12 }}>
          Dissolve every multi-room group. Create or edit groups from the fleet Sync panel.
        </p>
        <button
          type="button"
          className="btn"
          disabled={busy !== null || groupCount === 0}
          onClick={() => {
            if (
              !window.confirm(
                `Break all ${groupCount} sync group${groupCount === 1 ? '' : 's'}?`,
              )
            ) {
              return;
            }
            run('break', breakAll);
          }}
        >
          {busy === 'break' ? '…' : 'Break all groups'}
        </button>
      </section>

      <section className="panel">
        <h2>Maintenance</h2>
        <p className="card-meta" style={{ marginBottom: 12 }}>
          Rescan the LAN, or reboot every player. Playback stops until each chassis comes back.
        </p>
        <div className="fleet-actions" role="group" aria-label="House maintenance">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null || refreshing}
            onClick={() => run('rescan', () => refresh())}
          >
            {busy === 'rescan' || refreshing ? 'Scanning…' : 'Rescan network'}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy !== null || devices.length === 0}
            onClick={() => {
              if (
                !window.confirm(
                  `Reboot all ${devices.length} player${devices.length === 1 ? '' : 's'}? Playback will stop until they come back.`,
                )
              ) {
                return;
              }
              run('reboot', () => fleetRebootAll());
            }}
          >
            {busy === 'reboot' ? '…' : 'Reboot all'}
          </button>
        </div>
      </section>
    </div>
  );
}
