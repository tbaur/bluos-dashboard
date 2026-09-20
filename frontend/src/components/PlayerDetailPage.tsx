import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '@/api/client';
import type { AudioInput, DiagnoseResponse, PlayerStatus, Preset, QueueResponse, UpgradeStatus } from '@/api/types';
import { DeviceSettingsPanel } from '@/components/DeviceSettingsPanel';
import { PresenceBar } from '@/components/PresenceBar';
import { SeekBar } from '@/components/SeekBar';
import { StickyArt } from '@/components/StickyArt';
import { VolumeNudgeButtons } from '@/components/VolumeNudgeButtons';
import {
  deviceEndpoint,
  endpointsMatch,
  formatDeviceHardware,
  formatDeviceHost,
} from '@/lib/endpoint';
import {
  formatDropLine,
  formatRelativeAge,
  latestDrop,
  presenceSegments,
} from '@/lib/health';
import { META_SEP, joinMeta } from '@/lib/meta';
import { displaySyncRole } from '@/lib/syncGraph';
import { reorderQueue } from '@/lib/queue';
import { streamQualityLabel } from '@/lib/streamQuality';
import { formatPlayerUptime } from '@/lib/uptime';
import { useFleetStore } from '@/store/fleetStore';

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

export function PlayerDetailPage() {
  const { id = '' } = useParams();
  const device = useFleetStore((s) => s.devices.find((d) => d.id === id));
  const devices = useFleetStore((s) => s.devices);
  const sync = useFleetStore((s) => s.sync);
  const control = useFleetStore((s) => s.control);
  const toggleMute = useFleetStore((s) => s.toggleMute);
  const patchDevice = useFleetStore((s) => s.patchDevice);
  const toast = useFleetStore((s) => s.toast);
  const setToast = useFleetStore((s) => s.setToast);
  const health = useFleetStore((s) => s.health);
  const volumeCommitTimer = useRef<number | undefined>(undefined);
  const nudgeBaseline = useRef(device?.volume ?? 0);

  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [inputs, setInputs] = useState<AudioInput[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [bluetooth, setBluetooth] = useState('');
  const [bluetoothSupported, setBluetoothSupported] = useState(false);
  const [diag, setDiag] = useState<DiagnoseResponse | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeStatus | null>(null);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const scrapeAbort = useRef<AbortController | null>(null);

  const interruptScrapes = () => {
    scrapeAbort.current?.abort();
  };

  useEffect(() => {
    if (!id) return;
    const ac = new AbortController();
    void api
      .getQueue(id, { signal: ac.signal })
      .then((value) => {
        if (!ac.signal.aborted) setQueue(value);
      })
      .catch(() => {
        if (!ac.signal.aborted) setDetailError('Failed to load: queue');
      });
    return () => ac.abort();
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const ac = new AbortController();
    scrapeAbort.current = ac;
    void (async () => {
      try {
        const value = await api.diagnose(id, { signal: ac.signal });
        if (!ac.signal.aborted) setDiag(value);
      } catch {
        /* aborted or failed — Device card keeps "—" */
      }
      if (ac.signal.aborted) return;
      try {
        const value = await api.getUpgrade(id, { signal: ac.signal });
        if (!ac.signal.aborted) setUpgrade(value);
      } catch {
        if (!ac.signal.aborted) {
          setUpgrade({
            device_id: id,
            name: '',
            ip: '',
            current_fw: '',
            update_available: false,
            message: 'Upgrade check failed',
            ok: false,
          });
        }
      }
    })();
    return () => ac.abort();
  }, [id]);

  useEffect(() => {
    if (!id || !advancedOpen) return;
    const ac = new AbortController();
    void (async () => {
      const failures: string[] = [];
      try {
        const value = await api.getInputs(id, { signal: ac.signal });
        if (!ac.signal.aborted) setInputs(value);
      } catch {
        failures.push('inputs');
      }
      try {
        const value = await api.getPresets(id, { signal: ac.signal });
        if (!ac.signal.aborted) setPresets(value);
      } catch {
        failures.push('presets');
      }
      try {
        const value = await api.getBluetooth(id, { signal: ac.signal });
        if (!ac.signal.aborted) {
          setBluetoothSupported(value.supported);
          setBluetooth(value.supported ? (value.mode ?? '') : '');
        }
      } catch {
        setBluetoothSupported(false);
        failures.push('bluetooth');
      }
      if (!ac.signal.aborted && failures.length) {
        setDetailError(`Failed to load: ${failures.join(', ')}`);
      }
    })();
    return () => ac.abort();
  }, [id, advancedOpen]);

  useEffect(() => {
    if (device) nudgeBaseline.current = device.volume;
  }, [device]);

  useEffect(
    () => () => {
      if (volumeCommitTimer.current) window.clearTimeout(volumeCommitTimer.current);
    },
    [],
  );

  const commitDeviceVolume = (level: number) => {
    if (!device) return;
    const deviceId = device.id;
    useFleetStore.getState().holdVolume(deviceId);
    patchDevice(deviceId, { volume: level });
    nudgeBaseline.current = level;
    if (volumeCommitTimer.current) window.clearTimeout(volumeCommitTimer.current);
    volumeCommitTimer.current = window.setTimeout(() => {
      volumeCommitTimer.current = undefined;
      void control(deviceId, () => api.setVolume(deviceId, level), { volume: level });
    }, 80);
  };

  const nudgeDeviceVolume = (level: number) => {
    if (!device) return;
    const deviceId = device.id;
    const delta = level - nudgeBaseline.current;
    if (delta === 0) return;
    nudgeBaseline.current = level;
    useFleetStore.getState().holdVolume(deviceId);
    patchDevice(deviceId, { volume: level });
    void control(deviceId, () => api.adjustVolume(deviceId, delta), { volume: level });
  };

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
  const playing = ['play', 'stream', 'connecting'].includes(device.state);
  const isIdle =
    !device.track.trim() &&
    (device.state === 'stop' || device.state === '' || device.state === 'pause');
  const nowTitle = device.track.trim()
    ? device.track
    : device.state === 'pause'
      ? 'Paused'
      : isIdle
        ? 'Idle'
        : playing
          ? 'Playing'
          : device.state || 'Idle';
  const activeInput = inputs.find((input) => input.selected);
  const upgradeView = upgrade && upgrade.device_id === id ? upgrade : null;
  const metaLine = streamQualityLabel(device.quality, device.stream_format);
  const nowSec = health?.observed_at ?? device.last_seen ?? 0;
  const lastDrop = health ? latestDrop(health, device.id) : null;
  const presence = health
    ? presenceSegments({
        deviceId: device.id,
        firstOnlineAt: health.first_online[device.id],
        drops: health.drops,
        now: nowSec,
        windowSeconds: health.presence_window_seconds,
      })
    : [];
  const slowPoll =
    Boolean(health) && device.consecutive_failures >= (health?.circuit_failure_threshold ?? 5);

  const runDeviceControl = (
    action: () => Promise<void>,
    optimistic?: Partial<PlayerStatus>,
  ) => {
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
            {device.status}
          </span>
          {role !== 'standalone' && (
            <span className="badge" data-role={role}>
              {role}
            </span>
          )}
        </div>
      </header>

      {detailError && <div className="error-banner">{detailError}</div>}

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

      <section className="panel dossier-now">
        <div className="dossier-now-grid">
          <div className="dossier-art" aria-hidden={!device.image}>
            <StickyArt
              src={device.image}
              empty={<div className="dossier-art-empty">No artwork</div>}
            />
          </div>
          <div className="dossier-now-copy">
            <p className="card-meta">{isIdle ? 'Status' : 'Now playing'}</p>
            <h2>{nowTitle}</h2>
            {!isIdle && (
              <p className="dossier-now-meta">
                {joinMeta(device.artist, device.album) || '—'}
              </p>
            )}
            <p className="card-meta">
              {joinMeta(
                device.service || null,
                activeInput ? `Input ${activeInput.name}` : null,
                !isIdle ? metaLine || null : null,
                !isIdle ? device.state : null,
              )}
            </p>
            {device.totlen > 0 && (
              <SeekBar
                key={device.id}
                initialSecs={device.secs}
                totlen={device.totlen}
                playing={['play', 'stream'].includes(device.state)}
                canSeek={device.can_seek}
                onSeek={
                  device.can_seek
                    ? (seconds) =>
                        runDeviceControl(() => api.seek(device.id, seconds), {
                          secs: seconds,
                        })
                    : undefined
                }
              />
            )}
            <div className="transport" style={{ marginTop: 14 }}>
              <button type="button" className="btn" onClick={() => runDeviceControl(() => api.back(device.id))}>
                Prev
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  runDeviceControl(
                    () => api.toggle(device.id),
                    { state: playing ? 'pause' : 'play' },
                  )
                }
              >
                {playing ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => runDeviceControl(() => api.stop(device.id), { state: 'stop' })}
              >
                Stop
              </button>
              <button type="button" className="btn" onClick={() => runDeviceControl(() => api.skip(device.id))}>
                Next
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Device</h2>
        <dl className="dossier-metrics">
          <div>
            <dt>Volume</dt>
            <dd>
              {device.volume}%
              {device.db ? `${META_SEP}${device.db} dB` : ''}
              {device.muted ? `${META_SEP}muted` : ''}
            </dd>
          </div>
          {health ? (
            <div className="presence-block">
              <dt>Last 12h</dt>
              <dd>
                <PresenceBar segments={presence} />
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Last drop</dt>
            <dd>{lastDrop ? formatDropLine(lastDrop) : '—'}</dd>
          </div>
          <div>
            <dt>Failures</dt>
            <dd>
              {device.consecutive_failures}
              {slowPoll ? `${META_SEP}slow-poll` : ''}
            </dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{formatRelativeAge(device.last_seen, nowSec) || '—'}</dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>{formatPlayerUptime(diag?.uptime) || '—'}</dd>
          </div>
          <div>
            <dt>Sync</dt>
            <dd>{syncSummary({ ...device, sync_role: role }, primary?.name ?? null)}</dd>
          </div>
          {diag?.signal_strength ? (
            <div>
              <dt>Wi‑Fi signal</dt>
              <dd>{diag.signal_strength}</dd>
            </div>
          ) : null}
          {diag?.network_name ? (
            <div>
              <dt>Network</dt>
              <dd>
                {diag.network_name}
                {device.ip ? `${META_SEP}${formatDeviceHost(device)}` : ''}
                {device.mac ? `${META_SEP}${device.mac}` : ''}
              </dd>
            </div>
          ) : (
            <div>
              <dt>Network</dt>
              <dd>
                {formatDeviceHost(device)}
                {device.mac ? `${META_SEP}${device.mac}` : ''}
              </dd>
            </div>
          )}
          {diag?.total_songs != null && diag.total_songs !== '' ? (
            <div>
              <dt>Library songs</dt>
              <dd>{diag.total_songs}</dd>
            </div>
          ) : null}
          <div>
            <dt>Firmware</dt>
            <dd title={upgradeView?.message || undefined}>
              {device.fw || diag?.web_fw || '—'}
              {upgradeView
                ? upgradeView.ok
                  ? upgradeView.update_available
                    ? `${META_SEP}update available`
                    : `${META_SEP}up to date`
                  : `${META_SEP}check failed`
                : ''}
            </dd>
          </div>
          {device.battery != null && device.battery !== '' && (
            <div>
              <dt>Battery</dt>
              <dd>{device.battery}%</dd>
            </div>
          )}
          {device.input_type_index && (
            <div>
              <dt>Capture input</dt>
              <dd>{activeInput?.name || device.input_type_index}</dd>
            </div>
          )}
        </dl>
        <div className="dossier-volume">
          <h3>Device volume</h3>
          <div className="volume-row">
            <VolumeNudgeButtons value={device.volume} onChange={nudgeDeviceVolume} />
            <input
              type="range"
              min={0}
              max={100}
              value={device.volume}
              aria-label="Device volume"
              onPointerDown={() => useFleetStore.getState().holdVolume(device.id)}
              onChange={(e) => commitDeviceVolume(Number(e.target.value))}
            />
            <span className="volume-value">{device.volume}</span>
            <button type="button" className="btn" onClick={() => void toggleMute(device.id)}>
              {device.muted ? 'Unmute' : 'Mute'}
            </button>
          </div>
        </div>
      </section>

      <details
        className="panel panel-collapse"
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <h2>Advanced</h2>
          <span className="card-meta">
            queue {queue?.count ?? 0}
            {META_SEP}inputs {inputs.length}
            {META_SEP}presets {presets.length}
          </span>
        </summary>

        <div className="dossier-advanced">
          <section>
            <h3>Queue</h3>
            {!queue || queue.count === 0 ? (
              <div className="empty">Queue is empty</div>
            ) : (
              <ul className="list list-scroll">
                {queue.items.map((item, index) => (
                  <li key={`${item.title}-${index}`}>
                    <span>
                      {item.title}
                      <div className="card-meta">{item.artist}</div>
                    </span>
                    <span className="queue-move">
                      <button
                        type="button"
                        className="btn btn-compact"
                        disabled={index === 0}
                        aria-label={`Move ${item.title} up`}
                        onClick={() => moveQueue(index, index - 1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-compact"
                        disabled={index >= queue.items.length - 1}
                        aria-label={`Move ${item.title} down`}
                        onClick={() => moveQueue(index, index + 1)}
                      >
                        ↓
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="btn btn-danger"
              style={{ marginTop: 12 }}
              onClick={() => {
                if (window.confirm('Clear the queue on this player?')) {
                  runDeviceControl(async () => {
                    await api.clearQueue(device.id);
                    setQueue(await api.getQueue(device.id));
                  });
                }
              }}
            >
              Clear queue
            </button>
          </section>

          <section>
            <h3>Inputs</h3>
            <ul className="list">
              {inputs.map((input) => (
                <li key={input.id || input.name} data-selected={String(input.selected)}>
                  <span>
                    {input.name}
                    <div className="card-meta">{input.id || input.type}</div>
                  </span>
                  <button
                    type="button"
                    className={input.selected ? 'btn btn-primary' : 'btn'}
                    disabled={input.selected}
                    onClick={() =>
                      runDeviceControl(async () => {
                        await api.setInput(device.id, input.id || input.name);
                        setInputs(await api.getInputs(device.id));
                      })
                    }
                  >
                    {input.selected ? 'In use' : 'Select'}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>Presets</h3>
            {presets.length === 0 ? (
              <div className="empty">No presets</div>
            ) : (
              <ul className="list">
                {presets.map((preset) => (
                  <li key={preset.id}>
                    <span>{preset.name || `Preset ${preset.id}`}</span>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => runDeviceControl(() => api.playPreset(device.id, preset.id))}
                    >
                      Play
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {bluetoothSupported ? (
            <section>
              <h3>Bluetooth</h3>
              <p className="card-meta">Current mode: {bluetooth || 'Unknown'}</p>
              <div className="transport" style={{ marginTop: 8 }}>
                {(
                  [
                    [0, 'Manual'],
                    [1, 'Automatic'],
                    [2, 'Guest'],
                    [3, 'Disabled'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={bluetooth === label ? 'btn btn-primary' : 'btn'}
                    onClick={() =>
                      runDeviceControl(async () => {
                        await api.setBluetooth(device.id, mode);
                        const next = await api.getBluetooth(device.id);
                        setBluetoothSupported(next.supported);
                        setBluetooth(next.supported ? (next.mode ?? '') : '');
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {advancedOpen ? <DeviceSettingsPanel deviceId={device.id} /> : null}

          <section>
            <h3>Maintenance</h3>
            <p className="card-meta" style={{ marginBottom: 10 }} title={upgradeView?.message || undefined}>
              {upgradeView
                ? upgradeView.ok
                  ? upgradeView.update_available
                    ? 'An update is available. Install it from the BluOS Controller app.'
                    : 'No update available on this player.'
                  : 'Firmware check failed. Retry below, or open the BluOS Controller app.'
                : 'Checking firmware…'}
            </p>
            <div className="transport">
              <button
                type="button"
                className="btn"
                disabled={upgradeBusy}
                onClick={() => {
                  setUpgradeBusy(true);
                  void api
                    .getUpgrade(device.id)
                    .then(setUpgrade)
                    .catch(() =>
                      setUpgrade({
                        device_id: device.id,
                        name: device.name,
                        ip: device.ip,
                        current_fw: device.fw,
                        update_available: false,
                        message: 'Upgrade check failed',
                        ok: false,
                      }),
                    )
                    .finally(() => setUpgradeBusy(false));
                }}
              >
                {upgradeBusy ? 'Checking…' : 'Check for upgrade'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  if (
                    window.confirm(
                      `Reboot ${device.name}? Playback will stop until it comes back.`,
                    )
                  ) {
                    void runDeviceControl(() => api.reboot(device.id));
                  }
                }}
              >
                Reboot
              </button>
            </div>
          </section>
        </div>
      </details>
    </div>
  );
}
