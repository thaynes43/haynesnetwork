import { pgTable, uuid, text, timestamp, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles } from './roles';
import {
  SECTION_IDS,
  SECTION_PERMISSION_LEVELS,
  type SectionId,
  type SectionPermissionLevel,
} from './enums';

const SECTION_IDS_SQL_LIST = SECTION_IDS.map((s) => `'${s}'`).join(',');
const SECTION_LEVELS_SQL_LIST = SECTION_PERMISSION_LEVELS.map((l) => `'${l}'`).join(',');

/**
 * ADR-021 / DESIGN-009 D-03 — a role's access LEVEL per top-level section
 * (Edit / Read-Only / Disabled). One row per (role, section); the absence of a row means
 * the section's documented default (SECTION_DEFAULT_LEVELS). An `is_admin` role stores NO
 * rows and implies Edit everywhere (ADR-021 C-03), exactly like role_library_grants /
 * role_app_grants. Written only by the @hnet/domain `setSectionPermission` single-writer,
 * which co-writes a `permission_audit` row in the same transaction (CLAUDE.md hard rule 6).
 * Composite PK dedupes; the FK cascades so deleting a role removes its section rows.
 */
export const roleSectionPermissions = pgTable(
  'role_section_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    sectionId: text('section_id').$type<SectionId>().notNull(),
    level: text('level').$type<SectionPermissionLevel>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.sectionId] }),
    check(
      'role_section_permissions_section_enum',
      sql`${t.sectionId} = ANY (ARRAY[${sql.raw(SECTION_IDS_SQL_LIST)}])`,
    ),
    check(
      'role_section_permissions_level_enum',
      sql`${t.level} = ANY (ARRAY[${sql.raw(SECTION_LEVELS_SQL_LIST)}])`,
    ),
  ],
);

export type RoleSectionPermissionRow = typeof roleSectionPermissions.$inferSelect;
export type RoleSectionPermissionInsert = typeof roleSectionPermissions.$inferInsert;
