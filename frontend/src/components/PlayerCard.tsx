import { Link } from 'react-router';
import { api } from '@/api/client';
import type { PlayerStatus } from '@/api/types';
import { isCiS2Device } from '@/lib/deviceGroups';
import {
  deviceEndpoint,
  endpointsMatch,
  formatDeviceHardware,
  formatDeviceHost,
} from '@/lib/endpoint';
import { joinMeta } from '@/lib/meta';
import { displaySyncRole } from '@/lib/syncGraph';
import { useFleetStore } from '@/store/fleetStore';
import { useEffect, useMemo, useRef, useState } from 'react';

function isPlaying(state: string): boolean {
  return state === 'play' || state === 'stream';
}

function isIdle(device: PlayerStatus): boolean {
  if (device.track.trim()) return false;
  return device.state === 'stop' || device.state === '' || device.state === 'pause';
}

function nowPlaying(device: PlayerStatus): { primary: string; secondary: string; idle: boolean } {
  if (isIdle(device) && !device.track.trim()) {
    const state =
      device.state === 'pause' ? 'Paused' : device.state === 'stop' || !device.state ? 'Idle' : device.state;
    return {
      primary: state,
      secondary: device.service && device.service !== 'Library/Input' ? device.service : '',
      idle: true,
    };
  }
  const primary = device.track || (isPlaying(device.state) ? 'Playing' : 'Paused');
  const secondary = joinMeta(device.artist, device.service);
  return { primary, secondary, idle: false };
}

function primaryNameFor(device: PlayerStatus, devices: PlayerStatus[]): string | null {
  if (device.sync_role !== 'synced' || !device.master) return null;
  const primary = devices.find((d) => endpointsMatch(deviceEndpoint(d), device.master));
  return primary?.name ?? device.master;
}

/** Compact fixed-column fleet row — keeps controls aligned across players. */
export function PlayerRow({ device }: { device: PlayerStatus }) {
  const devices = useFleetStore((s) => s.devices);
  const sync = useFleetStore((s) => s.sync);
  const control = useFleetStore((s) => s.control);
  const toggleMute = useFleetStore((s) => s.toggleMute);
  const holdVolume = useFleetStore((s) => s.holdVolume);
  const commitTimer = useRef<number | undefined>(undefined);
  const latestLevel = useRef(device.volume);
  const [dragging, setDragging] = useState(false);
  const [dragVolume, setDragVolume] = useState<number | null>(null);
  const displayVolume = dragVolume ?? device.volume;

  const volumePeers = useMemo(() => {
    const s2 = isCiS2Device(device);
    return devices.filter((d) => isCiS2Device(d) === s2);
  }, [device, devices]);
  const volumesLinked =
    volumePeers.length > 1 && volumePeers.every((d) => d.volume === volumePeers[0].volume);
  const role = displaySyncRole(device, sync);
  const follows = useMemo(() => primaryNameFor({ ...device, sync_role: role }, devices), [
    device,
    devices,
    role,
  ]);
  const synced = role === 'synced';
  const playing = isPlaying(device.state);
  const np = nowPlaying(device);

  useEffect(() => {
    if (!dragging) {
      latestLevel.current = device.volume;
    }
  }, [device.volume, dragging]);

  // Unmounting mid-drag (sort change, rescan) must not fire a late volume write.
  useEffect(
    () => () => {
      if (commitTimer.current) window.clearTimeout(commitTimer.current);
    },
    [],
  );

  const flushVolume = (level: number) => {
    latestLevel.current = level;
    void control(device.id, () => api.setVolume(device.id, level), { volume: level });
  };

  const onVolumeInput = (level: number) => {
    latestLevel.current = level;
    setDragVolume(level);
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = undefined;
      flushVolume(level);
    }, 80);
  };

  const endDrag = () => {
    setDragging(false);
    setDragVolume(null);
    if (commitTimer.current) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = undefined;
    }
    flushVolume(latestLevel.current);
  };

  const onMuteClick = () => {
    if (device.muted) {
      const restore =
        useFleetStore.getState().lastAudibleVolume[device.id] ??
        (displayVolume > 0 ? displayVolume : 20);
      setDragVolume(restore);
      latestLevel.current = restore;
    } else {
      setDragVolume(0);
      latestLevel.current = 0;
    }
    void toggleMute(device.id);
  };

  return (
    <div
      className="fleet-row"
      role="row"
      data-sync={role}
      data-idle={np.idle ? 'true' : 'false'}
    >
      <div className="fleet-cell fleet-cell-player" role="cell">
        <div className="fleet-player-line">
          <span
            className="status-dot"
            data-online={device.status === 'online'}
            aria-label={device.status}
          />
          <Link className="fleet-player-name" to={`/player/${device.id}`}>
            {device.name}
          </Link>
        </div>
        <div className="fleet-player-hardware">{formatDeviceHardware(device)}</div>
        <div className="fleet-player-meta">
          {role !== 'standalone' && (
            <span className="badge" data-role={role}>
              {role}
            </span>
          )}
          <span className="fleet-player-ip">{formatDeviceHost(device)}</span>
        </div>
      </div>

      <div className="fleet-cell fleet-cell-playing" role="cell">
        {synced && follows ? (
          <div className="fleet-track fleet-follows" title={`Follows ${follows}`}>
            Follows {follows}
          </div>
        ) : np.idle ? (
          <div className="fleet-track fleet-idle">{np.primary}</div>
        ) : (
          <>
            <div className="fleet-track" title={np.primary}>
              {np.primary}
            </div>
            {np.secondary ? (
              <div className="fleet-subtitle" title={np.secondary}>
                {np.secondary}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div
        className="fleet-cell fleet-cell-transport"
        role="cell"
        aria-label={`Transport for ${device.name}`}
      >
        {synced ? (
          <div className="fleet-synced-hint">
            <button type="button" className="btn btn-compact" onClick={onMuteClick}>
              {device.muted ? 'Unmute' : 'Mute'}
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-compact"
              onClick={() => void control(device.id, () => api.back(device.id))}
            >
              Prev
            </button>
            <button
              type="button"
              className="btn btn-compact btn-primary"
              onClick={() =>
                void control(
                  device.id,
                  () => (playing ? api.pause(device.id) : api.play(device.id)),
                  { state: playing ? 'pause' : 'play' },
                )
              }
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className="btn btn-compact"
              onClick={() =>
                void control(device.id, () => api.stop(device.id), { state: 'stop' })
              }
            >
              Stop
            </button>
            <button
              type="button"
              className="btn btn-compact"
              onClick={() => void control(device.id, () => api.skip(device.id))}
            >
              Next
            </button>
            <button type="button" className="btn btn-compact" onClick={onMuteClick}>
              {device.muted ? 'Unmute' : 'Mute'}
            </button>
          </>
        )}
      </div>

      <div className="fleet-cell fleet-cell-volume" role="cell">
        <input
          id={`vol-${device.id}`}
          type="range"
          min={0}
          max={100}
          value={displayVolume}
          aria-label={`Volume for ${device.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={displayVolume}
          onPointerDown={() => {
            setDragging(true);
            setDragVolume(device.volume);
            holdVolume(device.id, 5000);
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onChange={(e) => onVolumeInput(Number(e.target.value))}
        />
        <span className="volume-value">{displayVolume}</span>
        {volumesLinked ? (
          <span
            className="volume-linked"
            title={
              isCiS2Device(device)
                ? 'NAD CI S2 players share this volume'
                : 'Bluesound players share this volume'
            }
          >
            link
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** @deprecated Prefer PlayerRow — alias for older imports */
export const PlayerCard = PlayerRow;
