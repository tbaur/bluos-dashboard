import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerStatus } from '@/api/types';
import { PlayerRow } from '@/components/PlayerCard';
import { useFleetStore } from '@/store/fleetStore';

const play = vi.fn().mockResolvedValue(undefined);
const pause = vi.fn().mockResolvedValue(undefined);
const stop = vi.fn().mockResolvedValue(undefined);
const skip = vi.fn().mockResolvedValue(undefined);
const back = vi.fn().mockResolvedValue(undefined);
const setVolume = vi.fn().mockResolvedValue(undefined);

vi.mock('@/api/client', () => ({
  api: {
    play: (...args: unknown[]) => play(...args),
    pause: (...args: unknown[]) => pause(...args),
    stop: (...args: unknown[]) => stop(...args),
    skip: (...args: unknown[]) => skip(...args),
    back: (...args: unknown[]) => back(...args),
    setVolume: (...args: unknown[]) => setVolume(...args),
  },
}));

const sample: PlayerStatus = {
  id: 'player-kitchen',
  ip: '192.168.1.20',
  name: 'Kitchen',
  model: 'NODE',
  brand: 'Bluesound',
  full_model: 'Bluesound NODE',
  device_class: 'streamer',
  mac: '',
  status: 'online',
  state: 'play',
  service: 'Qobuz',
  service_id: 'Qobuz',
  volume: 22,
  muted: false,
  db: '',
  fw: '',
  master: '',
  group: '',
  group_volume: null,
  slaves: [],
  sync_role: 'standalone',
  battery: null,
  track: 'Nightclubbing',
  artist: 'Iggy Pop',
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

describe('PlayerRow', () => {
  beforeEach(() => {
    play.mockClear();
    pause.mockClear();
    useFleetStore.setState({
      devices: [sample],
      sync: null,
      control: async (_id, action, optimistic) => {
        if (optimistic) {
          useFleetStore.getState().patchDevice(_id, optimistic);
        }
        await action();
      },
      toggleMute: vi.fn().mockResolvedValue(undefined),
      holdVolume: vi.fn(),
    });
  });

  it('renders now playing and pauses on click', async () => {
    render(
      <MemoryRouter>
        <PlayerRow device={sample} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Kitchen' })).toHaveAttribute(
      'href',
      '/player/player-kitchen',
    );
    expect(screen.getByText('Nightclubbing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(pause).toHaveBeenCalledWith('player-kitchen');
  });

  it('shows Follows when synced to another player', () => {
    const follower: PlayerStatus = {
      ...sample,
      id: 'player-den',
      name: 'Den',
      ip: '192.168.1.21',
      sync_role: 'synced',
      master: '192.168.1.20:11000',
      state: 'stream',
    };
    useFleetStore.setState({ devices: [sample, follower] });
    render(
      <MemoryRouter>
        <PlayerRow device={follower} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Follows Kitchen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
  });

  it('does not show Follows after the runtime group is gone', () => {
    const follower: PlayerStatus = {
      ...sample,
      id: 'player-den',
      name: 'Den',
      ip: '192.168.1.21',
      sync_role: 'synced',
      master: '192.168.1.20:11000',
      state: 'stop',
    };
    useFleetStore.setState({
      devices: [sample, follower],
      sync: { groups: [], standalone_ids: [sample.id, follower.id] },
    });
    render(
      <MemoryRouter>
        <PlayerRow device={follower} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/Follows/)).not.toBeInTheDocument();
    expect(screen.queryByText('synced')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('does not mark a NAD C658 as volume-linked with Bluesound rooms', () => {
    const c658: PlayerStatus = {
      ...sample,
      id: 'player-c658',
      name: 'NAD C658',
      model: 'C658',
      brand: 'NAD',
      full_model: 'NAD C658',
      volume: 20,
      state: 'stop',
      track: '',
      artist: '',
    };
    useFleetStore.setState({ devices: [sample, c658] });
    render(
      <MemoryRouter>
        <PlayerRow device={c658} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('link')).not.toBeInTheDocument();
  });
});
