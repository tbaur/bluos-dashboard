import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HouseRemote } from '@/components/HouseRemote';
import type { PlayerStatus, SyncState } from '@/api/types';
import { houseStoppedSession, LIVE_HOUSE_SESSION } from '@/lib/houseSession';
import { useFleetStore } from '@/store/fleetStore';

const toggle = vi.fn();
const skip = vi.fn();
const back = vi.fn();
const seek = vi.fn();
const setShuffle = vi.fn();
const setRepeat = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    toggle: (...args: unknown[]) => toggle(...args),
    skip: (...args: unknown[]) => skip(...args),
    back: (...args: unknown[]) => back(...args),
    seek: (...args: unknown[]) => seek(...args),
    setShuffle: (...args: unknown[]) => setShuffle(...args),
    setRepeat: (...args: unknown[]) => setRepeat(...args),
  },
}));

function player(
  partial: Partial<PlayerStatus> & Pick<PlayerStatus, 'id' | 'name'>,
): PlayerStatus {
  return {
    ip: partial.ip ?? `10.0.0.${partial.id}`,
    model: 'NODE',
    brand: 'Bluesound',
    full_model: 'Bluesound NODE',
    device_class: 'streamer',
    mac: '',
    status: 'online',
    state: 'stop',
    service: '',
    service_id: '',
    volume: 20,
    muted: false,
    db: '',
    fw: '',
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
    shuffle: 0,
    repeat: 0,
    input_type_index: '',
    consecutive_failures: 0,
    last_seen: 1,
    ...partial,
  };
}

const grouped: SyncState = {
  groups: [
    {
      primary_id: '1',
      primary_name: 'Hallway',
      primary_ip: '10.0.0.1',
      group: '',
      slave_ids: ['2'],
      slave_names: ['Kitchen'],
    },
  ],
  standalone_ids: [],
};

function renderRemote() {
  return render(
    <MemoryRouter>
      <HouseRemote />
    </MemoryRouter>,
  );
}

