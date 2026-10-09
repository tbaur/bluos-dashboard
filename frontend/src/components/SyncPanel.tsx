import { useMemo, useState } from 'react';
import type { PlayerStatus, SyncGroup } from '@/api/types';
import { useSyncActions } from '@/hooks/useSyncActions';
import {
  availableFollowers,
  freeRooms as freeRoomsOf,
  occupiedRoomIds,
  roomCountLabel,
} from '@/lib/syncGroups';
import { useFleetStore } from '@/store/fleetStore';

type DevicesById = Record<string, PlayerStatus>;

function remainingFollowers(primaryId: string): PlayerStatus[] {
  const { devices, sync } = useFleetStore.getState();
  return availableFollowers(devices, sync, sync?.groups ?? [], primaryId);
}

/**
 * Multi-room sync: one card per linked set of rooms.
 * Lead room is first; followers can be removed with ×.
 * Header stays calm — secondary actions live in the footer.
 */
export function SyncPanel() {
  const sync = useFleetStore((s) => s.sync);
  const devices = useFleetStore((s) => s.devices);
  const actions = useSyncActions();

  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [leadId, setLeadId] = useState('');
  const [creating, setCreating] = useState(false);

  const groups = useMemo(() => sync?.groups ?? [], [sync?.groups]);
  const byId = useMemo(() => Object.fromEntries(devices.map((d) => [d.id, d])), [devices]);
  const freeRooms = useMemo(() => freeRoomsOf(devices, sync, groups), [devices, sync, groups]);

  // If SSE/optimistic sync occupies the chosen lead, treat builder as reset (no effect).
  const leadBlocked = Boolean(leadId && occupiedRoomIds(groups).has(leadId));
  const activeCreating = creating && !leadBlocked;
  const activeLeadId = leadBlocked ? '' : leadId;

  if (devices.length < 2) return null;

  const canStartGroup = freeRooms.length >= 2;
  const showBuilder = canStartGroup && (groups.length === 0 || activeCreating);
  const canStartSeparate = canStartGroup && groups.length > 0 && !showBuilder;

  const closeBuilder = () => {
    setCreating(false);
    setLeadId('');
  };

  const openBuilder = () => {
    setCreating(true);
    setLeadId('');
    setAddingTo(null);
  };

  const addFollower = (primaryId: string, slaveId: string, fromBuilder: boolean) => {
    void actions.addFollower(primaryId, slaveId, fromBuilder ? closeBuilder : undefined).then(() => {
      if (!fromBuilder && remainingFollowers(primaryId).length === 0) setAddingTo(null);
    });
  };

  const ungroup = (group: SyncGroup) => {
    void actions.ungroup(group).then(() => {
      if (addingTo === group.primary_id) setAddingTo(null);
    });
  };

  const ungroupAll = () => {
    const message =
      'Ungroup every multi-room group? Playback will stop so leftover AirPlay sessions clear.';
    if (!window.confirm(message)) return;
    void actions.ungroupAll(groups[0].primary_id).then(() => {
      setAddingTo(null);
      closeBuilder();
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
        {groups.map((group) => (
          <SyncGroupCard
            key={group.primary_id}
            group={group}
            byId={byId}
            candidates={
              byId[group.primary_id]
                ? availableFollowers(devices, sync, groups, group.primary_id)
                : []
            }
            adding={addingTo === group.primary_id}
            busy={actions.busy}
            onToggleAdding={() =>
              setAddingTo((cur) => (cur === group.primary_id ? null : group.primary_id))
            }
            onAdd={(slaveId) => addFollower(group.primary_id, slaveId, false)}
            onRemove={(slaveId) => void actions.removeFollower(group.primary_id, slaveId)}
            onUngroup={() => ungroup(group)}
          />
        ))}

        {showBuilder && (
          <GroupBuilder
            hasGroups={groups.length > 0}
            leadId={activeLeadId}
            byId={byId}
            freeRooms={freeRooms}
            followers={availableFollowers(devices, sync, groups, activeLeadId)}
            busy={actions.busy}
            onLead={setLeadId}
            onCancel={closeBuilder}
            onAdd={(slaveId) => addFollower(activeLeadId, slaveId, true)}
            onGroupAll={() => void actions.groupAllUnder(activeLeadId, closeBuilder)}
          />
        )}
      </div>

      {!canStartGroup && groups.length === 0 ? (
        <p className="sync-empty">Need at least two free rooms to start a multi-room group.</p>
      ) : null}

      {groups.length > 0 && (
        <SyncFooter
          freeCount={showBuilder ? 0 : freeRooms.length}
          canStartSeparate={canStartSeparate}
          busy={actions.busy}
          onStartSeparate={openBuilder}
          onUngroupAll={ungroupAll}
        />
      )}
    </section>
  );
}

interface SyncGroupCardProps {
  group: SyncGroup;
  byId: DevicesById;
  candidates: PlayerStatus[];
  adding: boolean;
  busy: boolean;
  onToggleAdding: () => void;
  onAdd: (slaveId: string) => void;
  onRemove: (slaveId: string) => void;
  onUngroup: () => void;
}

function SyncGroupCard(props: SyncGroupCardProps) {
  const { group, byId, candidates, busy } = props;
  const primaryOnline = Boolean(byId[group.primary_id]);
  const open = props.adding && primaryOnline;
  const followerCount = group.slave_ids.length;
  return (
    <article className="sync-group">
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
              onClick={props.onToggleAdding}
            >
              {open ? 'Done' : 'Add rooms'}
            </button>
          )}
          {followerCount > 0 && (
            <button
              type="button"
              className="btn btn-compact btn-quiet"
              disabled={busy}
              onClick={props.onUngroup}
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
            onClick={() => props.onRemove(id)}
          >
            {byId[id]?.name || id}
            <span className="sync-chip-x" aria-hidden="true">
              ×
            </span>
          </button>
        ))}
        {open && <ChoiceChips rooms={candidates} busy={busy} onPick={props.onAdd} prefix="+ " />}
      </div>
    </article>
  );
}

