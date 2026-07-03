import { pgView, uuid, text } from 'drizzle-orm/pg-core';

/**
 * DESIGN-001 D-11 — effective permissions derivation (R-22, AC-06).
 *
 * Declared `.existing()`: the view DDL lives in migrations/0001_init.sql (Q-04 resolved:
 * the SQL is hand-audited into 0001 rather than relying on drizzle-kit view emission).
 * UNION ALL deliberately preserves one row per provenance — a user granted an app
 * directly AND via two tags yields three rows; the dashboard dedupes on app_id, the
 * admin UI renders every row's provenance (R-22).
 *
 *   CREATE VIEW effective_app_grants AS
 *     SELECT uag.user_id, uag.app_id, 'direct'::text AS source, NULL::uuid AS tag_id
 *       FROM user_app_grants uag
 *     UNION ALL
 *     SELECT ut.user_id, tag_grant.app_id, 'tag'::text AS source, ut.tag_id
 *       FROM user_tags ut
 *       JOIN tag_app_grants tag_grant ON tag_grant.tag_id = ut.tag_id;
 */
export const effectiveAppGrants = pgView('effective_app_grants', {
  userId: uuid('user_id').notNull(),
  appId: uuid('app_id').notNull(),
  source: text('source').$type<'direct' | 'tag'>().notNull(),
  tagId: uuid('tag_id'),
}).existing();

// drizzle-orm 0.36 has no $inferSelect on views — keep the row shape by hand.
export interface EffectiveAppGrantRow {
  userId: string;
  appId: string;
  source: 'direct' | 'tag';
  tagId: string | null;
}
