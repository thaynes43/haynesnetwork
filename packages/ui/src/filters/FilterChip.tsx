'use client';

// The shared, EDITABLE multi-value filter chip + its inline editor popover (PLAN-018 §3 D-1;
// DESIGN-007 §4.11), ported from demo-console (DESIGN-008 D-10). A chip renders one field's
// OR-ed values in CSV form and opens a click-to-edit popover:
//   • enum fields → a multi-select CHECKLIST of the field's known values;
//   • unbounded fields → a TYPEAHEAD reusing the host's suggestions, each current value a removable
//     sub-token.
// The ✕ clears the whole field (rendered only while the field HAS values — an empty chip is a
// pure "open the editor" affordance, so hnet hosts can keep every field's chip permanently in the
// bar without dangling clear buttons).
//
// ADR-015 (no reorientation): the chip bar is a fixed-height reserved row, so the editor is an
// OVERLAY — positioned `fixed` and clamped to the viewport (chipPopoverStyle below). Fixed
// positioning (a port-time divergence from the donor's `absolute`) is what lets the popover
// escape a horizontally-scrolling chip bar unclipped AND stay on-screen at 390px-wide viewports;
// the donor SPA only ever anchored chips in a wide static toolbar. This component is i18n-FREE
// and theme-FREE: the host injects every copy string via `labels` and chooses the class namespace
// via `classPrefix` (default `hnet`); all hues come from the global theme tokens the host's CSS
// binds. The optional per-value tint rides a `--fc` custom property (no hex).

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Autocomplete } from './Autocomplete';

/** Host-injected copy for the chip (no i18n inside the shared component). `field`/`value` are
 *  interpolated by the host (already localized). */
export interface FilterChipLabels {
  /** the "open the editor" button tooltip, given the field label. */
  editChip: (field: string) => string;
  /** the ✕ clear-field control aria-label/tooltip, given the field label. */
  clearChip: (field: string) => string;
  /** the typeahead input aria-label, given the field label. */
  addValue: (field: string) => string;
  /** a sub-token ✕ aria-label/tooltip, given the field label + value. */
  removeValue: (field: string, value: string) => string;
  /** the typeahead input placeholder. */
  valuePlaceholder: string;
  /** the typeahead "Add" button label. */
  add: string;
  /** the typeahead "no matches" message (shown when the narrowing listbox is open but empty). */
  noMatches?: string;
  /** enum: the message shown when the field has NO known values yet (empty facet). */
  noValues?: string;
}

/** Viewport-clamped `position: fixed` style for a chip-anchored popover. Pure — exported so a
 *  host's bespoke chip (e.g. a bounded-range editor) can reuse the exact same overlay geometry.
 *  Clamps left so a `maxWidth`-wide panel never overflows a narrow (390px) viewport, and caps
 *  height to what fits below the anchor (min 160px so it stays usable near the fold). */
export function chipPopoverStyle(
  anchor: { bottom: number; left: number },
  viewport: { width: number; height: number },
  { maxWidth = 320, margin = 8, gap = 6 }: { maxWidth?: number; margin?: number; gap?: number } = {},
): CSSProperties {
  const width = Math.min(maxWidth, viewport.width - margin * 2);
  const left = Math.min(Math.max(margin, anchor.left), Math.max(margin, viewport.width - width - margin));
  const top = anchor.bottom + gap;
  const maxHeight = Math.max(160, Math.min(360, viewport.height - top - margin));
  return { position: 'fixed', top, left, maxWidth: width, maxHeight };
}

export interface FilterChipProps {
  /** the localized field label (e.g. "State"). */
  fieldLabel: string;
  /** the raw values (used for add/remove callbacks + the typeahead sub-tokens). */
  values: string[];
  /** the values mapped to display text (enum → localized label); defaults to `values`. */
  displayValues?: string[];
  kind: 'enum' | 'unbounded';
  /** enum: the known values to offer in the checklist (raw tokens). */
  enumValues?: readonly string[];
  /** enum: map a raw value to its display label for the checklist + CSV. */
  enumLabel?: (value: string) => string;
  /** unbounded: suggestion pool for the narrowing typeahead (stream-derived). */
  suggestions?: string[];
  /** optional chip tint (a CSS var; no hex) — e.g. Side A/B. */
  tint?: string;
  /** host-injected copy. */
  labels: FilterChipLabels;
  /** class namespace for the chip's elements (default `hnet`). */
  classPrefix?: string;
  /** add one value to this field (OR-in). */
  onAdd: (value: string) => void;
  /** remove one value from this field; removing the last drops the chip. */
  onRemove: (value: string) => void;
  /** clear the whole field (the ✕). */
  onClear: () => void;
}

