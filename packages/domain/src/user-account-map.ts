// ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user watch/read-state) — the app-user ↔ media-account
// MAPPING seam. The single seam for the `user_account_map` store (per-source handles: plex.tv numeric
// id, ABS user id, Kavita username). Written ONLY by `upsertUserAccountHandles` and the fill-if-empty
// `ensurePlexUserIdMapping` (the guard forbids any other module from touching the table); the latter
// is driven by `mapPlexUserIdFromStoredIdentity` / `reconcilePlexUserIdMappings` — the plex.tv id
// auto-fill from the sign-in hook and the metadata-refresh reconcile. NO audit row — descriptive
// attribution config (ADR-052 C-04 class); handle entry is admin-only (ADR-053 C-07) and the map
// never widens access. The Feed-attribution backlog item reuses this seam verbatim (ADR-053 C-01).
import {
  account,
  userAccountMap,
  users,
  type Database,
  type DbClient,
  type UserAccountMapRow,
} from '@hnet/db';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { resolvePlexIdentity } from './plex-identity';

export interface UpsertUserAccountHandlesInput {
  db?: DbClient;
  userId: string;
  /**
   * Per-source handle updates. `undefined` = LEAVE the stored value unchanged (a partial update — e.g.
   * the login auto-fill only touches plex_user_id); an explicit `null` = CLEAR the handle; a value = set
   * it. Handles are stored verbatim (they are opaque upstream ids / usernames).
   */
  plexUserId?: string | null;
  absUserId?: string | null;
  kavitaUsername?: string | null;
}

/**
 * The SINGLE WRITER for a user's account handles: merge the provided handles over any existing row and
 * upsert on the user_id PK (undefined = keep, null = clear, value = set). One row per app user. No
 * audit row (descriptive mapping, ADR-052 C-04 class). A duplicate plex_user_id / abs_user_id trips the
 * table's UNIQUE constraint (one media account maps to at most one app user) — the caller surfaces it.
 */
export async function upsertUserAccountHandles(
  input: UpsertUserAccountHandlesInput,
): Promise<UserAccountMapRow> {
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select()
      .from(userAccountMap)
      .where(eq(userAccountMap.userId, input.userId))
      .for('update');
    const merged = {
      plexUserId:
        input.plexUserId !== undefined ? input.plexUserId : (existing?.plexUserId ?? null),
      absUserId: input.absUserId !== undefined ? input.absUserId : (existing?.absUserId ?? null),
      kavitaUsername:
        input.kavitaUsername !== undefined
          ? input.kavitaUsername
          : (existing?.kavitaUsername ?? null),
    };
    const now = new Date();
    const [row] = await tx
      .insert(userAccountMap)
      .values({ userId: input.userId, ...merged, updatedAt: now })
      .onConflictDoUpdate({
        target: userAccountMap.userId,
        set: { ...merged, updatedAt: now },
      })
      .returning();
    return row!;
  });
}

/**
 * ADR-053 approach A/B — auto-fill a user's plex.tv numeric id from the resolved identity (the OIDC
 * claim / friend match) WITHOUT clobbering an admin-set value: sets plex_user_id only when the row has
 * none yet (or no row exists). Idempotent — a no-op once set. Called by `mapPlexUserIdFromStoredIdentity`
 * (below — the sign-in hook + the metadata-refresh reconcile); a later admin override wins because this
 * never overwrites a present value. Returns whether it wrote.
 */
export async function ensurePlexUserIdMapping(input: {
  db?: DbClient;
  userId: string;
  plexUserId: string;
}): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ plexUserId: userAccountMap.plexUserId })
      .from(userAccountMap)
      .where(eq(userAccountMap.userId, input.userId))
      .for('update');
    if (existing?.plexUserId) return { changed: false };
    const now = new Date();
    await tx
      .insert(userAccountMap)
      .values({ userId: input.userId, plexUserId: input.plexUserId, updatedAt: now })
      .onConflictDoUpdate({
        target: userAccountMap.userId,
        set: { plexUserId: input.plexUserId, updatedAt: now },
      });
    return { changed: true };
  });
}

