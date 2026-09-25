# DESIGN-046: Arr queue janitor — classifier, census, promotion ladder

- **Status:** Accepted
- **Last updated:** 2026-09-25 (D-10: four classifier/action fixes from the L0→L1 census spot-check, made
  before any cell enforces: `skipRedownload` on every removal, the identity-mismatch guard, message-only
  reasons, release-level-only release-defect signals). Prior: 2026-08-01.
- **Satisfies:** governed by ADR-083; extends ADR-007 (Fix / `markHistoryFailed`), ADR-059 /
  DESIGN-030 (queue read model), ADR-082 (audited config precedent). Build plan: PLAN-065.

## Overview

A new standalone sync mode `queue-cleanup` (hourly CronJob, sync rail) reads the **whole**
download queue of Sonarr, Radarr and Lidarr, classifies every errored grab into an Action
Class (T-239), persists one append-only observation row per item, and — only where that
class×instance is switched to `enforce` — executes the class's cleanup action. Ships all-census
(T-238); enforcement arrives through the Promotion Ladder (T-240) as audited config flips, not
releases. Nightly owner visibility rides a new section of the existing failure-digest email.

## Detailed design

### D-01 — Job shape: standalone mode on the sync rail

`--mode=queue-cleanup` follows the standalone-mode conventions exactly (recon 2026-08-01):

- `'queue-cleanup'` joins `SYNC_RUN_KINDS` (`packages/db/src/schema/enums.ts`); the
  `sync_runs.run_kind` CHECK is rebuilt in migration 0075 for enum hygiene, but the mode
  **writes no `sync_runs` row** — like the other standalone modes its trail is its own table
  (D-06) plus one JSON log line per phase and per action.
- `sync.ts`: USAGE, the no-`--source` guard list, `defaultSources []`, client construction,
  `runSync` threading. `orchestrator.ts`: early-return block (the `activity-scan` pattern), new
  `RunSyncOptions` injection field, `SyncReport.queueCleanup` + `queueCleanupError`
  (`totalFailure` ⇒ exit 1).
- Schedule (haynes-ops helmrelease): `25 * * * *`, `concurrencyPolicy: Forbid`,
  `backoffLimit 1`, same image/secret/resource shape as `sync-incremental`.

### D-02 — Whole-queue read

The existing `getQueue()` reads are per-parent-id. Add an unfiltered, **paged** whole-queue
read to the three read clients (`packages/arr/src/read.ts`), page size 250, following pages
until `totalRecords` is exhausted; each record must carry `id`, `status`,
`trackedDownloadStatus`, `trackedDownloadState`, `statusMessages[]`, `errorMessage`, `added`,
the parent ids, and `downloadId`. Read-only; BC-03 ACL — only the consumed subset enters the
schema.

### D-03 — Classifier

`classifyQueueItem(record) → { class, reason, confidence }` in
`packages/domain/src/queue-cleanup.ts` — pure, exhaustively tested, patterns in versioned code
(ADR-083: enforcement scope is config; classification is code). First-match order:

| Class (T-239) | Signal (initial pattern set, tuned by census) |
|---|---|
| `have_better` | `importBlocked`/`importPending` + a `statusMessages` message matching the *arr's own already-satisfied rejections: "Not an upgrade for existing …", "Not a Custom Format upgrade …", "…quality cutoff … already met…". The *arr already compared against the library — the janitor trusts its verdict rather than re-deriving (the *arrs are the source of truth, hard rule 4). Since D-10, not when the item also carries an identity mismatch (then `unknown`). |
| `bad_release` | `trackedDownloadStatus: 'error'`; or messages matching "Unable to parse…", "…sample…", "…archive…/…password…/…executable…" (release defects); or `status: 'failed'`. Since D-10 the release-defect patterns read release-level messages only ("Sample" and "Found archive file…" verbatim). |
| `retry_import` | `importBlocked`/`importPending` with an empty/transient message set ("Waiting to import…", no messages at all) — the stuck-import class `ProcessMonitoredDownloads` exists for. |
| `unknown` | Everything else — **including, initially, Lidarr's match-ambiguity messages** ("…not close enough…", manual-import prompts): with 59 live items and unobserved message text, Lidarr's dominant class deliberately starts unclassified; census evidence graduates specific patterns into A/B/C (Q-01). |

Anything not matched with confidence falls to `unknown`. Items younger than
`minItemAgeHours` (D-05) classify normally but are marked `skipped_young` and never acted on.

### D-04 — Actions per class + safety rails

Executed only for `enforce` cells, in `evaluateQueueCleanup` (single writer, `@hnet/domain`):

- `have_better` → `DELETE /queue/{id}?removeFromClient=true&blocklist=true&skipRedownload=true`
  (new `deleteQueueItem(id, opts)` on `ArrWriteClientBase`, `packages/arr/src/write.ts` — shared
  verbatim by the three *arrs). No re-search: the library is already satisfied. `skipRedownload`
  is what makes that true (D-10).
- `retry_import` → at most one `ProcessMonitoredDownloads` per instance per run (it is
  estate-wide); an item still `retry_import` after `retryEscalateRuns` consecutive runs
  (tracked via its persisted action rows) escalates to `bad_release` handling.
