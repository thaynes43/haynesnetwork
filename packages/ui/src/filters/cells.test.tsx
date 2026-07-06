// @vitest-environment jsdom
//
// Unit tests for the shared filter cells. FilterCell toggles/drills (or renders a muted dash for an
// empty value); BinChip shows a COMPACT short form + a sibling COPY control that writes the FULL id
// (stopPropagation so a copy click never toggles the filter). Copy is host-injected via `labels`;
// plain-DOM assertions only (no jest-dom in packages/shared).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { BinChip, FilterCell, type BinChipLabels, type FilterCellLabels } from './cells';

afterEach(cleanup);

const cellLabels: FilterCellLabels = { drillTip: 'Drill in →', filterTip: 'Click to filter', removeTip: 'Active — click to remove' };
const binLabels: BinChipLabels = {
  filterTip: 'Click to filter',
  removeTip: 'Active — click to remove',
  copy: { copied: 'Copied', tip: 'Copy the full id', label: 'Copy id' },
};

type F = 'run' | 'state';
const UUID = '812f3392-cefc-7f28-6ae7-28791df32f95';

describe('FilterCell', () => {
  it('renders a muted dash (no affordance) for a null/empty value', () => {
    const { container } = render(
      <FilterCell<F> field="state" value={null} active={false} onToggle={vi.fn()} labels={cellLabels} />,
    );
    const dash = container.querySelector('.hnet-sub')!;
    expect(dash).toBeTruthy();
    expect(dash.textContent).toBe('—');
    expect(container.querySelector('.hnet-efcell')).toBeNull();
  });

  it('an attribute cell toggles in place (filterTip → removeTip when active)', () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <FilterCell<F> field="state" value="InProgress" active={false} onToggle={onToggle} labels={cellLabels} />,
    );
    const cell = container.querySelector('.hnet-efcell')!;
    expect(cell.getAttribute('title')).toBe('Click to filter');
    expect(cell.classList.contains('filtered')).toBe(false);
    fireEvent.click(cell);
    expect(onToggle).toHaveBeenCalledWith('state', 'InProgress');

    rerender(<FilterCell<F> field="state" value="InProgress" active onToggle={onToggle} labels={cellLabels} />);
    const active = container.querySelector('.hnet-efcell')!;
    expect(active.classList.contains('filtered')).toBe(true);
    expect(active.getAttribute('title')).toBe('Active — click to remove');
  });

  it('a cascade (drill) cell advances the grain instead of toggling', () => {
    const onDrill = vi.fn();
    const onToggle = vi.fn();
    const { container } = render(
      <FilterCell<F>
        field="run"
        value="ORD-1"
        active={false}
        drill="stations"
        onDrill={onDrill}
        onToggle={onToggle}
        labels={cellLabels}
      />,
    );
    const cell = container.querySelector('.hnet-efcell')!;
    expect(cell.classList.contains('drill')).toBe(true);
    expect(cell.getAttribute('title')).toBe('Drill in →');
    fireEvent.click(cell);
    expect(onDrill).toHaveBeenCalledWith('run', 'ORD-1', 'stations');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('honours a classPrefix override', () => {
    const { container } = render(
      <FilterCell<F> field="state" value="x" active mono classPrefix="wk" onToggle={vi.fn()} labels={cellLabels} />,
    );
    const cell = container.querySelector('.wk-efcell')!;
    expect(cell).toBeTruthy();
    expect(cell.classList.contains('wk-mono')).toBe(true);
    expect(cell.classList.contains('filtered')).toBe(true);
  });
});

describe('BinChip', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('renders the compact short form, full id on hover, and toggles with the FULL value', () => {
    const onToggle = vi.fn();
    const { container } = render(<BinChip bin={UUID} active onToggle={onToggle} labels={binLabels} />);
    const chip = container.querySelector('.hnet-bin-chip')!;
    expect(chip.textContent).toBe('812f3392');
    expect(chip.getAttribute('title')).toBe(UUID);
    expect(chip.classList.contains('filtered')).toBe(true);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(onToggle).toHaveBeenCalledWith(UUID);
  });

  it('the copy control writes the FULL id and does NOT toggle the filter (stopPropagation)', () => {
    const onToggle = vi.fn();
    const { container } = render(<BinChip bin={UUID} active={false} onToggle={onToggle} labels={binLabels} />);
    const copyBtn = container.querySelector('.hnet-copybtn')!;
    fireEvent.click(copyBtn);
    expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(UUID);
    expect(onToggle).not.toHaveBeenCalled();
    // The copy button is a real sibling button — not nested in the filter chip.
    const chip = container.querySelector('.hnet-bin-chip')!;
    expect(copyBtn.tagName).toBe('BUTTON');
    expect(chip.contains(copyBtn)).toBe(false);
  });
});
