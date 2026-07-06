// @vitest-environment jsdom
//
// Component tests for the shared CUSTOM narrowing <Autocomplete> (PLAN-019; DDD-003 T-112) that
// replaces the native <datalist>. The whole point of the rewrite is that the listbox renders ONLY
// the matching <li role="option">s IN THE DOM — which is exactly what makes it testable (a native
// <datalist> renders every <option> in jsdom regardless of input, so narrowing is unobservable).
// Plain-DOM assertions only (the shared package has no jest-dom). Copy is host-injected via `labels`
// (no i18n / no I18nextProvider — that is the host's concern).

import { useState, type JSX } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Autocomplete, filterSuggestions, type AutocompleteLabels } from './Autocomplete';

afterEach(cleanup);

const labels: AutocompleteLabels = {
  ariaLabel: 'Filter value',
  placeholder: 'value…',
  noMatches: 'No matches',
};

/** A controlled harness — the component owns nothing; the host owns `value`. */
function Harness({
  suggestions,
  onCommit,
  initial = '',
  topN,
}: {
  suggestions: string[];
  onCommit: (v: string) => void;
  initial?: string;
  topN?: number;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <Autocomplete
      value={value}
      onChange={setValue}
      suggestions={suggestions}
      onCommit={onCommit}
      labels={labels}
      topN={topN}
      position="overlay"
    />
  );
}

const POOL10 = Array.from({ length: 10 }, (_, i) => `TR-${String(i + 1).padStart(2, '0')}`); // TR-01..TR-10
const optionTexts = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');

describe('filterSuggestions (pure)', () => {
  it('narrows by case-insensitive SUBSTRING, prefix matches first, capped to n', () => {
    const pool = ['alpha', 'beta', 'gamma', 'alphabet'];
    // 'a' — prefix (alpha, alphabet) ranked before substring (beta, gamma).
    expect(filterSuggestions('a', pool, 8)).toEqual(['alpha', 'alphabet', 'beta', 'gamma']);
    // case-insensitive; prefix 'beta' before substring 'alphabet'.
    expect(filterSuggestions('BET', pool, 8)).toEqual(['beta', 'alphabet']);
  });

  it('empty query → the first n of the pool (a few, NOT all, NOT none)', () => {
    expect(filterSuggestions('', POOL10, 8)).toEqual(POOL10.slice(0, 8));
    expect(filterSuggestions('   ', POOL10, 8)).toEqual(POOL10.slice(0, 8)); // whitespace = empty
  });

  it('caps the result at n', () => {
    expect(filterSuggestions('tr', POOL10, 5)).toHaveLength(5); // all 10 match "tr"; capped to 5
  });

  it('returns [] when nothing matches', () => {
    expect(filterSuggestions('zzz', POOL10, 8)).toEqual([]);
  });
});

describe('Autocomplete (narrowing in the DOM)', () => {
  it('renders ONLY matching options — fewer than the full pool — case-insensitively', () => {
    const { container, getByRole } = render(<Harness suggestions={POOL10} onCommit={vi.fn()} topN={20} />);
    const input = getByRole('combobox') as HTMLInputElement;
    // Lower-case query proves case-insensitivity; 'tr-0' matches TR-01..TR-09 but NOT TR-10.
    fireEvent.change(input, { target: { value: 'tr-0' } });
    const shown = optionTexts(container);
    expect(shown).toEqual(POOL10.slice(0, 9)); // TR-01..TR-09
    expect(shown.length).toBeLessThan(POOL10.length); // strictly NARROWED
    expect(shown).not.toContain('TR-10');
  });

  it('caps the rendered options at topN', () => {
    const { container, getByRole } = render(<Harness suggestions={POOL10} onCommit={vi.fn()} topN={3} />);
    fireEvent.change(getByRole('combobox'), { target: { value: 'tr' } }); // all 10 match
    expect(optionTexts(container)).toHaveLength(3);
  });

  it('empty query → topN of the pool (a few, not all, not none)', () => {
    const { container, getByRole } = render(<Harness suggestions={POOL10} onCommit={vi.fn()} topN={4} />);
    fireEvent.focus(getByRole('combobox')); // opens with an empty draft
    const shown = optionTexts(container);
    expect(shown).toEqual(POOL10.slice(0, 4));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(POOL10.length);
  });
});