- `bad_release` → `deleteQueueItem(id, {removeFromClient:true, blocklist:true, skipRedownload:true})`, then the
  owning *arr's existing search command (`EpisodeSearch`/`MoviesSearch`/`AlbumSearch`) **only
  if** the target is still monitored (checked via the read client); unmonitored targets get
  the blocklist only.
- `unknown` → never acted on (ADR-083, normative).

Rails (all levels): per-instance per-run mutation cap `maxActionsPerRun` (default 10);
`minItemAgeHours` (default 2) so freshly-completed items get their organic import window; a
failed *arr write logs + records `outcome:'error'` and counts against the cap; the whole run
is idempotent (an item already handled disappears from the next queue read; blocklist makes
re-grab of the same release impossible).

**Write confinement:** `@hnet/sync` keeps importing only `@hnet/arr/read`. The write bundle is
built inside `@hnet/domain` (the `arrClientBundleFromEnv` pattern) and injected opaque; the
`arr-write-import-guard` test stays green.

### D-05 — Config: `arr_queue_cleanup_config` (audited app setting)

One `app_settings` jsonb key (migration 0075 rebuilds the key CHECK), ADR-082 shape:

```jsonc
{
  "modes": {              // 'census' | 'enforce' per class×instance (T-240 cells)
    "sonarr":  { "have_better": "census", "retry_import": "census", "bad_release": "census" },
    "radarr":  { "have_better": "census", "retry_import": "census", "bad_release": "census" },
    "lidarr":  { "have_better": "census", "retry_import": "census", "bad_release": "census" }
  },
  "maxActionsPerRun": 10,
  "minItemAgeHours": 2,
  "retryEscalateRuns": 6
}
```

- `QUEUE_CLEANUP_MODES = ['census','enforce'] as const` (`SPACE_POLICY_MODES` idiom); no
  `unknown` cell — it has no enforce state by construction.
- Resolution **DB row → code default** (all-census); typeof-guarded reads fail safe to
  census. No env tier: unlike the governor there is no pre-existing env contract to honor.
- Writer `setArrQueueCleanupConfig({db?, config, actorId})` validates
  (`queueCleanupConfigError`: unknown keys, bad modes, caps 1..100, age 0..168, escalate
  1..48) then delegates to `setAppSetting` — audit action `update_app_setting`,
  `detail:{key,before,after}` same-tx (hard rule 6). Zod mirror at the tRPC edge.
- Ladder state is **derived**: level = f(modes matrix); age = latest `update_app_setting`
  audit row for the key (or feature-ship date when unwritten).

### D-06 — Persistence: `arr_queue_cleanup_actions` (migration 0075)

Append-only; the census record AND the action audit in one table:

`id`, `instance` (`sonarr|radarr|lidarr`, CHECK), `queueItemId`, `downloadId`, `title`,
`actionClass` (CHECK on `QUEUE_CLEANUP_ACTION_CLASSES`), `mode` (`census|enforce`), `action`
(`none|removed_blocklisted|retried_import|blocklisted_searched|skipped_young|skipped_cap`),
`outcome` (`observed|done|error`), `reason` (the driving or most informative message, ≤500 chars;
never a release or file name, D-10), `error`,
`createdAt`. Indexed `(createdAt desc)` and `(instance, downloadId, createdAt desc)` — the
second powers retry-escalation counting and "seen before" dedup. Digest and tuning read this
table; a retention sweep is Q-02.

### D-07 — Digest section (owner visibility, nightly)

Extend the existing `activity_failure_digest` payload (`packages/domain/src/activity/digest.ts`)
with a `queueCleanup` object — last-24h rollup from D-06: per instance × class counts
(census vs enforced), actions taken, top-3 distinct reasons per class with counts, ladder
level + **age in days** + the next criteria line from PLAN-065, and a **stagnation nag**: when
any class×instance has met its promotion criteria (PLAN-065) or the ladder age exceeds 14 days
at the same level, the digest subject gains `[janitor: promotion due]`. Render in the
`activity_failure_digest` case of `renderOutboxEmail` (`notify-outbox.ts`). The digest now
enqueues when EITHER open import failures exist OR the janitor observed anything — a clean
ledger no longer suppresses janitor visibility.

### D-08 — /admin surface

`/admin/janitor`, modeled on `/admin/governor` (ADR-082 C-05): a 3×3 mode grid
(class × instance, `census|enforce` toggle cells — the books-actions grant-grid shape), the
three numeric knobs, ladder level + age readout, and a last-7-days census/action summary
table read from D-06. `adminProcedure` only; ConfirmButton two-step on any census→enforce
flip (ADR-014); reflow-safe (ADR-015). Router `queueCleanup` (`@hnet/api`): `status` query +
`config.set` mutation.

### D-09 — Test strategy

- Classifier: table-driven unit tests over captured/synthetic queue records per class per
  *arr, including precedence and unknown-fallback; fixtures grow from live census reasons.
