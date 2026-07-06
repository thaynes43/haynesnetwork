'use client';

// DESIGN-008 D-11 / DESIGN-009 D-08 — host glue shared by the /library grid and the /ledger
// spreadsheet: the chip copy (the ported @hnet/ui FilterChip is i18n-free) and the bounded
// rating-range chip. Both pages keep the exact same chip skin + overlay-popover geometry
// (chipPopoverStyle), so filters read identically across the two browse surfaces (ADR-015:
// editors overlay, the bar never grows).
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { chipPopoverStyle, type FilterChipLabels } from '@hnet/ui';

/** Host copy for the ported chips (the shared components are i18n-free — D-10). */
export const CHIP_LABELS: FilterChipLabels = {
  editChip: (f) => `Edit the ${f} filter`,
  clearChip: (f) => `Clear the ${f} filter`,
  addValue: (f) => `Add a ${f} value`,
  removeValue: (_f, v) => `Remove ${v}`,
  valuePlaceholder: 'Type a value…',
  add: 'Add',
  noMatches: 'No matches',
  noValues: 'Nothing to filter by yet — values appear as the metadata harvest runs.',
};

/** DESIGN-008 D-11 — the bounded rating-range chip. It wears the shared `hnet-` chip skin
 *  (same pill, same overlay-popover geometry via chipPopoverStyle) but edits a RANGE rather
 *  than a value set, so it is host glue rather than a FilterChip kind. */
export function RatingChip({
  min,
  max,
  onChange,
}: {
  min: number | undefined;
  max: number | undefined;
  onChange: (min: number | undefined, max: number | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<CSSProperties | undefined>(undefined);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const empty = min === undefined && max === undefined;

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (rootRef.current !== null) {
      setPopStyle(
        chipPopoverStyle(rootRef.current.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    }
    setOpen(true);
  };

  // Same dismissal contract as the shared FilterChip: outside click, Escape, resize, scroll.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    const onScroll = (e: Event) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const csv =
    min !== undefined && max !== undefined
      ? `${min}–${max}`
      : min !== undefined
        ? `≥ ${min}`
        : max !== undefined
          ? `≤ ${max}`
          : '';
  const bound = (raw: string): number | undefined => (raw === '' ? undefined : Number(raw));

  return (
    <span ref={rootRef} className={`hnet-filter-chip${empty ? ' is-empty' : ''}`}>
      <button
        type="button"
        className="hnet-chip-open"
        aria-haspopup="true"
        aria-expanded={open}
        title="Edit the Rating filter"
        onClick={toggleOpen}
      >
        <span className="hnet-chip-label">
          Rating
          {csv !== '' ? (
            <>
              {' · '}
              <span className="hnet-chip-csv">{csv}</span>
            </>
          ) : null}
        </span>
        <span className="hnet-chip-caret" aria-hidden="true" />
      </button>
      {!empty ? (
        <button
          type="button"
          className="hnet-chip-x"
          aria-label="Clear the Rating filter"
          title="Clear the Rating filter"
          onClick={() => onChange(undefined, undefined)}
        >
          ✕
        </button>
      ) : null}
      {open ? (
        <div
          className="hnet-chip-popover"
          role="dialog"
          aria-label="Edit the Rating filter"
          style={popStyle}
        >
          <div className="rating-editor">
            <label className="rating-editor__bound">
              <span>Min</span>
              <select
                value={min ?? ''}
                onChange={(e) => onChange(bound(e.target.value), max)}
                aria-label="Minimum rating"
              >
                <option value="">Any</option>
                {[9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n}+
                  </option>
                ))}
              </select>
            </label>
            <label className="rating-editor__bound">
              <span>Max</span>
              <select
                value={max ?? ''}
                onChange={(e) => onChange(min, bound(e.target.value))}
                aria-label="Maximum rating"
              >
                <option value="">Any</option>
                {[10, 9, 8, 7, 6, 5, 4, 3, 2].map((n) => (
                  <option key={n} value={n}>
                    up to {n}
                  </option>
                ))}
              </select>
            </label>
            <p className="rating-editor__hint muted">Rating, 0–10</p>
          </div>
        </div>
      ) : null}
    </span>
  );
}
