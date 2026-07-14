'use client';

// DESIGN-008 D-11 / DESIGN-009 D-08 / DESIGN-026 D-08 — host glue shared by the /library grid and
// the /ledger spreadsheet: the chip copy (the ported @hnet/ui FilterChip is i18n-free) and the
// bounded-range / single-select chips. All wear the exact same chip skin + overlay-popover geometry
// (chipPopoverStyle), so filters read identically across the browse surfaces (ADR-015: editors
// overlay, the bar never grows).
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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

/**
 * The shared popover open/position/dismiss contract of the host chips (same as @hnet/ui FilterChip):
 * viewport-clamped fixed positioning via chipPopoverStyle; dismissed by outside click, Escape,
 * resize, and any outside scroll. One implementation so every host chip stays in lockstep.
 */
function useChipPopover(rootRef: React.RefObject<HTMLSpanElement | null>) {
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<CSSProperties | undefined>(undefined);

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
  }, [open, rootRef]);

  return { open, popStyle, toggleOpen };
}

/** The shared chip SHELL: pill + label·CSV + caret, the clear ✕ when active, and the overlay
 *  popover slot. Hosts supply the editor body; the skin/geometry stays identical everywhere. */
function HostChip({
  label,
  csv,
  empty,
  onClear,
  children,
}: {
  label: string;
  csv: string;
  empty: boolean;
  onClear: () => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const { open, popStyle, toggleOpen } = useChipPopover(rootRef);
  return (
    <span ref={rootRef} className={`hnet-filter-chip${empty ? ' is-empty' : ''}`}>
      <button
        type="button"
        className="hnet-chip-open"
        aria-haspopup="true"
        aria-expanded={open}
        title={`Edit the ${label} filter`}
        onClick={toggleOpen}
      >
        <span className="hnet-chip-label">
          {label}
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
          aria-label={`Clear the ${label} filter`}
          title={`Clear the ${label} filter`}
          onClick={onClear}
        >
          ✕
        </button>
      ) : null}
      {open ? (
        <div
          className="hnet-chip-popover"
          role="dialog"
          aria-label={`Edit the ${label} filter`}
          style={popStyle}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}

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
  const empty = min === undefined && max === undefined;
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
    <HostChip label="Rating" csv={csv} empty={empty} onClear={() => onChange(undefined, undefined)}>
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
    </HostChip>
  );
}

/** Compact "Mar 4, 2022" for the date-range chip CSV. */
function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * DESIGN-026 D-08 (PLAN-029) — the bounded DATE-range chip (Release Date / First Aired). Same host
 * skin + overlay geometry as RatingChip; edits `YYYY-MM-DD` bounds the host maps to the wire's
 * releasedFrom/releasedTo ISO instants.
 */
export function DateRangeChip({
  label,
  from,
  to,
  onChange,
}: {
  label: string;
  /** `YYYY-MM-DD` or undefined. */
  from: string | undefined;
  to: string | undefined;
  onChange: (from: string | undefined, to: string | undefined) => void;
}) {
  const empty = from === undefined && to === undefined;
  const csv =
    from !== undefined && to !== undefined
      ? `${shortDay(from)} – ${shortDay(to)}`
      : from !== undefined
        ? `after ${shortDay(from)}`
        : to !== undefined
          ? `before ${shortDay(to)}`
          : '';
  const bound = (raw: string): string | undefined => (raw === '' ? undefined : raw);

  return (
    <HostChip label={label} csv={csv} empty={empty} onClear={() => onChange(undefined, undefined)}>
      <div className="rating-editor">
        <label className="rating-editor__bound">
          <span>From</span>
          <input
            type="date"
            value={from ?? ''}
            onChange={(e) => onChange(bound(e.target.value), to)}
            aria-label={`${label} from`}
          />
        </label>
        <label className="rating-editor__bound">
          <span>To</span>
          <input
            type="date"
            value={to ?? ''}
            onChange={(e) => onChange(from, bound(e.target.value))}
            aria-label={`${label} to`}
          />
        </label>
        <p className="rating-editor__hint muted">{label} range, inclusive</p>
      </div>
    </HostChip>
  );
}

/**
 * DESIGN-026 D-07/D-08 (PLAN-029) — the SINGLE-select facet chip (per-user Watched / Read states —
 * the wire takes exactly one state). A radio list in the shared popover; "Any" clears.
 */
export function SelectChip({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string | undefined) => void;
}) {
  const active = options.find((o) => o.value === value);
  return (
    <HostChip label={label} csv={active?.label ?? ''} empty={active === undefined} onClear={() => onChange(undefined)}>
      <ul className="hnet-chip-checklist" role="radiogroup" aria-label={`${label} options`}>
        <li>
          <label className="hnet-chip-check">
            <input
              type="radio"
              name={`select-chip-${label}`}
              checked={active === undefined}
              onChange={() => onChange(undefined)}
            />
            <span>Any</span>
          </label>
        </li>
        {options.map((o) => (
          <li key={o.value}>
            <label className="hnet-chip-check">
              <input
                type="radio"
                name={`select-chip-${label}`}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
              />
              <span>{o.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </HostChip>
  );
}
