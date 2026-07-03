import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * DESIGN-001 D-03 — Better Auth verification table. Unused by the OIDC-only flow, but
 * Better Auth's core expects the model to exist.
 */
export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export type VerificationRow = typeof verification.$inferSelect;
export type VerificationInsert = typeof verification.$inferInsert;