export function FilterChip({
  fieldLabel,
  values,
  displayValues,
  kind,
  enumValues,
  enumLabel,
  suggestions,
  tint,
  labels,
  classPrefix = 'hnet',
  onAdd,
  onRemove,
  onClear,
}: FilterChipProps): JSX.Element {
  const p = classPrefix;
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<CSSProperties | undefined>(undefined);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  const toggleOpen = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    if (rootRef.current !== null && typeof window !== 'undefined') {
      setPopStyle(
        chipPopoverStyle(rootRef.current.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    }
    setOpen(true);
  };

  // Close on an outside click, Escape, viewport resize, or an outside scroll (the fixed-position
  // overlay would detach from its anchor). The popover overlays; it never traps focus. NB: the
  // typeahead's own Escape stops propagation so the FIRST Escape only closes its listbox — this
  // handler then closes the popover on a subsequent Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const close = (): void => setOpen(false);
    const onScroll = (e: Event): void => {
      // Scrolling INSIDE the popover (its own overflow) must not close it.
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

  const label = (v: string): string => (enumLabel ? enumLabel(v) : v);
  const csv = (displayValues ?? values.map(label)).join(', ');
  const empty = values.length === 0;

  return (
    <span
      ref={rootRef}
      className={`${p}-filter-chip ${p}-chip-editable${empty ? ' is-empty' : ''}`}
      style={tint ? ({ ['--fc' as string]: tint } as CSSProperties) : undefined}
    >
      <button
        type="button"
        className={`${p}-chip-open`}
        aria-haspopup="true"
        aria-expanded={open}
        title={labels.editChip(fieldLabel)}
        onClick={toggleOpen}
      >
        <span className={`${p}-chip-label`}>
          {fieldLabel}
          {csv !== '' ? (
            <>
              {' · '}
              <span className={`${p}-chip-csv`}>{csv}</span>
            </>
          ) : null}
        </span>
        <span className={`${p}-chip-caret`} aria-hidden="true" />
      </button>
      {!empty ? (
        <button
          type="button"
          className={`${p}-chip-x`}
          aria-label={labels.clearChip(fieldLabel)}
          title={labels.clearChip(fieldLabel)}
          onClick={onClear}
        >
          ✕
        </button>
      ) : null}

      {open && (
        <div
          className={`${p}-chip-popover`}
          role="dialog"
          aria-label={labels.editChip(fieldLabel)}
          style={popStyle}
        >
          {kind === 'enum' ? (
            (enumValues ?? []).length === 0 ? (
              <p className={`${p}-sub`}>{labels.noValues}</p>
            ) : (
              <ul className={`${p}-chip-checklist`}>
                {(enumValues ?? []).map((ev) => {
                  const checked = values.includes(ev);
                  return (
                    <li key={ev}>
                      <label className={`${p}-chip-check`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => (checked ? onRemove(ev) : onAdd(ev))}
                        />
                        <span>{label(ev)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            <UnboundedEditor
              fieldLabel={fieldLabel}
              values={values}
              suggestions={suggestions ?? []}
              labels={labels}
              classPrefix={p}
              onAdd={onAdd}
              onRemove={onRemove}
            />
          )}
        </div>
      )}
    </span>
  );
}

/** The unbounded-field editor: removable sub-tokens for the current values + a narrowing typeahead
 *  to add. The typeahead is the shared <Autocomplete> in `flow` position — its in-DOM listbox grows
 *  the already-scrolling popover (no clipping) instead of overlaying it. FREE-TYPEABLE: an
 *  unknown value still commits on Enter / Add (suggestions are a convenience, never a gate). */
function UnboundedEditor({
  fieldLabel,
  values,
  suggestions,
  labels,
  classPrefix,
  onAdd,
  onRemove,
}: {
  fieldLabel: string;
  values: string[];
  suggestions: string[];
  labels: FilterChipLabels;
  classPrefix: string;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}): JSX.Element {
  const p = classPrefix;
  const [draft, setDraft] = useState('');

  const commit = (raw: string): void => {
    const v = raw.trim();
    if (!v) return;
    onAdd(v);
    setDraft('');
  };

  return (
    <div className={`${p}-chip-typeahead`}>
      <div className={`${p}-chip-tokens`}>
        {values.map((v) => (
          <span className={`${p}-chip-token`} key={v}>
            <span className={`${p}-mono`}>{v}</span>
            <button
              type="button"
              className={`${p}-chip-token-x`}
              aria-label={labels.removeValue(fieldLabel, v)}
              title={labels.removeValue(fieldLabel, v)}
              onClick={() => onRemove(v)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className={`${p}-chip-add`}>
        <Autocomplete
          value={draft}
          onChange={setDraft}
          suggestions={suggestions}
          onCommit={commit}
          labels={{
            ariaLabel: labels.addValue(fieldLabel),
            placeholder: labels.valuePlaceholder,
            noMatches: labels.noMatches,
          }}
          classPrefix={p}
          position="flow"
        />
        <button type="button" className={`${p}-addbtn`} onClick={() => commit(draft)}>
          {labels.add}
        </button>
      </div>
    </div>
  );
}
