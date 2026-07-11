import {
  permissionAudit,
  roleBulletinViewGrants,
  roles,
  BULLETIN_VIEWS,
  BULLETIN_VIEW_DEFAULTS,
  type BulletinView,
  type DbClient,
} from '@hnet/db';
import { asc, eq } from 'drizzle-orm';
import { NotFoundError, SystemRoleImmutableError } from './errors';
import { inTransaction, resolveDb } from './db-client';

/**
 * ADR-049 / DESIGN-012 amend (PLAN-027) — the single writer for a Role's Bulletin SUB-VIEW
 * visibility grants (role_bulletin_view_grants), a clone of setRoleMessageActions: replace-whole-set
 * + a same-tx `update_bulletin_views` permission_audit row carrying the before/after view lists
 * (CLAUDE.md hard rule 6). A row = the view is GRANTED (presence is the grant; no boolean).
 *
 * RESOLUTION differs from setRoleMessageActions: because "Bulletin is for everyone" (ADR-026 C-02),
 * a role with NO rows resolves to BOTH views (bulletinViewsForRole below), and present rows are the
 * exact narrowing allowlist. Writing an EMPTY set therefore RE-OPENS both views (back to the default)
 * — it is NOT "hide everything" (that is the section-level `disabled`). The Admin role is immutable
 * here — it implies BOTH views with NO rows — so setting views on it is rejected with
 * SystemRoleImmutableError (ROLE_IMMUTABLE), exactly like setRoleMessageActions / setSectionPermission.
 */
export interface SetRoleBulletinViewsInput {
  db?: DbClient;
  roleId: string;
  /** The WHOLE granted set — replace-in-place (unknown values rejected up front). */
  views: BulletinView[];
  actorId: string | null;
}

function normalizeViews(views: BulletinView[]): BulletinView[] {
  const set = new Set(views);
  for (const v of set) {
    if (!BULLETIN_VIEWS.includes(v)) throw new NotFoundError(`Unknown Bulletin view '${v}'`);
  }
  return BULLETIN_VIEWS.filter((v) => set.has(v));
}

export async function setRoleBulletinViews(
  input: SetRoleBulletinViewsInput,
): Promise<{ changed: boolean; before: BulletinView[]; after: BulletinView[] }> {
  const after = normalizeViews(input.views);
  return inTransaction(input.db, async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, name: roles.name, isAdmin: roles.isAdmin })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (role.isAdmin) {
      throw new SystemRoleImmutableError(
        'The Admin role sees every Bulletin view and has no editable view grants.',
      );
    }

    const beforeRows = await tx
      .select({ view: roleBulletinViewGrants.view })
      .from(roleBulletinViewGrants)
      .where(eq(roleBulletinViewGrants.roleId, input.roleId))
      .orderBy(asc(roleBulletinViewGrants.view));
    const beforeSet = new Set(beforeRows.map((r) => r.view));
    const before = BULLETIN_VIEWS.filter((v) => beforeSet.has(v));

    await tx.delete(roleBulletinViewGrants).where(eq(roleBulletinViewGrants.roleId, input.roleId));
    if (after.length > 0) {
      await tx
        .insert(roleBulletinViewGrants)
        .values(after.map((view) => ({ roleId: input.roleId, view })));
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_bulletin_views',
      roleId: input.roleId,
      detail: { role_name: role.name, before, after },
    });

    const changed = before.length !== after.length || before.some((v, i) => v !== after[i]);
    return { changed, before, after };
  });
}

/**
 * ADR-049 C-02 — resolve a role's effective Bulletin views, applying the Admin=all + no-row=default
 * fallbacks. A read; used by session hydration + any server-side re-check. `isAdmin` short-circuits
 * to BOTH views with no query. A non-admin role with STORED rows gets exactly those (a narrowing);
 * a non-admin role with NO rows gets BULLETIN_VIEW_DEFAULTS (both) — the section-default pattern.
 */
export async function bulletinViewsForRole(input: {
  db?: DbClient;
  roleId: string;
  isAdmin?: boolean;
}): Promise<BulletinView[]> {
  if (input.isAdmin) return [...BULLETIN_VIEWS];
  const db = resolveDb(input.db);
  const rows = await db
    .select({ view: roleBulletinViewGrants.view })
    .from(roleBulletinViewGrants)
    .where(eq(roleBulletinViewGrants.roleId, input.roleId));
  if (rows.length === 0) return [...BULLETIN_VIEW_DEFAULTS];
  const set = new Set(rows.map((r) => r.view));
  return BULLETIN_VIEWS.filter((v) => set.has(v));
}

/**
 * ADR-049 C-02 — the pure, query-free resolver shared by the session hydration and the roles-list
 * projection: given a role's isAdmin flag + its STORED view rows, return the effective view set with
 * the Admin=all + no-row=default (both) fallbacks applied. Keeps the "no rows ⇒ both" rule in ONE
 * place so callers can't drift.
 */
export function resolveBulletinViews(
  isAdmin: boolean,
  storedViews: readonly BulletinView[],
): BulletinView[] {
  if (isAdmin) return [...BULLETIN_VIEWS];
  if (storedViews.length === 0) return [...BULLETIN_VIEW_DEFAULTS];
  const set = new Set(storedViews);
  return BULLETIN_VIEWS.filter((v) => set.has(v));
}
