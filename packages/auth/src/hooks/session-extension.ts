import { eq } from 'drizzle-orm';
import {
  db,
  roleSectionPermissions,
  roleTrashActionGrants,
  roles,
  users,
  SECTION_IDS,
  SECTION_DEFAULT_LEVELS,
  TRASH_ACTIONS,
  type Database,
  type DbClient,
  type SectionId,
  type SectionPermissionLevel,
  type TrashAction,
} from '@hnet/db';

/** The role summary carried on the session (ADR-012 — one role per user). */
export interface SessionRole {
  id: string;
  name: string;
  isAdmin: boolean;
  /**
   * ADR-021 C-02 — the caller's resolved access LEVEL per top-level section, so nav + the
   * `sectionProcedure` gate need no per-request query (mirrors `isAdmin`). ALWAYS a full map
   * over SECTION_IDS: admin ⇒ 'edit' everywhere; otherwise the role's row or the section default.
   */
  sectionPermissions: Record<SectionId, SectionPermissionLevel>;
  /**
   * ADR-023 C-03 — the caller's resolved FINE-GRAINED Trash action grants, so `trashActionProcedure`
   * needs no per-request query. Admin ⇒ ALL actions; otherwise exactly the role's granted rows
   * (absence ⇒ not granted). Layered on top of `sectionPermissions.trash` (which gates VIEW).
   */
  trashActions: TrashAction[];
}

/**
 * The per-user fields getServerSession grafts onto Better Auth's session read
 * (DESIGN-002 D-06). ADR-012: `role` is the user's single role (id + name + isAdmin),
 * joined from the roles table — consumers (DESIGN-003 D-01 tRPC context, route gating)
 * switch on `role.isAdmin`, never a string literal.
 */
export interface SessionExtension {
  role: SessionRole;
  displayName: string;
}

/**
 * One-lookup hydration of role + displayName for a user id (users ⋈ roles). Returns null
 * when the user row is gone (deleted between sign-in and read) so callers fail closed.
 */
export async function getSessionExtension(
  userId: string,
  dbc?: DbClient,
): Promise<SessionExtension | null> {
  const q = (dbc ?? db) as Database;
  const [row] = await q
    .select({
      roleId: users.roleId,
      displayName: users.displayName,
      roleName: roles.name,
      isAdmin: roles.isAdmin,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId));
  if (!row) return null;
  // ADR-021 C-01/C-03 — resolve the full section-level map: admin ⇒ 'edit' everywhere (no
  // rows), otherwise the role's stored rows with each missing section falling back to its
  // documented default. One small extra query, mirroring the role join above.
  const sectionRows = row.isAdmin
    ? []
    : await q
        .select({
          sectionId: roleSectionPermissions.sectionId,
          level: roleSectionPermissions.level,
        })
        .from(roleSectionPermissions)
        .where(eq(roleSectionPermissions.roleId, row.roleId));
  const byId = new Map(sectionRows.map((r) => [r.sectionId, r.level]));
  const sectionPermissions = Object.fromEntries(
    SECTION_IDS.map((sid) => [
      sid,
      row.isAdmin ? 'edit' : (byId.get(sid) ?? SECTION_DEFAULT_LEVELS[sid]),
    ]),
  ) as Record<SectionId, SectionPermissionLevel>;
  // ADR-023 C-03 — the fine-grained Trash action grants: admin ⇒ every action (no rows),
  // otherwise the role's granted rows filtered to the canonical order. One more small query,
  // skipped entirely for admins.
  const grantRows = row.isAdmin
    ? []
    : await q
        .select({ action: roleTrashActionGrants.action })
        .from(roleTrashActionGrants)
        .where(eq(roleTrashActionGrants.roleId, row.roleId));
  const grantedSet = new Set(grantRows.map((r) => r.action));
  const trashActions: TrashAction[] = row.isAdmin
    ? [...TRASH_ACTIONS]
    : TRASH_ACTIONS.filter((a) => grantedSet.has(a));
  return {
    role: {
      id: row.roleId,
      name: row.roleName,
      isAdmin: row.isAdmin,
      sectionPermissions,
      trashActions,
    },
    displayName: row.displayName,
  };
}
