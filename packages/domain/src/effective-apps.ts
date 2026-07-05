import { appCatalog, roleAppGrants, roles, users, type DbClient } from '@hnet/db';
import { asc, eq } from 'drizzle-orm';
import { resolveDb } from './db-client';

/**
 * A catalog app a user can see. ADR-012: with one role per user there is a single
 * provenance (the user's role), so there are no per-source/tag fields — every visible app
 * comes from the role.
 */
export interface EffectiveApp {
  appId: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  url: string;
  sortOrder: number;
}

const APP_COLUMNS = {
  appId: appCatalog.id,
  slug: appCatalog.slug,
  name: appCatalog.name,
  description: appCatalog.description,
  icon: appCatalog.icon,
  url: appCatalog.url,
  sortOrder: appCatalog.sortOrder,
} as const;

/**
 * ADR-012 — the complete set of apps a user can open, ordered by sort_order, name. An
 * Admin-role user sees EVERY catalog app (implicit all-apps — new apps included
 * automatically); every other user sees exactly the apps their role grants
 * (role_app_grants). Unlike the old model there is no separate default-visible union —
 * "default visible" is now the Default role's app set.
 */
export async function effectiveAppsForUser(userId: string, dbc?: DbClient): Promise<EffectiveApp[]> {
  const q = resolveDb(dbc);

  const [u] = await q
    .select({ roleId: users.roleId, isAdmin: roles.isAdmin, grantsAll: roles.grantsAll })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId));
  if (!u) return [];

  // Admin (superuser) and any grants_all role see EVERY app — including ones added later.
  if (u.isAdmin || u.grantsAll) {
    return q.select(APP_COLUMNS).from(appCatalog).orderBy(asc(appCatalog.sortOrder), asc(appCatalog.name));
  }

  return q
    .select(APP_COLUMNS)
    .from(roleAppGrants)
    .innerJoin(appCatalog, eq(appCatalog.id, roleAppGrants.appId))
    .where(eq(roleAppGrants.roleId, u.roleId))
    .orderBy(asc(appCatalog.sortOrder), asc(appCatalog.name));
}
