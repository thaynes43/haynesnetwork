# ADR-022: Generalize Restore into `executeArrAdd` + emergency export; reframe the fileless backlog

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (autonomous run, KICKOFF mandate; live-DB verified)

## Context and problem statement

The Ledger section (PLAN-005) gives an authorized user two powers over a **filtered set** of
ledger rows: (a) **Add & search** the items in the matching `*arr`, and (b) **export** the set to
disk as an emergency import list. Power (a) is the same disaster-recovery re-add the admin-only
**Restore** already performs (`executeRestore`, DESIGN-005 D-16) — Restore is just the special
case where the set is "everything the ledger has that the live `*arr` lost". Rather than fork a
second re-add path, we generalize the one that exists.

Restore, as shipped, is deliberately narrow: it **skips any row already present** in the live
`*arr` and searches are **OFF** (Q-04 — indexer safety beats convenience). The Ledger's real
workload is different: the household's Radarr holds thousands of movies that are **present but
unmonitored with nothing on disk** — a backlog to (re)acquire, not to re-add. That set must be
*monitored + searched*, which the skip-if-present Restore path cannot do.

PLAN-005 originally proposed importing a 4,008-row "radarr fileless backlog" markdown snapshot
(`.agents/plans/radarr-fileless-backlog.md`) into `media_items` as tombstoned rows (draft R-56).
A live probe of the staging database showed that import is **unnecessary**.

## Decision drivers

1. One re-add mechanism, not two — keep the audited `restore_runs` record, the fresh-diff TOCTOU
   re-validation, the by-name profile/root/tag mapping, and the per-item report unchanged.
2. The Ledger's actual need (monitor + search the present-but-unmonitored backlog) must be a
   first-class outcome, not a skipped no-op.
3. No synthetic data, no import migration, no new writer if the live database already models the
   need (evidence over assumption — CLAUDE.md "ask rather than invent").
4. Every `*arr` write stays confined to `packages/domain` (the ADR-011/D-12 guard is untouched).

## Decision

- **C-01 — `executeRestore` is generalized into `executeArrAdd`** taking an explicit id list, an
  initiation **`reason`** (`ARR_ADD_REASONS = ['restore','ledger_add']`), and a **`searchOnAdd`**
  flag. It classifies each approved id against **fresh** live state into **three per-item
  outcomes**:
  - **absent** from the live `*arr` → **add** it monitored (recorded profile/root/tags — the
    existing `addItemToArr` path); when `searchOnAdd`, trigger the item search on the **new** id;
  - **present but unmonitored** → **set `monitored=true`** via the `*arr` bulk-editor PUT
    (`PUT /{movie,series,artist}/editor` — a new confined write method) + item search on the
    **existing** id. This is the real fileless workload; the old skip-if-present behavior must
    NOT skip these when the reason is `ledger_add`;
  - **present + monitored** (or **any present row under reason `restore`**) → **skip**, recorded.
  `executeRestore` becomes a thin `executeArrAdd({ reason:'restore', searchOnAdd:false })` wrapper
  that preserves the failsafe contract exactly (present → skip, searches OFF, only monitored
  ledger rows eligible), so the `restore` router, page, and tests are untouched. **Search-cap
  safety:** a searched run rejects `> 1000` items (`ARR_ADD_SEARCH_CAP` →
  `ARR_ADD_SEARCH_CAP_EXCEEDED`) before any `*arr` call — the `*arrs` queue commands internally
  but indexers rate-limit, so the UI guides batching (e.g. by vote tier).

