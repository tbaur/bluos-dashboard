import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import type {
  AudioInput,
  BluetoothResponse,
  DiagnoseResponse,
  Preset,
  QueueResponse,
  UpgradeStatus,
} from '@/api/types';
import { useFleetStore } from '@/store/fleetStore';

/** Debounce for the device volume slider before the command is sent. */
const VOLUME_COMMIT_MS = 80;

type ReportError = (message: string) => void;

export interface BluetoothView {
  supported: boolean;
  mode: string;
}

/** Shown when the player's upgrade page cannot be read. */
export function failedUpgrade(device: {
  id: string;
  name?: string;
  ip?: string;
  fw?: string;
}): UpgradeStatus {
  return {
    device_id: device.id,
    name: device.name ?? '',
    ip: device.ip ?? '',
    current_fw: device.fw ?? '',
    update_available: false,
    message: 'Upgrade check failed',
    ok: false,
  };
}

function bluetoothView(value: BluetoothResponse): BluetoothView {
  return { supported: value.supported, mode: value.supported ? (value.mode ?? '') : '' };
}

/** Play queue, loaded when the page opens. */
export function usePlayerQueue(id: string, reportError: ReportError) {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  useEffect(() => {
    if (!id) return;
    const ac = new AbortController();
    void api
      .getQueue(id, { signal: ac.signal })
      .then((value) => {
        if (!ac.signal.aborted) setQueue(value);
      })
      .catch(() => {
        if (!ac.signal.aborted) reportError('Failed to load: queue');
      });
    return () => ac.abort();
  }, [id, reportError]);
  return { queue, setQueue };
}

/**
 * Diagnostics, then the upgrade check, from the player's web UI.
 *
 * Both scrapes hold browser connections to this host, so a control calls
 * `interruptScrapes` first rather than queueing behind them.
 */
export function usePlayerScrapes(id: string) {
  const [diag, setDiag] = useState<DiagnoseResponse | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeStatus | null>(null);
  const scrapeAbort = useRef<AbortController | null>(null);

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
        if (!ac.signal.aborted) setUpgrade(failedUpgrade({ id }));
      }
    })();
    return () => ac.abort();
  }, [id]);

  const interruptScrapes = useCallback(() => scrapeAbort.current?.abort(), []);
  return { diag, upgrade, setUpgrade, interruptScrapes };
}

/** Inputs, presets and Bluetooth, loaded only while Advanced is open. */
export function useAdvancedDetails(id: string, open: boolean, reportError: ReportError) {
  const [inputs, setInputs] = useState<AudioInput[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [bluetooth, setBluetooth] = useState<BluetoothView>({ supported: false, mode: '' });

  useEffect(() => {
    if (!id || !open) return;
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
        if (!ac.signal.aborted) setBluetooth(bluetoothView(value));
      } catch {
        setBluetooth((current) => ({ ...current, supported: false }));
        failures.push('bluetooth');
      }
      if (!ac.signal.aborted && failures.length) {
        reportError(`Failed to load: ${failures.join(', ')}`);
      }
    })();
    return () => ac.abort();
  }, [id, open, reportError]);

  const applyBluetooth = useCallback(
    (value: BluetoothResponse) => setBluetooth(bluetoothView(value)),
    [],
  );
  return { inputs, setInputs, presets, bluetooth, applyBluetooth };
}

/** Paint the slider at once, and send the newest level after a short pause. */
export function useDeviceVolumeCommit(deviceId: string | undefined) {
  const control = useFleetStore((s) => s.control);
  const patchDevice = useFleetStore((s) => s.patchDevice);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  return (level: number) => {
    if (!deviceId) return;
    useFleetStore.getState().holdVolume(deviceId);
    patchDevice(deviceId, { volume: level });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      void control(deviceId, () => api.setVolume(deviceId, level), { volume: level });
    }, VOLUME_COMMIT_MS);
  };
}
