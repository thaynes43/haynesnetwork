'use client';

// The shared, CUSTOM narrowing autocomplete / typeahead (PLAN-019; DDD-003 T-112) that REPLACES the
// native HTML <datalist> used by every filter input (the chip editor's add-value box + the add-filter
// and quick-search boxes in Explore/Discover). A native <datalist> dumps the WHOLE pool, won't
// reliably narrow / cap / style / keyboard-navigate, renders inconsistently across browsers, and is
// untestable (jsdom renders all <option>s regardless of input). This component renders an in-DOM
// <ul role="listbox"> holding ONLY the matching options — which is precisely what makes it
// cross-browser-consistent AND unit-testable.
//
// It is fully CONTROLLED (value/onChange), theme-FREE and i18n-FREE (the host injects ALL copy via
// `labels` and picks the class namespace via `classPrefix`, default neutral `hnet`; it must never
// import react-i18next — see noI18n.guard.test.ts). The filtered options are derived DURING RENDER
// (no effect-driven option state) so it is StrictMode-safe; the only state is the open flag and the
// roving virtual-focus index.

import { useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';

/** Case-insensitive SUBSTRING match over `pool`, PREFIX matches ranked first, sliced to `n`. An
 *  EMPTY query returns the first `n` of the pool (a few, NOT all, NOT none) so opening the box always
 *  shows a useful starting set. Order is stable within each rank bucket (preserves pool order). Pure
 *  — exported so callers can unit-test the narrowing directly. */
export function filterSuggestions(query: string, pool: readonly string[], n = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return pool.slice(0, n);
  const prefix: string[] = [];
  const substr: string[] = [];
  for (const item of pool) {
    const idx = item.toLowerCase().indexOf(q);
    if (idx === 0) prefix.push(item);
    else if (idx > 0) substr.push(item);
  }
  return [...prefix, ...substr].slice(0, n);
}

/** Host-injected copy (no i18n inside the shared component). */
export interface AutocompleteLabels {
  /** the combobox input aria-label. */
  ariaLabel: string;
  /** the combobox input placeholder. */
  placeholder: string;
  /** optional message rendered when the listbox is open but nothing matches. */
  noMatches?: string;
}

export interface AutocompleteProps {
  /** the controlled draft text. */
  value: string;
  /** draft changed (the host owns the value). */
  onChange: (value: string) => void;
  /** the suggestion pool (stream-derived); narrowed + capped internally. */
  suggestions: string[];
  /** commit a value — the active option on Enter/Tab/click, OR the raw draft (FREE-TYPEABLE: unknown
   *  values still commit even with zero matches). The host decides what committing means. */
  onCommit: (value: string) => void;
  /** host-injected copy. */
  labels: AutocompleteLabels;
  /** class namespace (default neutral `hnet`). */
  classPrefix?: string;
  /** max options shown (default 8). */
  topN?: number;
  /** `flow` renders the listbox IN-FLOW (grows an already-scrolling container, e.g. the chip
   *  popover); `overlay` renders it absolutely-positioned under the input (for inputs that sit in an
   *  `overflow:visible` chrome row). */
  position: 'flow' | 'overlay';
}

export function Autocomplete({
  value,
  onChange,
  suggestions,
  onCommit,
  labels,
  classPrefix = 'hnet',
  topN = 8,
  position,
}: AutocompleteProps): JSX.Element {
  const p = classPrefix;
  const [open, setOpen] = useState(false);
  // The roving virtual-focus index. -1 = no active option (focus stays in the input so typing
  // continues). We DERIVE the clamped `active` during render so a stale index (after the options
  // shrink) never points past the end.
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Colon-free ids (React's `useId()` returns a colon-wrapped token like `:r0:`; colons are hostile
  // to CSS selectors and to aria-activedescendant lookups). Strip them so the ids stay selector-safe.
  const uid = useId().replace(/:/g, '');
  const listboxId = `${p}-ac-list-${uid}`;
  const optionId = (i: number): string => `${p}-ac-opt-${uid}-${i}`;

  // Derived DURING RENDER — never stored in state (StrictMode-safe; no effect-driven option list).
  const options = filterSuggestions(value, suggestions, topN);
  const active = open && activeIndex >= 0 && activeIndex < options.length ? activeIndex : -1;
  const hasPopup = open && (options.length > 0 || !!labels.noMatches);

  const commit = (raw: string): void => {
    onCommit(raw);
    setOpen(false);
    setActiveIndex(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(options.length > 0 ? 0 : -1);
        } else {
          setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        setOpen(true);
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        // The active option if one is highlighted, else the raw draft (free-typeable).
        commit(active >= 0 ? options[active]! : value);
        break;
      case 'Escape':
        // Close ONLY the listbox — and stopPropagation so a host popover (the FilterChip editor) does
        // NOT also close on the same Escape. The draft value is retained.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setActiveIndex(-1);
        break;
      case 'Tab':
        // Commit + close, but let focus move on (no preventDefault).
        if (active >= 0) commit(options[active]!);
        else {
          setOpen(false);
          setActiveIndex(-1);
        }
        break;
      default:
        break;
    }
  };

  return (
    <div className={`${p}-ac ${p}-ac--${position}`}>
      <input
        ref={inputRef}
        className={`${p}-search ${p}-ac-input`}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={hasPopup}
        aria-controls={listboxId}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        aria-label={labels.ariaLabel}
        placeholder={labels.placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Close on blur. Option picks use onMouseDown + preventDefault (below) so the input never
          // blurs before the pick registers.
          setOpen(false);
          setActiveIndex(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {hasPopup && (
        <ul id={listboxId} role="listbox" className={`${p}-ac-list`}>
          {options.length > 0 ? (
            options.map((opt, i) => (
              <li
                key={opt}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={`${p}-ac-option${i === active ? ' is-active' : ''}`}
                // onMouseDown + preventDefault: the input must NOT blur (which would close the list)
                // before the pick registers; then refocus so the user can keep typing.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(opt);
                  inputRef.current?.focus();
                }}
              >
                {opt}
              </li>
            ))
          ) : (
            <li className={`${p}-ac-empty`} aria-disabled="true">
              {labels.noMatches}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
