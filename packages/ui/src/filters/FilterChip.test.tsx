// @vitest-environment jsdom
//
// Component tests for the shared editable <FilterChip> (PLAN-018 §3 D-1): the click-to-edit popover
// — an enum CHECKLIST (check to OR-in, uncheck to remove) and an unbounded TYPEAHEAD (type/pick to
// add; each value a removable sub-token). The ✕ clears the whole field. Copy is host-injected via
// `labels` (no i18n / no I18nextProvider here — that is the host's concern). Plain-DOM assertions
// only (the shared package has no jest-dom).

import type { ReactElement } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FilterChip, type FilterChipLabels } from './FilterChip';

afterEach(cleanup);

const labels: FilterChipLabels = {
  editChip: (field) => `Edit the ${field} filter`,
  clearChip: (field) => `Clear the ${field} filter`,
  addValue: (field) => `Add a ${field} value`,
  removeValue: (field, value) => `Remove ${field} ${value}`,
  valuePlaceholder: 'value…',
  add: 'Add',
};

const wrap = (ui: ReactElement) => render(ui);

describe('FilterChip (enum checklist)', () => {
  it('renders the CSV value list and OR-s in / removes via the checklist', () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    const onClear = vi.fn();
    wrap(
      <FilterChip
        fieldLabel="State"
        values={['InProgress']}
        displayValues={['In Progress']}
        kind="enum"
        enumValues={['Pending', 'InProgress', 'Complete']}
        enumLabel={(v) => v}
        labels={labels}
        onAdd={onAdd}
        onRemove={onRemove}
        onClear={onClear}
      />,
    );
    // The chip shows the CSV body (display labels).
    expect(screen.getByText('In Progress')).toBeTruthy();

    // Open the editor.
    fireEvent.click(screen.getByTitle('Edit the State filter'));
    const dialog = screen.getByRole('dialog');
    // The active value is checked; checking another OR-s it in.
    const complete = within(dialog).getByLabelText('Complete') as HTMLInputElement;
    expect(complete.checked).toBe(false);
    fireEvent.click(complete);
    expect(onAdd).toHaveBeenCalledWith('Complete');
    // Unchecking the active value removes it.
    const inProgress = within(dialog).getByLabelText('InProgress') as HTMLInputElement;
    expect(inProgress.checked).toBe(true);
    fireEvent.click(inProgress);
    expect(onRemove).toHaveBeenCalledWith('InProgress');
  });

  it('the ✕ clears the whole field', () => {
    const onClear = vi.fn();
    wrap(
      <FilterChip
        fieldLabel="State"
        values={['InProgress']}
        kind="enum"
        enumValues={['InProgress']}
        labels={labels}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByLabelText('Clear the State filter'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('defaults to the neutral `hnet` class namespace, and honours an override', () => {
    const { container, rerender } = render(
      <FilterChip
        fieldLabel="State"
        values={['InProgress']}
        kind="enum"
        enumValues={['InProgress']}
        labels={labels}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(container.querySelector('.hnet-filter-chip')).toBeTruthy();
    rerender(
      <FilterChip
        fieldLabel="State"
        values={['InProgress']}
        kind="enum"
        enumValues={['InProgress']}
        labels={labels}
        classPrefix="wk"
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(container.querySelector('.wk-filter-chip')).toBeTruthy();
    expect(container.querySelector('.hnet-filter-chip')).toBeNull();
  });
});

describe('FilterChip (unbounded typeahead = shared narrowing Autocomplete)', () => {
  // A pool wide enough to prove NARROWING: typing 'TR-0' must drop TR-10, IT-1, AX-2.
  const TRUCKS = ['TR-08', 'TR-09', 'TR-10', 'IT-1', 'AX-2'];
  const optionTexts = (root: ParentNode): string[] =>
    [...root.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');

  it('shows removable sub-tokens and adds a typed value (free-typeable, unknown ids welcome)', () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    wrap(
      <FilterChip
        fieldLabel="Truck"
        values={['TR-08']}
        kind="unbounded"
        suggestions={TRUCKS}
        labels={labels}
        onAdd={onAdd}
        onRemove={onRemove}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Edit the Truck filter'));
    const dialog = screen.getByRole('dialog');

    // The current value renders as a removable sub-token.
    fireEvent.click(within(dialog).getByLabelText('Remove Truck TR-08'));
    expect(onRemove).toHaveBeenCalledWith('TR-08');

    // Typing a value with ZERO matches + Enter still adds it (free-typeable).
    const input = within(dialog).getByLabelText('Add a Truck value');
    fireEvent.change(input, { target: { value: 'TR-99' } });
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0); // nothing matches
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('TR-99');
  });

  it('NARROWS the in-DOM listbox to matching options as you type (the acceptance gate)', () => {
    const onAdd = vi.fn();
    const { container } = wrap(
      <FilterChip
        fieldLabel="Truck"
        values={[]}
        kind="unbounded"
        suggestions={TRUCKS}
        labels={labels}
        onAdd={onAdd}
        onRemove={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Edit the Truck filter'));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText('Add a Truck value') as HTMLInputElement;

    // Empty query opens to a FEW of the pool (not all, not none) — proves the listbox renders.
    fireEvent.focus(input);
    const nAll = optionTexts(dialog).length;
    expect(nAll).toBeGreaterThan(0);
    expect(nAll).toBeLessThanOrEqual(TRUCKS.length);

    // Typing 'TR-0' NARROWS to ONLY the matches (TR-08, TR-09) — strictly fewer, all matching.
    fireEvent.change(input, { target: { value: 'TR-0' } });
    const shown = optionTexts(dialog);
    expect(shown).toEqual(['TR-08', 'TR-09']);
    expect(shown.length).toBeLessThan(nAll); // strictly narrowed
    expect(shown.every((s) => s.toLowerCase().includes('tr-0'))).toBe(true);

    // Picking the first option via mouseDown ADDS it and CLEARS the draft.
    const opts = [...dialog.querySelectorAll('[role="option"]')] as HTMLElement[];
    fireEvent.mouseDown(opts[0]!);
    expect(onAdd).toHaveBeenCalledWith('TR-08');
    expect(input.value).toBe(''); // draft cleared on commit

    // The listbox ids are colon-free (selector-safe) — a raw useId() (`:r0:`) breaks selectors.
    fireEvent.change(input, { target: { value: 'TR' } });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox.id.includes(':')).toBe(false);
    expect(container.querySelector(`#${listbox.id}`)).toBe(listbox);
  });

  it('gives two open chips DISTINCT colon-free listbox ids (no id collision)', () => {
    const { container } = render(
      <>
        <FilterChip
          fieldLabel="Truck"
          values={[]}
          kind="unbounded"
          suggestions={['TR-01']}
          labels={labels}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onClear={vi.fn()}
        />
        <FilterChip
          fieldLabel="Item"
          values={[]}
          kind="unbounded"
          suggestions={['IT-1']}
          labels={labels}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onClear={vi.fn()}
        />
      </>,
    );
    // Open both editors and open each typeahead listbox (focus).
    for (const t of ['Edit the Truck filter', 'Edit the Item filter']) {
      fireEvent.click(screen.getByTitle(t));
    }
    const inputs = [...container.querySelectorAll('input[role="combobox"]')] as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    inputs.forEach((i) => fireEvent.focus(i));
    const listboxes = [...container.querySelectorAll('[role="listbox"]')] as HTMLElement[];
    expect(listboxes).toHaveLength(2);
    const ids = listboxes.map((l) => l.id);
    expect(ids.every((id) => !id.includes(':'))).toBe(true); // colon-free
    expect(new Set(ids).size).toBe(2); // unique per chip instance
    // Each open listbox carries its own non-empty option set.
    for (const lb of listboxes) {
      expect(lb.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    }
  });
});
