import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerStatus } from '@/api/types';
import { HouseRemote } from '@/components/HouseRemote';
import { VolumeNudgeButtons } from '@/components/VolumeNudgeButtons';
import { partitionVolumeGroups } from '@/lib/deviceGroups';
import { createLatestValueSender, type LatestValueSender } from '@/lib/latestValueSender';
import { audibleDevices } from '@/lib/mute';
import { DRAG_VOLUME_HOLD_MS, useFleetStore } from '@/store/fleetStore';

const BLUESOUND_VOLUME_LEVELS = [20, 48, 60] as const;
const CI_S2_VOLUME_LEVELS = [42, 50, 60, 70] as const;

function medianVolume(volumes: number[]): number {
  if (volumes.length === 0) return 0;
  const sorted = [...volumes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

/** "N muted" next to a group slider: those rooms keep their mute when the slider moves. */
function MutedPill({ devices }: { devices: PlayerStatus[] }) {
  if (devices.length === 0) return null;
  const names = devices.map((d) => d.name).join(', ');
  return (
    <span className="volume-muted-pill" title={`Stays muted: ${names}`}>
      {devices.length} muted
    </span>
  );
}

type GroupVolumePanelProps = {
  title: string;
  scopeLabel: string;
  devices: PlayerStatus[];
  inputId: string;
  ariaLabel: string;
  levels?: readonly number[];
};

function GroupVolumePanel({
  title,
  scopeLabel,
  devices,
  inputId,
  ariaLabel,
  levels,
}: GroupVolumePanelProps) {
  const setFleetVolume = useFleetStore((s) => s.setFleetVolume);
  const holdVolumes = useFleetStore((s) => s.holdVolumes);
  const commitTimer = useRef<number | undefined>(undefined);
  const latestLevel = useRef(0);
  const deviceIdsRef = useRef<string[]>([]);
  const senderRef = useRef<LatestValueSender<number> | null>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [dragDraft, setDragDraft] = useState<number | null>(null);

  const deviceIds = useMemo(() => devices.map((d) => d.id), [devices]);
  useEffect(() => {
    deviceIdsRef.current = deviceIds;
  }, [deviceIds]);

  const audible = audibleDevices(devices);
  const mutedRooms = devices.filter((d) => d.muted);
  const allMuted = audible.length === 0;
  const fleetMedian = medianVolume(audible.map((d) => d.volume));
  const display = dragDraft ?? fleetMedian;
  const volumesMatch = !allMuted && audible.every((d) => d.volume === audible[0].volume);
  const controlsDisabled = pending || allMuted;
  const headingId = `${inputId}-heading`;

  useEffect(() => {
    latestLevel.current = display;
  }, [display]);

  useEffect(() => {
    const sender = createLatestValueSender<number>({
      send: (level) => {
        const ids = deviceIdsRef.current.slice();
        holdVolumes(ids, DRAG_VOLUME_HOLD_MS);
        return setFleetVolume(level, ids);
      },
      onIdle: () => {
        setPending(false);
        // Mid-drag the thumb must stay where the finger is, not jump to the old median.
        if (!draggingRef.current) setDragDraft(null);
      },
    });
    senderRef.current = sender;
    return () => {
      if (commitTimer.current) window.clearTimeout(commitTimer.current);
      sender.cancel();
    };
  }, [holdVolumes, setFleetVolume]);

  const flush = (level: number) => {
    if (deviceIdsRef.current.length === 0) return;
    setPending(true);
    holdVolumes(deviceIdsRef.current, DRAG_VOLUME_HOLD_MS);
    senderRef.current?.push(level);
  };

  const scheduleFlush = (level: number) => {
    latestLevel.current = level;
    setDragDraft(level);
    holdVolumes(deviceIdsRef.current, DRAG_VOLUME_HOLD_MS);
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = undefined;
      flush(latestLevel.current);
    }, 80);
  };

  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (commitTimer.current) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = undefined;
    }
    flush(latestLevel.current);
  };

  if (devices.length === 0) return null;

  return (
    <section className="fleet-bar-panel" aria-labelledby={headingId}>
      <div className="fleet-bar-panel-head">
        <h2 id={headingId}>{title}</h2>
        <span className="card-meta">
          {pending ? (
            'Syncing…'
          ) : allMuted ? (
            'All muted'
          ) : dragging ? (
            <>
              {scopeLabel} → {display}
            </>
          ) : volumesMatch ? (
            <>
              {scopeLabel} → {display}
              <span className="volume-linked-pill">linked</span>
            </>
          ) : (
            <>
              Median {fleetMedian}
              <button
                type="button"
                className="volume-linked-pill volume-linked-pill-action"
                disabled={pending}
                title={`Set ${scopeLabel} to median volume ${fleetMedian}`}
                onClick={() => {
                  setDragDraft(fleetMedian);
                  latestLevel.current = fleetMedian;
                  flush(fleetMedian);
                }}
              >
                re-sync → {fleetMedian}
              </button>
            </>
          )}
          {allMuted ? null : <MutedPill devices={mutedRooms} />}
        </span>
      </div>
      <div className="volume-row global-volume-row">
        <VolumeNudgeButtons
          value={display}
          disabled={controlsDisabled}
          onChange={(level) => scheduleFlush(level)}
        />
        <label htmlFor={inputId}>Vol</label>
        <input
          id={inputId}
          type="range"
          min={0}
          max={100}
          value={display}
          disabled={allMuted}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={display}
          aria-label={ariaLabel}
          onPointerDown={() => {
            draggingRef.current = true;
            setDragging(true);
            setDragDraft(fleetMedian);
            latestLevel.current = fleetMedian;
            holdVolumes(deviceIdsRef.current, DRAG_VOLUME_HOLD_MS);
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onChange={(e) => scheduleFlush(Number(e.target.value))}
        />
        <span className="global-volume-value" title={`${display}%`}>
          {display}
        </span>
      </div>
      {levels && levels.length > 0 ? (
        <div className="volume-level-chips" role="group" aria-label={`${scopeLabel} levels`}>
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              className="volume-level-chip"
              disabled={controlsDisabled}
              aria-pressed={display === level}
              aria-label={`Set ${scopeLabel} volume to ${level}`}
              onClick={() => {
                setDragDraft(level);
                latestLevel.current = level;
                flush(level);
              }}
            >
              {level}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Now-playing house remote (hero) + grouped volume sliders. */
export function FleetBar() {
  const devices = useFleetStore((s) => s.devices);
  const { bluesound, ciS2 } = useMemo(() => partitionVolumeGroups(devices), [devices]);
  if (devices.length === 0) return null;
  const hasVolumes = bluesound.length > 0 || ciS2.length > 0;

  return (
    <div className={hasVolumes ? 'fleet-bar' : 'fleet-bar fleet-bar-remote-only'}>
      <HouseRemote variant="fleet" />
      {hasVolumes ? (
        <div className="fleet-bar-rail">
          {bluesound.length > 0 ? (
            <GroupVolumePanel
              title="Bluesound"
              scopeLabel="Bluesound"
              devices={bluesound}
              inputId="global-vol"
              ariaLabel="Set volume on Bluesound players"
              levels={BLUESOUND_VOLUME_LEVELS}
            />
          ) : null}
          {ciS2.length > 0 ? (
            <GroupVolumePanel
              title="NAD CI S2"
              scopeLabel="NAD CI S2"
              devices={ciS2}
              inputId="ci-s2-vol"
              ariaLabel="Set volume on NAD CI S2 zones"
              levels={CI_S2_VOLUME_LEVELS}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** @deprecated Use FleetBar — kept name for any lingering imports */
export function GlobalVolumeControl() {
  return <FleetBar />;
}
