import { pgTable, uuid, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import {
  COLLECTION_BUILDER_TYPES,
  COLLECTION_PROVIDERS,
  COLLECTION_SUGGESTION_STATUSES,
  type CollectionBuilderType,
  type CollectionProvider,
  type CollectionSuggestionStatus,
} from './enums';

const BUILDER_SQL_LIST = COLLECTION_BUILDER_TYPES.map((a) => `'${a}'`).join(',');
const PROVIDER_SQL_LIST = COLLECTION_PROVIDERS.map((a) => `'${a}'`).join(',');
const STATUS_SQL_LIST = COLLECTION_SUGGESTION_STATUSES.map((a) => `'${a}'`).join(',');

/**
 * ADR-069 / DESIGN-042 D-05 (PLAN-052 — the member contribution flow) — a member's PROPOSED collection.
 * A `suggest`-granted member files one of these from the walls; it lands `pending` and applies NOTHING.
 * A `manage` admin approves (materialize the recipe via the confined @hnet/libretto writer — acquisition
 * OFF unless the approver holds `acquire` and opts in; `created_recipe_id` stamped) or declines with a
 * reason. Guarded single-writer table: createCollectionSuggestion co-writes a
 * `create_collection_suggestion` permission_audit row same-tx; approve/decline co-write a
 * `review_collection_suggestion` row same-tx (hard rule 6). Provider-shaped (`provider`, 'libretto' now)
 * so the Kometa leg needs no schema change (ADR-069 C-06). This is the ONLY durable local collection
 * intent — an approved suggestion's recipe lives in Libretto; a declined one is a closed audit trail.
 */
export const collectionSuggestions = pgTable(
  'collection_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    suggesterId: uuid('suggester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<CollectionProvider>().notNull().default('libretto'),
    name: text('name').notNull(),
    builderType: text('builder_type').$type<CollectionBuilderType>().notNull(),
    builderRef: text('builder_ref').notNull(),
    /** The target library the member wants it in (a Libretto target label/id); null = manager decides. */
    targetLibrary: text('target_library'),
    /** The suggester's optional note ("the series I started"). */
    note: text('note'),
    status: text('status').$type<CollectionSuggestionStatus>().notNull().default('pending'),
    /** The manage admin's reason on decline (null while pending / on approve). */
    decisionNote: text('decision_note'),
    /** The Libretto recipe id created on approval (null while pending / on decline). */
    createdRecipeId: text('created_recipe_id'),
    reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'collection_suggestions_provider_enum',
      sql`${t.provider} = ANY (ARRAY[${sql.raw(PROVIDER_SQL_LIST)}])`,
    ),
    check(
      'collection_suggestions_builder_type_enum',
      sql`${t.builderType} = ANY (ARRAY[${sql.raw(BUILDER_SQL_LIST)}])`,
    ),
    check(
      'collection_suggestions_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(STATUS_SQL_LIST)}])`,
    ),
  ],
);

export type CollectionSuggestionRow = typeof collectionSuggestions.$inferSelect;
export type CollectionSuggestionInsert = typeof collectionSuggestions.$inferInsert;
