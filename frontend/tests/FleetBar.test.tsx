import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetBar } from '@/components/GlobalVolumeControl';
import type { PlayerStatus, SyncState } from '@/api/types';
import { LIVE_HOUSE_SESSION } from '@/lib/houseSession';
import { useFleetStore } from '@/store/fleetStore';

vi.mock('@/components/VolumeNudgeButtons', () => ({
  VolumeNudgeButtons: () => null,
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
    input_type_index: '',
    consecutive_failures: 0,
    last_seen: 1,
    ...partial,
  };
}

function renderBar() {
  return render(
    <MemoryRouter>
      <FleetBar />
    </MemoryRouter>,
  );
}

describe('FleetBar house remote art', () => {
  beforeEach(() => {
    useFleetStore.setState({
      devices: [],
      sync: null,
      houseSession: LIVE_HOUSE_SESSION,
      fleetMuteAll: vi.fn(),
      fleetPauseAll: vi.fn(),
      fleetStopAll: vi.fn(),
      setFleetVolume: vi.fn().mockResolvedValue(undefined),
      holdVolumes: vi.fn(),
    });
  });

  it('shows artwork when one house stream is dominant', () => {
    const sync: SyncState = {
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
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Hallway Speakers',
          state: 'play',
          service: 'AirPlay',
          sync_role: 'primary',
          track: 'Track',
          artist: 'Artist',
          image: 'http://10.0.0.1/cover.jpg',
        }),
        player({
          id: '2',
          name: 'Kitchen Speakers',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.1:11000',
          track: 'Track',
          artist: 'Artist',
        }),
      ],
      sync,
    });

    renderBar();
    const art = screen.getByRole('link', {
      name: /Now playing artwork — open Track/,
    });
    expect(art).toHaveAttribute('href', '/player/1');
    expect(art.querySelector('img')).toHaveAttribute('src', 'http://10.0.0.1/cover.jpg');
    expect(screen.getByText('Track — Artist')).toBeInTheDocument();
    expect(screen.getByText('AirPlay')).toBeInTheDocument();
    expect(screen.queryByText(/Open house/)).not.toBeInTheDocument();
  });

  it('shows stream format and bitrate under the track when available', () => {
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Kitchen',
          state: 'play',
          service: 'TIDAL connect',
          track: 'Sapana',
          artist: 'Artist',
          quality: 'cd',
          stream_format: 'FLAC',
          image: 'http://10.0.0.1/cover.jpg',
        }),
      ],
      sync: null,
    });

    renderBar();
    expect(screen.getByText('Sapana — Artist')).toBeInTheDocument();
    expect(screen.getByText('TIDAL connect / FLAC / CD')).toBeInTheDocument();
  });

  it('shows track/service for parallel same-stream endpoints without room counts', () => {
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Front Bedroom Speakers',
          state: 'play',
          service: 'AirPlay',
          track: 'Joni',
          artist: 'Moomin',
          image: 'http://10.0.0.1/cover.jpg',
        }),
        player({
          id: '2',
          name: 'Hallway Speakers',
          state: 'stream',
          service: 'AirPlay',
          track: 'Joni',
          artist: 'Moomin',
        }),
      ],
      sync: null,
    });

    renderBar();
    expect(screen.getByText('Joni — Moomin')).toBeInTheDocument();
    expect(screen.getByText('AirPlay')).toBeInTheDocument();
    expect(screen.getByText('2 playing')).toBeInTheDocument();
    expect(screen.queryByText(/rooms/)).not.toBeInTheDocument();
    const art = screen.getByRole('link', {
      name: /Now playing artwork — open Joni/,
    });
    expect(art).toHaveAttribute('href', '/player/1');
  });

  it('hides a single house stream when multiple sources are playing, and lets you pick one', () => {
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          track: 'Party',
          artist: 'A',
          image: 'http://art/party.jpg',
        }),
        player({
          id: '2',
          name: 'Bedroom',
          state: 'play',
          track: 'Quiet',
          artist: 'B',
          image: 'http://art/quiet.jpg',
        }),
      ],
      sync: null,
    });

    renderBar();
    expect(screen.getByRole('tablist', { name: 'House sources' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Quiet/ })).toHaveAttribute('aria-selected', 'true');
    const quietArt = screen.getByRole('link', { name: /Now playing artwork — open Quiet/ });
    expect(quietArt.querySelector('img')).toHaveAttribute('src', 'http://art/quiet.jpg');
    fireEvent.click(screen.getByRole('tab', { name: /Party/ }));
    expect(screen.getByRole('tab', { name: /Party/ })).toHaveAttribute('aria-selected', 'true');
    const partyArt = screen.getByRole('link', { name: /Now playing artwork — open Party/ });
    expect(partyArt.querySelector('img')).toHaveAttribute('src', 'http://art/party.jpg');
  });

  it('puts the house remote left of volume', () => {
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Kitchen',
          state: 'play',
          volume: 26,
          track: 'Joni',
        }),
        player({
          id: '2',
          name: 'Patio',
          model: 'CI S2',
          brand: 'NAD',
          full_model: 'NAD CI S2',
          volume: 60,
        }),
      ],
      sync: null,
    });

    const { container } = renderBar();
    const bar = container.querySelector('.fleet-bar');
    expect(bar?.firstElementChild).toHaveClass('house-remote');
    expect(bar?.lastElementChild).toHaveClass('fleet-bar-rail');
    expect(screen.getByRole('heading', { name: 'Bluesound' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'NAD CI S2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'House' })).toBeInTheDocument();
  });

  it('sets Bluesound volume from house level chips', async () => {
    const setFleetVolume = vi.fn().mockResolvedValue(undefined);
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Kitchen',
          volume: 20,
        }),
        player({
          id: '2',
          name: 'Patio',
          model: 'CI S2',
          brand: 'NAD',
          full_model: 'NAD CI S2',
          volume: 60,
        }),
      ],
      sync: null,
      setFleetVolume,
    });

    renderBar();
    expect(screen.getByRole('group', { name: 'Bluesound levels' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set Bluesound volume to 20' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Set Bluesound volume to 48' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set Bluesound volume to 60' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set Bluesound volume to 48' }));
    await waitFor(() => expect(setFleetVolume).toHaveBeenCalledWith(48, ['1']));
  });

  it('sets NAD CI S2 volume from level chips', async () => {
    const setFleetVolume = vi.fn().mockResolvedValue(undefined);
    useFleetStore.setState({
      devices: [
        player({
          id: '1',
          name: 'Kitchen',
          volume: 26,
        }),
        player({
          id: '2',
          name: 'Patio',
          model: 'CI S2',
          brand: 'NAD',
          full_model: 'NAD CI S2',
          volume: 60,
        }),
      ],
      sync: null,
      setFleetVolume,
    });

    renderBar();
    expect(screen.getByRole('group', { name: 'NAD CI S2 levels' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Bluesound levels' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set NAD CI S2 volume to 60' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set NAD CI S2 volume to 42' }));
    await waitFor(() => expect(setFleetVolume).toHaveBeenCalledWith(42, ['2']));
  });

  it('keeps NAD C658 off house sliders and out of Bluesound writes', async () => {
    const setFleetVolume = vi.fn().mockResolvedValue(undefined);
    useFleetStore.setState({
      devices: [
        player({ id: '1', name: 'Patio Speakers', volume: 26 }),
        player({
          id: '2',
          name: 'NAD C658',
          model: 'C658',
          brand: 'NAD',
          full_model: 'NAD C658',
          volume: 56,
        }),
        player({
          id: '3',
          name: 'Kitchen',
          model: 'CI S2',
          brand: 'NAD',
          full_model: 'NAD CI S2',
          volume: 60,
        }),
      ],
      sync: null,
      setFleetVolume,
    });

    renderBar();
    expect(screen.getByRole('heading', { name: 'Bluesound' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'NAD CI S2' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'NAD C658' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Set volume on Bluesound players'), {
      target: { value: '20' },
    });
    await waitFor(() => expect(setFleetVolume).toHaveBeenCalledWith(20, ['1']));
  });
});
