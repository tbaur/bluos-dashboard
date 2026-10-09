import { useState } from 'react';
import { api } from '@/api/client';
import type { SyncGroup } from '@/api/types';
import { deviceEndpoint } from '@/lib/endpoint';
import { syncStateFor, withFollower, withoutFollowers } from '@/lib/syncGroups';
import { GROUP_CHANGE_SYNC_HOLD_MS, useFleetStore } from '@/store/fleetStore';

/** Grouping every free room settles more slowly than a single link. */
const GROUP_ALL_SYNC_HOLD_MS = 8000;

/** Paint `primaryId` leading `slaveId` before BluOS reports it. */
function paintLink(primaryId: string, slaveId: string): void {
  const state = useFleetStore.getState();
  const lead = state.devices.find((d) => d.id === primaryId);
  const follower = state.devices.find((d) => d.id === slaveId);
  if (!lead || !follower) return;
  const groups = withFollower(state.sync?.groups ?? [], lead, follower);
  state.setSync(syncStateFor(groups, state.devices));
  state.holdSync(GROUP_CHANGE_SYNC_HOLD_MS);
  state.patchDevice(primaryId, {
    sync_role: 'primary',
    slaves: Array.from(new Set([...(lead.slaves ?? []), deviceEndpoint(follower)])),
  });
  state.patchDevice(slaveId, { sync_role: 'synced', master: deviceEndpoint(lead) });
}

function paintUnlink(primaryId: string, slaveIds: readonly string[]): void {
  const state = useFleetStore.getState();
  const groups = withoutFollowers(state.sync?.groups ?? [], primaryId, slaveIds);
  state.setSync(syncStateFor(groups, state.devices));
  state.holdSync(GROUP_CHANGE_SYNC_HOLD_MS);
}

function toastFailures(failed: number, message: string): void {
  if (failed > 0) useFleetStore.getState().setToast(message);
}

/**
 * Group and ungroup commands for the Sync panel. Each one paints the change
 * at once and holds sync so a late /SyncStatus does not undo the paint.
 * `busy` is true while any command runs.
 */
export function useSyncActions() {
  const control = useFleetStore((s) => s.control);
  const reloadStatus = useFleetStore((s) => s.reloadStatus);
  const [busy, setBusy] = useState(false);

  const run = async (deviceId: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await control(deviceId, action);
    } finally {
      setBusy(false);
    }
  };

  /** `onLinked` runs once the link is painted, before BluOS confirms it. */
  const addFollower = (primaryId: string, slaveId: string, onLinked?: () => void) =>
    run(primaryId, async () => {
      await api.syncAdd(primaryId, slaveId);
      paintLink(primaryId, slaveId);
      onLinked?.();
      // Wait until BluOS reflects the link — never replace optimistic sync with empty.
      await reloadStatus({ ensureLink: { primaryId, slaveId } });
    });

  const removeFollower = (primaryId: string, slaveId: string) =>
    run(primaryId, async () => {
      await api.syncRemove(primaryId, slaveId);
      paintUnlink(primaryId, [slaveId]);
      await reloadStatus();
    });

  const ungroup = (group: SyncGroup) =>
    run(group.primary_id, async () => {
      for (const slaveId of group.slave_ids) {
        await api.syncRemove(group.primary_id, slaveId);
      }
      paintUnlink(group.primary_id, group.slave_ids);
      await reloadStatus();
    });

  const ungroupAll = (anyPrimaryId: string) =>
    run(anyPrimaryId, async () => {
      const result = await api.syncBreak();
      const state = useFleetStore.getState();
      state.setSync(syncStateFor([], state.devices));
      state.holdSync(GROUP_CHANGE_SYNC_HOLD_MS);
      await reloadStatus();
      toastFailures(result.failed, `Ungrouped ${result.succeeded}; ${result.failed} failed`);
    });

  /** `onGrouped` runs after the reload, before any partial-failure toast. */
  const groupAllUnder = (primaryId: string, onGrouped: () => void) =>
    run(primaryId, async () => {
      useFleetStore.getState().holdSync(GROUP_ALL_SYNC_HOLD_MS);
      const result = await api.syncEnable(primaryId);
      await reloadStatus();
      onGrouped();
      const rooms = `${result.succeeded} free room${result.succeeded === 1 ? '' : 's'}`;
      toastFailures(result.failed, `Grouped ${rooms}; ${result.failed} failed`);
    });

  return { busy, addFollower, removeFollower, ungroup, ungroupAll, groupAllUnder };
}
