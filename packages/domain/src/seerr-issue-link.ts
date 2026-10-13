// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7) — the link from a Repair Request or a Fix to the Seerr issue it answers.
// Its own small module (no client, no setting) so the repair and Fix writers can read it inside their transactions.
import { seerrIssues, type DbClient } from '@hnet/db';
import { and, eq, isNull } from 'drizzle-orm';
import { resolveDb } from './db-client';

/**
 * PLAN-077 P7 — the Seerr issue a new Repair Request or Fix may name: only an open, mirrored issue on the SAME title
 * (the guide was opened from that report). Anything else links nothing (null), and the repair itself goes ahead: the
 * link only lets the bridge resolve the issue later. Read inside the writer's transaction.
 */
export async function seerrIssueLinkFor(
  exec: DbClient | undefined,
  input: { seerrIssueId: number | null | undefined; mediaItemId: string },
): Promise<number | null> {
  const id = input.seerrIssueId;
  if (id === null || id === undefined || !Number.isSafeInteger(id) || id <= 0) return null;
  const [row] = await resolveDb(exec)
    .select({ id: seerrIssues.seerrIssueId })
    .from(seerrIssues)
    .where(
      and(
        eq(seerrIssues.seerrIssueId, id),
        eq(seerrIssues.mediaItemId, input.mediaItemId),
        eq(seerrIssues.status, 'open'),
        isNull(seerrIssues.removedAt),
      ),
    );
  return row ? row.id : null;
}
