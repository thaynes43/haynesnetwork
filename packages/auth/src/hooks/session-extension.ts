import { eq } from 'drizzle-orm';
import { db, roles, users, type Database, type DbClient } from '@hnet/db';

/** The role summary carried on the session (ADR-012 — one role per user). */
export interface SessionRole {
  id: string;
  name: string;
  isAdmin: boolean;
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
  return {
    role: { id: row.roleId, name: row.roleName, isAdmin: row.isAdmin },
    displayName: row.displayName,
  };
}
