import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { api } from '@/api/client';
import type { PlayerStatus, SyncState } from '@/api/types';
import { SeekBar } from '@/components/SeekBar';
import { StickyArt } from '@/components/StickyArt';
import { playerArtSrc } from '@/lib/artwork';
import { useStableHouseStatus } from '@/hooks/useStableHouseStatus';
import {
  fleetHasActivePlayback,
  houseTransportTargets,
  type HouseStreamSource,
} from '@/lib/fleetStatus';
import { displaySyncRole } from '@/lib/syncGraph';
import {
  ALSO_PLAYING_VISIBLE,
  alsoPlayingMeta,
  focusedSource,
  otherStreams,
  rosterHeading,
  speakerRoster,
  streamPlaceLabel,
  type SpeakerRosterRow,
} from '@/lib/houseRoster';
import { useFleetStore } from '@/store/fleetStore';

function IconPrev() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6h2v12H6V6zm3.5 6L18 18V6l-8.5 6z" fill="currentColor" />
    </svg>
  );
}

function IconNext() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 6h2v12h-2V6zM6 18l8.5-6L6 6v12z" fill="currentColor" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5L8 5.5z" fill="currentColor" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" fill="currentColor" />
    </svg>
  );
}

function IconShuffle() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 7h3.5l2 3 1.6-2.4L9.2 5H4v2zm9.2 0 1.8 2.7L17 7h3v2h-2.2l-3.2 4.8L17.8 19H20v2h-3.5l-2.2-3.3L12.6 19H4v-2h7.2l2.1-3.2L10.8 9H4V7h9.2z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconRepeat({ one }: { one: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"
        fill="currentColor"
      />
      {one ? (
        <text x="12" y="14.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="currentColor">
          1
        </text>
      ) : null}
    </svg>
  );
}

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

/** Followers of the commanded player. Direct rooms are not told to pause or skip. */
function syncedFollowerIds(
  memberIds: readonly string[],
  commandedIds: readonly string[],
  devices: readonly PlayerStatus[],
  sync: SyncState | null,
): string[] {
  const commanded = new Set(commandedIds);
  const byId = new Map(devices.map((device) => [device.id, device]));
  return memberIds.filter((id) => {
    if (commanded.has(id)) return false;
    const device = byId.get(id);
    return Boolean(device && displaySyncRole(device, sync) === 'synced');
  });
}

function holdCluster(memberIds: string[]) {
  const store = useFleetStore.getState();
  for (const id of memberIds) {
    store.holdPlayback(id);
  }
}

function paintCluster(memberIds: string[], optimistic?: Partial<PlayerStatus>) {
  if (!optimistic || memberIds.length === 0) return;
  const store = useFleetStore.getState();
  for (const id of memberIds) {
    store.patchDevice(id, optimistic);
    store.holdPlayback(id);
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    target.isContentEditable
  );
}

type HouseRemoteProps = {
  variant?: 'fleet' | 'page';
};

