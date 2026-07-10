// ADR-012 — roles router (admin-only). A role is a named app set; a user has exactly one.
// All writes delegate to @hnet/domain single-writers (create_role/update_role/delete_role
// audits in the same tx). Role ASSIGNMENT to a user lives on the users router (setRole).
import { z } from 'zod';
import { asc, count } from 'drizzle-orm';
import {
  roleAppGrants,
  roleMessageActionGrants,
  roleSectionPermissions,
  roleTrashActionGrants,
  roles,
  users,
  MESSAGE_ACTIONS,
  METRICS_LEVELS,
  SECTION_IDS,
  SECTION_DEFAULT_LEVELS,
  TRASH_ACTIONS,
  type MessageAction,
  type SectionId,
  type SectionPermissionLevel,
  type TrashAction,
} from '@hnet/db';
import {
  createRole,
  deactivateSyncedTier,
  deleteRole,
  provisionSyncedTier,
  setRoleMessageActions,
  setRoleMetricsLevel,
  setRoleTrashActions,
  setSectionPermission,
  updateRole,
} from '@hnet/domain';
import { mapDomainErrors, resolveAuthentikPortalBundle, router } from '../trpc';
import { adminProcedure } from '../middleware/role';
import {
  MessageActionsInput,
  RoleInput,
  RolePatchInput,
  SectionPermissionInput,
  TrashActionsInput,
} from '../schemas';

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
        metricsLevel: roles.metricsLevel,
        syncedTier: roles.syncedTier,
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
    // ADR-026 — each role's fine-grained Bulletin message action grant rows (a row = granted).
    const messageActionRows = await ctx.db
      .select({
        roleId: roleMessageActionGrants.roleId,
        action: roleMessageActionGrants.action,
      })
      .from(roleMessageActionGrants);

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
    const messageActionsByRole = new Map<string, Set<MessageAction>>();
    for (const row of messageActionRows) {
      const s = messageActionsByRole.get(row.roleId) ?? new Set<MessageAction>();
      s.add(row.action);
      messageActionsByRole.set(row.roleId, s);
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
      // ADR-026 — admin ⇒ every message action; otherwise the granted rows in canonical order.
      const messageGrantedSet = messageActionsByRole.get(row.id);
      const messageActions: MessageAction[] = row.isAdmin
        ? [...MESSAGE_ACTIONS]
        : MESSAGE_ACTIONS.filter((a) => messageGrantedSet?.has(a));
      return {
        ...row,
        // ADR-037 C-01 — admin implies 'full' (like admin implies section 'edit'); else the column.
        metricsLevel: row.isAdmin ? 'full' : row.metricsLevel,
        appIds: appIdsByRole.get(row.id) ?? [],
        memberCount: membersByRole.get(row.id) ?? 0,
        sectionPermissions,
        trashActions,
        messageActions,
      };
    });
  }),

  create: adminProcedure.input(RoleInput).mutation(async ({ ctx, input }) => {
    // Audits 'create_role'; duplicate name → ROLE_NAME_CONFLICT (D-13). ADR-045 — when created as a
    // synced tier, the local flag is set by createRole and the external group PRE-CREATE (Authentik +
    // OWUI) + owned-allowlist append run in provisionSyncedTier right after.
    return mapDomainErrors(async () => {
      const { roleId } = await createRole({ db: ctx.db, ...input, actorId: ctx.user.id });
      if (input.syncedTier) {
        const tier = await provisionSyncedTier({
          db: ctx.db,
          bundle: resolveAuthentikPortalBundle(ctx),
          roleId,
          actorId: ctx.user.id,
        });
        return { roleId, tier };
      }
      return { roleId };
    });
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

  /**
   * ADR-026 C-04 — replace a role's fine-grained Bulletin message action grants (post / moderate).
   * Delegates to the @hnet/domain single-writer (audits 'update_message_actions' in-tx); the Admin
   * role is immutable → ROLE_IMMUTABLE. Layered on top of the coarse `bulletin` section level
   * (setSectionPermission) — a Disabled-bulletin role's actions are moot until it's ≥ Read-Only.
   */
  setMessageActions: adminProcedure.input(MessageActionsInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(() =>
      setRoleMessageActions({
        db: ctx.db,
        roleId: input.roleId,
        actions: input.actions,
        actorId: ctx.user.id,
      }),
    );
  }),

  /**
   * ADR-037 C-01 — set a role's metrics access level (full | limited). Delegates to the @hnet/domain
   * single-writer (audits 'update_role_metrics_level' in-tx); the Admin role is immutable (implies
   * 'full') → ROLE_IMMUTABLE (D-13). Orthogonal to the `metrics` section level (setSectionPermission):
   * visibility gates whether Metrics is seen, this level shapes how much of it.
   */
  setMetricsLevel: adminProcedure
    .input(z.object({ roleId: z.uuid(), level: z.enum(METRICS_LEVELS) }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        setRoleMetricsLevel({
          db: ctx.db,
          roleId: input.roleId,
          level: input.level,
          actorId: ctx.user.id,
        }),
      );
    }),

  /**
   * ADR-045 (PLAN-026) — flip a role's "synced tier" opt-in. ON ⇒ provisionSyncedTier: PRE-CREATE the
   * Authentik group (name = role name lowercased) + the same-named Open WebUI group, add it to the
   * owned-groups allowlist + role→group map (all idempotent). OFF ⇒ deactivateSyncedTier: stop managing
   * it (remove from the allowlist) — NON-destructive, the groups + memberships are left intact (group
   * deletion is out of scope). Reaches Authentik/OWUI ⇒ BAD_GATEWAY on an upstream outage (D-13).
   */
  setSyncedTier: adminProcedure
    .input(z.object({ roleId: z.uuid(), syncedTier: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        if (input.syncedTier) {
          return await provisionSyncedTier({
            db: ctx.db,
            bundle: resolveAuthentikPortalBundle(ctx),
            roleId: input.roleId,
            actorId: ctx.user.id,
          });
        }
        return await deactivateSyncedTier({ db: ctx.db, roleId: input.roleId, actorId: ctx.user.id });
      });
    }),
});
