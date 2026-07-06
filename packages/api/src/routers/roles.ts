// ADR-012 — roles router (admin-only). A role is a named app set; a user has exactly one.
// All writes delegate to @hnet/domain single-writers (create_role/update_role/delete_role
// audits in the same tx). Role ASSIGNMENT to a user lives on the users router (setRole).
import { z } from 'zod';
import { asc, count } from 'drizzle-orm';
import {
  roleAppGrants,
  roleSectionPermissions,
  roleTrashActionGrants,
  roles,
  users,
  SECTION_IDS,
  SECTION_DEFAULT_LEVELS,
  TRASH_ACTIONS,
  type SectionId,
  type SectionPermissionLevel,
  type TrashAction,
} from '@hnet/db';
import {
  createRole,
  deleteRole,
  setRoleTrashActions,
  setSectionPermission,
  updateRole,
} from '@hnet/domain';
import { mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';
import { RoleInput, RolePatchInput, SectionPermissionInput, TrashActionsInput } from '../schemas';

export const rolesRouter = router({
  /** Every role with its app set + member count (feeds /admin/roles + the user role picker). */
  list: adminProcedure.query(async ({ ctx }) => {
    const roleRows = await ctx.db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
        isAdmin: roles.isAdmin,
        isDefault: roles.isDefault,
        grantsAll: roles.grantsAll,
        sortOrder: roles.sortOrder,
      })
      .from(roles)
      .orderBy(asc(roles.sortOrder), asc(roles.name));
    const grantRows = await ctx.db
      .select({ roleId: roleAppGrants.roleId, appId: roleAppGrants.appId })
      .from(roleAppGrants);
    const memberRows = await ctx.db
      .select({ roleId: users.roleId, members: count(users.id) })
      .from(users)
      .groupBy(users.roleId);
    // ADR-021 — each role's section access rows (Ledger + reserved Trash).
    const sectionRows = await ctx.db
      .select({
        roleId: roleSectionPermissions.roleId,
        sectionId: roleSectionPermissions.sectionId,
        level: roleSectionPermissions.level,
      })
      .from(roleSectionPermissions);
    // ADR-023 — each role's fine-grained Trash action grant rows (a row = granted).
    const trashActionRows = await ctx.db
      .select({
        roleId: roleTrashActionGrants.roleId,
        action: roleTrashActionGrants.action,
      })
      .from(roleTrashActionGrants);

    const appIdsByRole = new Map<string, string[]>();
    for (const row of grantRows) {
      const list = appIdsByRole.get(row.roleId) ?? [];
      list.push(row.appId);
      appIdsByRole.set(row.roleId, list);
    }
    const membersByRole = new Map(memberRows.map((row) => [row.roleId, Number(row.members)]));
    const sectionLevelByRole = new Map<string, Map<SectionId, SectionPermissionLevel>>();
    for (const row of sectionRows) {
      const m = sectionLevelByRole.get(row.roleId) ?? new Map<SectionId, SectionPermissionLevel>();
      m.set(row.sectionId, row.level);
      sectionLevelByRole.set(row.roleId, m);
    }
    const trashActionsByRole = new Map<string, Set<TrashAction>>();
    for (const row of trashActionRows) {
      const s = trashActionsByRole.get(row.roleId) ?? new Set<TrashAction>();
      s.add(row.action);
      trashActionsByRole.set(row.roleId, s);
    }

    // The Admin role has no explicit grants — it's an implicit all-apps / all-sections superuser.
    return roleRows.map((row) => {
      const stored = sectionLevelByRole.get(row.id);
      const sectionPermissions = Object.fromEntries(
        SECTION_IDS.map((sid) => [
          sid,
          row.isAdmin ? 'edit' : (stored?.get(sid) ?? SECTION_DEFAULT_LEVELS[sid]),
        ]),
      ) as Record<SectionId, SectionPermissionLevel>;
      // ADR-023 — admin ⇒ every action; otherwise the granted rows in canonical order.
      const grantedSet = trashActionsByRole.get(row.id);
      const trashActions: TrashAction[] = row.isAdmin
        ? [...TRASH_ACTIONS]
        : TRASH_ACTIONS.filter((a) => grantedSet?.has(a));
      return {
        ...row,
        appIds: appIdsByRole.get(row.id) ?? [],
        memberCount: membersByRole.get(row.id) ?? 0,
        sectionPermissions,
        trashActions,
      };
    });
  }),

  create: adminProcedure.input(RoleInput).mutation(async ({ ctx, input }) => {
    // Audits 'create_role'; duplicate name → ROLE_NAME_CONFLICT (D-13).
    return mapDomainErrors(() => createRole({ db: ctx.db, ...input, actorId: ctx.user.id }));
  }),

  update: adminProcedure.input(RolePatchInput).mutation(async ({ ctx, input }) => {
    const { id, ...patch } = input;
    // Admin role → ROLE_IMMUTABLE; Default role rename → ROLE_IMMUTABLE; audits 'update_role'.
    return mapDomainErrors(() => updateRole({ db: ctx.db, roleId: id, ...patch, actorId: ctx.user.id }));
  }),

  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    // Reassigns members to Default, then deletes; system roles → ROLE_IMMUTABLE. Audits 'delete_role'.
    return mapDomainErrors(() => deleteRole({ db: ctx.db, roleId: input.id, actorId: ctx.user.id }));
  }),

  /**
   * ADR-021 C-02 — set a role's access level for one section (Ledger now; Trash reserved for
   * PLAN-006). Delegates to the @hnet/domain single-writer (audits 'update_section_permission'
   * in-tx); the Admin role is immutable → ROLE_IMMUTABLE (D-13).
   */
  setSectionPermission: adminProcedure
    .input(SectionPermissionInput)
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        setSectionPermission({
          db: ctx.db,
          roleId: input.roleId,
          sectionId: input.sectionId,
          level: input.level,
          actorId: ctx.user.id,
        }),
      );
    }),

  /**
   * ADR-023 C-03 — replace a role's fine-grained Trash action grants (Save/Expedite/Edit-rules/
   * Restore). Delegates to the @hnet/domain single-writer (audits 'update_trash_actions' in-tx);
   * the Admin role is immutable → ROLE_IMMUTABLE. Layered on top of the coarse `trash` section
   * level (setSectionPermission) — a Disabled-trash role's actions are moot until it's ≥ Read-Only.
   */
  setTrashActions: adminProcedure.input(TrashActionsInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(() =>
      setRoleTrashActions({
        db: ctx.db,
        roleId: input.roleId,
        actions: input.actions,
        actorId: ctx.user.id,
      }),
    );
  }),
});