export function HouseRemote({ variant = 'fleet' }: HouseRemoteProps) {
  const devices = useFleetStore((s) => s.devices);
  const sync = useFleetStore((s) => s.sync);
  const control = useFleetStore((s) => s.control);
  const fleetMuteAll = useFleetStore((s) => s.fleetMuteAll);
  const fleetPauseAll = useFleetStore((s) => s.fleetPauseAll);
  const fleetStopAll = useFleetStore((s) => s.fleetStopAll);
  const location = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  const [focusMemberIds, setFocusMemberIds] = useState<string[] | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const playButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);

  const status = useStableHouseStatus(devices, sync);
  const allMuted = devices.length > 0 && devices.every((d) => d.muted);
  const anyPlaying = fleetHasActivePlayback(devices);
  const mixed = status.sources.length > 1;
  const focused = focusedSource(status.sources, focusMemberIds);

  const targets = focused ? houseTransportTargets(focused, devices) : [];
  const lead = transportLead(targets, devices);
  const streamPlaying = focused?.playing ?? false;
  const focusedRef = useRef(focused);
  const streamPlayingRef = useRef(streamPlaying);
  const allMutedRef = useRef(allMuted);

  useEffect(() => {
    focusedRef.current = focused;
    streamPlayingRef.current = streamPlaying;
    allMutedRef.current = allMuted;
  }, [focused, streamPlaying, allMuted]);

  const showNowPlaying = Boolean(focused);
  const artHref = focused?.leadId ? `/player/${focused.leadId}` : '/house';
  const titleHref = location.pathname === '/house' ? null : '/house';
  const shuffleOn = (lead?.shuffle ?? 0) === 1;
  const repeatMode = (lead?.repeat ?? 0) as 0 | 1 | 2;
  const canSeek = Boolean(lead?.can_seek);
  const totlen = lead?.totlen ?? 0;
  const secs = lead?.secs ?? 0;
  const albumLine = focused?.album && focused.album !== focused.primary ? focused.album : '';
  const roster = focused ? speakerRoster(focused, devices, sync) : [];
  const place = streamPlaceLabel(roster.length, roster[0]?.name ?? '');
  const others = focused ? otherStreams(status.sources, focused.key) : [];
  const alsoVisible = others.slice(0, ALSO_PLAYING_VISIBLE);
  const alsoMeta = alsoPlayingMeta(others.length);

  const run = (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    void action().finally(() => setBusy(null));
  };

  const commandTargets = (
    key: string,
    fn: (id: string) => Promise<void>,
    optimistic?: Partial<PlayerStatus>,
    ids = targets,
  ) => {
    if (ids.length === 0) return;
    const members = focused?.memberIds ?? ids;
    const followers = syncedFollowerIds(members, ids, devices, sync);
    if (key === 'skip' || key === 'back') {
      useFleetStore.getState().beginHouseCatchup(members);
    }
    run(key, async () => {
      holdCluster(followers);
      await Promise.all(ids.map((id) => control(id, () => fn(id), optimistic)));
      paintCluster(followers, optimistic);
    });
  };

  const toggleStream = () => {
    if (!focused) return;
    const nextState = streamPlaying ? 'pause' : 'play';
    commandTargets('play', (id) => api.toggle(id), { state: nextState });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const store = useFleetStore.getState();
      const focusedNow = focusedRef.current;
      const ids = focusedNow ? houseTransportTargets(focusedNow, store.devices) : [];
      const members = focusedNow?.memberIds ?? ids;
      const followers = syncedFollowerIds(members, ids, store.devices, store.sync);
      const send = (fn: (id: string) => Promise<void>, optimistic?: Partial<PlayerStatus>) => {
        if (ids.length === 0) return;
        holdCluster(followers);
        void Promise.all(ids.map((id) => store.control(id, () => fn(id), optimistic))).then(() => {
          paintCluster(followers, optimistic);
        });
      };
      if (event.key === ' ' || event.key === 'k') {
        if (!focusedRef.current) return;
        event.preventDefault();
        const nextState = streamPlayingRef.current ? 'pause' : 'play';
        send((id) => api.toggle(id), { state: nextState });
      } else if (event.key === 'ArrowRight' || event.key === 'l') {
        if (ids.length === 0) return;
        event.preventDefault();
        store.beginHouseCatchup(members);
        send((id) => api.skip(id));
      } else if (event.key === 'ArrowLeft' || event.key === 'j') {
        if (ids.length === 0) return;
        event.preventDefault();
        store.beginHouseCatchup(members);
        send((id) => api.back(id));
      } else if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        void store.fleetMuteAll(!allMutedRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const playLabel = streamPlaying ? 'Pause house stream' : 'Play house stream';
  const repeatLabel =
    repeatMode === 1 ? 'Repeat all' : repeatMode === 2 ? 'Repeat one' : 'Repeat off';

  const showAlsoPlaying = showAlso(alsoVisible, alsoMeta);
  const overflow = others.length - alsoVisible.length;

  const chooseStream = (memberIds: readonly string[]) => {
    returnFocusRef.current = true;
    setMoreOpen(false);
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
      data-art={showNowPlaying ? 'true' : 'false'}
      data-also={showAlsoPlaying ? 'true' : 'false'}
    >
    <section
      className={`fleet-bar-panel house-remote house-remote-${variant}`}
      aria-labelledby="fleet-actions-heading"
      data-idle={status.isIdle ? 'true' : 'false'}
      data-art={showNowPlaying ? 'true' : 'false'}
      data-paused={status.isPaused ? 'true' : 'false'}
    >
      <div className="house-remote-body">
        {showNowPlaying ? (
          <Link
            to={artHref}
            className="house-remote-art"
            aria-label={
              focused?.image
                ? `Now playing artwork — open ${focused.primary}`
                : `Open ${focused?.primary ?? 'player'}`
            }
          >
            <StickyArt
              src={
                focused?.leadId
                  ? playerArtSrc(focused.leadId, focused.image)
                  : ''
              }
              className="house-remote-art-img"
              empty={
                <span className="house-remote-art-empty" aria-hidden="true">
                  <span className="house-remote-art-glyph" />
                </span>
              }
            />
          </Link>
        ) : null}
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
          <p className="house-remote-primary" title={focused?.primary ?? status.primary}>
            {titleHref ? (
              <Link to={titleHref} className="house-remote-status-link">
                {focused?.primary ?? status.primary}
              </Link>
            ) : (
              (focused?.primary ?? status.primary)
            )}
          </p>
          {albumLine ? <p className="house-remote-album">{albumLine}</p> : null}
          {(focused?.detail ?? status.detail) ? (
            <p className="house-remote-detail" title={focused?.detail || status.detail}>
              {focused?.detail || status.detail}
            </p>
          ) : null}
        </div>
      </div>

      <div className="house-remote-foot">
        {showNowPlaying && place ? <SpeakerChip place={place} rows={roster} /> : null}
        {showNowPlaying && totlen > 0 ? (
          <SeekBar
            key={lead?.id ?? 'house-seek'}
            initialSecs={secs}
            totlen={totlen}
            playing={streamPlaying && (lead?.state === 'play' || lead?.state === 'stream')}
            canSeek={canSeek}
            onSeek={
              canSeek
                ? (seconds) =>
                    commandTargets(
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
          {showNowPlaying ? (
            <div className="house-remote-transport" role="group" aria-label="House stream">
              <button
                type="button"
                className="house-icon-btn"
                disabled={targets.length === 0}
                aria-label="Previous track"
                onClick={() => commandTargets('back', (id) => api.back(id))}
              >
                <IconPrev />
              </button>
              <button
                ref={playButtonRef}
                type="button"
                className="house-icon-btn house-icon-btn-play"
                disabled={targets.length === 0}
                aria-label={playLabel}
                onClick={toggleStream}
              >
                {streamPlaying ? <IconPause /> : <IconPlay />}
              </button>
              <button
                type="button"
                className="house-icon-btn"
                disabled={targets.length === 0}
                aria-label="Next track"
                onClick={() => commandTargets('skip', (id) => api.skip(id))}
              >
                <IconNext />
              </button>
              <button
                type="button"
                className="house-icon-btn house-icon-btn-mode"
                disabled={targets.length === 0}
                aria-label={shuffleOn ? 'Shuffle on' : 'Shuffle off'}
                aria-pressed={shuffleOn}
                onClick={() =>
                  commandTargets(
                    'shuffle',
                    (id) => api.setShuffle(id, shuffleOn ? 0 : 1),
                    { shuffle: shuffleOn ? 0 : 1 },
                  )
                }
              >
                <IconShuffle />
              </button>
              <button
                type="button"
                className="house-icon-btn house-icon-btn-mode"
                disabled={targets.length === 0}
                aria-label={repeatLabel}
                aria-pressed={repeatMode !== 0}
                onClick={() => {
                  const next = nextRepeat(repeatMode);
                  commandTargets('repeat', (id) => api.setRepeat(id, next), { repeat: next });
                }}
              >
                <IconRepeat one={repeatMode === 2} />
              </button>
            </div>
          ) : null}

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
        </div>
        <p className="house-remote-keys">
          Space or K play/pause · arrows or J/L skip · M mute
        </p>
      </div>
    </section>

      {showAlsoPlaying ? (
        <section className="house-also" aria-label="Also playing">
          <div className="house-also-head">
            <div className="house-also-count">
              {overflow > 0 ? (
                <>
                  {`${ALSO_PLAYING_VISIBLE} other streams + `}
                  <button
                    type="button"
                    className="house-also-more"
                    aria-expanded={moreOpen}
                    aria-label={`${overflow} more streams`}
                    onClick={() => setMoreOpen((open) => !open)}
                  >
                    {overflow} more
                  </button>
                </>
              ) : (
                alsoMeta
              )}
            </div>
            {moreOpen && overflow > 0 ? (
              <ul className="house-also-more-list" aria-label="More streams">
                {others.slice(ALSO_PLAYING_VISIBLE).map((source) => (
                  <li key={source.key}>
                    <button type="button" onClick={() => chooseStream(source.memberIds)}>
                      {source.primary}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="house-also-list">
            {alsoVisible.map((source) => (
              <AlsoStream
                key={source.key}
                source={source}
                devices={devices}
                sync={sync}
                onFocus={() => chooseStream(source.memberIds)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function showAlso(visible: { length: number }, meta: string): boolean {
  return visible.length > 0 && meta.length > 0;
}

function SpeakerChip({ place, rows }: { place: string; rows: SpeakerRosterRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="house-where-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {place}
      </button>
      {open ? (
        <SpeakerDialog place={place} rows={rows} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function SpeakerDialog({
  place,
  rows,
  onClose,
}: {
  place: string;
  rows: SpeakerRosterRow[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const heading = rosterHeading(rows);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return undefined;
    dialog.showModal();
    closeRef.current?.focus();
    return undefined;
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="house-roster-dialog"
      aria-labelledby="house-speaker-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="house-roster-dialog-head">
        <div>
          <h2 id="house-speaker-dialog-title">{heading}</h2>
          <p>{place}</p>
        </div>
        <button ref={closeRef} type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <SpeakerRoster rows={rows} />
    </dialog>
  );
}

function SpeakerRoster({ rows }: { rows: SpeakerRosterRow[] }) {
  return (
    <ul className="house-roster" aria-label="Speakers on this stream">
      {rows.map((row) => (
        <li key={row.id}>
          <span className="house-roster-name">{row.name}</span>
          <span className="house-roster-role">{row.roleLabel}</span>
          <span className={row.muted ? 'house-roster-vol is-muted' : 'house-roster-vol'}>
            {row.muted ? 'Muted' : row.volume}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AlsoStream({
  source,
  devices,
  sync,
  onFocus,
}: {
  source: HouseStreamSource;
  devices: PlayerStatus[];
  sync: SyncState | null;
  onFocus: () => void;
}) {
  const rows = speakerRoster(source, devices, sync);
  const place = streamPlaceLabel(rows.length, rows[0]?.name ?? '');
  return (
    <button type="button" className="house-also-open" onClick={onFocus}>
      <StickyArt
        src={source.leadId ? playerArtSrc(source.leadId, source.image) : ''}
        className="house-also-thumb"
        empty={<span className="house-also-thumb house-also-thumb-empty" aria-hidden="true" />}
      />
      <span className="house-also-copy">
        <span className="house-also-place">{place}</span>
        <span className="house-also-title">{source.primary}</span>
      </span>
    </button>
  );
}
