import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncPanel } from '@/components/SyncPanel';
import type { PlayerStatus, SyncState } from '@/api/types';
import { useFleetStore } from '@/store/fleetStore';

const syncEnable = vi.fn();
const syncAdd = vi.fn();
const syncBreak = vi.fn();
const syncRemove = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    syncEnable: (...args: unknown[]) => syncEnable(...args),
    syncAdd: (...args: unknown[]) => syncAdd(...args),
    syncBreak: (...args: unknown[]) => syncBreak(...args),
    syncRemove: (...args: unknown[]) => syncRemove(...args),
  },
}));

function player(
  partial: Partial<PlayerStatus> & Pick<PlayerStatus, 'id' | 'name'>,
): PlayerStatus {
  return {
    ip: partial.ip ?? `10.0.0.${partial.id.length}`,
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

describe('SyncPanel', () => {
  beforeEach(() => {
    syncEnable.mockReset();
    syncAdd.mockReset();
    syncBreak.mockReset();
    syncRemove.mockReset();
    syncEnable.mockResolvedValue({
      action: 'sync_enable',
      primary_id: 'a',
      succeeded: 1,
      failed: 0,
      results: [],
    });
    syncAdd.mockResolvedValue(undefined);
    syncBreak.mockResolvedValue({
      action: 'sync_break',
      succeeded: 1,
      failed: 0,
      results: [],
    });
    syncRemove.mockResolvedValue(undefined);

    const devices = [
      player({ id: 'a', name: 'Alpha', ip: '10.0.0.1' }),
      player({ id: 'b', name: 'Bravo', ip: '10.0.0.2' }),
      player({ id: 'c', name: 'Charlie', ip: '10.0.0.3' }),
    ];
    const sync: SyncState = { groups: [], standalone_ids: ['a', 'b', 'c'] };

    useFleetStore.setState({
      devices,
      sync,
      control: vi.fn(async (_id, action) => {
        await action();
      }),
      reloadStatus: vi.fn(async () => undefined),
      setSync: vi.fn(),
      patchDevice: vi.fn(),
      holdSync: vi.fn(),
      setToast: vi.fn(),
      toast: null,
    });
  });

  it('renders multi-room heading when two or more players exist', () => {
    render(<SyncPanel />);
    expect(screen.getByRole('heading', { name: 'Multi-room groups' })).toBeInTheDocument();
  });

  it('groups all free rooms under the selected lead', async () => {
    render(<SyncPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Group all free rooms' }));
    await waitFor(() => {
      expect(syncEnable).toHaveBeenCalledWith('a');
    });
  });

  it('toasts when syncEnable reports partial failure', async () => {
    syncEnable.mockResolvedValue({
      action: 'sync_enable',
      primary_id: 'a',
      succeeded: 1,
      failed: 1,
      results: [],
    });
    const setToast = vi.fn();
    useFleetStore.setState({ setToast });

    render(<SyncPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Group all free rooms' }));
    await waitFor(() => {
      expect(setToast).toHaveBeenCalledWith('Grouped 1 free room; 1 failed');
    });
  });

  it('hides Add rooms for offline primary orphan groups', () => {
    useFleetStore.setState({
      devices: [
        player({
          id: 'orphan',
          name: 'Orphan',
          ip: '10.0.0.9',
          sync_role: 'synced',
          master: '10.0.0.8:11000',
        }),
        player({ id: 'free', name: 'Free', ip: '10.0.0.7' }),
      ],
      sync: {
        groups: [
          {
            primary_id: 'orphan-dead',
            primary_name: 'Offline primary',
            primary_ip: '10.0.0.8',
            primary_endpoint: '10.0.0.8:11000',
            group: '',
            slave_ids: ['orphan'],
            slave_names: ['Orphan'],
          },
        ],
        standalone_ids: ['free'],
      },
    });

    render(<SyncPanel />);
    expect(screen.queryByRole('button', { name: /Add rooms/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ungroup all' })).toBeInTheDocument();
  });

  it('links a follower from the builder and waits for BluOS to show it', async () => {
    render(<SyncPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Bravo' }));

    const state = useFleetStore.getState();
    await waitFor(() => expect(syncAdd).toHaveBeenCalledWith('a', 'b'));
    await waitFor(() =>
      expect(state.reloadStatus).toHaveBeenCalledWith({
        ensureLink: { primaryId: 'a', slaveId: 'b' },
      }),
    );
    expect(state.setSync).toHaveBeenCalledWith({
      groups: [expect.objectContaining({ primary_id: 'a', slave_ids: ['b'] })],
      standalone_ids: ['c'],
    });
    expect(state.patchDevice).toHaveBeenCalledWith('b', {
      sync_role: 'synced',
      master: '10.0.0.1:11000',
    });
    expect(state.holdSync).toHaveBeenCalled();
  });

  describe('with a group', () => {
    beforeEach(() => {
      useFleetStore.setState({
        sync: {
          groups: [
            {
              primary_id: 'a',
              primary_name: 'Alpha',
              primary_ip: '10.0.0.1',
              primary_endpoint: '10.0.0.1:11000',
              group: '',
              slave_ids: ['b', 'c'],
              slave_names: ['Bravo', 'Charlie'],
            },
          ],
          standalone_ids: [],
        },
      });
    });

    it('removes one follower and keeps the rest of the group', async () => {
      render(<SyncPanel />);
      fireEvent.click(screen.getByTitle('Remove Bravo'));
      await waitFor(() => expect(syncRemove).toHaveBeenCalledWith('a', 'b'));
      expect(useFleetStore.getState().setSync).toHaveBeenCalledWith({
        groups: [expect.objectContaining({ slave_ids: ['c'], slave_names: ['Charlie'] })],
        standalone_ids: ['b'],
      });
    });

    it('ungroups every follower of one group', async () => {
      render(<SyncPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }));
      await waitFor(() => expect(syncRemove).toHaveBeenCalledTimes(2));
      expect(useFleetStore.getState().setSync).toHaveBeenCalledWith({
        groups: [],
        standalone_ids: ['a', 'b', 'c'],
      });
    });

    it('ungroups everything after confirming and reports partial failure', async () => {
      syncBreak.mockResolvedValue({ action: 'sync_break', succeeded: 1, failed: 1, results: [] });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
      render(<SyncPanel />);

      fireEvent.click(screen.getByRole('button', { name: 'Ungroup all' }));
      expect(syncBreak).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Ungroup all' }));
      await waitFor(() =>
        expect(useFleetStore.getState().setToast).toHaveBeenCalledWith('Ungrouped 1; 1 failed'),
      );
      confirm.mockRestore();
    });
  });
});
