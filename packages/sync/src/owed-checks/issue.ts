// DESIGN-053 D-06: the shared label discovers candidates; the generated marker proves ownership.
export interface OverdueIssue {
  number: number;
  body: string | null;
}

export interface OverdueIssueActions {
  listOpen(): Promise<OverdueIssue[]>;
  create(): Promise<void>;
  edit(number: number): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  close(number: number, comment: string): Promise<void>;
}

/** null means this is not an owned reminder, including a marker quoted later in a defect report. */
export function overdueMarkerIds(body: string | null): string | null {
  const first = body?.split(/\r?\n/, 1)[0] ?? '';
  const marker = /^<!-- owed-checks-overdue: (.*?) -->$/.exec(first);
  if (!marker) return null;
  const ids = marker[1]!;
  return ids === '' || /^OC-\d{3}(?:,OC-\d{3})*$/.test(ids) ? ids : null;
}

/** All mutations are restricted to reminders with the ownership marker, never another labelled issue. */
export async function reconcileOverdueIssue(
  markdown: string,
  actions: OverdueIssueActions,
): Promise<void> {
  const ids = overdueMarkerIds(markdown);
  if (ids === null)
    throw new Error('Invalid owed-check report ownership marker; refusing issue changes');
  const owned = (await actions.listOpen())
    .filter((issue) => overdueMarkerIds(issue.body) !== null)
    .sort((a, b) => a.number - b.number);
  const issue = owned[0];
  for (const duplicate of owned.slice(1)) {
    await actions.close(duplicate.number, `Duplicate of #${issue!.number}; closing.`);
  }
  if (ids) {
    if (!issue) {
      await actions.create();
    } else {
      const was = overdueMarkerIds(issue.body)!;
      await actions.edit(issue.number);
      if (was !== ids) {
        await actions.comment(
          issue.number,
          `Overdue now: ${ids.replaceAll(',', ', ')} (was: ${was || 'none'}).`,
        );
      }
    }
  } else if (issue) {
    await actions.close(issue.number, 'No owed check is overdue now; closing.');
  }
}
