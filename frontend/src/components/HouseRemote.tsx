import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { api } from '@/api/client';
import type { PlayerStatus } from '@/api/types';
import { AlsoPlaying } from '@/components/house/AlsoPlaying';
import {
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconRepeat,
  IconShuffle,
} from '@/components/house/HouseIcons';
import { SpeakerChip } from '@/components/house/SpeakerChip';
import { SeekBar } from '@/components/SeekBar';
import { StickyArt } from '@/components/StickyArt';
import { useHouseTransport } from '@/hooks/useHouseTransport';
import { useStableHouseStatus } from '@/hooks/useStableHouseStatus';
import { playerArtSrc } from '@/lib/artwork';
import {
  fleetHasActivePlayback,
  houseTransportTargets,
  type HouseStreamSource,
} from '@/lib/fleetStatus';
import {
  alsoPlayingMeta,
  focusedSource,
  otherStreams,
  speakerRoster,
  streamPlaceLabel,
} from '@/lib/houseRoster';
import { useFleetStore } from '@/store/fleetStore';

type HouseCommand = ReturnType<typeof useHouseTransport>['command'];

function transportLead(ids: string[], devices: PlayerStatus[]): PlayerStatus | undefined {
  const members = ids
    .map((id) => devices.find((d) => d.id === id))
    .filter((d): d is PlayerStatus => Boolean(d));
  return members.find((d) => d.can_seek && d.totlen > 0) ?? members[0];
}

function nextRepeat(current: number): 0 | 1 | 2 {
  if (current === 0) return 1;
  if (current === 1) return 2;
  return 0;
}

type HouseRemoteProps = {
  variant?: 'fleet' | 'page';
};

export function HouseRemote({ variant = 'fleet' }: HouseRemoteProps) {
  const devices = useFleetStore((s) => s.devices);
  const sync = useFleetStore((s) => s.sync);
  const location = useLocation();
  const [focusMemberIds, setFocusMemberIds] = useState<string[] | null>(null);
  const playButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);

  const status = useStableHouseStatus(devices, sync);
  const allMuted = devices.length > 0 && devices.every((d) => d.muted);
  const focused = focusedSource(status.sources, focusMemberIds);
  const targets = focused ? houseTransportTargets(focused, devices) : [];
  const lead = transportLead(targets, devices);
  const streamPlaying = focused?.playing ?? false;
  const transport = useHouseTransport({
    focused,
    targets,
    streamPlaying,
    allMuted,
    devices,
    sync,
    pinStream: setFocusMemberIds,
  });

  const roster = focused ? speakerRoster(focused, devices, sync) : [];
  const place = streamPlaceLabel(roster.length, roster[0]?.name ?? '');
  const others = focused ? otherStreams(status.sources, focused.key) : [];
  const alsoMeta = alsoPlayingMeta(others.length);
  const showAlsoPlaying = others.length > 0 && alsoMeta.length > 0;
  const titleHref = location.pathname === '/house' ? null : '/house';
  const totlen = lead?.totlen ?? 0;
  const canSeek = Boolean(lead?.can_seek);

  const chooseStream = (memberIds: readonly string[]) => {
    returnFocusRef.current = true;
    setFocusMemberIds([...memberIds]);
  };

  useLayoutEffect(() => {
    if (!returnFocusRef.current) return;
    returnFocusRef.current = false;
    playButtonRef.current?.focus();
  }, [focused?.key]);

  return (
    <div
      className={`house-remote-stack house-remote-stack-${variant}`}
      data-art={focused ? 'true' : 'false'}
      data-also={showAlsoPlaying ? 'true' : 'false'}
    >
      <section
        className={`fleet-bar-panel house-remote house-remote-${variant}`}
        aria-labelledby="fleet-actions-heading"
        data-idle={status.isIdle ? 'true' : 'false'}
        data-art={focused ? 'true' : 'false'}
        data-paused={status.isPaused ? 'true' : 'false'}
      >
        <div className="house-remote-body">
          {focused ? <HouseArt focused={focused} /> : null}
          <HouseHeadline
            focused={focused}
            status={status}
            titleHref={titleHref}
          />
        </div>

        <div className="house-remote-foot">
          {focused && place ? <SpeakerChip place={place} rows={roster} /> : null}
          {focused && totlen > 0 ? (
            <SeekBar
              key={lead?.id ?? 'house-seek'}
              initialSecs={lead?.secs ?? 0}
              totlen={totlen}
              playing={streamPlaying && (lead?.state === 'play' || lead?.state === 'stream')}
              canSeek={canSeek}
              onSeek={
                canSeek
                  ? (seconds) =>
                      transport.command(
                        'seek',
                        (id) => api.seek(id, seconds),
                        { secs: seconds },
                        targets.filter((id) => devices.find((d) => d.id === id)?.can_seek),
                      )
                  : undefined
              }
            />
          ) : null}

          <div className="house-remote-deck">
            {focused ? (
              <HouseTransport
                lead={lead}
                disabled={targets.length === 0}
                streamPlaying={streamPlaying}
                playButtonRef={playButtonRef}
                command={transport.command}
                onToggle={transport.toggleStream}
              />
            ) : null}
            <HouseActions
              devices={devices}
              allMuted={allMuted}
              mixed={status.sources.length > 1}
              busy={transport.busy}
              run={transport.run}
            />
          </div>
          <p className="house-remote-keys">
            Space or K play/pause · arrows or J/L skip · M mute
          </p>
        </div>
      </section>

      {showAlsoPlaying ? (
        <AlsoPlaying
          others={others}
          meta={alsoMeta}
          devices={devices}
          sync={sync}
          onChoose={chooseStream}
        />
      ) : null}
    </div>
  );
}

