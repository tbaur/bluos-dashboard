import { useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { PlayerStatus, SyncGroup, SyncState } from '@/api/types';
import { deviceEndpoint } from '@/lib/endpoint';
import { useFleetStore } from '@/store/fleetStore';

function isOnlinePrimary(primaryId: string, byId: Record<string, PlayerStatus>): boolean {
  return Boolean(byId[primaryId]);
}

function occupiedRoomIds(groups: SyncGroup[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    ids.add(group.primary_id);
    for (const slaveId of group.slave_ids) ids.add(slaveId);
  }
  return ids;
}

/** Rooms not already in any multi-room set (prefer API standalone_ids). */
function freeRoomsFrom(
  devices: PlayerStatus[],
  sync: SyncState | null,
  groups: SyncGroup[],
): PlayerStatus[] {
  const occupied = occupiedRoomIds(groups);
  const standaloneIds = new Set(sync?.standalone_ids ?? []);
  return devices
    .filter((d) => {
      if (occupied.has(d.id)) return false;
      if (standaloneIds.size > 0) return standaloneIds.has(d.id);
      return d.sync_role === 'standalone';
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

function availableFollowers(
  devices: PlayerStatus[],
  sync: SyncState | null,
  groups: SyncGroup[],
  primaryId: string,
): PlayerStatus[] {
  return freeRoomsFrom(devices, sync, groups)
    .filter((d) => d.id !== primaryId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function roomCountLabel(n: number): string {
  return n === 1 ? '1 room' : `${n} rooms`;
}

/**
 * Multi-room sync: one card per linked set of rooms.
 * Lead room is first; followers can be removed with ×.
 * Header stays calm — secondary actions live in the footer.
 */
export function SyncPanel() {
  const sync = useFleetStore((s) => s.sync);
  const devices = useFleetStore((s) => s.devices);
  const control = useFleetStore((s) => s.control);
  const reloadStatus = useFleetStore((s) => s.reloadStatus);
  const setSync = useFleetStore((s) => s.setSync);
  const patchDevice = useFleetStore((s) => s.patchDevice);
  const holdSync = useFleetStore((s) => s.holdSync);

  const [busy, setBusy] = useState(false);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [leadId, setLeadId] = useState('');
  const [creating, setCreating] = useState(false);

  const groups = useMemo(() => sync?.groups ?? [], [sync?.groups]);
  const byId = useMemo(
    () => Object.fromEntries(devices.map((d) => [d.id, d])),
    [devices],
  );

  const freeRooms = useMemo(
    () => freeRoomsFrom(devices, sync, groups),
    [devices, sync, groups],
  );

  // If SSE/optimistic sync occupies the chosen lead, treat builder as reset (no effect).
  const leadBlocked = Boolean(leadId && occupiedRoomIds(groups).has(leadId));
  const activeCreating = creating && !leadBlocked;
  const activeLeadId = leadBlocked ? '' : leadId;

  const createFollowers = useMemo(
    () => availableFollowers(devices, sync, groups, activeLeadId),
    [devices, sync, groups, activeLeadId],
  );

  if (devices.length < 2) return null;

  const canStartGroup = freeRooms.length >= 2;
  const showBuilder = canStartGroup && (groups.length === 0 || activeCreating);
  const canStartSeparate = canStartGroup && groups.length > 0 && !showBuilder;
  const canUngroupAll = groups.length >= 1;

  const run = async (deviceId: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await control(deviceId, action);
    } finally {
      setBusy(false);
    }
  };

  const closeBuilder = () => {
    setCreating(false);
    setLeadId('');
  };

  const openBuilder = () => {
    setCreating(true);
    setLeadId('');
    setAddingTo(null);
  };

  const applyOptimisticLink = (primaryId: string, slaveId: string) => {
    const state = useFleetStore.getState();
    const lead = state.devices.find((d) => d.id === primaryId);
    const follower = state.devices.find((d) => d.id === slaveId);
    if (!lead || !follower) return;

    const currentGroups = state.sync?.groups ?? [];
    const nextGroups = currentGroups.map((g) => ({
      ...g,
      slave_ids: [...g.slave_ids],
      slave_names: [...g.slave_names],
    }));
    const existing = nextGroups.find((g) => g.primary_id === primaryId);
    if (existing) {
      if (!existing.slave_ids.includes(slaveId)) {
        existing.slave_ids.push(slaveId);
        existing.slave_names.push(follower.name);
      }
    } else {
      nextGroups.push({
        primary_id: primaryId,
        primary_name: lead.name,
        primary_ip: lead.ip,
        primary_endpoint: deviceEndpoint(lead),
        group: lead.group || '',
        slave_ids: [slaveId],
        slave_names: [follower.name],
      });
    }

    const occupied = occupiedRoomIds(nextGroups);
    setSync({
      groups: nextGroups,
      standalone_ids: state.devices.map((d) => d.id).filter((id) => !occupied.has(id)),
    });
    holdSync(6000);
    patchDevice(primaryId, {
      sync_role: 'primary',
      slaves: Array.from(new Set([...(lead.slaves ?? []), deviceEndpoint(follower)])),
    });
    patchDevice(slaveId, {
      sync_role: 'synced',
      master: deviceEndpoint(lead),
    });
  };

  const applyOptimisticUnlink = (primaryId: string, slaveIds: string[]) => {
    const state = useFleetStore.getState();
    const remove = new Set(slaveIds);
    const nextGroups = (state.sync?.groups ?? [])
      .map((g) => {
        if (g.primary_id !== primaryId) return g;
        const keep = g.slave_ids
          .map((id, index) => ({ id, name: g.slave_names[index] ?? id }))
          .filter((member) => !remove.has(member.id));
        return {
          ...g,
          slave_ids: keep.map((member) => member.id),
          slave_names: keep.map((member) => member.name),
        };
      })
      .filter((g) => g.slave_ids.length > 0);
    const occupied = occupiedRoomIds(nextGroups);
    setSync({
      groups: nextGroups,
      standalone_ids: state.devices.map((d) => d.id).filter((id) => !occupied.has(id)),
    });
    holdSync(6000);
  };

  const addFollower = (primaryId: string, slaveId: string, fromBuilder: boolean) => {
    void run(primaryId, async () => {
      await api.syncAdd(primaryId, slaveId);
      applyOptimisticLink(primaryId, slaveId);
      if (fromBuilder) closeBuilder();
      // Wait until BluOS reflects the link — never replace optimistic sync with empty.
      await reloadStatus({ ensureLink: { primaryId, slaveId } });
    }).then(() => {
      if (fromBuilder) return;
      const remaining = availableFollowers(
        useFleetStore.getState().devices,
        useFleetStore.getState().sync,
        useFleetStore.getState().sync?.groups ?? [],
        primaryId,
      );
      if (remaining.length === 0) setAddingTo(null);
    });
  };

  const removeFollower = (primaryId: string, slaveId: string) => {
    void run(primaryId, async () => {
      await api.syncRemove(primaryId, slaveId);
      applyOptimisticUnlink(primaryId, [slaveId]);
      await reloadStatus();
    });
  };

  const ungroup = (group: SyncGroup) => {
    void run(group.primary_id, async () => {
      for (const slaveId of group.slave_ids) {
        await api.syncRemove(group.primary_id, slaveId);
      }
      applyOptimisticUnlink(group.primary_id, group.slave_ids);
      await reloadStatus();
    }).then(() => {
      if (addingTo === group.primary_id) setAddingTo(null);
    });
  };

  const ungroupAll = () => {
    if (
      !window.confirm(
        'Ungroup every multi-room group? Playback will stop so leftover AirPlay sessions clear.',
      )
    ) {
      return;
    }
    void run(groups[0].primary_id, async () => {
      const result = await api.syncBreak();
      setSync({
        groups: [],
        standalone_ids: useFleetStore.getState().devices.map((d) => d.id),
      });
      holdSync(6000);
      await reloadStatus();
      if (result.failed > 0) {
        useFleetStore.getState().setToast(
          `Ungrouped ${result.succeeded}; ${result.failed} failed`,
        );
      }
    }).then(() => {
      setAddingTo(null);
      closeBuilder();
    });
  };

  const groupAllUnder = (primaryId: string) => {
    void run(primaryId, async () => {
      holdSync(8000);
      const result = await api.syncEnable(primaryId);
      await reloadStatus();
      closeBuilder();
      if (result.failed > 0) {
        useFleetStore.getState().setToast(
          `Grouped ${result.succeeded} free room${result.succeeded === 1 ? '' : 's'}; ${result.failed} failed`,
        );
      }
    });
  };

  return (
    <section className="sync-strip" aria-labelledby="sync-heading">
      <header className="sync-head">
        <div className="sync-head-copy">
          <h2 id="sync-heading">Multi-room groups</h2>
          <p className="sync-head-meta">Play the same music across rooms</p>
        </div>
      </header>

      <div className="sync-stack">
        {groups.map((group) => {
          const primaryOnline = isOnlinePrimary(group.primary_id, byId);
          const open = addingTo === group.primary_id && primaryOnline;
          const candidates = primaryOnline
            ? availableFollowers(devices, sync, groups, group.primary_id)
            : [];
          const followerCount = group.slave_ids.length;
          return (
            <article className="sync-group" key={group.primary_id}>
              <div className="sync-group-top">
                <p className="sync-group-label">
                  {group.primary_name}
                  <span className="sync-group-label-muted">
                    {' '}
                    {' / '}
                    {primaryOnline ? 'lead' : 'offline'}
                    {' / '}
                    {roomCountLabel(followerCount + (primaryOnline ? 1 : 0))}
                  </span>
                </p>
                <div className="sync-actions">
                  {primaryOnline && candidates.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-compact"
                      disabled={busy}
                      aria-expanded={open}
                      onClick={() =>
                        setAddingTo((cur) =>
                          cur === group.primary_id ? null : group.primary_id,
                        )
                      }
                    >
                      {open ? 'Done' : 'Add rooms'}
                    </button>
                  )}
                  {followerCount > 0 && (
                    <button
                      type="button"
                      className="btn btn-compact btn-quiet"
                      disabled={busy}
                      onClick={() => ungroup(group)}
                    >
                      Ungroup
                    </button>
                  )}
                </div>
              </div>

              <div className="sync-chain" role="list">
                <span className="sync-chip sync-chip-primary" role="listitem">
                  {group.primary_name}
                </span>
                {followerCount > 0 ? (
                  <span className="sync-arrow" aria-hidden="true">
                    →
                  </span>
                ) : null}
                {group.slave_ids.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="sync-chip sync-chip-follower"
                    role="listitem"
                    disabled={busy}
                    title={`Remove ${byId[id]?.name || id}`}
                    onClick={() => removeFollower(group.primary_id, id)}
                  >
                    {byId[id]?.name || id}
                    <span className="sync-chip-x" aria-hidden="true">
                      ×
                    </span>
                  </button>
                ))}
                {open &&
                  candidates.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className="sync-chip sync-chip-choice"
                      disabled={busy}
                      onClick={() => addFollower(group.primary_id, d.id, false)}
                    >
                      + {d.name}
                    </button>
                  ))}
              </div>
            </article>
          );
        })}

        {showBuilder && (
          <article className="sync-group sync-group-draft" aria-label="Start a multi-room group">
            <div className="sync-group-top">
              <p className="sync-group-label">
                {groups.length === 0 ? 'Start a group' : 'Start another group'}
                <span className="sync-group-label-muted">
                  {' '}
                  {' / '}{activeLeadId ? 'pick rooms to follow' : 'choose the lead room'}
                </span>
              </p>
              {groups.length > 0 ? (
                <div className="sync-actions">
                  <button
                    type="button"
                    className="btn btn-compact btn-quiet"
                    disabled={busy}
                    onClick={closeBuilder}
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>

            <div className="sync-chain">
              {!activeLeadId ? (
                freeRooms.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="sync-chip sync-chip-choice"
                    disabled={busy}
                    onClick={() => setLeadId(d.id)}
                  >
                    {d.name}
                  </button>
                ))
              ) : (
                <>
                  <button
                    type="button"
                    className="sync-chip sync-chip-primary sync-chip-selected"
                    disabled={busy}
                    title="Change lead room"
                    onClick={() => setLeadId('')}
                  >
                    {byId[activeLeadId]?.name ?? 'Lead'}
                  </button>
                  <span className="sync-arrow" aria-hidden="true">
                    →
                  </span>
                  {createFollowers.length === 0 ? (
                    <span className="sync-hint">No free rooms left</span>
                  ) : (
                    <>
                      {createFollowers.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          className="sync-chip sync-chip-choice"
                          disabled={busy}
                          onClick={() => addFollower(activeLeadId, d.id, true)}
                        >
                          + {d.name}
                        </button>
                      ))}
                      {createFollowers.length >= 1 ? (
                        <button
                          type="button"
                          className="btn btn-compact"
                          disabled={busy}
                          onClick={() => groupAllUnder(activeLeadId)}
                        >
                          Group all free rooms
                        </button>
                      ) : null}
                    </>
                  )}
                </>
              )}
            </div>
          </article>
        )}
      </div>

      {!canStartGroup && groups.length === 0 ? (
        <p className="sync-empty">Need at least two free rooms to start a multi-room group.</p>
      ) : null}

      {(canStartSeparate || canUngroupAll || (groups.length > 0 && freeRooms.length > 0)) && (
        <footer className="sync-foot">
          {freeRooms.length > 0 && groups.length > 0 && !showBuilder ? (
            <p className="sync-foot-meta">
              {roomCountLabel(freeRooms.length)} not linked
              {canStartSeparate ? (
                <>
                  {' / '}
                  <button
                    type="button"
                    className="sync-text-btn"
                    disabled={busy}
                    onClick={openBuilder}
                  >
                    Group them separately
                  </button>
                </>
              ) : (
                <>{' / '}use Add rooms above to join a set</>
              )}
            </p>
          ) : (
            <span />
          )}
          {canUngroupAll ? (
            <button
              type="button"
              className="btn btn-compact btn-quiet"
              disabled={busy}
              onClick={ungroupAll}
            >
              Ungroup all
            </button>
          ) : null}
        </footer>
      )}
    </section>
  );
}