// ── The auto-fill WIRING (DESIGN-026 D-07 status note, 2026-09-23) ──────────────────────────────────
// ensurePlexUserIdMapping shipped in PR #243 with no caller, so the map stayed empty in production and
// the harvest attributed nothing. The two callers below close that: the sign-in hook (@hnet/auth
// mapPlexAccountOnSignin, per user) and the metadata-refresh reconcile (the backfill + self-heal).

/**
 * What one auto-fill attempt did. `already_mapped` covers an admin-set id too: the auto-fill never
 * overwrites a present value (ADR-053: the admin override wins). `conflict` = the resolved id already
 * belongs to ANOTHER app user; the table's UNIQUE allows one app user per plex.tv account, so it is
 * left for an admin rather than moved.
 */
export type PlexUserIdMappingOutcome = 'mapped' | 'already_mapped' | 'no_claim' | 'conflict';

/**
 * The plex.tv numeric id the SESSION carries for this user (`getSessionExtension`'s
 * `plexIdentity.userId`): the stored OIDC id_token decoded through `resolvePlexIdentity`, with the admin
 * `users.plex_email`/`plex_username` override passed exactly as the session passes it. The numeric id
 * is CLAIM-ONLY (no override column — the Authentik `plex_user_id` scope mapping is its sole source),
 * so an override never invents an id; the email/username overrides only feed the friend-matcher arm,
 * which needs a plex.tv round-trip and is not run here. Every `account` row is an Authentik OIDC link
 * (CLAUDE.md hard rule 5), and a user's freshest token wins. null when no stored token carries the claim.
 */
async function readStoredPlexUserId(executor: Database, userId: string): Promise<string | null> {
  const [user] = await executor
    .select({ plexEmail: users.plexEmail, plexUsername: users.plexUsername })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;
  const tokens = await executor
    .select({ idToken: account.idToken })
    .from(account)
    .where(and(eq(account.userId, userId), isNotNull(account.idToken)))
    .orderBy(desc(account.updatedAt));
  for (const { idToken } of tokens) {
    const plexUserId = resolvePlexIdentity({
      idToken,
      overrideEmail: user.plexEmail,
      overrideUsername: user.plexUsername,
    }).userId;
    if (plexUserId) return plexUserId;
  }
  return null;
}

/**
 * ADR-053 approach A — record ONE user's plex.tv numeric id from their stored identity (the Authentik
 * `plex_user_id` claim on the id_token Better Auth refreshes at every sign-in), fill-if-empty through
 * `ensurePlexUserIdMapping`. Idempotent: `already_mapped` returns before decoding anything. Throws only
 * on a DB error (the callers isolate it).
 */
export async function mapPlexUserIdFromStoredIdentity(input: {
  db?: DbClient;
  userId: string;
}): Promise<{ outcome: PlexUserIdMappingOutcome; plexUserId: string | null }> {
  const executor = resolveDb(input.db);
  const [own] = await executor
    .select({ plexUserId: userAccountMap.plexUserId })
    .from(userAccountMap)
    .where(eq(userAccountMap.userId, input.userId));
  if (own?.plexUserId) return { outcome: 'already_mapped', plexUserId: own.plexUserId };

  const plexUserId = await readStoredPlexUserId(executor, input.userId);
  if (!plexUserId) return { outcome: 'no_claim', plexUserId: null };

  const [holder] = await executor
    .select({ userId: userAccountMap.userId })
    .from(userAccountMap)
    .where(eq(userAccountMap.plexUserId, plexUserId));
  if (holder && holder.userId !== input.userId) return { outcome: 'conflict', plexUserId };

  const { changed } = await ensurePlexUserIdMapping({
    db: input.db,
    userId: input.userId,
    plexUserId,
  });
  return { outcome: changed ? 'mapped' : 'already_mapped', plexUserId };
}

