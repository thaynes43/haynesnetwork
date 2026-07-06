// Unit tests for the shared chip model (PLAN-018 §3 D-1): same-field values consolidate into ONE
// chip in CSV form (OR), preserving field + value order; the field-kind callback drives enum vs
// unbounded; chipCsv renders the value body.

import { describe, expect, it } from 'vitest';
import { chipCsv, groupPairs } from './chipModel';

type F = 'state' | 'truck' | 'job';
const kind = (f: F) =>
  f === 'state' ? ({ kind: 'enum', enumValues: ['Pending', 'InProgress'] } as const) : ({ kind: 'unbounded' } as const);

describe('groupPairs', () => {
  it('consolidates same-field values into ONE chip (same-field OR → CSV), preserving order', () => {
    const chips = groupPairs<F>(
      [
        { field: 'state', value: 'InProgress' },
        { field: 'truck', value: 'TR-08' },
        { field: 'state', value: 'Complete' },
      ],
      kind,
    );
    // One chip per field, first-seen field order (state before truck).
    expect(chips.map((c) => c.field)).toEqual(['state', 'truck']);
    // Same-field values OR into one chip, in insertion order.
    expect(chips[0]).toMatchObject({ field: 'state', values: ['InProgress', 'Complete'], kind: 'enum' });
    expect(chips[0]!.enumValues).toEqual(['Pending', 'InProgress']);
    expect(chips[1]).toMatchObject({ field: 'truck', values: ['TR-08'], kind: 'unbounded' });
  });

  it('de-duplicates a repeated (field, value) pair within a chip', () => {
    const chips = groupPairs<F>(
      [
        { field: 'job', value: 'J-1' },
        { field: 'job', value: 'J-1' },
        { field: 'job', value: 'J-2' },
      ],
      kind,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]!.values).toEqual(['J-1', 'J-2']);
  });

  it('renders the CSV body', () => {
    expect(chipCsv(['InProgress', 'Complete'])).toBe('InProgress, Complete');
    expect(chipCsv([])).toBe('');
  });
});
