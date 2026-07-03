import { appCatalog, permissionAudit, userAppGrants, users, type DbClient } from '@hnet/db';
import { and, eq } from 'drizzle-orm';
import { NotFoundError } from './errors';
import { inTransaction } from './db-client';

export interface GrantAppInput {
  db?: DbClient;
  userId: string;
  appId: string;
  /** Acting admin's user id; null = system. Recorded as granted_by and audit actor. */
  actorId: string | null;
}

export interface RevokeAppInput {
  db?: DbClient;
  userId: string;
  appId: string;
  actorId: string | null;
}

/**
 * DESIGN-001 D-06/D-12 — single writer for direct per-user app grants (R-15). Inserts
 * the grant and its 'grant_app' permission_audit row in ONE transaction. Idempotent:
 * an existing grant is a no-op with no audit row (DESIGN-003 D-11).
 */
export async function grantApp(input: GrantAppInput): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [app] = await tx
      .select({ slug: appCatalog.slug, name: appCatalog.name })
      .from(appCatalog)
      .where(eq(appCatalog.id, input.appId));
    if (!app) {
      throw new NotFoundError(`Catalog app ${input.appId} not found`);
    }
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId));
    if (!user) {
      throw new NotFoundError(`User ${input.userId} not found`);
    }

    const [existing] = await tx
      .select({ id: userAppGrants.id })
      .from(userAppGrants)
      .where(and(eq(userAppGrants.userId, input.userId), eq(userAppGrants.appId, input.appId)));
    if (existing) {
      return { changed: false };
    }

    await tx.insert(userAppGrants).values({
      userId: input.userId,
      appId: input.appId,
      grantedBy: input.actorId,
    });

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'grant_app',
      subjectUserId: input.userId,
      appId: input.appId,
      detail: { app_slug: app.slug, app_name: app.name },
    });

    return { changed: true };
  });
}

/**
 * DESIGN-001 D-06/D-12 — revoke a direct grant + its 'revoke_app' audit row in ONE
 * transaction. Idempotent: no existing grant → no-op, no audit row.
 */
export async function revokeApp(input: RevokeAppInput): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [app] = await tx
      .select({ slug: appCatalog.slug, name: appCatalog.name })
      .from(appCatalog)
      .where(eq(appCatalog.id, input.appId));
    if (!app) {
      throw new NotFoundError(`Catalog app ${input.appId} not found`);
    }

    const deleted = await tx
      .delete(userAppGrants)
      .where(and(eq(userAppGrants.userId, input.userId), eq(userAppGrants.appId, input.appId)))
      .returning({ id: userAppGrants.id });
    if (deleted.length === 0) {
      return { changed: false };
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'revoke_app',
      subjectUserId: input.userId,
      appId: input.appId,
      detail: { app_slug: app.slug, app_name: app.name },
    });

    return { changed: true };
  });
}
