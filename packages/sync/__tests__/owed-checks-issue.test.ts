import { describe, expect, it } from 'vitest';
import {
  reconcileOverdueIssue,
  type OverdueIssue,
  type OverdueIssueActions,
} from '../src/owed-checks/issue';

const report = (ids: string) => `<!-- owed-checks-overdue: ${ids} -->\nAggregate overdue report`;
const defect: OverdueIssue = {
  number: 864,
  body: 'Pathfinder EPUBs disappeared after the nightly scan.\nFound by OC-047.',
};
function harness(issues: OverdueIssue[]) {
  const calls: unknown[][] = [];
  const actions: OverdueIssueActions = {
    listOpen: async () => issues,
    create: async () => {
      calls.push(['create']);
    },
    edit: async (number) => {
      calls.push(['edit', number]);
    },
    comment: async (number, body) => {
      calls.push(['comment', number, body]);
    },
    close: async (number, comment) => {
      calls.push(['close', number, comment]);
    },
  };
  return { actions, calls };
}

describe('owed-check issue ownership', () => {
  it('deduplicates and updates only owned reminders alongside independently labelled defects', async () => {
    const h = harness([
      defect,
      { number: 870, body: report('OC-015') },
      { number: 853, body: report('OC-015') },
    ]);
    await reconcileOverdueIssue(report('OC-015,OC-046'), h.actions);
    expect(h.calls).toEqual([
      ['close', 870, 'Duplicate of #853; closing.'],
      ['edit', 853],
      ['comment', 853, 'Overdue now: OC-015, OC-046 (was: OC-015).'],
    ]);
  });

  it('does not take an older manually filed defect as the canonical reminder', async () => {
    const h = harness([
      { ...defect, number: 800 },
      { number: 853, body: report('OC-046') },
    ]);
    await reconcileOverdueIssue(report('OC-046'), h.actions);
    expect(h.calls).toEqual([['edit', 853]]);
  });

  it('closes only owned reminders when no check remains overdue', async () => {
    const h = harness([
      defect,
      { number: 853, body: report('OC-046') },
      { number: 870, body: report('OC-046') },
    ]);
    await reconcileOverdueIssue(report(''), h.actions);
    expect(h.calls).toEqual([
      ['close', 870, 'Duplicate of #853; closing.'],
      ['close', 853, 'No owed check is overdue now; closing.'],
    ]);
  });

  it('creates a reminder without editing a defect, a quoted marker or a malformed marker', async () => {
    const issues = [
      defect,
      { number: 801, body: `Issue about a reminder\n${report('OC-046')}` },
      { number: 802, body: report('unrelated issue') },
      { number: 803, body: null },
    ];
    const h = harness(issues);
    await reconcileOverdueIssue(report('OC-046'), h.actions);
    expect(h.calls).toEqual([['create']]);
    const empty = harness(issues);
    await reconcileOverdueIssue(report(''), empty.actions);
    expect(empty.calls).toEqual([]);
  });

  it('rejects malformed generated output before any issue mutation', async () => {
    const h = harness([{ number: 853, body: report('OC-046') }]);
    await expect(
      reconcileOverdueIssue('Renderer failed without a marker', h.actions),
    ).rejects.toThrow('refusing issue changes');
    expect(h.calls).toEqual([]);
  });
});