describe('HouseRemote', () => {
  beforeEach(() => {
    toggle.mockReset().mockResolvedValue(undefined);
    skip.mockReset().mockResolvedValue(undefined);
    back.mockReset().mockResolvedValue(undefined);
    seek.mockReset().mockResolvedValue(undefined);
    setShuffle.mockReset().mockResolvedValue(undefined);
    setRepeat.mockReset().mockResolvedValue(undefined);

    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          service: 'TIDAL connect',
          sync_role: 'primary',
          track: 'Sapana',
          artist: 'Artist',
          album: 'Night',
          image: 'http://10.0.0.1/cover.jpg',
          secs: 30,
          totlen: 240,
          can_seek: true,
          shuffle: 0,
          repeat: 0,
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.1:11000',
          track: 'Sapana',
          artist: 'Artist',
        }),
      ],
      sync: grouped,
      playbackHoldUntil: {},
      muteHoldUntil: {},
      houseSession: LIVE_HOUSE_SESSION,
      fleetMuteAll: vi.fn().mockResolvedValue(undefined),
      fleetPauseAll: vi.fn().mockResolvedValue(undefined),
      fleetStopAll: vi.fn().mockResolvedValue(undefined),
      control: vi.fn(async (id: string, action: () => Promise<void>, optimistic?: Partial<PlayerStatus>) => {
        if (optimistic) useFleetStore.getState().patchDevice(id, optimistic);
        await action();
      }),
    });
    useFleetStore.getState().beginHouseCatchup([]);
  });

  it('drives skip, pause, and shuffle on the sync primary', async () => {
    renderRemote();
    expect(screen.getByText('Sapana — Artist')).toBeInTheDocument();
    expect(screen.getByText('Night')).toBeInTheDocument();
    expect(screen.getByText('Hallway')).toBeInTheDocument();
    expect(screen.getByText('Kitchen')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause house stream' }));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith('1'));

    fireEvent.click(screen.getByRole('button', { name: 'Next track' }));
    await waitFor(() => expect(skip).toHaveBeenCalledWith('1'));
    expect(skip).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Shuffle off' }));
    await waitFor(() => expect(setShuffle).toHaveBeenCalledWith('1', 1));
  });

  it('does not dim transport while skip is in flight', async () => {
    let release!: () => void;
    skip.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderRemote();
    fireEvent.click(screen.getByRole('button', { name: 'Next track' }));
    expect(screen.getByRole('button', { name: 'Pause house stream' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next track' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mute' })).toBeEnabled();
    release();
    await waitFor(() => expect(skip).toHaveBeenCalledWith('1'));
  });

  it('seeks the house stream', async () => {
    renderRemote();
    const slider = screen.getByRole('slider', { name: 'Seek' });
    fireEvent.change(slider, { target: { value: '90' } });
    await waitFor(() => expect(seek).toHaveBeenCalledWith('1', 90));
  });

  it('skips from the keyboard without stealing input', async () => {
    renderRemote();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(skip).toHaveBeenCalledWith('1'));

    const field = document.createElement('input');
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: 'ArrowRight' });
    expect(skip).toHaveBeenCalledTimes(1);
    field.remove();
  });

  it('does not flash source tabs when skip splits a merged house stream', async () => {
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          track: 'Sapana',
          artist: 'Artist',
          album: 'Night',
          image: 'http://art/a.jpg',
          secs: 30,
          totlen: 240,
          can_seek: true,
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'play',
          track: 'Sapana',
          artist: 'Artist',
        }),
      ],
      sync: { groups: [], standalone_ids: ['1', '2'] },
      playbackHoldUntil: {},
    });
    renderRemote();
    fireEvent.click(screen.getByRole('button', { name: 'Next track' }));
    await waitFor(() => expect(skip).toHaveBeenCalledWith('1'));
    expect(skip).toHaveBeenCalledTimes(1);
    act(() => {
      useFleetStore.setState({
        devices: [
          player({
            id: '1',
            name: 'Hallway',
            state: 'play',
            track: 'Next',
            artist: 'B',
            album: 'Night',
            image: 'http://art/b.jpg',
            secs: 1,
            totlen: 180,
            can_seek: true,
          }),
          player({
            id: '2',
            name: 'Kitchen',
            state: 'play',
            track: 'Sapana',
            artist: 'Artist',
          }),
        ],
        playbackHoldUntil: {},
      });
    });

    expect(screen.getByText('Hallway')).toBeInTheDocument();
    expect(screen.getByText('Kitchen')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'House sources' })).not.toBeInTheDocument();
    expect(screen.getByText('Next — B')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause all' })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeInTheDocument();
  });

  it('goes idle after stop even if AirPlay rooms report connecting', () => {
    useFleetStore.setState({
      houseSession: houseStoppedSession(),
      devices: [
        player({
          id: '1',
          name: 'Hallway',
          state: 'connecting',
          track: 'Sapana',
          artist: 'Artist',
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'connecting',
          track: 'Sapana',
          artist: 'Artist',
        }),
      ],
      sync: { groups: [], standalone_ids: ['1', '2'] },
    });
    renderRemote();
    expect(screen.getByText('All quiet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause house stream' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'House sources' })).not.toBeInTheDocument();
    const actions = screen.getByRole('group', { name: 'House transport' });
    expect(actions.closest('.house-remote-foot')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Mute' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop all' })).toBeInTheDocument();
  });

  it('cycles repeat off → all → one', async () => {
    renderRemote();
    fireEvent.click(screen.getByRole('button', { name: 'Repeat off' }));
    await waitFor(() => expect(setRepeat).toHaveBeenCalledWith('1', 1));
    fireEvent.click(screen.getByRole('button', { name: 'Repeat all' }));
    await waitFor(() => expect(setRepeat).toHaveBeenCalledWith('1', 2));
  });
});
