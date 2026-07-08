import { pgTable, uuid, text, timestamp, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles, SEEDED_ROLE_IDS } from './roles';

/**
 * DESIGN-001 D-02 — Better Auth user model (modelName: 'users', `name` field mapped to
 * `display_name` per DESIGN-002 D-02). ADR-012: a user's access is entirely defined by
 * exactly one role (`role_id`); the old `role` enum column and the `is_family` flag are
 * gone. `image` is required by Better Auth 1.6.x, which writes the OIDC `picture` claim.
 * `role_id` is ON DELETE RESTRICT — the domain deleteRole writer reassigns members to the
 * Default role before deleting, so a role in use is never orphaned.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  roleId: uuid('role_id')
    .notNull()
    .default(sql.raw(`'${SEEDED_ROLE_IDS.default}'::uuid`))
    .references(() => roles.id, { onDelete: 'restrict' }),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // fix/plex-identity-mapping — the admin-set Plex identity OVERRIDE (migration 0023). The OIDC
  // id_token carries the Authentik email, which for a linked pre-existing account need NOT equal
  // the user's plex.tv email/username; these columns let an admin pin the real Plex identity so
  // My Plex owner/friend matching resolves. Read as the FALLBACK after the OIDC plex_* claim
  // (@hnet/auth resolvePlexIdentity). Both nullable; stored trimmed + lowercased by the writer.
  plexEmail: text('plex_email'),
  plexUsername: text('plex_username'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