describe('Autocomplete (free-typeable invariant)', () => {
  it('commits the RAW draft on Enter even with zero matches', () => {
    const onCommit = vi.fn();
    const { container, getByRole } = render(<Harness suggestions={['AAA', 'BBB']} onCommit={onCommit} />);
    const input = getByRole('combobox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'TR-99' } }); // matches nothing
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
    // The no-matches message is shown (labels.noMatches provided), but the value still commits.
    expect(container.querySelector('.hnet-ac-empty')?.textContent).toBe('No matches');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('TR-99');
  });
});

describe('Autocomplete (keyboard)', () => {
  it('ArrowDown sets aria-activedescendant; Enter commits the active option', () => {
    const onCommit = vi.fn();
    const { getByRole } = render(<Harness suggestions={POOL10} onCommit={onCommit} topN={20} />);
    const input = getByRole('combobox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'TR-0' } }); // TR-01..TR-09
    expect(input.getAttribute('aria-activedescendant')).toBeNull(); // no active option yet

    fireEvent.keyDown(input, { key: 'ArrowDown' }); // → first option active
    const desc = input.getAttribute('aria-activedescendant');
    expect(desc).toBeTruthy();
    const activeOpt = document.getElementById(desc!);
    expect(activeOpt?.getAttribute('aria-selected')).toBe('true');
    expect(activeOpt?.textContent).toBe('TR-01');

    fireEvent.keyDown(input, { key: 'ArrowDown' }); // → second option active
    const desc2 = input.getAttribute('aria-activedescendant');
    expect(document.getElementById(desc2!)?.textContent).toBe('TR-02');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('TR-02'); // the ACTIVE option, not the raw draft
  });

  it('Escape closes the listbox, RETAINS the value, and stops propagation (host popover stays open)', () => {
    const onCommit = vi.fn();
    const parentKey = vi.fn();
    const { container, getByRole } = render(
      <div onKeyDown={parentKey}>
        <Harness suggestions={POOL10} onCommit={onCommit} />
      </div>,
    );
    const input = getByRole('combobox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'TR-0' } });
    expect(container.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(container.querySelector('[role="listbox"]')).toBeNull(); // closed
    expect(input.value).toBe('TR-0'); // value retained (NOT cleared)
    expect(parentKey).not.toHaveBeenCalled(); // stopPropagation → the FilterChip popover won't close
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('Autocomplete (mouse + a11y)', () => {
  it('picks an option via onMouseDown (input never blurs the pick away)', () => {
    const onCommit = vi.fn();
    const { container, getByRole } = render(<Harness suggestions={POOL10} onCommit={onCommit} topN={20} />);
    fireEvent.change(getByRole('combobox'), { target: { value: 'TR-0' } });
    const opts = [...container.querySelectorAll('[role="option"]')] as HTMLElement[];
    fireEvent.mouseDown(opts[2]!); // TR-03
    expect(onCommit).toHaveBeenCalledWith('TR-03');
    // The pick refocuses the input so the user can keep typing (the host clears `value` on commit).
    expect(document.activeElement).toBe(getByRole('combobox'));
  });

  it('exposes the combobox ARIA contract', () => {
    const { container, getByRole } = render(<Harness suggestions={POOL10} onCommit={vi.fn()} />);
    const input = getByRole('combobox') as HTMLInputElement;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false'); // closed initially
    expect(input.getAttribute('aria-label')).toBe('Filter value');

    fireEvent.change(input, { target: { value: 'TR' } });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    // The input controls the listbox by id, and the id is COLON-FREE (selector-safe).
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    expect(listbox.id.includes(':')).toBe(false);
    expect(container.querySelector(`#${listbox.id}`)).toBe(listbox);
  });
});
