// Issue #693 — the one-off wrong-volume requests repair: its argument contract (the repair itself is tested in
// @hnet/domain's wrong-volume-guards.test.ts).
import { describe, expect, it } from 'vitest';
import {
  HAND_PARKED_WANTS,
  parseWrongVolumeRepairArgs,
  REMOVED_ANCHOR_WANTS,
} from '../src/scripts/wrong-volume-requests-repair';

describe('wrong-volume-requests-repair arguments', () => {
  it('requires exactly one of --dry-run / --apply, and skips the cross-volume repair record by default', () => {
    expect(parseWrongVolumeRepairArgs(['--dry-run'])).toEqual({
      apply: false,
      skipLl: ['ik6xzgEACAAJ'],
    });
    expect(parseWrongVolumeRepairArgs(['--apply'])).toEqual({
      apply: true,
      skipLl: ['ik6xzgEACAAJ'],
    });
    expect(() => parseWrongVolumeRepairArgs([])).toThrow(/required/);
    expect(() => parseWrongVolumeRepairArgs(['--dry-run', '--apply'])).toThrow(/exclusive/);
    expect(() => parseWrongVolumeRepairArgs(['--force'])).toThrow(/unknown argument/);
    expect(parseWrongVolumeRepairArgs(['--help'])).toBe('help');
  });

  it('takes its own skip list', () => {
    expect(parseWrongVolumeRepairArgs(['--apply', '--skip-ll=a,b'])).toEqual({
      apply: true,
      skipLl: ['a', 'b'],
    });
    expect(parseWrongVolumeRepairArgs(['--dry-run', '--skip-ll='])).toEqual({
      apply: false,
      skipLl: [],
    });
  });

  it('settles only the two Mistborn sequel wants named by the issue, each on the id it must still hold', () => {
    expect(REMOVED_ANCHOR_WANTS.map((w) => w.llBookId)).toEqual(['t_ZYYXZq4RgC', 't_ZYYXZq4RgC']);
  });

  it('conforms only the four Chroniken wants the cross-volume repair parked by hand', () => {
    expect(HAND_PARKED_WANTS).toHaveLength(4);
    expect(new Set(HAND_PARKED_WANTS.map((id) => id.slice(0, 8)))).toEqual(
      new Set(['c0afcc7e', '525913ff', 'ca08224a', 'aec71b5a']),
    );
  });
});
