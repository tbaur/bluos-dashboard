import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerDetailPage } from '@/components/PlayerDetailPage';
import type { PlayerStatus } from '@/api/types';
import { useFleetStore } from '@/store/fleetStore';

const getQueue = vi.fn();
const getInputs = vi.fn();
const getPresets = vi.fn();
const getBluetooth = vi.fn();
const diagnose = vi.fn();
const getUpgrade = vi.fn();
const reboot = vi.fn();
const moveQueueItem = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    getQueue: (...args: unknown[]) => getQueue(...args),
    getInputs: (...args: unknown[]) => getInputs(...args),
    getPresets: (...args: unknown[]) => getPresets(...args),
    getBluetooth: (...args: unknown[]) => getBluetooth(...args),
    diagnose: (...args: unknown[]) => diagnose(...args),
    getUpgrade: (...args: unknown[]) => getUpgrade(...args),
    reboot: (...args: unknown[]) => reboot(...args),
    moveQueueItem: (...args: unknown[]) => moveQueueItem(...args),
  },
}));

vi.mock('@/components/DeviceSettingsPanel', () => ({
  DeviceSettingsPanel: () => <div data-testid="settings-panel" />,
}));

vi.mock('@/components/VolumeNudgeButtons', () => ({
  VolumeNudgeButtons: () => null,
}));

const sample: PlayerStatus = {
  id: 'player-kitchen',
  ip: '192.168.1.20',
  name: 'Kitchen',
  model: 'NODE',
  brand: 'Bluesound',
  full_model: 'Bluesound NODE',
  device_class: 'streamer',
  mac: '90:56:82:00:00:01',
  status: 'online',
  state: 'pause',
  service: '',
  service_id: '',
  volume: 20,
  muted: false,
  db: '-40',
  fw: '4.16.6',
  master: '',
  group: '',
  group_volume: null,
  slaves: [],
  sync_role: 'standalone',
  battery: null,
  track: '',
  artist: '',
  album: '',
  quality: '',
  stream_format: '',
  image: '',
  secs: 0,
  totlen: 0,
  can_seek: false,
  input_type_index: '',
  consecutive_failures: 0,
  last_seen: 1,
};

