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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const speakers = screen.getByRole('button', { name: '2 speakers' });
    fireEvent.mouseEnter(speakers);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(speakers);
    const dialog = screen.getByRole('dialog', { name: 'In this group' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Hallway')).toBeInTheDocument();
    expect(screen.getByText('Kitchen')).toBeInTheDocument();
    expect(screen.getByText('Lead')).toBeInTheDocument();
    expect(dialog.querySelector('.house-roster-role')).toHaveTextContent('Lead');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause house stream' }));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith('1'));

    fireEvent.click(screen.getByRole('button', { name: 'Next track' }));
    await waitFor(() => expect(skip).toHaveBeenCalledWith('1'));
    expect(skip).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Shuffle off' }));
    await waitFor(() => expect(setShuffle).toHaveBeenCalledWith('1', 1));
  });

  it('pauses synced followers and leaves a direct player playing', async () => {
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          sync_role: 'primary',
          track: 'Joni',
          artist: 'Moomin',
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.1:11000',
          track: 'Joni',
          artist: 'Moomin',
        }),
        player({
          id: '3',
          name: 'Patio',
          state: 'play',
          sync_role: 'standalone',
          track: 'Joni',
          artist: 'Moomin',
        }),
      ],
      sync: {
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
        standalone_ids: ['3'],
      },
    });
    renderRemote();
    fireEvent.click(screen.getByRole('button', { name: 'Pause house stream' }));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith('1'));
    expect(toggle).toHaveBeenCalledTimes(1);
    const states = Object.fromEntries(
      useFleetStore.getState().devices.map((device) => [device.id, device.state]),
    );
    expect(states).toEqual({ '1': 'pause', '2': 'pause', '3': 'play' });
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

  it('keeps the hero on the new title when skip splits a merged house stream', async () => {
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

    const speakers = screen.queryByRole('button', { name: '2 speakers' });
    if (speakers) fireEvent.click(speakers);
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

  it('keeps direct players on the house stream when only part of it is synced', () => {
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Front Bedroom',
          state: 'play',
          sync_role: 'primary',
          track: 'Joni',
          artist: 'Moomin',
          volume: 40,
        }),
        player({
          id: '2',
          name: 'Hallway',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.1:11000',
          track: 'Joni',
          artist: 'Moomin',
          volume: 40,
        }),
        ...['Kitchen', 'Living Room', 'Office', 'Patio', 'Den'].map((name, index) =>
          player({
            id: String(index + 3),
            name,
            state: 'play',
            sync_role: 'standalone',
            track: 'Joni',
            artist: 'Moomin',
            volume: 18,
          }),
        ),
      ],
      sync: {
        groups: [
          {
            primary_id: '1',
            primary_name: 'Front Bedroom',
            primary_ip: '10.0.0.1',
            group: '',
            slave_ids: ['2'],
            slave_names: ['Hallway'],
          },
        ],
        standalone_ids: ['3', '4', '5', '6', '7'],
      },
    });
    renderRemote();
    expect(screen.queryByRole('region', { name: 'Also playing' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '7 speakers' }));
    expect(screen.getByText('On this stream')).toBeInTheDocument();
    expect(screen.queryByText('In this group')).not.toBeInTheDocument();
    expect(screen.getAllByText('Direct')).toHaveLength(5);
  });

  it('does not call players on the same audio a group', () => {
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          track: 'Joni',
          artist: 'Moomin',
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'play',
          track: 'Joni',
          artist: 'Moomin',
        }),
      ],
      sync: { groups: [], standalone_ids: ['1', '2'] },
    });
    renderRemote();
    fireEvent.click(screen.getByRole('button', { name: '2 speakers' }));
    expect(screen.getByText('On this stream')).toBeInTheDocument();
    expect(screen.getAllByText('Direct')).toHaveLength(2);
    expect(screen.queryByText('In this group')).not.toBeInTheDocument();
  });

  it('lists every speaker in the dialog when the stream is long', () => {
    const names = Array.from({ length: 20 }, (_, index) => `Room ${index + 1}`);
    useFleetStore.setState({
      devices: names.map((name, index) =>
        player({
          id: String(index + 1),
          name,
          state: 'play',
          track: 'Shared',
          artist: 'Artist',
        }),
      ),
      sync: { groups: [], standalone_ids: names.map((_, index) => String(index + 1)) },
    });
    renderRemote();
    fireEvent.click(screen.getByRole('button', { name: '20 speakers' }));
    const dialog = screen.getByRole('dialog', { name: 'On this stream' });
    expect(dialog.querySelectorAll('.house-roster li')).toHaveLength(20);
    expect(screen.getByText('Room 20')).toBeInTheDocument();
  });

  it('shows three other streams and can focus the rest', () => {
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
    useFleetStore.setState({
      devices: names.map((name, index) =>
        player({
          id: String(index + 1),
          name,
          state: 'play',
          track: name,
          artist: 'Artist',
          image: `http://art/${name}.jpg`,
        }),
      ),
      sync: { groups: [], standalone_ids: names.map((_, index) => String(index + 1)) },
    });
    renderRemote();
    expect(screen.getByRole('region', { name: 'Also playing' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Artist/ })).toHaveLength(3);
    expect(screen.queryByRole('link', { name: /more/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2 more streams' }));
    fireEvent.click(screen.getByRole('button', { name: 'Echo — Artist' }));
    expect(screen.getByRole('button', { name: 'Pause house stream' })).toHaveFocus();
    expect(screen.getByText('Echo — Artist')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2 more streams' }));
    fireEvent.click(screen.getByRole('button', { name: 'Foxtrot — Artist' }));
    expect(screen.getByText('Foxtrot — Artist')).toBeInTheDocument();
  });

  it('stays on the stream you chose after that song changes', async () => {
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          track: 'House',
          artist: 'Artist',
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'play',
          track: 'Other',
          artist: 'Artist',
        }),
      ],
      sync: { groups: [], standalone_ids: ['1', '2'] },
    });
    renderRemote();
    expect(screen.getByText('House — Artist')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Other — Artist/ }));
    expect(screen.getByText('Other — Artist')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next track' }));
    await waitFor(() => expect(skip).toHaveBeenCalledWith('2'));
    act(() => {
      useFleetStore.setState({
        devices: [
          player({ id: '1', name: 'Hallway', state: 'play', track: 'House', artist: 'Artist' }),
          player({ id: '2', name: 'Kitchen', state: 'play', track: 'Next', artist: 'Artist' }),
        ],
      });
    });
    expect(document.querySelector('.house-remote-primary')).toHaveTextContent('Next — Artist');
    expect(screen.getByRole('button', { name: /House — Artist/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /House — Artist/ }));
    act(() => {
      useFleetStore.setState({
        devices: [
          player({ id: '1', name: 'Hallway', state: 'play', track: 'Later', artist: 'Artist' }),
          player({ id: '2', name: 'Kitchen', state: 'play', track: 'Next', artist: 'Artist' }),
        ],
      });
    });
    expect(document.querySelector('.house-remote-primary')).toHaveTextContent('Later — Artist');
    expect(screen.getByRole('button', { name: /Next — Artist/ })).toBeInTheDocument();
  });

  it('cycles repeat off → all → one', async () => {
    renderRemote();
    fireEvent.click(screen.getByRole('button', { name: 'Repeat off' }));
    await waitFor(() => expect(setRepeat).toHaveBeenCalledWith('1', 1));
    fireEvent.click(screen.getByRole('button', { name: 'Repeat all' }));
    await waitFor(() => expect(setRepeat).toHaveBeenCalledWith('1', 2));
  });
});
