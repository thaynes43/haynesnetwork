// Generic, i18n-free filter cells (DESIGN-007 §4.4/§4.10.4) shared across sections. These are the
// click-to-filter primitives lifted out of Work's `explorer/cells.tsx`:
//   • FilterCell — a value cell that toggles a filter in place (attribute), or, given a `drill` key,
//     cascades (set filter AND advance to the next grain);
//   • BinChip — a long opaque id rendered COMPACT (the first id segment) + a sibling copy control;
//   • CopyableId — the compact-display + copy-to-clipboard control BinChip composes.
//
// All copy is host-injected via `labels` (no `useTranslation` here — a stray hook would silently
// passthrough-fail under a different host's i18n instance). The class namespace is the host's via
// `classPrefix` (default neutral `hnet`); all hues come from the global theme tokens the host's CSS
// binds. The host owns the field union `F` and the predicate/match-mode; these cells never reference
// a reference-domain literal.

import {
  useCallback,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

/** Host-injected copy for a filter value cell. */
export interface FilterCellLabels {
  /** cascade-id (drill) cell tooltip. */
  drillTip: string;
  /** inactive attribute cell tooltip ("click to filter"). */
  filterTip: string;
  /** active attribute cell tooltip ("click to remove"). */
  removeTip: string;
}

/** Host-injected copy for the copy-to-clipboard control. */
export interface CopyableIdLabels {
  /** the transient "Copied" announcement + tooltip after a copy. */
  copied: string;
  /** the idle copy-button tooltip. */
  tip: string;
  /** the idle copy-button aria-label. */
  label: string;
}

/** Host-injected copy for a BinChip (the toggle tips + the nested copy control's copy). */
export interface BinChipLabels {
  filterTip: string;
  removeTip: string;
  copy: CopyableIdLabels;
}

export interface FilterCellProps<F extends string> {
  field: F;
  value: string | null | undefined;
  /** override the displayed text (the filter value still rides `value`). */
  display?: string;
  /** custom render (a badge/chip); falls back to `display ?? value`. */
  children?: ReactNode;
  mono?: boolean;
  /** is this field already filtered to this value? (highlight + "remove" affordance). */
  active: boolean;
  /** the grain to advance to when this is a cascade-id cell; omit for pure attribute (toggle) cells. */
  drill?: string;
  /** advance to the next grain (cascade cells); optional — omit for pure toggle cells. */
  onDrill?: (field: F, value: string, nextGrain: string) => void;
  onToggle: (field: F, value: string) => void;
  /** host-injected copy. */
  labels: FilterCellLabels;
  /** class namespace (default neutral `hnet`). */
  classPrefix?: string;
}

/**
 * A Discover-consistent value cell (the `efcell` analogue). With `drill` (the next-grain key) it is
 * a CASCADE id: clicking it sets the filter AND advances to that grain (rendered as a `›` link).
 * Without `drill` it is an ATTRIBUTE: clicking toggles a filter in place (highlighted when active;
 * click again — or the chip — to remove). A null/empty value renders a muted dash with no
 * affordance. The custom rendering (`children`, e.g. a badge) overrides the default text. All
 * hues/affordances come from CSS classes (no hex).
 */
export function FilterCell<F extends string>({
  field,
  value,
  display,
  children,
  mono,
  active,
  drill,
  onDrill,
  onToggle,
  labels,
  classPrefix = 'hnet',
}: FilterCellProps<F>): JSX.Element {
  const p = classPrefix;
  if (value == null || value === '') return <span className={`${p}-sub`}>—</span>;
  const cls = `${p}-efcell${mono ? ` ${p}-mono` : ''}${active ? ' filtered' : ''}${drill ? ' drill' : ''}`;
  const title = drill ? labels.drillTip : active ? labels.removeTip : labels.filterTip;
  return (
    <span
      className={cls}
      role="button"
      tabIndex={0}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (drill) onDrill?.(field, value, drill);
        else onToggle(field, value);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        if (drill) onDrill?.(field, value, drill);
        else onToggle(field, value);
      }}
    >
      {children ?? display ?? value}
    </span>
  );
}

/**
 * A long opaque id (e.g. a 36-char UUID Bin) rendered as a COMPACT mono chip + a sibling copy
 * control. The chip shows a short form (its caller supplies via `toggle`); the FULL id rides the
 * `title` hover and is what the copy button writes to the clipboard. Clicking copy swaps the icon
 * for a check + announces "Copied" for ~1s. The copy button is a SIBLING of `toggle` (never nested
 * inside it) so there is no interactive-in-interactive nesting, and it `stopPropagation`s so a copy
 * click never toggles the surrounding filter cell.
 */
export function CopyableId({
  value,
  toggle,
  labels,
  classPrefix = 'hnet',
}: {
  value: string;
  /** the compact display target this copy button sits BESIDE (rendered first) — usually a
   *  click-to-filter short chip, but any node (a plain short label) works. */
  toggle: ReactNode;
  labels: CopyableIdLabels;
  classPrefix?: string;
}): JSX.Element {
  const p = classPrefix;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    (e: MouseEvent | KeyboardEvent) => {
      // Must NOT bubble to the filter-toggle target beside it (stopPropagation), nor submit a form.
      e.stopPropagation();
      e.preventDefault();
      void navigator.clipboard?.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1000);
    },
    [value],
  );

  return (
    <span className={`${p}-copyid`}>
      {toggle}
      <button
        type="button"
        className={`${p}-copybtn${copied ? ' copied' : ''}`}
        title={copied ? labels.copied : labels.tip}
        aria-label={copied ? labels.copied : labels.label}
        // A copy click on a child of an interactive cell must not bubble to it (mousedown too, so a
        // focus-then-click never starts a toggle); the button itself owns the click.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={copy}
      >
        <span className={`${p}-copy-glyph`} aria-hidden="true">
          {copied ? '✓' : '⧉'}
        </span>
        <span role="status" aria-live="polite" className={`${p}-vh`}>
          {copied ? labels.copied : ''}
        </span>
      </button>
    </span>
  );
}

/** A compact mono chip for a long opaque id (a 36-char UUID in the live backend) that can't fit
 *  inline: it renders the first id segment as the click-to-FILTER target + a sibling copy-the-full-id
 *  control via {@link CopyableId}. The full id rides the `title` hover. */
export function BinChip({
  bin,
  active,
  onToggle,
  labels,
  classPrefix = 'hnet',
}: {
  bin: string;
  /** is the bin already filtered to this value? (the `.filtered` highlight). */
  active: boolean;
  /** toggle the bin filter (click the short chip); omit for a non-interactive chip. */
  onToggle?: (value: string) => void;
  labels: BinChipLabels;
  classPrefix?: string;
}): JSX.Element {
  const p = classPrefix;
  const short = bin.split('-')[0] || bin;
  const interactive = onToggle != null;
  // The full bin ALWAYS rides the `title` hover (readability — nothing is permanently hidden); the
  // filter affordance is conveyed via `aria-label` so we don't clobber the full-value tooltip.
  const toggle = (
    <span
      className={`${p}-bin-chip ${p}-mono${active ? ' filtered' : ''}`}
      title={bin}
      {...(interactive
        ? {
            role: 'button' as const,
            tabIndex: 0,
            'aria-pressed': active,
            'aria-label': active ? labels.removeTip : labels.filterTip,
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              onToggle!(bin);
            },
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              onToggle!(bin);
            },
          }
        : {})}
    >
      {short}
    </span>
  );
  return <CopyableId value={bin} toggle={toggle} labels={labels.copy} classPrefix={p} />;
}
