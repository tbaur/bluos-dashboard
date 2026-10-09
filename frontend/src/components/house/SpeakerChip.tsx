import { useEffect, useRef, useState } from 'react';
import { rosterHeading, type SpeakerRosterRow } from '@/lib/houseRoster';

/** Speaker count for the focused stream; opens a dialog listing every player on it. */
export function SpeakerChip({ place, rows }: { place: string; rows: SpeakerRosterRow[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="house-where-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {place}
      </button>
      {open ? <SpeakerDialog place={place} rows={rows} onClose={close} /> : null}
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
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const requestClose = () => {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
      return;
    }
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="house-roster-dialog"
      aria-labelledby="house-speaker-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="house-roster-dialog-head">
        <div>
          <h2 id="house-speaker-dialog-title">{heading}</h2>
          <p>{place}</p>
        </div>
        <button ref={closeRef} type="button" className="btn" onClick={requestClose}>
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
