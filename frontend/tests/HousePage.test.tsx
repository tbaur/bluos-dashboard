import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HousePage } from '@/components/HousePage';
import type { PlayerStatus, SyncState } from '@/api/types';
import { LIVE_HOUSE_SESSION } from '@/lib/houseSession';
import { useFleetStore } from '@/store/fleetStore';

const fleetUpgrades = vi.fn();
const syncBreak = vi.fn();
const toggle = vi.fn();
const skip = vi.fn();
const back = vi.fn();
const seek = vi.fn();
const setShuffle = vi.fn();
const setRepeat = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    fleetUpgrades: (...args: unknown[]) => fleetUpgrades(...args),
    syncBreak: (...args: unknown[]) => syncBreak(...args),
    toggle: (...args: unknown[]) => toggle(...args),
    skip: (...args: unknown[]) => skip(...args),
    back: (...args: unknown[]) => back(...args),
    seek: (...args: unknown[]) => seek(...args),
    setShuffle: (...args: unknown[]) => setShuffle(...args),
    setRepeat: (...args: unknown[]) => setRepeat(...args),
  },
}));

const sample: PlayerStatus = {
  id: 'player-1',
  ip: '192.168.1.10',
  name: 'Kitchen',
  model: 'NODE',
  brand: 'Bluesound',
  full_model: 'Bluesound NODE',
  device_class: 'streamer',
  mac: '90:56:82:00:00:01',
  status: 'online',
  state: 'play',
  service: 'Spotify',
  service_id: 'Spotify',
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
  track: 'Track',
  artist: 'Artist',
  album: 'Album',
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

const syncWithGroup: SyncState = {
  groups: [
    {
      primary_id: 'player-1',
      primary_name: 'Kitchen',
      primary_ip: '192.168.1.10',
      group: 'g1',
      slave_ids: ['player-2'],
      slave_names: ['Living'],
    },
  ],
  standalone_ids: [],
};

function renderHouse() {
  return render(
    <MemoryRouter>
      <HousePage />
    </MemoryRouter>,
  );
}

describe('HousePage actions', () => {
  beforeEach(() => {
    fleetUpgrades.mockReset();
    syncBreak.mockReset();
    toggle.mockReset().mockResolvedValue(undefined);
    skip.mockReset().mockResolvedValue(undefined);
    back.mockReset().mockResolvedValue(undefined);
    seek.mockReset().mockResolvedValue(undefined);
    setShuffle.mockReset().mockResolvedValue(undefined);
    setRepeat.mockReset().mockResolvedValue(undefined);
    fleetUpgrades.mockResolvedValue({
      checked: 1,
      updates_available: 0,
      failed: 0,
      results: [],
    });
    syncBreak.mockResolvedValue({
      action: 'sync_break',
      succeeded: 1,
      failed: 0,
      results: [],
    });

    useFleetStore.setState({
      devices: [{ ...sample }, { ...sample, id: 'player-2', name: 'Living', fw: '4.10.0', state: 'play' }],
      discoveredAt: Date.now(),
      discoveryMethod: 'mdns',
      sync: syncWithGroup,
      health: null,
      connection: 'live',
      loading: false,
      refreshing: false,
      error: null,
      toast: null,
      volumeHoldUntil: {},
      playbackHoldUntil: {},
      muteHoldUntil: {},
      houseSession: LIVE_HOUSE_SESSION,
      globalVolumeHoldUntil: 0,
      syncHoldUntil: 0,
      fleetMuteAll: vi.fn().mockResolvedValue(undefined),
      fleetPauseAll: vi.fn().mockResolvedValue(undefined),
      fleetStopAll: vi.fn().mockResolvedValue(undefined),
      fleetRebootAll: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      reloadStatus: vi.fn().mockResolvedValue(undefined),
      holdSync: vi.fn(),
      control: vi.fn(async (_id: string, action: () => Promise<void>) => {
        await action();
      }),
      setToast: vi.fn((toast: string | null) => {
        useFleetStore.setState({ toast });
      }),
    });
  });

  it('shows the Health panel under the house remote', () => {
    useFleetStore.setState({
      health: {
        started_at: Date.now() / 1000 - 600,
        observed_at: Date.now() / 1000,
        window_seconds: 86_400,
        presence_window_seconds: 43_200,
        circuit_failure_threshold: 5,
        first_online: { 'player-1': Date.now() / 1000 - 600 },
        drops: [
          {
            device_id: 'player-1',
            name: 'Kitchen',
            started_at: Date.now() / 1000 - 180,
            ended_at: Date.now() / 1000 - 60,
            duration_seconds: 120,
            peak_failures: 3,
            slow_poll: false,
          },
        ],
      },
    });
    renderHouse();
    expect(screen.getByRole('heading', { name: 'Health' })).toBeInTheDocument();
    expect(screen.getByText(/2m · 3 fails → recovered/)).toBeInTheDocument();
  });

  it('lists each device once with status and firmware in the same row', () => {
    renderHouse();
    expect(screen.getAllByRole('heading', { name: 'Devices' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Firmware' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Rooms' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Kitchen/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Living/ })).toBeInTheDocument();
    expect(screen.getByText('online / play / vol 20 / fw 4.16.6')).toBeInTheDocument();
    expect(
      screen.getByText('online / play / vol 20 / fw 4.10.0 / behind house newest'),
    ).toBeInTheDocument();
  });

  it('runs Check all for upgrades and sets a toast', async () => {
    renderHouse();
    fireEvent.click(screen.getByRole('button', { name: 'Check all for upgrades' }));
    await waitFor(() => {
      expect(fleetUpgrades).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(useFleetStore.getState().toast).toBe('Firmware: no updates available');
    });
  });

  it('mutes and stops the fleet from the house remote', async () => {
    const state = useFleetStore.getState();
    renderHouse();

    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(state.fleetMuteAll).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByRole('button', { name: 'Pause house stream' }));
    await waitFor(() => expect(toggle).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Stop all' }));
    await waitFor(() => expect(state.fleetStopAll).toHaveBeenCalled());
  });

  it('breaks all groups after confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const holdSync = useFleetStore.getState().holdSync;
    const reloadStatus = useFleetStore.getState().reloadStatus;
    renderHouse();

    fireEvent.click(screen.getByRole('button', { name: 'Break all groups' }));
    await waitFor(() => expect(syncBreak).toHaveBeenCalled());
    expect(holdSync).toHaveBeenCalled();
    expect(reloadStatus).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('skips break when confirm is cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderHouse();
    fireEvent.click(screen.getByRole('button', { name: 'Break all groups' }));
    expect(syncBreak).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('rescans and reboots after confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const refresh = useFleetStore.getState().refresh;
    const fleetRebootAll = useFleetStore.getState().fleetRebootAll;
    renderHouse();

    fireEvent.click(screen.getByRole('button', { name: 'Rescan network' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Reboot all' }));
    await waitFor(() => expect(fleetRebootAll).toHaveBeenCalled());
    confirm.mockRestore();
  });
});