- **C-02 — The durable record stays the `restore_runs` row** (conceptually "arr-add runs" in the
  DDD; the **table name is kept** to avoid a rename migration). A `reason` column
  (`NOT NULL DEFAULT 'restore'`, CHECK from `ARR_ADD_REASONS`, migration 0014) distinguishes
  Restore from Ledger-add; existing rows backfill to `restore`. `recordRestoreResult` keeps its
  same-tx write-back: an **added** success clears the tombstone, adopts the new `*arr` id, and
  writes the `restored` ledger event; a **monitored** success sets `monitored=true` in place
  (no tombstone, no `restored` event). When a search was triggered it also writes a
  **`search_requested`** ledger event in the **same transaction** (hard rule 6; reusing the T-44
  event type). Ledger-add runs are read back through `reason='ledger_add'`-scoped projections so
  the section never surfaces failsafe Restore runs and vice-versa.

- **C-03 — Export format is deterministic JSONL** — one round-trippable object per row,
  `{ kind, title, year, tmdbId, tvdbId, musicbrainzArtistId, qualityProfileName, rootFolder,
  tags, monitored, onDisk, tombstonedAt }`, ordered `(sort_title, id)`. Streamed by a Next route
  handler (`/api/ledger/export`, section-gated to Read-Only+, content-disposition attachment) that
  iterates keyset pages server-side so a 17k-row export never buffers in memory. JSONL (over CSV or
  a native `*arr` "custom list") is line-oriented (grep/split friendly), lossless for the array
  `tags`, and trivially fed row-by-row into a re-import script.

- **C-04 — The fileless-backlog import is DROPPED; R-56 is reframed.** A live probe of the staging
  database (2026-07-06) found that **all 4,008 backlog TMDB ids already exist as live Radarr
  `media_items` rows** — 0 missing, 0 tombstoned; **3,910 unmonitored** and **3,971 with no file**
  — and `media_metadata` carries `imdb_votes` for **~99%** of Radarr rows, so the vote tiers the
  backlog cared about are already filterable. There is therefore **no import, no synthetic rows,
  no new writer**: the backlog's need is fully met by the Ledger filters (unmonitored + no-file +
  vote tiers + the shared facets) plus the `ledger_add` bulk action in C-01. The
  glossary term **T-66 Fileless Set** names the *filterable state* (on-disk none + unmonitored),
  not an import. The backlog markdown stays as a historical reference, cited from here.

## Consequences

- **Positive:** one re-add engine with a per-item outcome for the real backlog workload; the
  failsafe is unchanged and still callable; export is a small stateless stream; and dropping the
  import removes a whole migration, a synthetic-key scheme, a writer, and its idempotency surface —
  the ledger stays a faithful `*arr` mirror with no app-invented rows.
- **Negative / trade-offs:** `restore_runs` now holds two run kinds distinguished only by `reason`
  (the table name is a slight misnomer — accepted to avoid a rename migration). A monitored (flip)
  success writes `monitored=true` back to `media_items` — a sanctioned write-back (ADR-008), which
  the next sync reconciles anyway.
- **Neutral:** the bulk-editor monitor PUT is a new `@hnet/arr/write` method; it stays
  import-confined to `packages/domain` (guard untouched).
- **Neutral (best-effort search):** the add/monitor is the durable state change; the follow-on
  item search under `searchOnAdd` is **best-effort**. A search-command failure leaves the item
  `ok:true` (`searched:false`) with a `searchError` recorded on the result, the run still
  `completed`, and — because `search_requested` is written only when `searched` — **no
  `search_requested` ledger event** for that item. Consumers must key success off `ok`/`searched`,
  not off the presence of error text (see DESIGN-009).

## Alternatives considered

- **A second, separate Ledger add path.** Rejected — duplicates the TOCTOU re-validation, the
  by-name mapping, and the `restore_runs` audit for no benefit.
- **Skip-if-present for Ledger too (monitor via a later sync).** Rejected — the whole point is to
  monitor+search the present-but-unmonitored backlog *now*; deferring to sync does neither.
- **Import the fileless backlog as tombstoned rows (draft R-56).** Rejected on evidence — the rows
  already exist live and are already filterable; an import would create 4,008 duplicate/synthetic
  rows a real sync would then have to reconcile.
- **CSV export.** Rejected — lossy for the `tags` array and needs quoting rules; JSONL is
  lossless and line-streamable.
