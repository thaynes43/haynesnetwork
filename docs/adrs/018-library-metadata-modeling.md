# ADR-018: Library metadata modeling — a separate 1:1 `media_metadata` table

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (autonomous run, KICKOFF mandate)

## Context and problem statement

PLAN-004 enriches the media ledger with **descriptive/quality metadata** per Media Item —
IMDb/TMDb ratings + vote counts, the Rotten Tomatoes tomatometer, runtime, resolution, genres,
the *arr "added" date, Tautulli watch-stats (play count / last-viewed, unified across the three
estate Tautulli instances), parsed *arr-tag semantics (requester / source-collection), and a
poster reference. This feeds Library browsing (sort + filter) now and is the substrate PLAN-005
(Ledger) and PLAN-006 (Trash) build on.

`media_items` (DESIGN-005 D-05) is the **Sync/Restore aggregate**: its columns are the *arr
settings snapshot that `upsertMediaItemsBatch` rewrites on every full sync and that Restore
replays. Metadata has a **different write cadence** — a periodic multi-source refresh of
*volatile* values (ratings/votes/watch-stats drift) harvested from several systems, some of
which are frequently unreachable. The question: do the new fields become columns on
`media_items`, or a separate table?

The metadata sources and their live shapes were verified **live** on 2026-07-06 (GET-only, no
writes) against the real Radarr 6.x / Sonarr 4.x / Lidarr 3.x, the HaynesOps + HaynesKube
Tautulli instances, and Maintainerr.

## Decision drivers

- **Write-cadence isolation.** A 6-hourly metadata refresh must not rewrite (and bloat the WAL
  of) the sync aggregate, and must not appear in a Restore preview diff.
- **Volatility.** Ratings/votes/watch-stats change constantly; the *arr-settings snapshot is
  near-static. Mixing them muddies "what Restore replays".
- **Tombstone survival.** DDD-001 T-41: rows are tombstoned, never hard-deleted. Metadata must
  survive a parent tombstone (a deleted title still shows its ratings/poster in the ledger).
- **Multi-source + per-source degradation.** Each field may come from a different tier; a wholly
  failed tier must still let the others land. The row needs its own `source`/`fetched_at`
  provenance, distinct from the sync bookkeeping.
- **Single-writer invariant** (CLAUDE.md hard rule 6): the new table joins the
  `no-direct-state-writes` guard like every other ledger table.

## Considered options

1. **Separate 1:1 `media_metadata` table** keyed by a unique FK to `media_items` (cascade).
2. **Columns on `media_items`.**
3. A generic key/value `media_attributes` table (many rows per item).

## Decision outcome

Chosen option: **a separate 1:1 `media_metadata` table** — because it isolates the volatile,
multi-cadence columns from the Sync/Restore aggregate, carries its own `sources`/`fetched_at`
provenance, keeps its rows after a parent tombstones, and adds exactly one nullable-rich sibling
rather than widening the hot sync-upsert path. Option 2 was rejected: it bloats every
`upsertMediaItemsBatch` write, pollutes the Restore-preview diff with rating churn, and forces the
sync writer to either overwrite or carefully preserve metadata on every pass. Option 3 was
rejected as over-general — the field set is fixed and typed; SELECT-DISTINCT facets and range
filters want real columns, not an EAV.

### Schema (DESIGN-008 D-01)

`media_metadata`: `id` uuid pk; `media_item_id` uuid **UNIQUE** FK → `media_items.id`
`ON DELETE cascade`; `imdb_rating numeric(3,1)`, `imdb_votes int`, `tmdb_rating numeric(4,1)`,
`tmdb_votes int`, `rt_tomatometer int`, `rt_popcorn int`, `runtime_minutes int`,
`resolution text` (CHECK `RESOLUTIONS`), `genres jsonb` (string[]), `arr_added_at timestamptz`,
`play_count int`, `last_viewed_at timestamptz`, `requesters jsonb` (string[]),
`source_collections jsonb` (string[]), `poster_source text` (CHECK `POSTER_SOURCES`, nullable),
`poster_ref text`, `sources jsonb` (which tiers contributed), `extra jsonb` (per-instance Tautulli
breakdown + Maintainerr props), `fetched_at timestamptz NOT NULL`, `created_at`/`updated_at`.
No `media_type` column — the media noun (Movie/Show/Artist) is `media_items.arr_kind` joined at
read time (reuse `ARR_KINDS`, no duplicate enum). Migration **0012**.

