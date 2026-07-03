import { pgTable, uuid, text, timestamp, boolean, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ROLES, type Role } from './enums';

const ROLES_SQL_LIST = ROLES.map((r) => `'${r}'`).join(',');

/**
 * DESIGN-001 D-02 — Better Auth user model (modelName: 'users', `name` field mapped to
 * `display_name` per DESIGN-002 D-02) plus haynesnetwork's role and DIRECT family
 * designation. `image` is required by Better Auth 1.6.x, which writes the OIDC `picture`
 * claim unconditionally.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    displayName: text('display_name').notNull(),
    role: text('role').$type<Role>().notNull().default('Member'),
    isFamily: boolean('is_family').notNull().default(false),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('users_role_enum', sql`${table.role} = ANY (ARRAY[${sql.raw(ROLES_SQL_LIST)}])`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
