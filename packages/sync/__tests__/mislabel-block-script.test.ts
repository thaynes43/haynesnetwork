// ADR-110 C-04, C-05 / DESIGN-055 D-05, P4 decision 17 (PLAN-077 P4) — the Mislabel Block's in-cluster tool: parsing only
// (the writes are mislabel-block.test.ts's, in packages/domain).
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
});
