// ADR-110 C-04, C-05, ADR-113 / DESIGN-055 D-05, P4 decision 17, Q-10 ruling (PLAN-077 P4) — the Mislabel Block's
// in-cluster tool: parsing only (the writes are mislabel-block.test.ts's, in packages/domain).
import { describe, expect, it } from 'vitest';
import { parseMislabelBlockArgs } from '../src/scripts/mislabel-block';

describe('mislabel-block.ts arguments', () => {
  it('lists, adopts, reconciles, and accepts a staff re-map\'s offer', () => {
    expect(parseMislabelBlockArgs(['list'])).toEqual({ command: 'list', state: 'active' });
    expect(parseMislabelBlockArgs(['adopt', '--series', '1061', '--group', 'BiOMA', '--dry-run'])).toEqual({
      command: 'adopt',
      seriesId: 1061,
      group: 'BiOMA',
      dryRun: true,
    });
    expect(parseMislabelBlockArgs(['reconcile'])).toEqual({ command: 'reconcile', dryRun: false });
    expect(
      parseMislabelBlockArgs(['offer', '--repair', 'C6975011-B638-4EB9-8822-79DA4606BE84', '--group', 'ROWSDOWER']),
    ).toEqual({ command: 'offer', repairRequestId: 'c6975011-b638-4eb9-8822-79da4606be84', group: 'ROWSDOWER' });
    expect(() => parseMislabelBlockArgs(['offer', '--group', 'X'])).toThrow(/offer needs --repair and --group/);
    expect(() => parseMislabelBlockArgs(['offer', '--repair', 'nope', '--group', 'X'])).toThrow(/repair request id/);
    expect(() => parseMislabelBlockArgs(['reconcile', '--repair', 'c6975011-b638-4eb9-8822-79da4606be84'])).toThrow(/only --dry-run/);
  });

  it('adds a mislabelled name as staff, or adopts one from the hand profile (ADR-113)', () => {
    expect(parseMislabelBlockArgs(['add-name', '--series', '1061', '--pair', 'S01E11 Secret Menu', '--dry-run'])).toEqual({
      command: 'add-name',
      seriesId: 1061,
      kind: 'pair',
      name: 'S01E11 Secret Menu',
      origin: 'staff',
      dryRun: true,
    });
    expect(parseMislabelBlockArgs(['add-name', '--series', '1061', '--double', 'S01E13E14'])).toMatchObject({
      kind: 'double',
      name: 'S01E13E14',
      origin: 'staff',
      dryRun: false,
    });
    expect(parseMislabelBlockArgs(['adopt', '--series', '1061', '--alias', ' Regular Show Die verlorenen Videos '])).toEqual({
      command: 'add-name',
      seriesId: 1061,
      kind: 'alias',
      name: 'Regular Show Die verlorenen Videos',
      origin: 'adoption',
      dryRun: false,
    });
    // `adopt --group` is unchanged.
    expect(parseMislabelBlockArgs(['adopt', '--series', '1061', '--group', 'BiOMA'])).toMatchObject({ command: 'adopt', group: 'BiOMA' });
    expect(() => parseMislabelBlockArgs(['add-name', '--series', '1061'])).toThrow(/add-name needs one of --pair, --double or --alias/);
    expect(() => parseMislabelBlockArgs(['add-name', '--series', '1061', '--group', 'BiOMA'])).toThrow(/add-name needs one of/);
    expect(() => parseMislabelBlockArgs(['add-name', '--pair', 'S01E11 Secret Menu'])).toThrow(/add-name needs --series/);
    expect(() => parseMislabelBlockArgs(['adopt', '--series', '1061', '--group', 'BiOMA', '--pair', 'S01E11 X'])).toThrow(
      /adopt needs one of --group, --pair, --double or --alias/,
    );
    expect(() => parseMislabelBlockArgs(['add-name', '--series', '1061', '--pair', 'S01E11 X', '--alias', 'Y'])).toThrow(/give one of/);
    expect(() => parseMislabelBlockArgs(['add-name', '--series', '1061', '--pair', '--dry-run'])).toThrow(/--pair needs the name/);
    expect(() => parseMislabelBlockArgs(['list', '--alias', 'Y'])).toThrow(/list takes only --state/);
    expect(() => parseMislabelBlockArgs(['reconcile', '--double', 'S01E13E14'])).toThrow(/takes no --pair/);
  });
});
