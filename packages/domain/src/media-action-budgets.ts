// ADR-080 (PLAN-041 Gap B — per-role media-action rate budgets). The ONE budget mechanism every
// media family draws: a single per-role number (`role_media_action_budgets.fix_per_hour`) applied
// INDEPENDENTLY to each existing pool — the arr pool (Fix + Force Search share one counter,
// DESIGN-005 D-17) and the books pool (book Fix + the book-item Force Search, DESIGN-033). The
// recovered owner ruling is binding: NO permission gating on Fix/Force-Search — everyone can Fix, the
// per-role rate limit is the governing instrument (a stricter Default is an owner act in /admin, not a
// release act). This module owns the single-writer that sets a role's budget and the resolver every
// budget check calls in place of the retired flat constants.
import {
  permissionAudit,
  roleMediaActionBudgets,
  roles,
  type DbClient,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { MediaActionBudgetRangeError, NotFoundError, SystemRoleImmutableError } from './errors';

/**
 * ADR-080 C-03 — the code fallback when a role has no budget row: today's flat constant. Absence IS
 * today's behavior, so NO seed rows are written and deploy is zero-change. The retired
 * `FIX_RATE_LIMIT_PER_HOUR` / `BOOK_FIX_RATE_LIMIT_PER_HOUR` constants collapse into this one number.
 */
export const MEDIA_ACTION_BUDGET_FALLBACK = 25;

/** ADR-080 C-02 — the CHECK ceiling (0 <= fix_per_hour <= 1000). */
export const MEDIA_ACTION_BUDGET_MAX = 1000;

/**
 * ADR-080 C-07 — the "limit reached" copy. It states the ROLE's effective number (never a constant)
 * and follows the owner copy rules: no em-dashes, no time-grounding, friendly semi-professional tone.
 * A budget of 0 is the documented block (C-05), so it gets its own honest wording.
 */
export function mediaActionBudgetReachedMessage(limit: number): string {
  if (limit === 0) {
    return 'Media actions are turned off for your role right now. An admin can turn them back on.';
  }
  return `You have reached your role's hourly limit of ${limit} media actions. Give it a little while and try again.`;
}

export interface EffectiveMediaActionBudgetInput {
  db?: DbClient;
  /** Resolve by role id (queries roles for the admin bypass + the budget row). */
  roleId?: string | null;
  /** Or pass an already-loaded role (short-circuits the admin bypass without a roles query). */
  role?: { id: string; isAdmin: boolean } | null;
  /** Or assert the caller is an admin (bypass) without any role context. */
  isAdmin?: boolean;
}

/**
 * ADR-080 C-03 — resolve a role's EFFECTIVE hourly media-action budget, in order:
 *   admin ⇒ bypass (returns `null`, meaning unlimited — D-09 unchanged) → the role's row →
 *   fallback 25.
 * Returns `null` for an admin (bypass); otherwise the numeric per-hour limit (which may be 0, the
 * block). A `null` result means the caller must NOT count/limit. This is a READ; callers pass their
 * open transaction as `db` so the resolve rides the same snapshot as the budget count.
 */
export async function effectiveMediaActionBudget(
  input: EffectiveMediaActionBudgetInput,
): Promise<number | null> {
  if (input.isAdmin === true) return null;
  if (input.role) {
    if (input.role.isAdmin) return null;
    return budgetRowFor(input.db, input.role.id);
  }
  if (input.roleId == null) return MEDIA_ACTION_BUDGET_FALLBACK;

  // Resolve admin-bypass + the row in one query (LEFT JOIN so a role with no budget row still returns).
  const [row] = await resolveDb(input.db)
    .select({ isAdmin: roles.isAdmin, fixPerHour: roleMediaActionBudgets.fixPerHour })
    .from(roles)
    .leftJoin(roleMediaActionBudgets, eq(roleMediaActionBudgets.roleId, roles.id))
    .where(eq(roles.id, input.roleId))
    .limit(1);
  if (!row) return MEDIA_ACTION_BUDGET_FALLBACK; // unknown role ⇒ today's behavior, never a crash.
  if (row.isAdmin) return null;
  return row.fixPerHour ?? MEDIA_ACTION_BUDGET_FALLBACK;
}

/** The role's stored budget, or the fallback when it has no row (non-admin path). */
async function budgetRowFor(db: DbClient | undefined, roleId: string): Promise<number> {
  const [row] = await resolveDb(db)
    .select({ fixPerHour: roleMediaActionBudgets.fixPerHour })
    .from(roleMediaActionBudgets)
    .where(eq(roleMediaActionBudgets.roleId, roleId))
    .limit(1);
  return row?.fixPerHour ?? MEDIA_ACTION_BUDGET_FALLBACK;
}

export interface SetRoleMediaActionBudgetInput {
  db?: DbClient;
  roleId: string;
  /** The per-hour allowance, 0..1000. 0 blocks that role's non-admin media actions (C-05). */
  fixPerHour: number;
  actorId: string | null;
}

/**
 * ADR-080 C-02 — the single writer for a role's media-action budget (the setSectionPermission /
 * setRoleBookActions idiom): validate 0..1000, refuse the Admin role (it bypasses budgets, so it has
 * no editable number — ROLE_IMMUTABLE), upsert the row, and co-write an `update_media_action_budget`
 * permission_audit row carrying { role_name, before, after } in the SAME transaction (hard rule 6).
 * `before` is the role's PRIOR effective number (its stored row, else the fallback 25) so the audit
 * reads honestly even for a role's first budget edit.
 */
export async function setRoleMediaActionBudget(
  input: SetRoleMediaActionBudgetInput,
): Promise<{ changed: boolean; before: number; after: number }> {
  if (
    !Number.isInteger(input.fixPerHour) ||
    input.fixPerHour < 0 ||
    input.fixPerHour > MEDIA_ACTION_BUDGET_MAX
  ) {
    throw new MediaActionBudgetRangeError(
      `A media-action budget must be a whole number from 0 to ${MEDIA_ACTION_BUDGET_MAX}.`,
    );
  }
  return inTransaction(input.db, async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, name: roles.name, isAdmin: roles.isAdmin })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (role.isAdmin) {
      throw new SystemRoleImmutableError(
        'The Admin role bypasses media-action budgets and has no editable budget.',
      );
    }

    const [existing] = await tx
      .select({ fixPerHour: roleMediaActionBudgets.fixPerHour })
      .from(roleMediaActionBudgets)
      .where(eq(roleMediaActionBudgets.roleId, input.roleId));
    // No row ⇒ the role currently resolves to the documented fallback.
    const before = existing?.fixPerHour ?? MEDIA_ACTION_BUDGET_FALLBACK;

    await tx
      .insert(roleMediaActionBudgets)
      .values({ roleId: input.roleId, fixPerHour: input.fixPerHour })
      .onConflictDoUpdate({
        target: roleMediaActionBudgets.roleId,
        set: { fixPerHour: input.fixPerHour, updatedAt: new Date() },
      });

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_media_action_budget',
      roleId: input.roleId,
      detail: { role_name: role.name, before, after: input.fixPerHour },
    });

    return { changed: before !== input.fixPerHour, before, after: input.fixPerHour };
  });
}
