// The shared, EDITABLE multi-value filter chip + its inline editor popover (PLAN-018 §3 D-1;
// DESIGN-007 §4.11), used by BOTH Discover and Explore (and, later, Inventory). A chip renders one
// field's OR-ed values in CSV form and opens a click-to-edit popover:
//   • enum fields → a multi-select CHECKLIST of the field's known values;
//   • unbounded fields → a TYPEAHEAD reusing the host's suggestions, each current value a removable
//     sub-token.
// The ✕ clears the whole field; unchecking / removing the last value removes the chip.
//
// ADR-010: the chip bar is a fixed-height reserved row, so the editor is an ABSOLUTELY-positioned
// overlay (it must not reflow the bar or the pane). This component is i18n-FREE and theme-FREE: the
// host injects every copy string via `labels` and chooses the class namespace via `classPrefix`
// (default neutral `hnet`); all hues come from the global theme tokens the host's CSS binds. The
// optional per-value tint rides a `--fc` custom property (no hex).

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
  /** class namespace for the chip's elements (default neutral `hnet`). */
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
  const rootRef = useRef<HTMLSpanElement | null>(null);

  // Close on an outside click or Escape (the popover overlays; it never traps focus). NB: the
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
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = (v: string): string => (enumLabel ? enumLabel(v) : v);
  const csv = (displayValues ?? values.map(label)).join(', ');

  return (
    <span
      ref={rootRef}
      className={`${p}-filter-chip ${p}-chip-editable`}
      style={tint ? ({ ['--fc' as string]: tint } as CSSProperties) : undefined}
    >
      <button
        type="button"
        className={`${p}-chip-open`}
        aria-haspopup="true"
        aria-expanded={open}
        title={labels.editChip(fieldLabel)}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`${p}-chip-label`}>
          {fieldLabel} · <span className={`${p}-mono`}>{csv}</span>
        </span>
      </button>
      <button
        type="button"
        className={`${p}-chip-x`}
        aria-label={labels.clearChip(fieldLabel)}
        title={labels.clearChip(fieldLabel)}
        onClick={onClear}
      >
        ✕
      </button>

      {open && (
        <div className={`${p}-chip-popover`} role="dialog" aria-label={labels.editChip(fieldLabel)}>
          {kind === 'enum' ? (
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
 *  the already-scrolling popover (ADR-010, no clipping) instead of overlaying it. FREE-TYPEABLE: an
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