### Source tiers (priority order) + per-source degradation

1. **arr** — the live *arr item list (`ratings`/`images`/`genres`/`runtime`/`added`), previously
   strip-dropped, now parsed.
2. **arr_lookup** — `GET /movie/lookup?term=tmdb:{id}` (Radarr), `/series/lookup?term=tvdb:{id}`
   (Sonarr), `/artist/lookup?term=lidarr:{mbid}` (Lidarr) — full metadata for tombstoned /
   never-listed rows **without re-adding** them.
3. **tautulli** — watch-stats across all three estate instances, joined by TMDB/IMDb/TVDB GUID
   (rating keys differ per server); `play_count` = SUM, `last_viewed_at` = MAX, per-instance
   breakdown → `extra.tautulli`.
4. **maintainerr** — computed rule-collection provenance → `extra.maintainerr` (best-effort).
5. **tmdb / tvdb** — direct fallback for holes the *arrs can't fill (keys staged in 1Password
   2026-07-05). RT stays *arr-only (no public RT API).

**Per-source degradation is mandatory** (today's Plex lesson): each tier fails independently —
it logs, records itself absent in `sources`, and never aborts the run. A refresh REPLACES the row
from the reachable tiers (synced-copy semantics); a briefly-down tier leaves its fields null this
cycle and self-heals next cycle.

### Tag parsing (live-verified 2026-07-06)

`media_items.arr_tags` is untouched. The harvest parses labels into structured dimensions:
`/^\d+-(.+)$/` (e.g. `1-manofoz`, `23-helmu15`) → `requesters[]` (a KEEP signal); every other
tag (`emmycollection`, `showcollection`, `kometa-added`, `pmm-added`, `traktrecommended`,
`tmdbpopular`, …) → `source_collections[]` verbatim (auto-collection provenance).

### Staleness / cadence

A NEW sync mode `metadata-refresh` (distinct from full/incremental, which never touch
`media_metadata`) harvests rows where metadata is **missing OR `fetched_at < now() - 6h`**,
oldest-first, batched (500/tx) through the single writer. Cluster CronJob `sync-metadata`
(`15 */6 * * *`, `concurrencyPolicy: Forbid`).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the sync-upsert hot path and the Restore preview are untouched by rating/watch-stat churn. |
| C-02 | Good: metadata survives a parent tombstone (cascade only fires on a hard delete, which never happens — T-41); deleted titles keep ratings/posters in the ledger. |
| C-03 | Good: `sources`/`fetched_at` make a partially-degraded harvest observable; the 6h staleness key drives incremental progress. |
| C-04 | Good: `media_metadata` is single-writer-confined (`upsertMediaMetadataBatch`) and in the `no-direct-state-writes` guard, like every ledger table. |
| C-05 | Neutral: a search that sorts/filters on metadata LEFT JOINs the sibling; unharvested rows still list (empty metadata block, sorted last — NULLS LAST). |
| C-06 | Bad: two write paths per item (sync + harvest); mitigated by the clean 1:1 key and independent cadences. |
| C-07 | Bad: Sonarr/Lidarr expose a single community rating (no imdb/tmdb split), mapped to the `tmdb_*` slots — the `imdb_rating` filter is movie-centric until the TMDB tier backfills. Documented in DESIGN-008 D-02. |

## More information

PRD-001 R-67..R-72; DESIGN-008 (schema, harvest sequence, the D-09 search/cursor contract);
ADR-019 (poster proxy); ADR-008 (one-way sync); ADR-003 (Postgres/Drizzle + transactional
audit); ADR-015 (no reorientation). Glossary T-55..T-58.