/** The metadata-refresh reconcile's per-run summary (logged + carried on the SyncReport). */
export interface PlexUserIdReconcileReport {
  /** App users with a stored id_token and no plex_user_id yet — the only rows walked. */
  candidates: number;
  mapped: number;
  /** No stored token carries the claim (the user has not signed in since the scope mapping shipped). */
  noClaim: number;
  conflicts: number;
  failed: number;
  /** The app user ids behind `conflicts` / `failed` (capped) — the admin follow-up list. */
  issues: Array<{ userId: string; outcome: 'conflict' | 'failed'; detail: string }>;
}

const RECONCILE_ISSUE_CAP = 20;

/**
 * ADR-053 / DESIGN-026 D-07 — the Plex Account Map RECONCILE: the backfill for users who signed in before
 * the sign-in hook existed, and the self-heal for a hook attempt that failed (sessions roll for 7 days, so
 * a user's next fresh sign-in can be weeks away). Walks ONLY users with a stored id_token and no
 * plex_user_id, so a mapped or admin-set row is never read or rewritten. One transaction per user (via
 * the single-writer); a failure is counted and never stops the rest. Idempotent: a second run maps nothing.
 */
export async function reconcilePlexUserIdMappings(
  input: { db?: DbClient } = {},
): Promise<PlexUserIdReconcileReport> {
  const executor = resolveDb(input.db);
  const candidates = await executor
    .selectDistinct({ userId: account.userId })
    .from(account)
    .leftJoin(userAccountMap, eq(userAccountMap.userId, account.userId))
    .where(and(isNotNull(account.idToken), isNull(userAccountMap.plexUserId)));
  const report: PlexUserIdReconcileReport = {
    candidates: candidates.length,
    mapped: 0,
    noClaim: 0,
    conflicts: 0,
    failed: 0,
    issues: [],
  };
  for (const { userId } of candidates) {
    try {
      const { outcome, plexUserId } = await mapPlexUserIdFromStoredIdentity({
        db: input.db,
        userId,
      });
      if (outcome === 'mapped') report.mapped += 1;
      else if (outcome === 'no_claim') report.noClaim += 1;
      else if (outcome === 'conflict') {
        report.conflicts += 1;
        if (report.issues.length < RECONCILE_ISSUE_CAP) {
          report.issues.push({
            userId,
            outcome: 'conflict',
            detail: `plex.tv id ${plexUserId} is already mapped to another app user`,
          });
        }
      }
      // 'already_mapped' — a sign-in filled it between the scan and now; nothing left to do.
    } catch (error) {
      report.failed += 1;
      if (report.issues.length < RECONCILE_ISSUE_CAP) {
        report.issues.push({
          userId,
          outcome: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return report;
}

/** Read one user's account map row (null when unmapped). */
export async function getUserAccountMap(
  db: DbClient | undefined,
  userId: string,
): Promise<UserAccountMapRow | null> {
  const executor = resolveDb(db);
  const [row] = await executor
    .select()
    .from(userAccountMap)
    .where(eq(userAccountMap.userId, userId));
  return row ?? null;
}

/** The plex.tv numeric id → app user id map (the Tautulli-history attribution join). Mapped users only. */
export async function getPlexUserIdToAppUserMap(
  db: DbClient | undefined,
): Promise<Map<string, string>> {
  const executor = resolveDb(db);
  const rows = await executor
    .select({ userId: userAccountMap.userId, plexUserId: userAccountMap.plexUserId })
    .from(userAccountMap)
    .where(isNotNull(userAccountMap.plexUserId));
  const map = new Map<string, string>();
  for (const r of rows) if (r.plexUserId) map.set(r.plexUserId, r.userId);
  return map;
}

/** The mapped ABS users (the per-user audiobook progress read iterates these). */
export async function listMappedAbsUsers(
  db: DbClient | undefined,
): Promise<Array<{ appUserId: string; absUserId: string }>> {
  const executor = resolveDb(db);
  const rows = await executor
    .select({ userId: userAccountMap.userId, absUserId: userAccountMap.absUserId })
    .from(userAccountMap)
    .where(isNotNull(userAccountMap.absUserId));
  return rows
    .filter((r): r is { userId: string; absUserId: string } => r.absUserId !== null)
    .map((r) => ({ appUserId: r.userId, absUserId: r.absUserId }));
}
