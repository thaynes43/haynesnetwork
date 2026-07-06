import {
  permissionAudit,
  roleSectionPermissions,
  roles,
  SECTION_DEFAULT_LEVELS,
  type DbClient,
  type SectionId,
  type SectionPermissionLevel,
} from '@hnet/db';
import { and, eq } from 'drizzle-orm';
import { NotFoundError, SystemRoleImmutableError } from './errors';
import { inTransaction, resolveDb } from './db-client';

/**
 * ADR-021 / DESIGN-009 D-03 — the single writer for a Role's section access level
 * (role_section_permissions), mirroring setRoleLibraries: one row per (role, section),
 * replace-in-place, with a same-tx `update_section_permission` permission_audit row carrying
 * the before/after level (CLAUDE.md hard rule 6). The Admin role is immutable here — it
 * implies Edit on every section with NO rows (ADR-021 C-03) — so setting a level on it is
 * rejected with SystemRoleImmutableError (the ROLE_IMMUTABLE coded error), exactly like
 * setRoleLibraries rejects editing the Admin library set.
 */
export interface SetSectionPermissionInput {
  db?: DbClient;
  roleId: string;
  sectionId: SectionId;
  level: SectionPermissionLevel;
  actorId: string | null;
}

export async function setSectionPermission(
  input: SetSectionPermissionInput,
): Promise<{ changed: boolean; before: SectionPermissionLevel; after: SectionPermissionLevel }> {
  return inTransaction(input.db, async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, name: roles.name, isAdmin: roles.isAdmin })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (role.isAdmin) {
      throw new SystemRoleImmutableError(
        'The Admin role has Edit access to every section and has no editable section levels.',
      );
    }

    const [existing] = await tx
      .select({ level: roleSectionPermissions.level })
      .from(roleSectionPermissions)
      .where(
        and(
          eq(roleSectionPermissions.roleId, input.roleId),
          eq(roleSectionPermissions.sectionId, input.sectionId),
        ),
      );
    // No row ⇒ the role currently resolves to the section's documented default.
    const before = existing?.level ?? SECTION_DEFAULT_LEVELS[input.sectionId];

    await tx
      .insert(roleSectionPermissions)
      .values({ roleId: input.roleId, sectionId: input.sectionId, level: input.level })
      .onConflictDoUpdate({
        target: [roleSectionPermissions.roleId, roleSectionPermissions.sectionId],
        set: { level: input.level, updatedAt: new Date() },
      });

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_section_permission',
      roleId: input.roleId,
      detail: {
        role_name: role.name,
        section_id: input.sectionId,
        before,
        after: input.level,
      },
    });

    return { changed: before !== input.level, before, after: input.level };
  });
}

/**
 * ADR-021 C-01/C-03 — resolve a role's effective level for one section, applying the
 * Admin=Edit and no-row=default fallbacks. A read; used by session hydration and any
 * server-side re-check. `isAdmin` short-circuits to 'edit' with no query.
 */
export async function sectionLevelForRole(input: {
  db?: DbClient;
  roleId: string;
  sectionId: SectionId;
  isAdmin?: boolean;
}): Promise<SectionPermissionLevel> {
  if (input.isAdmin) return 'edit';
  const db = resolveDb(input.db);
  const [row] = await db
    .select({ level: roleSectionPermissions.level })
    .from(roleSectionPermissions)
    .where(
      and(
        eq(roleSectionPermissions.roleId, input.roleId),
        eq(roleSectionPermissions.sectionId, input.sectionId),
      ),
    );
  return row?.level ?? SECTION_DEFAULT_LEVELS[input.sectionId];
}
