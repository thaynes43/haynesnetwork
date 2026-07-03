import { appCatalog, effectiveAppGrants, type DbClient } from '@hnet/db';
import { asc, eq } from 'drizzle-orm';
import { resolveDb } from './db-client';

/**
 * One effective grant row WITH provenance (R-22): a user granted an app directly and
 * via two tags yields three rows — the dashboard dedupes on appId, the admin UI shows
 * where each permission comes from.
 */
export interface EffectiveApp {
  appId: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  url: string;
  sortOrder: number;
  source: 'direct' | 'tag';
  tagId: string | null;
}

/**
 * DESIGN-001 D-11 — typed wrapper over the effective_app_grants view (the canonical
 * union of direct grants and tag-derived grants), joined to the catalog and ordered by
 * sort_order, name. Note: default-visible tiles are a separate ∪ at the dashboard
 * query (AC-04) — this returns grants only.
 */
export async function effectiveAppsForUser(
  userId: string,
  dbc?: DbClient,
): Promise<EffectiveApp[]> {
  const q = resolveDb(dbc);
  return q
    .select({
      appId: effectiveAppGrants.appId,
      slug: appCatalog.slug,
      name: appCatalog.name,
      description: appCatalog.description,
      icon: appCatalog.icon,
      url: appCatalog.url,
      sortOrder: appCatalog.sortOrder,
      source: effectiveAppGrants.source,
      tagId: effectiveAppGrants.tagId,
    })
    .from(effectiveAppGrants)
    .innerJoin(appCatalog, eq(appCatalog.id, effectiveAppGrants.appId))
    .where(eq(effectiveAppGrants.userId, userId))
    .orderBy(asc(appCatalog.sortOrder), asc(appCatalog.name));
}