function ChoiceChips({
  rooms,
  busy,
  onPick,
  prefix = '',
}: {
  rooms: PlayerStatus[];
  busy: boolean;
  onPick: (id: string) => void;
  prefix?: string;
}) {
  return (
    <>
      {rooms.map((d) => (
        <button
          key={d.id}
          type="button"
          className="sync-chip sync-chip-choice"
          disabled={busy}
          onClick={() => onPick(d.id)}
        >
          {prefix}
          {d.name}
        </button>
      ))}
    </>
  );
}

interface GroupBuilderProps {
  hasGroups: boolean;
  leadId: string;
  byId: DevicesById;
  freeRooms: PlayerStatus[];
  followers: PlayerStatus[];
  busy: boolean;
  onLead: (id: string) => void;
  onCancel: () => void;
  onAdd: (slaveId: string) => void;
  onGroupAll: () => void;
}

function GroupBuilder(props: GroupBuilderProps) {
  const { hasGroups, leadId, busy } = props;
  return (
    <article className="sync-group sync-group-draft" aria-label="Start a multi-room group">
      <div className="sync-group-top">
        <p className="sync-group-label">
          {hasGroups ? 'Start another group' : 'Start a group'}
          <span className="sync-group-label-muted">
            {' '}
            {' / '}
            {leadId ? 'pick rooms to follow' : 'choose the lead room'}
          </span>
        </p>
        {hasGroups ? (
          <div className="sync-actions">
            <button
              type="button"
              className="btn btn-compact btn-quiet"
              disabled={busy}
              onClick={props.onCancel}
            >
              Cancel
            </button>
          </div>
        ) : null}
      </div>

      <div className="sync-chain">
        {!leadId ? (
          <ChoiceChips rooms={props.freeRooms} busy={busy} onPick={props.onLead} />
        ) : (
          <LeadAndFollowers {...props} />
        )}
      </div>
    </article>
  );
}

function LeadAndFollowers({ leadId, byId, followers, busy, ...props }: GroupBuilderProps) {
  return (
    <>
      <button
        type="button"
        className="sync-chip sync-chip-primary sync-chip-selected"
        disabled={busy}
        title="Change lead room"
        onClick={() => props.onLead('')}
      >
        {byId[leadId]?.name ?? 'Lead'}
      </button>
      <span className="sync-arrow" aria-hidden="true">
        →
      </span>
      {followers.length === 0 ? (
        <span className="sync-hint">No free rooms left</span>
      ) : (
        <>
          <ChoiceChips rooms={followers} busy={busy} onPick={props.onAdd} prefix="+ " />
          <button
            type="button"
            className="btn btn-compact"
            disabled={busy}
            onClick={props.onGroupAll}
          >
            Group all free rooms
          </button>
        </>
      )}
    </>
  );
}

function SyncFooter({
  freeCount,
  canStartSeparate,
  busy,
  onStartSeparate,
  onUngroupAll,
}: {
  freeCount: number;
  canStartSeparate: boolean;
  busy: boolean;
  onStartSeparate: () => void;
  onUngroupAll: () => void;
}) {
  return (
    <footer className="sync-foot">
      {freeCount > 0 ? (
        <p className="sync-foot-meta">
          {roomCountLabel(freeCount)} not linked
          {canStartSeparate ? (
            <>
              {' / '}
              <button
                type="button"
                className="sync-text-btn"
                disabled={busy}
                onClick={onStartSeparate}
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
      <button
        type="button"
        className="btn btn-compact btn-quiet"
        disabled={busy}
        onClick={onUngroupAll}
      >
        Ungroup all
      </button>
    </footer>
  );
}
