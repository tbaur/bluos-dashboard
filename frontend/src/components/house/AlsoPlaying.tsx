import { useState } from 'react';
import type { PlayerStatus, SyncState } from '@/api/types';
import { StickyArt } from '@/components/StickyArt';
import { playerArtSrc } from '@/lib/artwork';
import type { HouseStreamSource } from '@/lib/fleetStatus';
import { ALSO_PLAYING_VISIBLE, speakerRoster, streamPlaceLabel } from '@/lib/houseRoster';

interface AlsoPlayingProps {
  others: HouseStreamSource[];
  meta: string;
  devices: PlayerStatus[];
  sync: SyncState | null;
  onChoose: (memberIds: readonly string[]) => void;
}

/** Streams other than the focused one. Choosing one moves the remote to it. */
export function AlsoPlaying({ others, meta, devices, sync, onChoose }: AlsoPlayingProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const visible = others.slice(0, ALSO_PLAYING_VISIBLE);
  const overflow = others.length - visible.length;
  const choose = (memberIds: readonly string[]) => {
    setMoreOpen(false);
    onChoose(memberIds);
  };
  return (
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
            meta
          )}
        </div>
        {moreOpen && overflow > 0 ? (
          <ul className="house-also-more-list" aria-label="More streams">
            {others.slice(ALSO_PLAYING_VISIBLE).map((source) => (
              <li key={source.key}>
                <button type="button" onClick={() => choose(source.memberIds)}>
                  {source.primary}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="house-also-list">
        {visible.map((source) => (
          <AlsoStream
            key={source.key}
            source={source}
            devices={devices}
            sync={sync}
            onFocus={() => choose(source.memberIds)}
          />
        ))}
      </div>
    </section>
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