function renderPlayer() {
  return render(
    <MemoryRouter initialEntries={['/player/player-kitchen']}>
      <Routes>
        <Route path="/player/:id" element={<PlayerDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PlayerDetailPage maintenance', () => {
  beforeEach(() => {
    getQueue.mockReset().mockResolvedValue({ items: [], count: 0 });
    getInputs.mockReset().mockResolvedValue([]);
    getPresets.mockReset().mockResolvedValue([]);
    getBluetooth.mockReset().mockResolvedValue({ supported: true, mode: 'Automatic' });
    diagnose.mockReset().mockResolvedValue({
      device_id: 'player-kitchen',
      ip: '192.168.1.20',
      name: 'Kitchen',
      model: 'NODE',
      full_model: 'Bluesound NODE',
      device_class: 'streamer',
      mac: '',
      fw: '4.16.6',
      state: 'pause',
      service: '',
      volume: 20,
      muted: false,
      db: '-40',
      sync_role: 'standalone',
      master: '',
      group: '',
      uptime: '1h',
    });
    getUpgrade.mockReset().mockResolvedValue({
      device_id: 'player-kitchen',
      name: 'Kitchen',
      ip: '192.168.1.20',
      current_fw: '4.16.6',
      update_available: false,
      message: 'No update available.',
      ok: true,
    });
    reboot.mockReset().mockResolvedValue(undefined);
    moveQueueItem.mockReset().mockResolvedValue(undefined);

    useFleetStore.setState({
      devices: [sample],
      discoveredAt: Date.now(),
      discoveryMethod: 'mdns',
      sync: null,
      health: null,
      connection: 'live',
      loading: false,
      refreshing: false,
      error: null,
      toast: null,
      volumeHoldUntil: {},
      playbackHoldUntil: {},
      globalVolumeHoldUntil: 0,
      syncHoldUntil: 0,
      lastAudibleVolume: {},
      control: vi.fn(async (_id, action) => {
        await action();
      }),
      toggleMute: vi.fn(),
      patchDevice: vi.fn(),
    });
  });

  it('auto-checks upgrade on load and again from the button', async () => {
    renderPlayer();
    await screen.findByText('No update available on this player.');
    expect(getUpgrade.mock.calls[0]?.[0]).toBe('player-kitchen');

    const before = getUpgrade.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Check for upgrade' }));
    await waitFor(() => expect(getUpgrade.mock.calls.length).toBeGreaterThan(before));
  });

  it('reboots only after confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const control = useFleetStore.getState().control;
    renderPlayer();
    await screen.findByRole('button', { name: 'Reboot' });

    fireEvent.click(screen.getByRole('button', { name: 'Reboot' }));
    await waitFor(() => expect(reboot).toHaveBeenCalledWith('player-kitchen'));
    expect(control).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('skips reboot when confirm is cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPlayer();
    await screen.findByRole('button', { name: 'Reboot' });
    fireEvent.click(screen.getByRole('button', { name: 'Reboot' }));
    expect(reboot).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('hides Bluetooth when the player reports unsupported', async () => {
    getBluetooth.mockResolvedValue({ supported: false, mode: null });
    renderPlayer();
    await screen.findByRole('button', { name: 'Reboot' });
    expect(screen.queryByRole('heading', { name: 'Bluetooth' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed to load/i)).not.toBeInTheDocument();
  });

  it('shows uptime even when inputs never resolve', async () => {
    getInputs.mockReturnValue(new Promise(() => {}));
    diagnose.mockResolvedValue({
      device_id: 'player-kitchen',
      ip: '192.168.1.20',
      name: 'Kitchen',
      model: 'NODE',
      full_model: 'Bluesound NODE',
      device_class: 'streamer',
      mac: '',
      fw: '4.16.6',
      state: 'pause',
      service: '',
      volume: 20,
      muted: false,
      db: '-40',
      sync_role: 'standalone',
      master: '',
      group: '',
      uptime: '37h13m24s',
    });
    renderPlayer();
    expect(await screen.findByText('1d 13h')).toBeInTheDocument();
    expect(diagnose.mock.calls[0]?.[0]).toBe('player-kitchen');
  });

  it('aborts diagnose when leaving the player page', async () => {
    let signal: AbortSignal | undefined;
    diagnose.mockImplementation((_id: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const { unmount } = renderPlayer();
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('moves a queue track down without waiting for diagnose', async () => {
    getQueue
      .mockResolvedValueOnce({
        count: 2,
        items: [
          { title: 'First', artist: 'A', album: '', image: '', service: '' },
          { title: 'Second', artist: 'B', album: '', image: '', service: '' },
        ],
      })
      .mockResolvedValue({
        count: 2,
        items: [
          { title: 'Second', artist: 'B', album: '', image: '', service: '' },
          { title: 'First', artist: 'A', album: '', image: '', service: '' },
        ],
      });
    diagnose.mockImplementation(() => new Promise(() => {}));
    renderPlayer();
    fireEvent.click(await screen.findByRole('button', { name: 'Move First down' }));
    await waitFor(() => expect(moveQueueItem).toHaveBeenCalledWith('player-kitchen', 0, 1));
    expect(screen.getByRole('button', { name: 'Move First up' })).toBeEnabled();
  });

  it('counts inputs and presets only after Advanced has loaded them', async () => {
    getInputs.mockResolvedValue([
      { name: 'Analog', type: 'analog', id: 'analog-1', selected: false },
    ]);
    const { container } = renderPlayer();
    const summary = () => container.querySelector('summary .card-meta')?.textContent;
    await waitFor(() => expect(getQueue).toHaveBeenCalled());
    expect(summary()).toBe('queue 0');

    const details = container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(summary()).toBe('queue 0 / inputs 1 / presets 0'));
  });

  it('shows poller health on the device panel', async () => {
    useFleetStore.setState({
      devices: [{ ...sample, consecutive_failures: 2, last_seen: Date.now() / 1000 - 12 }],
      health: {
        started_at: Date.now() / 1000 - 600,
        observed_at: Date.now() / 1000,
        window_seconds: 86_400,
        presence_window_seconds: 43_200,
        circuit_failure_threshold: 5,
        first_online: { 'player-kitchen': Date.now() / 1000 - 600 },
        drops: [
          {
            device_id: 'player-kitchen',
            name: 'Kitchen',
            started_at: Date.now() / 1000 - 180,
            ended_at: Date.now() / 1000 - 60,
            duration_seconds: 120,
            peak_failures: 2,
            slow_poll: false,
          },
        ],
      },
    });
    renderPlayer();
    expect(await screen.findByText('Last 12h')).toBeInTheDocument();
    expect(screen.getByText('Last drop').nextElementSibling).toHaveTextContent(/2m/);
    expect(screen.getByText('Failures').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Last seen').nextElementSibling).toHaveTextContent(/ago|just now/);
  });
});