function HouseArt({ focused }: { focused: HouseStreamSource }) {
  return (
    <Link
      to={focused.leadId ? `/player/${focused.leadId}` : '/house'}
      className="house-remote-art"
      aria-label={
        focused.image ? `Now playing artwork — open ${focused.primary}` : `Open ${focused.primary}`
      }
    >
      <StickyArt
        src={focused.leadId ? playerArtSrc(focused.leadId, focused.image) : ''}
        className="house-remote-art-img"
        empty={
          <span className="house-remote-art-empty" aria-hidden="true">
            <span className="house-remote-art-glyph" />
          </span>
        }
      />
    </Link>
  );
}

function HouseHeadline({
  focused,
  status,
  titleHref,
}: {
  focused: HouseStreamSource | null;
  status: ReturnType<typeof useStableHouseStatus>;
  titleHref: string | null;
}) {
  const primary = focused?.primary ?? status.primary;
  const detail = focused?.detail || status.detail;
  const albumLine = focused?.album && focused.album !== focused.primary ? focused.album : '';
  return (
    <div className="house-remote-head">
      <div className="house-remote-title-row">
        <h2 id="fleet-actions-heading">
          {titleHref ? (
            <Link to={titleHref} className="house-remote-title-link">
              House
            </Link>
          ) : (
            'House'
          )}
        </h2>
        {status.meta.length > 0 ? (
          <ul className="house-remote-meta" aria-label="House status">
            {status.meta.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <p className="house-remote-primary" title={primary}>
        {titleHref ? (
          <Link to={titleHref} className="house-remote-status-link">
            {primary}
          </Link>
        ) : (
          primary
        )}
      </p>
      {albumLine ? <p className="house-remote-album">{albumLine}</p> : null}
      {(focused?.detail ?? status.detail) ? (
        <p className="house-remote-detail" title={detail}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

function HouseTransport({
  lead,
  disabled,
  streamPlaying,
  playButtonRef,
  command,
  onToggle,
}: {
  lead: PlayerStatus | undefined;
  disabled: boolean;
  streamPlaying: boolean;
  playButtonRef: RefObject<HTMLButtonElement | null>;
  command: HouseCommand;
  onToggle: () => void;
}) {
  const shuffleOn = (lead?.shuffle ?? 0) === 1;
  const repeatMode = (lead?.repeat ?? 0) as 0 | 1 | 2;
  const repeatLabel =
    repeatMode === 1 ? 'Repeat all' : repeatMode === 2 ? 'Repeat one' : 'Repeat off';
  return (
    <div className="house-remote-transport" role="group" aria-label="House stream">
      <button
        type="button"
        className="house-icon-btn"
        disabled={disabled}
        aria-label="Previous track"
        onClick={() => command('back', (id) => api.back(id))}
      >
        <IconPrev />
      </button>
      <button
        ref={playButtonRef}
        type="button"
        className="house-icon-btn house-icon-btn-play"
        disabled={disabled}
        aria-label={streamPlaying ? 'Pause house stream' : 'Play house stream'}
        onClick={onToggle}
      >
        {streamPlaying ? <IconPause /> : <IconPlay />}
      </button>
      <button
        type="button"
        className="house-icon-btn"
        disabled={disabled}
        aria-label="Next track"
        onClick={() => command('skip', (id) => api.skip(id))}
      >
        <IconNext />
      </button>
      <button
        type="button"
        className="house-icon-btn house-icon-btn-mode"
        disabled={disabled}
        aria-label={shuffleOn ? 'Shuffle on' : 'Shuffle off'}
        aria-pressed={shuffleOn}
        onClick={() =>
          command('shuffle', (id) => api.setShuffle(id, shuffleOn ? 0 : 1), {
            shuffle: shuffleOn ? 0 : 1,
          })
        }
      >
        <IconShuffle />
      </button>
      <button
        type="button"
        className="house-icon-btn house-icon-btn-mode"
        disabled={disabled}
        aria-label={repeatLabel}
        aria-pressed={repeatMode !== 0}
        onClick={() => {
          const next = nextRepeat(repeatMode);
          command('repeat', (id) => api.setRepeat(id, next), { repeat: next });
        }}
      >
        <IconRepeat one={repeatMode === 2} />
      </button>
    </div>
  );
}

function HouseActions({
  devices,
  allMuted,
  mixed,
  busy,
  run,
}: {
  devices: PlayerStatus[];
  allMuted: boolean;
  mixed: boolean;
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>) => void;
}) {
  const fleetMuteAll = useFleetStore((s) => s.fleetMuteAll);
  const fleetPauseAll = useFleetStore((s) => s.fleetPauseAll);
  const fleetStopAll = useFleetStore((s) => s.fleetStopAll);
  const anyPlaying = fleetHasActivePlayback(devices);
  return (
    <div className="fleet-actions house-remote-actions" role="group" aria-label="House transport">
      <button
        type="button"
        className="btn"
        disabled={busy === 'mute'}
        onClick={() => run('mute', () => fleetMuteAll(!allMuted))}
      >
        {busy === 'mute' ? '…' : allMuted ? 'Unmute' : 'Mute'}
      </button>
      {mixed ? (
        <button
          type="button"
          className="btn"
          disabled={busy === 'pause' || !anyPlaying}
          title={anyPlaying ? 'Pause every playing room' : 'Nothing playing'}
          onClick={() => run('pause', () => fleetPauseAll())}
        >
          {busy === 'pause' ? '…' : 'Pause all'}
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-danger"
        disabled={busy === 'stop'}
        title="Stop playback on every player"
        onClick={() => run('stop', () => fleetStopAll())}
      >
        {busy === 'stop' ? '…' : 'Stop all'}
      </button>
    </div>
  );
}
