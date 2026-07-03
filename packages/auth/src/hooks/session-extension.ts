import { eq } from 'drizzle-orm';
import { db, users, type Database, type DbClient, type Role } from '@hnet/db';
import { isEffectivelyFamily } from '@hnet/domain';

/**
 * The per-user fields getServerSession grafts onto Better Auth's session read
 * (DESIGN-002 D-06). `isFamily` is the EFFECTIVE flag — direct users.is_family OR any
 * applied tag with tags.is_family — via @hnet/domain's canonical derivation, so
 * consumers (DESIGN-003 D-01 tRPC context) never re-derive it.
 */
export interface SessionExtension {
  role: Role;
  displayName: string;
  isFamily: boolean;
}

/**
 * One-lookup hydration of role/displayName/effective-isFamily for a user id.
 * Returns null when the user row is gone (deleted between sign-in and read) so
 * callers fail closed.
 */
export async function getSessionExtension(
  userId: string,
  dbc?: DbClient,
): Promise<SessionExtension | null> {
  const q = (dbc ?? db) as Database;
  const [row] = await q
    .select({ role: users.role, displayName: users.displayName, isFamily: users.isFamily })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return null;
  // Direct designation short-circuits; otherwise the domain helper checks family tags
  // (DESIGN-001 D-11 — the single source of the effective-family rule).
  const isFamily = row.isFamily ? true : await isEffectivelyFamily(userId, dbc);
  return { role: row.role, displayName: row.displayName, isFamily };
}

/**
 * DESIGN-002 D-06 — donor port: a one-query fallback returning { role, displayName }
 * for server components/route handlers that need role-gated UI when Better Auth's
 * additionalFields plumbing isn't in hand.
 */
export async function getSessionRole(
  userId: string,
  dbc?: DbClient,
): Promise<{ role: Role; displayName: string }> {
  const q = (dbc ?? db) as Database;
  const [row] = await q
    .select({ role: users.role, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) {
    throw new Error(`User ${userId} disappeared between signin and session-extension lookup`);
  }
  return { role: row.role, displayName: row.displayName };
}