- `evaluateQueueCleanup`: embedded-Postgres tests with stubbed clients — census writes rows
  and never calls writes; enforce honors caps/age/monitored-check/escalation; *arr write
  failure → `outcome:'error'` + run continues; config resolution + validation matrix.
- Digest: payload composition + render snapshot incl. nag line. Import-guard test unchanged.
- e2e/dev:local: stub *arrs gain a canned errored queue so `--mode=queue-cleanup` runs
  locally end-to-end in census.

### D-10 — Rulings from the census spot-check (2026-09-25, before L1)

The L0→L1 spot-check (56 days of census, read-only) met the promotion criterion: 69 of 69
Sonarr/Radarr `have_better` rows were judged correct. It also found four defects that had to be
fixed before any cell enforces. Each row below is pinned by tests (`queue-cleanup.test.ts`,
`write-clients.test.ts`). Upstream references are the running tags: Sonarr v4.0.20.3014, Radarr
v6.4.4.10685, Lidarr v3.1.6.5078.

| # | Ruling | Evidence and reason |
|---|---|---|
| 1 | **Every janitor removal sends `skipRedownload=true`** (`have_better` and `bad_release`); `deleteQueueItem` takes it as a required option. `bad_release` keeps its own search, which runs only when the target is monitored. | All three *arrs run with `autoRedownloadFailed: true`. Upstream, `QueueController.RemoveAction(id, removeFromClient = true, blocklist = false, skipRedownload = false, changeCategory = false)` sends a blocklisting removal through `FailedDownloadService.MarkAsFailed(trackedDownload, skipRedownload)`, and `RedownloadFailedDownloadService` re-searches unless `SkipRedownload` is set. Radarr history showed 24 of 24 failed downloads re-grabbed within 3 to 30 seconds. Without the flag, `have_better` would re-search (D-04 and the /admin copy promise it does not) and `bad_release` would search twice, the second search issued without the janitor's monitored check. |
| 2 | **Identity-mismatch guard.** A `have_better` match whose item also carries an identity mismatch classifies `unknown` (report only, no fall-through), with the mismatch message as the reason. Patterns: "not found in the grabbed release", "matched to series/movie by ID", "unexpected considering the … folder name", plus the title-mismatch warnings defensively. | Eight "Lioness.2023 S01E01–08" releases were grabbed for "Lioness (2021)", a different show missing those episodes, and they also carried CF-score "not an upgrade" messages. When the *arr doubts what the grab is, its "already have it" verdict may be about the wrong target, and removing a grab that is correctly identified could lose wanted episodes. |
| 3 | **`reason` is a message, never a name.** A statusMessage title with messages under it only names the release (single-result or plain warning) or a file (multi-file set), so it is neither matched nor stored. Order of preference: `errorMessage`, every `messages[]` entry, titles that are the message (an entry with no messages, e.g. Lidarr's single-result shape), and the generic "One or more … expected in this release were not imported or missing" header last. The release name is already the row's `title` column. | 129 of 195 Sonarr `unknown` rows stored a release name as the reason, because titles were collected before messages, so the digest's "top reasons" were release names. |
| 4 | **Release-defect patterns read release-level messages only.** Release level means `errorMessage`, the messages of the entry titled with the download itself, and title-borne messages outside a multi-file set. It never includes a per-file entry: anything after the multi-file header, or a title that is a media file name other than the download's own title. "Sample" matches only the upstream `NotSampleSpecification` rejection verbatim; "Unable to determine if file is a sample" is not a verdict. "archive" matches only the upstream "Found archive file, might need to be extracted". | Per-file "…-sample.mkv" titles inside otherwise good releases (The Gentlemen, Star Wars Visions) were briefly classed `bad_release`; at L2 that would blocklist good releases. The same fault reached `\barchive\b`, because upstream embeds release names and paths in other messages ("Archive 81", "…not found in the grabbed release: <release>", "…eligible for import in <path>"), and it reached per-file rejections such as an unparseable featurette. Every change moves items toward `unknown` (report only), never toward an action. |

Ladder bookkeeping (the spot-check entry and the L1 flip) lives in PLAN-065's ladder log, not here.

## Alternatives considered

Covered in ADR-083 (off-the-shelf janitor, agentic cron, status quo). Within this design:
per-item statusMessage patterns as DB config was deferred (Q-03) — versioned, tested code
wins while the pattern set is young; a bespoke config table instead of `app_settings` was
rejected (ADR-082 precedent fits, one migration lighter).

## Test strategy

See D-09.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Which Lidarr `importPending` reason strings graduate out of `unknown`, and into which class? The 59-item pile is likely match-ambiguity from the soularr/slskd path; some may deserve a dedicated "manual match" class rather than A/B/C. | (open — answer with the first week of census data; decision recorded as a PLAN-065 ladder note + classifier PR) |
| Q-02 | Retention sweep for `arr_queue_cleanup_actions` (append-only forever vs. 90-day prune)? | (open — revisit at L3; volume is small: ≤ queue size per hour) |
| Q-03 | Should classifier patterns graduate to DB config for release-free tuning once stable? | (open — only if post-L3 tuning cadence demands it) |
