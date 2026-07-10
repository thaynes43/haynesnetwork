import { pgTable, uuid, text, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  POSTER_GUARD_TARGET_KINDS,
  POSTER_GUARD_REASONS,
  type PosterGuardTargetKind,
  type PosterGuardReason,
} from './enums';

const TARGET_KINDS_SQL_LIST = POSTER_GUARD_TARGET_KINDS.map((k) => `'${k}'`).join(',');
const REASONS_SQL_LIST = POSTER_GUARD_REASONS.map((r) => `'${r}'`).join(',');

/**
 * ADR-043 / DESIGN-021 D-04 (PLAN-024 — Peloton poster guard). The APPEND-ONLY apply ledger the
 * `poster-guard` sync mode writes: one row every time it (re-)pushes a durable override poster to a
 * k8plex Peloton show/season. It is BOTH the drift baseline (the latest row per `rating_key` records
 * the Plex thumb path we observed right AFTER our upload + the sha256 of the bytes we pushed) AND the
 * audit trail (each row says why we re-applied and what the previous thumb was). Drift detection is
 * "does the live Plex thumb still equal the latest row's `applied_thumb`, and does the mapped asset's
 * sha256 still equal the latest row's `asset_sha256`?" — if either differs (or there is no row), the
 * guard re-applies and appends a new row (migration 0034).
 *
 * Written ONLY by the @hnet/domain `runPelotonPosterGuard` single-writer (guard-listed), which inserts
 * the row in the SAME transaction it records the apply (CLAUDE.md hard rule 6). Append-only, like
 * ledger_events / sync_runs — rows are never updated or deleted; "current applied identity" is the
 * newest row per target. Bytes never land here — the override PNGs live in the image (ADR-043 C-01),
 * this table stores only their identity + provenance.
 */
export const posterGuardApplications = pgTable(
  'poster_guard_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** A per-invocation CORRELATION id (self-generated at run start) grouping every re-apply from one
     *  guard run. Like the smart-alerts mode, poster-guard writes NO sync_runs row (this append-only
     *  ledger IS its audit trail — ADR-043 C-05); run_id is a correlation uuid, not a sync_runs FK. */
    runId: uuid('run_id').notNull(),
    /** The k8plex Plex ratingKey of the show or season whose poster we pushed. */
    ratingKey: text('rating_key').notNull(),
    /** 'show' (series art) | 'season' (duration art). */
    targetKind: text('target_kind').$type<PosterGuardTargetKind>().notNull(),
    /** The Peloton show title (e.g. 'Bike Bootcamp') — denormalized for the audit view. */
    showTitle: text('show_title').notNull(),
    /** The season index for a 'season' target (the duration in minutes); null for a 'show'. */
    seasonIndex: integer('season_index'),
    /** The durable override asset filename applied (e.g. '30-minutes.png', 'bike-bootcamp-poster.png'). */
    assetName: text('asset_name').notNull(),
    /** sha256 (hex) of the asset bytes we pushed — an owner PNG swap changes this ⇒ re-apply. */
    assetSha256: text('asset_sha256').notNull(),
    /** 'initial' (no prior row) | 'drift' (thumb moved) | 'asset-updated' (bytes changed). */
    reason: text('reason').$type<PosterGuardReason>().notNull(),
    /** The Plex thumb path observed BEFORE this re-apply (the drifted value), or null on 'initial'. */
    previousThumb: text('previous_thumb'),
    /** The Plex thumb path observed right AFTER our upload — the baseline the next run diffs against.
     *  Nullable only for the defensive case where the post-upload read yields no thumb (then the next run
     *  sees a mismatch and self-heals); in practice Plex always reports the fresh thumb immediately. */
    appliedThumb: text('applied_thumb'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'poster_guard_applications_target_kind_enum',
      sql`${t.targetKind} = ANY (ARRAY[${sql.raw(TARGET_KINDS_SQL_LIST)}])`,
    ),
    check(
      'poster_guard_applications_reason_enum',
      sql`${t.reason} = ANY (ARRAY[${sql.raw(REASONS_SQL_LIST)}])`,
    ),
    // Drift detection reads the newest row per target every run — index the lookup.
    index('poster_guard_applications_rating_key_created_idx').on(t.ratingKey, t.createdAt.desc()),
  ],
);

export type PosterGuardApplicationRow = typeof posterGuardApplications.$inferSelect;
export type PosterGuardApplicationInsert = typeof posterGuardApplications.$inferInsert;
