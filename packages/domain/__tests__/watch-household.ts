// TEST SUPPORT (ADR-091 C-04 / DESIGN-050 D-07, PLAN-069 S4) — a tracked `household` watch account. No production
// single-writer creates one yet (PLAN-070 extends the `watch` sync to household accounts), but the user-aware
// connector path must be proven for them now: the MCP end-to-end suite imports this to seed one. It lives under
// packages/domain/ on purpose — `watch_accounts` is a guarded table, and only domain code (tests included) may
// write it directly; nothing outside the domain gets a direct write.
import { sql } from 'drizzle-orm';
import type { Database } from '@hnet/db';

export async function insertHouseholdWatchAccount(
  db: Database,
  account: { plexAccountId: number; username: string; tracked?: boolean },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO watch_accounts (plex_account_id, username, role, tracked)
        VALUES (${account.plexAccountId}, ${account.username}, 'household', ${account.tracked ?? true})`,
  );
}
