import { useState } from 'react';
import { api } from '@/api/client';
import type {
  AudioInput,
  BluetoothResponse,
  PlayerStatus,
  Preset,
  QueueResponse,
  UpgradeStatus,
} from '@/api/types';
import { DeviceSettingsPanel } from '@/components/DeviceSettingsPanel';
import type { RunControl } from '@/components/player/NowPlayingPanel';
import { type BluetoothView, failedUpgrade } from '@/hooks/usePlayerDetails';
import { META_SEP } from '@/lib/meta';

const BLUETOOTH_MODES = [
  [0, 'Manual'],
  [1, 'Automatic'],
  [2, 'Guest'],
  [3, 'Disabled'],
] as const;

interface AdvancedPanelProps {
  device: PlayerStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queue: QueueResponse | null;
  setQueue: (queue: QueueResponse) => void;
  onMoveQueue: (fromIndex: number, toIndex: number) => void;
  inputs: AudioInput[];
  setInputs: (inputs: AudioInput[]) => void;
  presets: Preset[];
  /** Inputs and presets load when Advanced first opens; until then their counts are unknown. */
  loaded: boolean;
  bluetooth: BluetoothView;
  applyBluetooth: (value: BluetoothResponse) => void;
  upgrade: UpgradeStatus | null;
  setUpgrade: (upgrade: UpgradeStatus) => void;
  onControl: RunControl;
}

export function AdvancedPanel(props: AdvancedPanelProps) {
  const { device, open, onOpenChange, queue, inputs, presets, loaded, bluetooth, onControl } = props;
  return (
    <details
      className="panel panel-collapse"
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>
        <h2>Advanced</h2>
        <span className="card-meta">
          queue {queue?.count ?? 0}
          {loaded ? `${META_SEP}inputs ${inputs.length}${META_SEP}presets ${presets.length}` : null}
        </span>
      </summary>

      <div className="dossier-advanced">
        <QueueSection {...props} />
        <InputsSection {...props} />
        <PresetsSection device={device} presets={presets} onControl={onControl} />
        {bluetooth.supported ? <BluetoothSection {...props} /> : null}
        {open ? <DeviceSettingsPanel deviceId={device.id} /> : null}
        <MaintenanceSection {...props} />
      </div>
    </details>
  );
}

function QueueSection({ device, queue, setQueue, onMoveQueue, onControl }: AdvancedPanelProps) {
  return (
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
                  onClick={() => onMoveQueue(index, index - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-compact"
                  disabled={index >= queue.items.length - 1}
                  aria-label={`Move ${item.title} down`}
                  onClick={() => onMoveQueue(index, index + 1)}
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
            onControl(async () => {
              await api.clearQueue(device.id);
              setQueue(await api.getQueue(device.id));
            });
          }
        }}
      >
        Clear queue
      </button>
    </section>
  );
}

function InputsSection({ device, inputs, setInputs, onControl }: AdvancedPanelProps) {
  return (
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
                onControl(async () => {
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
  );
}

function PresetsSection({
  device,
  presets,
  onControl,
}: Pick<AdvancedPanelProps, 'device' | 'presets' | 'onControl'>) {
  return (
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
                onClick={() => onControl(() => api.playPreset(device.id, preset.id))}
              >
                Play
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BluetoothSection({ device, bluetooth, applyBluetooth, onControl }: AdvancedPanelProps) {
  return (
    <section>
      <h3>Bluetooth</h3>
      <p className="card-meta">Current mode: {bluetooth.mode || 'Unknown'}</p>
      <div className="transport" style={{ marginTop: 8 }}>
        {BLUETOOTH_MODES.map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            className={bluetooth.mode === label ? 'btn btn-primary' : 'btn'}
            onClick={() =>
              onControl(async () => {
                await api.setBluetooth(device.id, mode);
                applyBluetooth(await api.getBluetooth(device.id));
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

function upgradeMessage(upgrade: UpgradeStatus | null): string {
  if (!upgrade) return 'Checking firmware…';
  if (!upgrade.ok) return 'Firmware check failed. Retry below, or open the BluOS Controller app.';
  return upgrade.update_available
    ? 'An update is available. Install it from the BluOS Controller app.'
    : 'No update available on this player.';
}

function MaintenanceSection({ device, upgrade, setUpgrade, onControl }: AdvancedPanelProps) {
  const [busy, setBusy] = useState(false);
  const checkUpgrade = () => {
    setBusy(true);
    void api
      .getUpgrade(device.id)
      .then(setUpgrade)
      .catch(() => setUpgrade(failedUpgrade(device)))
      .finally(() => setBusy(false));
  };
  const reboot = () => {
    if (window.confirm(`Reboot ${device.name}? Playback will stop until it comes back.`)) {
      onControl(() => api.reboot(device.id));
    }
  };
  return (
    <section>
      <h3>Maintenance</h3>
      <p className="card-meta" style={{ marginBottom: 10 }} title={upgrade?.message || undefined}>
        {upgradeMessage(upgrade)}
      </p>
      <div className="transport">
        <button type="button" className="btn" disabled={busy} onClick={checkUpgrade}>
          {busy ? 'Checking…' : 'Check for upgrade'}
        </button>
        <button type="button" className="btn btn-danger" onClick={reboot}>
          Reboot
        </button>
      </div>
    </section>
  );
}
