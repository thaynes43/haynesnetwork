# DESIGN-046: Arr queue janitor — classifier, census, promotion ladder

- **Status:** Accepted
- **Last updated:** 2026-10-03 (D-25: a release the *arr holds on its delay profile is `waiting`, left out of the census
  instead of counted as `unknown`, after the owner's 120-minute Usenet delay profile on Sonarr). Prior: 2026-10-03 (D-23, D-24, ADR-098, owner ruling: one search budget per title across every janitor
  search, the loop guard on `bad_release` for all three *arrs, one search per failure, and the failed-download retry on
  Sonarr and Radarr once their own Redownload Failed is off; Q-08 answered: at most two tries per title in any
  rolling 30 days, for every loop guard, D-23 rule 7). Prior: 2026-09-29 (D-22, issue #621: a `leftover` folder must hold the same book files as its library
  copies, not only name a copy that exists. Audio matches by name and size, an eBook by extension and size, anything
  else is report only; the delete compares again; D-18 rule 5 amended). Prior: 2026-09-29 (D-21: why LazyLibrarian's fail loops spin, the reversible LazyLibrarian changes and the
  one-off cleanup that stopped 48 of the 60, and `loop_detected` as a state change: a loop logs when it is new, a
  standing one is left to the digest; Q-07 answered, Q-04 and D-18 rule 3 corrected). Prior: 2026-09-29 (D-15..D-20, ADR-095: the janitor covers the download suite. LazyLibrarian and
  Kapowarr come in through a source adapter seam with the same rails; the stored config stays valid without them;
  the promotion ladder is per family (`arr` unchanged, `books`, `comics`); new classes `leftover` and the report-only
  `fail_loop`; the loop guard and the loop signals reach the new sources; migration 0085). Prior: 2026-09-29 (D-13: owner ruling, `manual_match` acts on Lidarr through a census-default enforce
  cell, with a loop guard (`skipped_loop`) and loop signals in the digest and the logs; D-14, ADR-094: the failing
  release's name is blocked in a janitor-owned Lidarr release profile, written and read back before the removal;
  migration 0084). Prior: 2026-09-28 (D-12: Q-01 answered from Lidarr's live queue and its census since 2026-08-01. Lidarr's
  match rejections become the report-only class `manual_match`; nothing Lidarr shows graduates into an acting
  class; migration 0083). Prior: 2026-09-28 (D-11: one action per download, so a season pack is removed once,
  not once per episode; a removal that answers 404 is `skipped_gone`, not an error; retry escalation counts
  runs, not rows; issue #583 item 1, before L2). Prior: 2026-09-25 (D-10: four classifier/action fixes from the L0→L1
  census spot-check, made before any cell enforces: `skipRedownload` on every removal, the identity-mismatch
  guard, message-only reasons, release-level-only release-defect signals). Prior: 2026-08-01.
- **Satisfies:** governed by ADR-083 (superseded in part by ADR-094 for `manual_match` and by ADR-095 for the download
  suite and the per-family ladder, and by ADR-098 for the failed-download retry and the one search budget per title);
  extends ADR-007 (Fix / `markHistoryFailed`), ADR-059 /
  DESIGN-030 (queue read model), ADR-082 (audited config precedent). Build plan: PLAN-065.

## Overview

A new standalone sync mode `queue-cleanup` (hourly CronJob, sync rail) reads the **whole**
download queue of Sonarr, Radarr and Lidarr, classifies every errored grab into an Action
Class (T-239), persists one append-only observation row per item, and — only where that
class×instance is switched to `enforce` — executes the class's cleanup action. Ships all-census
(T-238); enforcement arrives through the Promotion Ladder (T-240) as audited config flips, not
releases. Nightly owner visibility rides a new section of the existing failure-digest email.
Since ADR-095 (D-15..D-20) the same pass also covers LazyLibrarian and Kapowarr through a source adapter, under the
same rails and rows, with one promotion ladder per family.

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
| `manual_match` | Since D-12: one of Lidarr's own match rejections ("Album match is not close enough…", "Worst track match…", "Has missing tracks", "Has unmatched tracks", "Couldn't find similar album for…", "Unable to import automatically, found multiple artists…"). Lidarr could not match the files to an album with confidence, so only a person can decide. **Report only**: no enforce cell, never acted on, like `unknown`. Also takes a `have_better` match that carries one of these messages. Since D-13 (owner ruling 2026-09-29) it has one enforce cell, on Lidarr, census by default. |
| `waiting` | Since D-25: `status: delay`, a release the *arr is holding back on purpose (its delay profile) and has not sent to a download client yet. Not a ledger class: it gets no row and no count, and is never acted on. Checked after every class above, so it never masks one. |
| `unknown` | Everything else. Lidarr's match-ambiguity messages started here and left for `manual_match` once census evidence answered Q-01 (D-12). |

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
  the blocklist only. _(Amended 2026-10-03, D-23 / D-24, ADR-098: the loop guard holds a target already tried on two
  earlier downloads; a download the *arr marked failed itself is removed and blocklisted with no search; a target is
  searched at most once per run; and on Sonarr and Radarr the same cell drives the failed-download retry, one search
  after each failed download the *arr records.)_
- `unknown` → never acted on (ADR-083, normative). `manual_match` → never acted on either (D-12); it has no
  enforce cell. **Since D-13 / D-14 (ADR-094):** where Lidarr's `manual_match` cell is enforced, the failing
  release's name is blocked in the janitor's Lidarr release profile (written and read back), then
  `deleteQueueItem(id, {removeFromClient:true, blocklist:true, skipRedownload:true})`, then one `AlbumSearch` for the
  albums that are monitored and still missing tracks; the loop guard holds an album already removed on two earlier
  downloads (`skipped_loop`), and a name that cannot be blocked safely leaves the download alone
  (`skipped_unblockable`).

Rails (all levels): per-instance per-run mutation cap `maxActionsPerRun` (default 10);
`minItemAgeHours` (default 2) so freshly-completed items get their organic import window; a
failed *arr write logs + records `outcome:'error'` and counts against the cap; the whole run
is idempotent (an item already handled disappears from the next queue read; blocklist makes
re-grab of the same release impossible). Since D-11 the janitor acts once per download, not once
per queue record, and the cap counts downloads; a removal the *arr answers with 404 is
`skipped_gone`, not an error.

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
  `unknown` cell — it has no enforce state by construction. The same holds for `manual_match` (D-12): the
  modes matrix is unchanged, so a stored config stays valid. Since D-13, Lidarr has a fourth cell,
  `modes.lidarr.manual_match` (census by default; a stored config without it reads as census, so it stays valid).
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
`actionClass` (CHECK on `QUEUE_CLEANUP_ACTION_CLASSES`; D-12 adds `manual_match`, migration 0083), `mode`
(`census|enforce`), `action`
(`none|removed_blocklisted|retried_import|blocklisted_searched|skipped_young|skipped_cap`; D-11 adds
`skipped_mixed|skipped_gone`, migration 0082; D-13 / D-14 add `skipped_loop|skipped_unblockable` and the `targetId`
column, migration 0084),
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

`/admin/janitor`, modeled on `/admin/governor` (ADR-082 C-05): a 3×3 mode grid (since D-13 a fourth row,
`manual_match`, with a toggle for Lidarr only and "Not used" for Sonarr and Radarr)
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

### D-11 — One action per download (2026-09-28, before L2)

Sonarr lists a season pack as one queue record per episode: upstream `QueueService` maps one tracked
download to one record per episode, each with the download's own `downloadId`, status, `statusMessages`
and `added`. Lidarr does the same per album. Before this ruling the evaluator acted per record, so an
enforced pack sent one DELETE per episode. The first removed the whole download and every later one
answered 404, because the *arr no longer tracked it. Each 404 was an `error` row and used up the per-run
cap (issue #583 item 1, found by the L1 audit; no such pack had been enforced yet). Each row below is
pinned by tests (`queue-cleanup.test.ts`, `migrations.test.ts`).

| # | Ruling | Reason |
|---|---|---|
| 1 | **Records group by download.** Within one instance, records that share a non-empty `downloadId` form one group, decided at its first record in queue order. A record with a null, empty or blank `downloadId` (a pending release, for one) is never grouped: it stands alone, as before. | The download is what a removal acts on. Grouping on a missing id would tie unrelated records together. |
| 2 | **One call per download, and the cap counts downloads.** A group acts only when every record in it would act on its own for the same effective class (after escalation): the class is not `unknown`, its cell is `enforce`, and no record is younger than `minItemAgeHours`. Then the janitor makes exactly one call (the DELETE targets the first record's queue id, and the *arr removes and blocklists the whole download) and it costs the cap once. Every record of the download gets that call's result as its row: the same `action`, `outcome` and `error`. The other records are *covered* by it, the way `retried_import` rows are covered by the run's one `ProcessMonitoredDownloads`. | A second DELETE for the same download can only answer 404, so none is sent: a 404 from a sibling is impossible by construction. The rows still say what happened to each record's download. |
| 3 | **A mixed download is left alone.** When the records of one download do not all qualify for the same action (a different class, `unknown`, a census cell, or a record still too young), nothing is sent for it. Each record that would have qualified on its own is recorded `skipped_mixed`; the others keep their own verdict (`none` or `skipped_young`). | One removal removes and blocklists every record of the download, so every record has to agree. A record the janitor would not touch vetoes the rest, which fails safe toward observation, like every D-10 change. Records of one download carry the same messages and `added`, so a mixed download is not expected; this rule is the guard, and `skipped_mixed` makes one visible in the census if it ever appears. |
| 4 | **A `bad_release` download is searched once for all its monitored targets.** After the one removal, the monitored check runs over all the download's records (one episode list per series, one album list per artist), and one search command covers every monitored target (`EpisodeSearch` and `AlbumSearch` take id lists, as does `MoviesSearch`). Each row records its own result: `blocklisted_searched` when its target is monitored, `removed_blocklisted` when it is not. When the removal landed but the monitored check or the search failed, the row keeps `removed_blocklisted` with `outcome: 'error'` (it was `none`). | Acting through the first record alone would re-search only the first episode of a pack and leave the rest missing. A failed search after a removal must not hide that the removal happened. |
| 5 | **A removal that answers 404 is `skipped_gone`.** `outcome: 'observed'`, no `error`, no search, not counted in the run's `errors`; it still counts against the cap. Any other failure stays `outcome: 'error'`. | After rule 2 the janitor never sends a second DELETE for a download, so a 404 now means the *arr dropped the record between the queue read and the removal: someone removed it, or a newer download pushed it out of the download client's history window (issue #583 item 2). Nothing failed, and the janitor removed and blocklisted nothing, so neither `error` nor `done` is true. If the record comes back, the next run sees it again. It costs the cap because the cap bounds the write calls a run makes, and a 404 was one. |
| 6 | **Retry escalation counts runs, not rows.** The lookback counts the distinct run timestamps of a download's prior `retry_import` rows (every row of one run carries the run's `createdAt`). | A pack writes one row per episode per run, so counting rows escalated a 10-episode pack to `bad_release` after a single run instead of after `retryEscalateRuns` runs. |

Schema: migration 0082 widens the `arr_queue_cleanup_actions.action` CHECK to admit `skipped_mixed` and
`skipped_gone`. It is additive; the previous image never writes either value. The per-instance report and
its log line gain `covered`, the count of records handled by another record's call. No config, class or
pattern changes, so the census of a run with no packs is unchanged.

### D-12 — Lidarr's classification, Q-01 answered (2026-09-28, before L2)

_Superseded in part by D-13 (2026-09-29, owner ruling): rule 1's "report only, no enforce cell" and rule 5 no longer
hold for `manual_match`, which acts on Lidarr where its cell is enforced (with D-14's release-name block). The
classification below stands._

Q-01 asked which Lidarr reasons leave `unknown`, and for which class. The evidence is read-only: Lidarr's live
queue (`GET /api/v1/queue?includeUnknownArtistItems=true`, 62 records), the album each record is for (`GET
/api/v1/album`), the download folders of the undecided shapes (file listing only), the census (every Lidarr row
since 2026-08-01: 234 downloads, 1,412 runs, read on a database replica) and the hourly run logs in Loki. Upstream
references are Lidarr v3.1.6.5078 (`CompletedDownloadService`, `TrackedDownloadService`, the import
specifications).

What the queue holds. 60 of the 62 records reach the census (the other 2 have no known artist; the janitor does
not ask for those, issue #583 item 4). Every hourly run since 2026-09-20 put 56 to 67 Lidarr records in `unknown`
and almost none anywhere else. The pile does not come from soularr/slskd, as Q-01 guessed: 58 records are
SABnzbd downloads and 2 are qBittorrent, and slskd is not a Lidarr download client.

| Shape (message, state) | Records | Age (days) | Album on disk | Ruling |
|---|---|---|---|---|
| Album match is not close enough, `importFailed` (usually with "Has missing/unmatched tracks") | 28 | 3–46 | 27 none, 1 complete | `manual_match` |
| Has missing tracks / Has unmatched tracks alone, `importFailed` | 11 | 6–46 | none | `manual_match` |
| Couldn't find similar album for [path], `importFailed` | 8 | 1–30 | none | `manual_match` |
| Worst track match, `importFailed` | 3 | 8–25 | none | `manual_match` |
| Unable to import automatically, found multiple artists, `downloading` | 2 | no `added` | not in the census | `manual_match` |
| No files found are eligible for import in [path], `importPending` | 9 | 2–44 | none | stays `unknown` |
| Not an upgrade for existing track file(s), `importFailed` | 1 | 38 | none (0 of 21 tracks) | stays `unknown` |

Historical Lidarr classes that keep their class: `bad_release` for "Duplicate NZB" (18 downloads, cleared by Lidarr
in hours) and "Found archive file, might need to be extracted" (8); `retry_import` with no message (53 downloads,
each seen once, the hour between completion and Lidarr's import attempt); "The download is stalled with no
connections" (2) stays `unknown`. Each ruling below is pinned by tests (`queue-cleanup.test.ts`,
`migrations.test.ts`), built from the live strings.

| # | Ruling | Evidence and reason |
|---|---|---|
| 1 | **Lidarr's match rejections are a new class, `manual_match`, and it is report only.** It has no enforce cell and is never acted on, exactly like `unknown`, so no config shape changes and no level of the ladder enforces it. First-match order becomes `have_better` → `bad_release` → `retry_import` → `manual_match` → `unknown`. When several match messages are present, the reason is the most informative (album match, worst track match, track match, similar album, multiple artists, then the bare "Has missing/unmatched tracks"). | 52 of the 62 records carry one of these messages. They are not a guess about what went wrong: they are Lidarr saying it could not tie the files to the album with confidence, and that a person must choose (a manual import against a chosen release, or a removal). No acting class fits. The albums of 49 of the 50 such records in the census have no files, and all 50 are monitored, so a removal deletes the only copy of a wanted album whose files may well be that album in another edition (seven album-match scores sit between 74.8 % and 79.4 % against the 80 % bar). The one album that is complete shows the other side: a live bootleg ("Bournemouth 1963") grabbed for the compilation "1" at 42.1 %. The score does not split right grabs from wrong ones reliably enough to act on. Naming the class takes 50 records out of `unknown`, so what stays there is small and meaningful, and it gives any future action one class to be spot-checked on its own. |
| 2 | **A `have_better` match that also carries a match rejection is `manual_match`.** | The D-10 identity guard in Lidarr's form: when Lidarr cannot match the files to the album, its "already have it" verdict may be about a different album. |
| 3 | **Lidarr's `importFailed` stays outside the stuck-import states**, so a Lidarr record in it is never `have_better` or `retry_import`. | Lidarr sets `importFailed` when any file of a release is rejected, "to prevent further attempts at processing"; `ProcessMonitoredDownloads` retries only `importPending`. The one live "Not an upgrade for existing track file(s)" record is for "Bête Noire", which has 0 of 21 tracks on disk, so the existing files it compares against belong to another album: removing it as `have_better` would act on the wrong target. In practice Lidarr's `have_better` cell stays empty, and its `retry_import` cell sees only the hour after a download completes. |
| 4 | **"No files found are eligible for import" stays `unknown`.** | One message, three causes, seen in the download folders: 6 are vinyl rips from one uploader stored as WavPack with a `.wvp` extension, which Lidarr does not read (it reads `.wv`); 2 are torrents of Guitar Pro tabs and PDFs, not audio; 1 folder is gone. `bad_release` (blocklist and search again) is right for the tab packs, but for the rips a new search would likely grab the next rip in the same format. Lidarr already retries `importPending` on every pass, so `retry_import` adds nothing. The rips are a Lidarr profile question, parked as issue #610. |
| 5 | **Nothing graduates into an acting class.** Lidarr's L2 cells enforce only what they already classify: `bad_release` for failed downloads and release defects, and `retry_import` for the empty-message hour. | A Lidarr reason may act only with strong evidence that the action is safe: no library loss and no removal of the wrong target. None of the shapes above has it. Every change in this ruling moves records from `unknown` to another report-only class and none moves one toward an action, like every D-10 and D-11 change. |

Schema: migration 0083 widens the `arr_queue_cleanup_actions.action_class` CHECK to admit `manual_match`. It is
additive; the previous image never writes the value. Rows written before D-12 keep `unknown`. The run log's
`byClass`, the digest's per-class rollup and the /admin summary gain the class; the /admin grid shows it as a
second report-only row. No config change: the modes matrix is the same, so a stored config stays valid and the
level is unchanged. ADR-083 needs no successor: its class D is "never acted on, reported only", and
`manual_match` is a named part of that class, with no new write-back. Glossary: T-267 Manual Match added,
T-239 Action Class amended.

### D-13 — `manual_match` acts on Lidarr, behind a loop guard (2026-09-29, owner ruling)

**Owner ruling (Tom, 2026-09-29):** `manual_match` gets an enforcing action, with no waiting period: it ships and is
enabled as soon as it is deployed. The action is the one the owner approved by hand twice that day, with about half
the albums importing: remove from the client with blocklist and `skipRedownload=true`, then an explicit album search
for the record's album, the `bad_release` pattern. A second ruling the same day: "You can monitor for loops." This
**supersedes D-12 rule 1 in part** ("report only, no enforce cell") and D-12 rule 5 for this class; D-12's
classification (the patterns, the precedence, rule 2's `have_better` guard, rules 3 and 4) stands. D-14 adds the
release-name block that runs before the removal. Each row is pinned by tests (`queue-cleanup.test.ts`,
`migrations.test.ts`).

| # | Ruling | Reason |
|---|---|---|
| 1 | **One enforce cell, `modes.lidarr.manual_match`, census by default.** It lives in the audited config beside the other cells and is flipped the same way (`setArrQueueCleanupConfig`, or the /admin grid's Lidarr toggle, which is the only toggle in the row: Sonarr and Radarr show "Not used"). A config stored before D-13 has no such key and reads as census, so the live L1 config stays valid and the deploy is inert until the cell is flipped. `modes.sonarr.manual_match` or `modes.radarr.manual_match` is an unknown class (refused). The ladder counts the cell: L2 now means every cell enforced, this one included, so a config that enforces the nine shared cells reads L1 until this cell is enforced too (the live config did on 2026-09-29, and the owner ruled the cell enabled at deploy). | Only Lidarr produces the class (its patterns are Lidarr's own messages), and the action ends in an album search. Absent-as-census is the D-05 fail-safe applied to a new cell. |
| 2 | **The action, per download (D-11):** block the release name (D-14), remove with `removeFromClient`, `blocklist` and `skipRedownload`, then one `AlbumSearch` for the download's records whose album is **monitored and still missing tracks** (Lidarr's `statistics.trackFileCount < trackCount`). An album that is unmonitored, complete, or whose counts Lidarr does not report is removed and blocklisted, not searched. The age rail, the cap and D-11's grouping apply unchanged. | The owner-approved action, with the completeness check the work order asked for: searching a complete album would only chase an upgrade the owner did not ask for. Unknown counts fail safe (no search). |
| 3 | **A record with no album (no `albumId`) is removed and blocklisted, never searched.** No completeness check is asked for it, and the search never falls back to an artist-wide `ArtistSearch` (which the `bad_release` path uses for a record without a child id). | The owner's action is scoped to one album. With no album there is nothing to search that is not wider than the approval: an artist search would search every monitored album of the artist. The removal is still right: Lidarr could not tie the files to any album, so nothing in the library depends on the download, and the name block (D-14) keeps the same release from coming back. Such records are rare: the janitor does not read unknown-artist records (issue #583 item 4). |
| 4 | **The loop guard.** An enforced `manual_match` record whose album the janitor has already removed as `manual_match` on `MANUAL_MATCH_LOOP_LIMIT` (2) **earlier downloads** is `skipped_loop`: reported (`mode: enforce`, `outcome: observed`), nothing sent. Earlier removals are rows of the same instance with `action_class = manual_match`, `outcome = done`, `action` `removed_blocklisted` or `blocklisted_searched`, the same `target_id` (the album) and another `download_id`. Each of them was followed by another match failure for the album (the next removed download, and for the last one this record), so the rule is exactly "the last K janitor actions were each followed by another failure". The hold applies only while the album is **still monitored and missing tracks** (the same check as rule 2): only then would the janitor search it again, so only then can it loop. An album that imported since (a later upgrade grab failing the match) or was unmonitored gets the removal and the block, and no search. While it applies, the hold does not expire: the album needs a person. A `skipped_loop` record in a multi-album download holds the whole download (its siblings are `skipped_mixed`, D-11 rule 3). If the guard's history read or its album check fails, no `manual_match` download is acted on that run. | The action can loop: a search can grab another release that fails the same way (the coordinator's hand sweep saw up to 10 grabs for one album). Two tries is the owner-approved budget; after that the janitor stops spending the album. Removals that errored, 404s (`skipped_gone`) and census rows are not tries. Gating on the album check keeps a recovered album from raising a false loop alarm every hour (review of PR #617). _(Amended 2026-10-03 by D-23 rule 1, ADR-098: the count is one budget across every searching class, so an earlier `bad_release` removal of the album counts too, and the guard also covers `bad_release` on all three *arrs and the failed-download retry. Its "the hold does not expire" is superseded by D-23 rule 7, the owner's ruling on Q-08: tries count for a rolling 30 days, so a held album is tried again once its oldest counted try is 30 days old.)_ |
| 5 | **Loop signals** (the second ruling). Every loop event is one warn line with the stable message **`[queue-cleanup] loop_detected`** (alert on it in Loki): `kind: 'skipped_loop'` once per held download per run (`downloadId`, `title`, `targetIds`, `priorRemovals`), and `kind: 'repeat_search'` when a janitor search covers a target the janitor also searched on an earlier run within 7 days, any class (`targets: [{targetId, searches7d}]`). The nightly digest's janitor section lists every download the guard held in the last 24h (with the runs it was held on) and every target searched on 2 or more runs in the last 7 days, and the subject gains **`[janitor: loop detected]`** when either list is non-empty (beside `[janitor: promotion due]`). | Loops must be visible without reading the database. The repeat-search signal fires on the second search, before the guard holds the album, so a loop shows up one step early. _(Amended by D-21 rule 10: a held download logs when it is new, not on every run it stays held.)_ |
| 6 | **`target_id` on every row.** Each action row records the record's search target: Sonarr the `episodeId`, Radarr the `movieId`, Lidarr the `albumId` (null when the record has none, and on every row before D-13). A partial index covers the rows that landed, per target. | The guard and the repeat-search list key on the album, which no earlier column held (a new download has a new `download_id`). |

Schema: migration 0084 (with D-14) widens the `action` CHECK to admit `skipped_loop`, adds `target_id` and the partial
index `arr_queue_cleanup_actions_target_done_idx (instance, target_id, created_at) WHERE outcome = 'done' AND
target_id IS NOT NULL`. Additive; the previous image never writes either. Glossary: T-268 Loop Guard added; T-267
and T-239 amended.

### D-14 — The janitor release block: the failing name is blocked before the removal (2026-09-29, ADR-094)

The coordinator's hand sweep of 2026-09-29 ran D-13's action on 74 records: 55 of 66 albums got a grab, 22 imported,
27 were stuck again, and **18 albums grabbed a same-titled re-post of the release that had just failed**: Lidarr's
blocklist blocks one posting (indexer and guid), not the title. The coordinator ruled, by default under the owner's
direction, that the action block the failing release **name** by reusing the ADR-093 Release Block pattern. ADR-094
records the decision and amends hard rule 4. The mechanics follow; each row is pinned by tests (`queue-cleanup.test.ts`,
`release-block-clients.test.ts`, `migrations.test.ts`). Upstream references are Lidarr v3.1.6.5078.

| # | Ruling | Reason |
|---|---|---|
| 1 | **Order.** For an enforced `manual_match` download: read the release identity, derive the term, write it into the janitor's profile and read it back, then remove (D-13 rule 2), then search. If the term cannot be derived the download is `skipped_unblockable` (observed, no write, no cap slot, logged `queue-cleanup: release name cannot be blocked, download left alone` with the reason). If the identity read fails, or the profile write or read-back fails, nothing is removed: the rows are `action: none, outcome: error` (the error names the step, never a term) and the next run tries again. The profile write counts against the cap; a failed read does not. | The removal is what lets a re-post in; the block has to be in place first, exactly as the Release Block precedes a Trash delete (ADR-093 C-07). |
| 2 | **The release name is the grab's own title.** `GET /api/v1/history?downloadId=…&eventType=1` (the download's grab, newest first) gives `sourceTitle`, the title as the indexer posted it, which is what Lidarr tests a term against (`ReleaseRestrictionsSpecification`: the raw `Release.Title`). The queue title (SABnzbd's job name, built by `CleanFileName`) is the fallback when no grab is recorded. The artist's name comes from `GET /api/v1/artist/{id}`. | A term built from the job name could differ from the posted title (a torrent's internal name certainly does). No URL-bearing history field is read. |
| 3 | **The term is the whole name.** `/^SEP*{words joined by SEP*}SEP*$/i` (`renderWholeNameTerm`, `release-terms.ts`), SEP `[^a-z0-9]`, each word written from the raw title with its apostrophes, accented letters and `&` as DESIGN-052 D-25dd / D-25di write them. It matches the same title posted again with any separators and nothing with a word more or a word less. It is a separate template from the Release Block's: `isGrammarTerm` never accepts it, and the janitor's writer accepts only it (`isWholeNameTerm`) and its sentinel. The term must match its own title raw. | The Release Block's exact form is a prefix match (it blocks every longer title that starts with the name), guarded by video-only signals (a resolution or a group). Music titles are short and carry neither, so only a whole-name match is safe. |
| 4 | **The title must name the artist.** The artist's words (a leading "The" optional) must appear as a run of the title's whole words, and the title must carry at least one more word. Otherwise the refusal is `artist_not_named` or `title_is_artist` (also `no_title`, `no_artist`, `grammar`), and the download is `skipped_unblockable`. So is a title with a letter, digit or symbol the term cannot write (another script, a Latin letter that does not fold such as `ø` or `ß`, a symbol such as `÷` or `♥`) anywhere but strictly inside a written word (`unwritable`; "Bjørk" and "Ke$ha" pass). | The profile has no tags, so it applies to every artist. A title without the artist ("Greatest Hits (2001)") would block that title for every artist. With the artist in it, a whole-name term blocks only that artist's release of that name. An unwritten character is matched only by SEP: harmless inside a word ("Bjørk"), but a whole unwritten word would let any other word stand in for it ("Artist - 日本 (2019)" would block "Artist - 東京 (2019)", and "Ed Sheeran - ÷ [FLAC]" would block "Ed Sheeran - × [FLAC]"). |
| 5 | **The profile.** One per *arr the janitor blocks on (`JANITOR_BLOCK_KINDS`, Lidarr only), `{enabled: true, required: [], ignored: [sentinel, …terms], indexerId: 0, tags: []}`. Lidarr's `ReleaseProfileResource` has no `name`, so the profile is found by its sentinel term `haynesnetwork-janitor-managed-do-not-edit` (a plain term, a case-insensitive "contains" no title carries), which also keeps the profile valid with no live term. Other profiles are never touched. | The Release Block finds its profile by name; Lidarr leaves the sentinel as the only marker a person also sees in Lidarr's UI. |
| 6 | **The single writer**, `reconcileJanitorReleaseBlock` (`janitor-release-block.ts`), under `pg_advisory_xact_lock('janitor-block:<instance>')` in one transaction: (1) every new term passes the whole-name grammar, and its row is inserted with `expires_at` 365 days on; (2) desired = the sentinel + the distinct live terms, newest block first, capped at 3,000, all re-validated; (3) the profile found by its sentinel: none ⇒ POST, one ⇒ PUT only when it drifted, more than one ⇒ `duplicate_profile`; (4) a read-back GET must show exactly one enabled profile holding every desired term. Any failure throws `JanitorReleaseBlockError` (step `validate`, `put`, `read_back` or `duplicate_profile`) and rolls the rows back, so a row exists only for a confirmed term. | ADR-093's writer, step for step, so the same guarantees hold: a malformed term is never written, a hand edit is overwritten, a deleted profile is re-created. |
| 7 | **Records and expiry.** `arr_queue_cleanup_block_terms` (migration 0084): one append-only row per block (`instance`, `term`, `release_title`, `download_id`, `target_id`, `created_at`, `expires_at`). A term is live while any of its rows has `expires_at` ahead, so a later block of the same term keeps it a year from then. Nothing deletes a row. At most 3,000 live terms per *arr (the oldest left out, logged `[queue-cleanup] block_pruned`). | The owner's Release Block ruling (365 days) and ADR-093 C-09's cap, on a simpler lifecycle: a janitor term is not tied to a library item that can come back, so it needs no in-flight or abandoned state. |
| 8 | **The hourly upkeep.** At the start of each janitor pass over an instance in `JANITOR_BLOCK_KINDS`, whatever its cells say: once the janitor has ever blocked a release there, one `GET /releaseprofile` compares the profile with the records, and any drift (an expired term still present, a hand edit, a disabled, deleted or copied profile, the cap) runs the writer, logged `[queue-cleanup] block_drift` (warn). Before any block, nothing is read or created. A failure is `[queue-cleanup] block_upkeep_failed` (warn), never the run's failure. | Expiry and drift repair have to run even when no new block is written, and even if the cell goes back to census. |
| 9 | **Digest.** The janitor section gains one line per *arr with a block: `Release names blocked on lidarr: N in the last 24h, M blocked now.` | Owner visibility of a new write-back, next to the loop lists (D-13 rule 5). |
| 10 | **Loops stay watched.** D-13 rules 4 and 5 are unchanged: a re-post under a different title escapes the term, and the guard and the loop signals catch it. | The term closes the same-name loop; the guard remains the backstop. |

Schema: migration 0084 also admits `skipped_unblockable` in the `action` CHECK and creates
`arr_queue_cleanup_block_terms` (instance CHECK, `(instance, expires_at)` index); the no-direct-state-writes guard covers
it. Client surface: `LidarrWriteClient.listReleaseProfiles / createReleaseProfile / updateReleaseProfile` (v1, no
`name`) and `LidarrClient.getDownloadGrabs`. Glossary: T-269 Janitor Release Block added; T-237 amended.

### D-15 — The source adapter seam: LazyLibrarian and Kapowarr under the same rails (2026-09-29, ADR-095)

**Owner direction (Tom, 2026-09-29):** the janitor should be generic enough to cover the whole download suite, monitor
for loops, and not wait on calendars. ADR-095 records the decision; this entry and D-16..D-20 hold the mechanics. The
*arr path (D-02..D-14) is unchanged. Each row is pinned by tests (`queue-cleanup-sources.test.ts`,
`queue-cleanup.test.ts`, `janitor.test.ts` in `@hnet/downloads`, `client.test.ts` in `@hnet/kapowarr`,
`migrations.test.ts`).

| # | Ruling | Reason |
|---|---|---|
| 1 | **The seam is `QueueCleanupSourceAdapter`** (`queue-cleanup-sources.ts`): `instance`; `observe()` reads the source and returns its items already classified (a throw is a failed read); `act(class, items)` carries out `bad_release` or `leftover` for ONE download's items (a throw means nothing was done; `QueueCleanupItemGoneError` means the source no longer holds it); `retryImports()` is the source-wide retry verb. An item (`QueueCleanupSourceItem`) carries `queueItemId` (nullable), `itemRef` (string), `downloadId`, `title`, `addedAt`, `targetId`, `actionClass`, `reason`, `attempts` and `removable`. | Each source says what is wrong in its own shapes (LazyLibrarian has no queue and no status messages), so each adapter classifies its own items with a pure classifier. The rails are not the adapter's: nothing an adapter does can skip them. The *arr client (`QueueCleanupInstanceClient`) stays as it is: its contract is the *arr queue record, and rewriting a path that enforces at L2 in production buys nothing. |
| 2 | **One shared evaluator for every adapter** (`evaluateSourceInstance`), run after the three *arrs in the same pass, with the same row insert. It applies: the class×instance cell (D-16); the age rail, for a class that has a cell on the instance (census included, so the census shows what would happen), from the source's own time or, when the source gives none, the janitor's first sighting of the download in its current class (its earliest row of that class, so hours in flight never make a fresh failure old); the per-instance per-run cap; one action per download and the mixed-download rule (D-11 rules 1-3); retry escalation by prior runs (D-11 rule 6), `retry_import` becoming `bad_release` after `retryEscalateRuns`; one `retryImports()` per run, the other retry records covered; a removing class (`bad_release`, `leftover`) on an item that is not removable is `skipped_seeding` (census included); the loop guard (D-20); `skipped_gone` for a download already gone (D-11 rule 5); a removal that landed with a failed search is `removed_blocklisted` with `outcome: 'error'` (D-11 rule 4). Report-only classes (`unknown`, `fail_loop`) are always `none`. | The rails of ADR-083 are what make an automated write-back safe; a new source gets all of them by construction. Kapowarr reports no timestamp, so the first sighting is the only honest age. |
| 3 | **The item's identity.** `queue_item_id` is nullable (migration 0085): LazyLibrarian has no queue. `item_ref` is the source's string reference where it has no integer one: LazyLibrarian `<bookId>/<ebook\|audiobook>`, the book format a grab, a leftover or a fail loop is about. `target_id` is Kapowarr's volume (its search target, as D-13 rule 6 defines the column). `attempts` holds a `fail_loop` row's failure count. | LazyLibrarian's book ids are strings, and a book has two formats that fail and loop separately. |
| 4 | **The bundle.** `arrQueueCleanupClientsFromEnv` adds `queueCleanupSourceAdaptersFromEnv`: LazyLibrarian needs `LAZYLIBRARIAN_API_KEY` and `SABNZBD_API_KEY`, Kapowarr `KAPOWARR_API_KEY` (all already in `haynesnetwork-secret`; URLs default to the in-cluster services). A source whose key is missing gets an adapter whose read fails with the config error: it reports `read: false` and the rest of the run goes on. The *arr rows are inserted before any source runs, and each source's rows go in on their own; a source that throws anywhere in its evaluation is logged (`queue-cleanup: source evaluation failed`) and reported (`read: false`, one error), and never costs the *arrs their trail. `totalFailure` (the job's nonzero exit) keeps its meaning: every *arr failed to read; a source never fails the job on its own. The write clients are built inside `@hnet/domain`, so `@hnet/sync` never imports a `/write` entry (the import guard). | A new source must never be able to break the *arr janitor that enforces today. |
| 5 | **Out of scope:** Bazarr, Prowlarr, Seerr, slskd/soularr, goodreads-sync and ytdrivarr. | None has a download queue that strands. |

Schema: migration 0085 widens the `instance`, `action_class` and `action` CHECKs (built from `QUEUE_CLEANUP_INSTANCES`,
`QUEUE_CLEANUP_ACTION_CLASSES`, `QUEUE_CLEANUP_ACTIONS`), drops NOT NULL from `queue_item_id`, adds `item_ref` and
`attempts`, and a partial index `arr_queue_cleanup_actions_item_ref_idx (instance, item_ref, created_at) WHERE item_ref
IS NOT NULL` for the LazyLibrarian loop guard and fail-loop lookups. Additive: the previous image never writes the new
values or columns and always writes `queue_item_id`.

### D-16 — Instances and config back-compat (2026-09-29, ADR-095)

| # | Ruling | Reason |
|---|---|---|
| 1 | **Five instances** (`QUEUE_CLEANUP_INSTANCES`): `sonarr`, `radarr`, `lidarr`, `lazylibrarian`, `kapowarr`. Cells (`QUEUE_CLEANUP_INSTANCE_CLASSES`): the *arrs as before; LazyLibrarian `retry_import`, `bad_release`, `leftover`; Kapowarr `bad_release`. All census by default. `ArrKind` stays the key of the *arr-only surfaces (the janitor release block, the *arr env). | The classes each source can act on safely (D-18, D-19). |
| 2 | **A stored config stays valid without the new instances.** An absent `lazylibrarian` or `kapowarr` key, or any absent cell of theirs, reads as census for that instance or cell only and never invalidates the rest (Lidarr's `manual_match` has read that way since D-13). The nine shared *arr cells stay required. An unknown instance or class, a class off its instance (`modes.sonarr.leftover`) and a bad mode still invalidate the whole row, which then resolves to all-census as before (D-05). The writer stores the canonical shape, every instance and cell present. | **The trap the work order named:** a validator that required the new instances would have rejected the live row, and a rejected row resolves to all-census, silently reverting every enforced *arr cell. The test loads the live row exactly as stored on 2026-09-29 (`{"modes": {"lidarr": {"bad_release": "enforce", "have_better": "enforce", "retry_import": "enforce"}, "radarr": {…the same}, "sonarr": {…the same}}, "minItemAgeHours": 2, "maxActionsPerRun": 10, "retryEscalateRuns": 6}`) and proves every cell survives. |
| 3 | **The API edge requires all five instances** (`QueueCleanupConfigInput`). | A page that predates the new cells cannot save without them, so it can never reset an enforced cell to census by omission. The domain writer stays lenient (rule 2) for a hand-run command that reads, edits and writes the resolved config. |
| 4 | **The writer leaves out a suite instance whose cells are all census** (`storableConfig`); reading fills it back as census. | Until a books or comics cell is enforced, the stored row is exactly one the image before ADR-095 accepts, so a rollback keeps every *arr cell enforcing. Once a suite cell is enforced, a rollback reads the row as invalid and falls back to all-census (fail safe, but the *arr cells stop acting until the row is rewritten): roll forward, or rewrite the row without the suite instances. |

### D-17 — One promotion ladder per family (2026-09-29, ADR-095 C-05)

| # | Ruling | Reason |
|---|---|---|
| 1 | **Families** (`QUEUE_CLEANUP_FAMILIES`): `arr` (Sonarr, Radarr, Lidarr), `books` (LazyLibrarian), `comics` (Kapowarr). A family's level comes from its own cells only (`deriveQueueCleanupLadderLevel(config, family)`, default `arr`): L0 all census, L1 partial, L2 every cell enforced. | L2 means every cell enforced. One global ladder would have read L1 the moment census-only book and comic cells shipped, although nothing about the *arrs changed. |
| 2 | **The `arr` ladder is PLAN-065's, unchanged**: the same criteria text and nag (age over 14 days, or census data on 3 days at L0). The live config of 2026-09-29 (nine shared cells enforced, no `manual_match` key) reads L1 exactly as it did before this change (D-13 rule 1), and L2 once the coordinator enforces Lidarr's `manual_match`; no book or comic cell can move it. | The work order: keep the Sonarr/Radarr/Lidarr ladder reading what it reads. |
| 3 | **A family's age** is the newest audited write of the key that changed one of its cells or a shared knob (`maxActionsPerRun`, `minItemAgeHours`, `retryEscalateRuns`); null when no write ever did. | Enabling a book cell must not reset the *arr ladder's age and hide its stagnation. A knob governs every family, so its change counts for each. |
| 4 | **The `books` and `comics` ladders wait on evidence, not on a calendar** (owner direction). Criteria: L0→L1 enforce a cell as soon as the coordinator has spot-checked its census rows (≥ 90 % judged correct, zero would-be bad removals); L1→L2 enforce the rest once the enforced cells' first actions are audited clean; L2→L3 is the steady state, set by a person. The nag fires while the family is below L2 and its census holds a row for one of its cells in the last 24 h, or after 14 days at one level. | Anti-stagnation (ADR-083) without a calendar: the moment there is evidence to check, the digest asks for the check. |
| 5 | **Surfaces.** `getArrQueueCleanupStatus` and the digest keep `ladder` and `promotionDue` (the `arr` family, as before) and add `ladders` (every family, each with its nag). The digest subject gets one tag per due family: `[janitor: promotion due]` for `arr` as before, `[janitor: books promotion due]` and `[janitor: comics promotion due]` for the others. The /admin page shows one ladder block per family. | The books and comics nags must not dilute the *arr one. A renderer that predates D-17 prints `ladder` and `promotionDue`, and a stored payload from before D-17 still renders. |

### D-18 — LazyLibrarian: strands, leftovers, fail loops (2026-09-29, ADR-095)

Live evidence, read-only on 2026-09-29: `cmd=getHistory` 8,514 rows (4,521 Failed, 3,285 Processed, 706 Seeding, 2
Snatched); SABnzbd's LazyLibrarian category holds 5,880 jobs, all but 2 archived (LazyLibrarian deletes every job it
processed, `DEL_COMPLETED`, and SABnzbd archives on delete); 769 completed jobs still have a folder and a Processed
row; the download folder holds 1,927 entries. Upstream: LazyLibrarian `postprocess.py` and `download_client.py`,
SABnzbd 5.1.3 `api.py`.

| # | Ruling | Reason |
|---|---|---|
| 1 | **Reads per run**: `getHistory` and `getAllBooks` (LazyLibrarian); SABnzbd's queue and the history of the Snatched rows' jobs, from both views (`archive=0` and `archive=1`, by `nzo_ids`). Only when both mounts are present (rule 6): SABnzbd's whole LazyLibrarian category history, status Completed, both views (about 9 MB), and one listing of the download folder, then an `lstat` per candidate folder and per recorded library file. | A job is in exactly one of SABnzbd's two views, and LazyLibrarian's own lookup reads only the live one. |
| 2 | **Snatches** (one item per Snatched row, `item_ref` its book format). SABnzbd: a job in SABnzbd's queue is in flight (`unknown`); a finished job LazyLibrarian has not imported is `retry_import` (it never aborts a download at 100 %, so it would strand for ever); a failed job it has not aborted is `bad_release` (the reason is SABnzbd's fail message); a job still post-processing is in flight; a job SABnzbd no longer shows is `unknown`, not removable (LazyLibrarian aborts it itself). qBittorrent: a finished torrent not imported is `retry_import`, never removable; otherwise in flight. The age is when SABnzbd finished the job (or LazyLibrarian's `Completed`). | The coordinator cleared 12 strands by hand on 2026-09-29. `forceProcess` re-runs LazyLibrarian's import pass; when a strand cannot import (a wrong file type), escalation turns it into a removal after `retryEscalateRuns` runs. |
| 3 | **`bad_release` deletes the job from SABnzbd's history** (`mode=history&name=delete&value=<nzo_id>`, which SABnzbd archives; never `del_files`), SABnzbd downloads only. Once SABnzbd no longer shows the job, LazyLibrarian reads the snatch as 0 % and aborts it after its task age (2 hours): the row becomes Failed, which is LazyLibrarian's own blocklist (its searches skip a failed URL), and the format goes back to Wanted. **The janitor does not search**: a search sent before the abort lands could grab the same release again, and LazyLibrarian's own backlog search (`search_bookinterval` 1440) wants the format again anyway. The row is `removed_blocklisted`. | LazyLibrarian has no fail or blocklist verb; its abort is the blocklist, and deleting the job is what triggers it (`get_download_progress`, `_handle_snatched_timeout`, `_handle_aborted_download`). _(Corrected by D-21 rule 2: for a Prowlarr release the failed row often does not block the next grab, so the loop guard is what stops a repeat.)_ |
| 4 | **A qBittorrent download is never removed** (`removable: false`, so `skipped_seeding` for `bad_release` or an escalated strand). `retry_import` may still run for it: `forceProcess` touches no torrent. | MyAnonaMouse torrents must keep seeding. |
| 5 | **`leftover`**: one item per SABnzbd job of the category whose completed folder is still on disk (a direct child of the download root). It is `leftover` only when no other SABnzbd job names the same folder, every LazyLibrarian row of the download is Processed, and every library copy it recorded (the Processed row's `DLResult`, read raw: `LlHistoryEntry.destination`) exists as a regular file, not a symlink, under a library root and outside the download folder. A folder named by more than one job is `unknown`: SABnzbd reuses a folder name once the folder is gone, so an old archived job can point at a newer download's folder (review of this PR). SABnzbd never reuses a name while the folder exists, so the claim cannot change between the census and the delete. A missing copy is `unknown` ("the download folder may be the only copy"); a failed download's folder is `unknown` (Q-06); a download with a Snatched row is left to rule 2. The action re-checks the folder and every copy in the same call, then deletes the folder (`DownloadFolderCleaner.removeFolder`): nothing is blocklisted or searched; the row is `removed_leftover`. A folder already gone is `skipped_gone`; a copy that vanished since the census is an error and the folder stays. | LazyLibrarian copies (`destination_copy = True`), so every Processed download's folder stays; 1,786 were deleted by hand on 2026-09-29 (about 377 GB). SABnzbd cannot delete them: its history delete removes only the incomplete folder (`_api_history_delete`). 79 Processed rows record a destination that is gone: for those the folder may be the only copy, so the janitor never touches them. _(Amended by D-22: a copy that exists is not enough. Every book file of the folder must have its counterpart among the copies' files, checked at the census and again by the delete.)_ |
| 6 | **The mounts.** The leftover census reads the book library and deletes in one folder, so the `sync-queue-cleanup` job needs two NFS mounts from `gasha01.haynesnetwork:/hdd-nfs-repl`, at the same paths LazyLibrarian and SABnzbd use: `data/media/books` **read-only** at `/data/cephfs-hdd/data/media/books`, and `data/usenet/complete-k8s/lazylibrarian` **read-write** at `/data/cephfs-hdd/data/usenet/complete-k8s/lazylibrarian`; and it must run as uid/gid 1000 (SABnzbd writes `1000:1000`, mode 0755). The paths are `JANITOR_LL_DOWNLOAD_ROOT` and `JANITOR_LL_LIBRARY_ROOTS` (defaults: the live paths). Without both mounts the janitor logs `queue-cleanup: leftover census off` and observes no leftover at all; the other classes are unaffected. Every path check refuses a symlink and anything outside its root; the delete takes only a direct child of the download root. | The narrowest mount that can do the job: one folder writable, the library read-only. A hand-deleted folder never appears (the census starts from what is on disk). |
| 7 | **Fail loops** (`fail_loop`, report only, no cell anywhere): a book format with `FAIL_LOOP_MIN_FAILURES` (5) or more Failed rows in LazyLibrarian's log whose status for that format is still Wanted. One item per loop: `attempts` the count, `reason` the most frequent failure (a tie goes to the row read last), title `<book> (eBook\|audiobook)`, no download id. | 60 such pairs on 2026-09-29, the worst 173 failures of one eBook. They are LazyLibrarian's own search loops; their fix (a better release filter, another indexer) is a person's, so the janitor reports them (D-20) and never acts. |
| 8 | **Reasons are messages** (`normalizeLlFailure`, D-10 rule 3). LazyLibrarian and SABnzbd embed names, paths and indexer URLs (with the key) in failure texts: markup and keys are stripped first (`sanitizeLlResult`), then the known shapes lose their names ("Rejecting torrent name, contains und", "Unable to locate a valid filetype (ebook), leaving for manual processing", "Repair failed, not enough repair blocks", "Failed to send nzb to SABnzbd", "Got a 500 response from the indexer", "Sent to SABNZBD, never finished"), any other absolute path is dropped, and no URL keeps its query string. | The digest's top reasons must group, and no reason may carry a release name or a key (an indexer link can carry a key under any parameter name). |

### D-19 — Kapowarr (2026-09-29, ADR-095)

| # | Ruling | Reason |
|---|---|---|
| 1 | **Read**: `GET /api/activity/queue`, one item per entry: `failed` is `bad_release`; everything else (queued, downloading, importing, seeding) is in flight (`unknown`). `queue_item_id` is the entry id; `download_id` is the entry id AND what it fetches (`<id>\|<volume>\|<issue>\|<page link>`), because Kapowarr's queue ids are SQLite rowids (`INTEGER PRIMARY KEY`), reused once the queue drains, and a reused id must not inherit an old download's age or removals; `target_id` is its volume. The age is the janitor's first sighting of the entry as failed (D-15 rule 2): Kapowarr gives no timestamp. Kapowarr's history is not read. | Kapowarr drops a failed download from its queue and blocklists its link itself (`features/download_queue.py`), so a `failed` entry that stays is stuck. Its history held 2 failed downloads on 2026-09-29, both already cleared. |
| 2 | **`bad_release`**: `DELETE /api/activity/queue/{id}` with `{"blocklist": true}` (`KapowarrWriteClient.deleteQueueItem`), then one `auto_search` for the volume while it is monitored and still missing issues (`issues_downloaded < issue_count`). A 404 is `skipped_gone`. A failed volume read means no search. | Kapowarr's own removal and blocklist, then the Library Force Search verb. |
| 3 | **Sparse calls**: at most one removal and one search per download, and the per-run cap. | Kapowarr's 429s are burst-rate. |

### D-20 — Loops on the suite, the digest and /admin (2026-09-29, ADR-095)

| # | Ruling | Reason |
|---|---|---|
| 1 | **The loop guard extends to the sources** for `bad_release`, the one source removal after which the source searches again: a download whose book format (`item_ref`) or volume (`target_id`) the janitor already removed on `QUEUE_CLEANUP_SOURCE_LOOP_LIMIT` (2) earlier downloads (`outcome: 'done'`) is `skipped_loop`, held for a person. A failed guard read holds every candidate that run. Unlike D-13 there is no completeness gate: a new stuck download of the same book format means the format is still wanted. `leftover` is never guarded (nothing is re-grabbed). _(Amended 2026-10-03 by D-23 rule 7: removals count for a rolling 30 days.)_ | The owner's "monitor for loops": a strand removed, re-grabbed and stranded again is the shape to stop. |
| 2 | **Loop log lines** (`[queue-cleanup] loop_detected`): `kind: 'skipped_loop'` (now with `itemRef`), `kind: 'repeat_search'` (Kapowarr volumes), and the new `kind: 'fail_loop'` for a source fail loop, logged when first seen and whenever its failure count grew since its latest earlier row (`attempts`, `previousAttempts`), so only a loop that is still spinning logs (the previous row is looked for within 48 hours, so the hourly read stays bounded). | Alertable in Loki without reading the database, and quiet for a loop that holds still. _(Amended by D-21 rule 10: a fail loop logs when it is new, not when its count grows.)_ |
| 3 | **The digest** rolls up every instance (the suite included), lists the source fail loops of the last 24 h (`loops.failLoops`: the 10 largest by name, the rest counted), and prints one ladder line per family. Fail loops do **not** set `loopDetected` (the `[janitor: loop detected]` subject tag stays the janitor's own loops); the promotion tags are per family (D-17 rule 5). The digest and the /admin summary count in SQL (`GROUP BY`), since the suite census adds hundreds of rows an hour. | Sixty LazyLibrarian loops would otherwise raise the loop tag every night and drown the signal it exists for. |
| 4 | **/admin/janitor**: one ladder block per family; the enforcement form gains a "Books and comics" grid (LazyLibrarian and Kapowarr columns: retry, bad release, leftover; "Keeps failing" and "Unknown reason" report only) beside the *arr grid, under one Save and the same two-step confirm; the 7-day summary follows the same two grids. | One form, one audited write, for every cell. |

### D-21 — LazyLibrarian's fail loops: causes, the cleanup, and loop signals as state changes (2026-09-29)

Evidence, read-only on 2026-09-29 (LazyLibrarian's database opened read-only, its API, SABnzbd's and qBittorrent's
APIs, Loki); the record, with the old values and the rollback list, is `.agents/context/2026-09-29-ll-fail-loops.md`.
The janitor's first books census (16:25Z) found 60 fail loops. In the 7 days before, those 60 made 25 grabs, **3.6 a
day, all failed**; LazyLibrarian as a whole made 179 (77 failed).

| # | Ruling | Reason |
|---|---|---|
| 1 | **Most loops were books LazyLibrarian already had.** 48 of the 60 formats (127 formats across all books) read `Wanted` while their file was on disk with a library date. haynesnetwork's unguarded `queueBook` put them there before 2026-09-22 (DESIGN-028 amendment of that date; none since). The daily library scan cut the 292 of that night to about 128 and does not move the rest, so LazyLibrarian's daily backlog search (`search_bookinterval` 1440) kept looking for books it held. | Each grab for a held book either fails as a duplicate (rules 3, 5) or imports another release over the held copy: about 50 different Wild Cards volumes were imported as "Wild Cards I" in August. |
| 2 | **LazyLibrarian's failed list does not block a release that came through Prowlarr** (corrects D-18 rule 3's "its searches skip a failed URL", and Q-04). Its URL check never matches, because Prowlarr re-encrypts the `link` parameter of its download URL on every search. Its fallback check (same provider and title) misses whenever LazyLibrarian has replaced the stored title with SABnzbd's job name, which SABnzbd sanitizes (`/` and `"` become `_`). | The Cibola Burn eBook grabbed the same post on 7 of the last 7 days. The janitor's `bad_release` on LazyLibrarian therefore rests on the loop guard (D-20 rule 1), not on LazyLibrarian's own list. |
| 3 | **"Duplicate NZB"** is SABnzbd's duplicate check (`no_dupes` 3, Fail, as it must stay; never Discard) finding a Completed job of the same name or NZB checksum in its history. Failed jobs do not count, so the earlier delete of failed jobs did not change it. | Fail mode turns the re-grab into a failed job LazyLibrarian can see, instead of a silent discard. |
| 4 | **"Unable to locate a valid filetype"**: the download holds no file of the wanted type at its top level. Two shapes: an MP3 audiobook posted with an `.mp4` subject, grabbed for an eBook (`reject_words` listed `mp3`, not `mp4`); and whole-series bundles grabbed for one audiobook (the Twilight saga, 490 mp3 in per-book folders; the four-book Inheritance Cycle). | Release filtering, not a download fault. |
| 5 | **"Failed to send torrent to QBITTORRENT"** is qBittorrent refusing a torrent it already has ("Detected an attempt to add a duplicate torrent" in its log); LazyLibrarian reports it with this generic text. All 16 of the last 7 days were re-grabs of MyAnonaMouse torrents already seeding for books LazyLibrarian held. | Rule 1 is the cause. |
| 6 | **"Failed to send nzb"** (1,047, from 2026-07-12 to 08-04, spread over all four indexers) was SABnzbd being unavailable during the talosw02 DiskPressure eviction loop, fixed 2026-08-01 (haynes-ops #2327, #2328); none since. "URL Fetching failed" (399, July) is the same window. | Not an indexer or connectivity fault today. |
| 7 | **LazyLibrarian's reject words are matched two ways.** The search filter (`resultlist.py`) compares whole words after stripping brackets and dots, and skips a word that is in the book's own title or author. The re-check after a torrent is added (`tor_dl_method`) is a raw substring match with no such exemption, and then deletes the torrent it just added (`DEL_FAILED`). All 14 of its rejections in LazyLibrarian's log were `und`, 12 inside English titles (Foundation, Underland, Unbounded, Scoundrel, Hellhounds) and 2 inside Spanish ones. | This is why Q-07's language tags cannot be added safely: `french` would reject "The French Lieutenant's Woman" at the re-check. It also corrects the ops runbook (`docs/ops/013-mam-books-acquisition.md` §11.4). |
| 8 | **LazyLibrarian settings changed (reversible, through its `writeCFG`, old values in the context note):** `reject_words` gains `mp4` and loses `und`; `reject_audio` loses `und`. No language tag is added (rule 7). | `mp4` stops the audiobook-for-eBook grab (rule 4) and cannot collide with an eBook name. `und` is the one reject word that hit English titles, and each hit deleted a MyAnonaMouse torrent right after adding it; the German-specific words stay. |
| 9 | **One-off cleanup (reversible):** `unqueueBook` (to `Skipped`) for every format that read `Wanted` with its file on disk: 127 formats (114 eBook, 13 audiobook). Excluded: formats with an open books Fix (a Fix is the one sanctioned way to re-acquire a held format, ops runbook §12.6) and the one format with a library date but no file. No search was sent: none of the 12 loops left has a cause that is gone. Fail loops: 60 → 12. | `Skipped` is LazyLibrarian's own "not looking" status (its `NOTFOUND_STATUS`), the library scan still promotes a matched book to `Open`, and `queueBook` undoes it. haynesnetwork's `Skipped` sweep leaves a held format alone (`llFormatAlreadyHeld`). A request's format then reads `missing` instead of `wanted`; its phase stays `have` wherever a format landed. |
| 10 | **`[queue-cleanup] loop_detected` is a state change** (amends D-13 rule 5 and D-20 rule 2). A `fail_loop` logs when its book format was not a `fail_loop` on the instance's previous run; a `skipped_loop` logs when its download (its download id, else its item reference) was not held on the previous run. The previous run is the instance's latest earlier rows (one run writes all of its rows with the same time), looked for within 48 hours; none within 48 hours means every loop is new. A loop that stands logs nothing, however its count grows; it stays in the rows and in the digest. A loop that clears and comes back logs again. A run that could not read the instance wrote no rows, so it is not a change. A failed state read logs every loop as new for that run. `repeat_search` is unchanged: it fires on a janitor search, which is an event, not a state. The `fail_loop` line drops `previousAttempts`. Generic over instances: the *arrs' held downloads follow the same rule. | The alert key must be rare: one line per new loop, not one per loop per run. The previous rule logged every held download on every run and every fail loop whose count grew. |
| 11 | **The janitor stays report-only on fail loops** (ADR-095 C-08). No new write-back: the loops left are a person's (bundles only, a German edition wanted, posts gone, two copies seeding that need a manual import), and the held-but-`Wanted` source was closed on 2026-09-22. | A recurrence shows up as a new `fail_loop` line and in the digest. |

### D-22 — `leftover` compares the folder's book files with the library copy (2026-09-29, issue #621)

**Evidence** (the coordinator's spot-check of all 673 `leftover` census rows on v0.104.0, read-only, recorded in
PLAN-065): 657 correct, 8 wrong, 8 uncertain. The 8 wrong are folders of volume 3 of a German series that
LazyLibrarian tracks as ONE book, so every volume's grab was imported over the same destination (`Chroniken der
Unterwelt - Cassandra Clare.epub`), which now holds volume 6; the folders were the only copy of volume 3. The 8
uncertain are *The Amber Spyglass* standalone, whose destination epub is a later grab of the three-book omnibus. D-18
rule 5 proved that a file exists at the recorded destination, never that it holds the folder's book. Owner ruling
through the coordinator (2026-09-29): a folder is a `leftover` only when every book file in it has its counterpart at
the destination; anything else is report only, never deleted. The rows are pinned by `janitor.test.ts` in
`@hnet/downloads` (pure and on a real filesystem) and `queue-cleanup-sources.test.ts` (both failure shapes and a
good shape, anonymized, through the adapter and the evaluator).

| # | Ruling | Reason |
|---|---|---|
| 1 | **A book file** is an audio or eBook format by extension, case-insensitive, anywhere in the folder (`bookFileKind`, `coverage.ts`): audio `mp3 m4a m4b aac flac ogg oga opus wma wav aax aa mka`, eBook `epub kepub mobi azw azw3 azw4 kfx pdf fb2 djvu lit lrf pdb prc rtf doc docx cbz cbr cb7 cbt`. Everything else (nfo, jpg, sfv, diz, url, m3u, txt, opf, par2 …) is not compared. An archive (`zip rar 7z tar gz tgz bz2 xz`, split parts `.r00`, `.001`) is its own kind. | The list is wider than LazyLibrarian's configured types (`epub, mobi, pdf, azw3`; `mp3, m4b, m4a`) on purpose: a wider list can only make a folder report only, never delete more. |
| 2 | **The counterpart depends on the format** (`compareFolderToLibrary`). **Audio:** a file of the same name and the same byte size. **eBook:** a file of the same extension and the same byte size, under any name. The files compared are the regular files (no symlink) at the top of each recorded destination's directory. A folder is covered only when it holds at least one book file, no archive, and every book file (a regular file, not a symlink) has its counterpart. | LazyLibrarian keeps audio names and renames every eBook file, the book and each extra format, to `<title> - <author>.<ext>` (`_process_destination`, `_get_dest_filename`), so for an eBook the name can never match. |
| 3 | **Why a size match without a name match counts for an eBook and not for audio.** An epub, mobi, azw3 or pdf is a compressed container: two different ones of byte-identical size in one book's folder is not a realistic collision, and the name is not available. Audio parts ripped at a constant bitrate and split at fixed lengths have equal sizes across different books, and the audio folder of a series tracked as one book mixes volumes (the German series' audio folder holds five volumes' parts), so for audio the name, which LazyLibrarian keeps, is the discriminator. An audiobook LazyLibrarian renames (if a rename setting is ever turned on) therefore reads report only: the safe direction. | The owner asked for this call to be made and justified. |
| 4 | **The live check of the equivalence** (the same 673 folders, 2026-09-29, the real `compareFolderToLibrary` over a read-only listing from the LazyLibrarian pod). The ruling taken literally (same name and size for every format) passes 523 of 523 audiobooks and 0 of 150 eBooks, since every eBook is renamed. With rule 2: **579 of the 657 correct rows pass** (523 audiobooks, 56 eBooks) and **0 of the 16 unsafe ones**. The other 78 become report only: their library copy is a different release of the same title (a later grab replaced it: 26 + 9 + 7 folders of three books) or a series pack whose other volumes sit in their own library folders (33 + 3). Their exact files are not in the library, so under the ruling they are a person's call. | Not a collapse: 88 % still pass, and what drops out is exactly what the ruling names (the folder's own file is not in the library). |
| 5 | **Report only, as `unknown` with its own reasons** (`LEFTOVER_COVERAGE_REASONS`): "Library copy differs from the download folder, the download folder may be the only copy" (a book file without its counterpart); "No book file in the download folder to compare with the library copy"; "Download folder holds an archive, it cannot be compared with the library copy"; "Download folder could not be compared with the library copy" (a read failed, the folder is over the bounds, or a destination fails `libraryFileExists`). No new class, action or migration: `unknown` is report only everywhere (D-15 rule 2). | The census and the digest's top reasons show each case by its message; nothing about them can act. |
| 6 | **Where it runs.** `DownloadPathProbe.folderCoverage(folder, destinations)` (read-only, `@hnet/downloads/read`) walks the folder without following a symlink (at most 4 levels, 5,000 entries; beyond is "could not be compared"), lists each destination's directory, and hands both to the pure comparison. The census walks only a folder that passed every other test (one job names it, every row Processed, every copy exists). **The delete compares again** in the same call as its other checks and keeps the folder unless it still passes ("library copy no longer matches the download folder, folder kept"): a later grab can overwrite a destination between the census and the delete, which is how the German volumes were lost. | One `lstat` per file: the whole download root held about 78,000 files on 2026-09-29 and a full walk took 32 s from the LazyLibrarian pod; the walk shrinks as leftovers are deleted. |
| 7 | **The cell stays census until the spot-check is re-run** on an image with this rule (PLAN-065). The library gap it found is recorded there and on issue #621: the German volume 3 was re-imported through LazyLibrarian's own `importBook` under its own book; *The Amber Spyglass* standalone is in the library as the same retail azw3, only its epub is not. The other German volumes the same overwrites removed, whose folders are gone, are issue #627. | Zero wrong is the bar (D-17 rule 4). |

### D-23 — One search budget per title, and one search per failure (2026-10-03, ADR-098)

**Evidence** (read-only, 2026-10-03: Sonarr's history API from inside its pod, the janitor's rows on a database replica,
Loki). The 06:25Z run of 2026-10-02 removed 7 Paw Patrol `bad_release` downloads ("Found archive file, might need to be
extracted", 13 episodes, every one of which already had a file) and sent one EpisodeSearch per episode: 13 searches.
Sonarr's history shows each removal as `Manually marked as failed` and no search after it, so `skipRedownload` held
(D-10 rule 1). The next 4 minutes held 15 failed downloads (SABnzbd "Aborted, cannot be completed"), each followed
within seconds by Sonarr's own Redownload Failed search: 25 grabs in 5 minutes, 11 from the janitor's searches and 14
from Sonarr's; S05E16 was grabbed 7 times, S05E15, S05E19 and S05E20 5 times each. No Sonarr or Radarr target
has yet been searched by the janitor on two downloads (34 Sonarr `bad_release` searches since 2026-09-25, 34 targets), so
the gap below had not looped through the janitor yet, but nothing bounded it: the guard covered only Lidarr's
`manual_match` (D-13) and the suite sources (D-20). Each row is pinned by tests (`queue-cleanup.test.ts`).

| # | Ruling | Reason |
|---|---|---|
| 1 | **One budget per title.** The loop guard (D-13 rule 4) covers every *arr class whose action ends in a janitor search: `bad_release` on Sonarr, Radarr and Lidarr, and `manual_match` on Lidarr. A try is a row of the instance in either class with `outcome = done` and `action` `removed_blocklisted` or `blocklisted_searched`, for the same `target_id`, on another download. The failed-download retry's rows (D-24) are `bad_release` rows, so its searches are tries too. A target with `QUEUE_CLEANUP_LOOP_LIMIT` (2) earlier tries in the last 30 days (rule 7) is `skipped_loop`: nothing sent, the whole download held (D-11 rule 3), logged once (D-21) and listed in the digest. `MANUAL_MATCH_LOOP_LIMIT` and `QUEUE_CLEANUP_SOURCE_LOOP_LIMIT` are now the same constant. | The owner's "cap of 2 per title" is a bound on searches of one title, whoever asks for them, so one counter serves every path. Counting across classes is the conservative reading: an album removed once as `bad_release` and once as `manual_match` has had two searches. |
| 2 | **The hold applies while the janitor would search again**: `manual_match` as before (monitored and missing tracks); `bad_release` while the target is monitored. Over the budget and unmonitored: removed and blocklisted, not searched, not held. A failed guard read holds every download of a searching class that run (it held `manual_match` only). | Without a search there is no loop, and holding a dead download for a person would only clutter the digest. |
| 3 | **A target is searched at most once per run**, whichever download asks: a second download of a target already searched in the run is removed and blocklisted (`removed_blocklisted`), not searched. | The 2026-10-02 run grabbed both an S05E03E04 pack and an S05E04 single; had both failed, one run would have searched S05E04 twice. |
| 4 | **The queue path never searches a failure the *arr took itself.** A `bad_release` record whose `trackedDownloadState` is `failed` (Lidarr `downloadFailed`) is removed and blocklisted, with no monitored read and no search. One in `failedPending` (Lidarr `downloadFailedPending`) is not acted on that run (`none`). | The *arr's failed-download handling has already blocklisted it and, with Redownload Failed on, searched; with it off, the failed-download retry searches once (D-24). A download stays in the queue after that only where the download client keeps failed items (qBittorrent here, `removeFailedDownloads: false`). `failedPending` lasts until the *arr's next processing pass; a removal first would turn the failure into a manual mark, which nothing retries. |
| 5 | **Removals keep `skipRedownload=true`** (D-10 rule 1). Of the two ways to get one search per removal, passing `skipRedownload` and searching ourselves, or leaving the search to the *arr, the first is kept. | The janitor's own search is the one that passes the monitored check, the completeness check (D-13) and this budget; the *arr's would pass none of them. It also keeps a removal independent of the *arr setting, which ADR-098 turns off in Sonarr and Radarr and leaves on in Lidarr. |
| 6 | **A record with no target is not counted.** | Sonarr and Radarr records always carry an episode or movie id; a `bad_release` record without one falls back to the parent's search (D-11 rule 4), and none has been seen since `target_id` landed (0 of the *arr rows since 2026-09-30). |
| 7 | **Two tries in any rolling 30 days** (owner ruling, 2026-10-03, Q-08: "Reset after 30 days"). A try counts toward the budget for `QUEUE_CLEANUP_LOOP_WINDOW_MS` (30 days) after its row's `created_at`, then drops out, so a held title is tried again once its oldest counted try is 30 days old, and never more than twice in any 30 days. It applies to every loop guard, because they share the budget: the *arrs' searching classes, the failed-download retry (D-24), and the suite sources (D-20: a book format or a Kapowarr volume). It supersedes D-13 rule 4's "the hold does not expire" for Lidarr's `manual_match` too; nothing in D-13's evidence needs a lifetime hold, and the release-name block (D-14) still keeps the same posting away for 365 days. The digest's held list and the `loop_detected` line are unchanged. | A title the janitor tried twice months ago should not need a person before it is tried again, and a monthly bound still makes a cascade impossible. One window for every guard keeps "two tries per title" one rule. The `target_done` and `item_ref` indexes lead with `(instance, target)` and end in `created_at`, so the bounded read stays an index range. |

### D-24 — The failed-download retry (2026-10-03, ADR-098, owner ruling)

**Owner ruling (Tom, 2026-10-03, "App retries, capped"):** Redownload Failed is turned off in Sonarr and Radarr, and the
janitor becomes the only thing that retries a failed download: at most two tries per title (in any 30 days, D-23 rule 7), at its hourly run. Recovery
taking up to an hour longer is accepted; cascades must be impossible. Each row is pinned by tests
(`queue-cleanup.test.ts`, `read-clients.test.ts`).

| # | Ruling | Reason |
|---|---|---|
| 1 | **Where.** Sonarr and Radarr (`failedDownloads` on their instance client), after the queue pass of the same run, sharing its per-run cap and its once-per-run search set. Not Lidarr. | The ruling's scope; Lidarr's Redownload Failed stays on. |
| 2 | **What it reads.** `GET /history/since?date=<now − 24 h>&eventType=downloadFailed`, and `eventType=grabbed` over the same window (a target is *grabbed again* when it has a grab after the failure). One failure per download and target, the newest record. | The *arr removes a failed SABnzbd download from its queue at once (`removeFailedDownloads: true`), so only its history still shows it. 24 hours covers missed hourly runs; an older failure is left alone. |
| 3 | **Never a failure to retry:** a record whose message is `Manually marked as failed` (any removal through the *arr's queue or history API: the janitor's own removals, which search by themselves; a Fix, which searches by itself; a person's removal in the *arr's UI); a record with no download id; a failure whose own download is still in the queue after this run's removals (no row: the queue path removes it, and the next run retries it). | A person who removes a download chose whether to search. After the settings change the *arr's own "Blocklist and Search" option no longer searches, so a person searches by hand (OPS-018). |
| 4 | **Recorded once.** One row per failure and target: `queue_item_id` null, the download id, the target, the release title, class `bad_release`, the mode of the instance's `bad_release` cell, and the *arr's failure message as `reason`. A failure with a row other than `skipped_cap` or an error is never acted on again, however often a later read returns it. | No migration: the row shape exists, and a null queue id tells a retry row apart from a queue row (every *arr queue record has an id). |
| 5 | **Who searches.** Nothing while the cell is census or while the *arr's own Redownload Failed is on (`GET /config/downloadclient`, `autoRedownloadFailed`, read on a run that has a failure to decide): every failure is `none`. Otherwise, per download (D-11): `none` for a target grabbed again since the failure, with another download in the queue, or already searched this run; `none` for an unmonitored target; `skipped_loop` for a target over the budget (D-23 rule 1); the rest get **one** search command for the download's targets (EpisodeSearch or MoviesSearch, both take id lists), each `blocklisted_searched`, `done` (the *arr blocklisted the release when it failed). | Exactly one search per failure: the *arr's own (setting on) or the janitor's (setting off), never both. Reading the setting every run also makes the deploy safe before the settings change, and keeps the retry quiet if the setting is ever turned back on. |
| 6 | **Rails.** The search costs one slot of `maxActionsPerRun`, after the queue path's; a spent cap is `skipped_cap`, tried again next run. No age rail: the failure has already happened. A failed history, record, setting or guard read writes nothing and logs one warning (the next run tries again). A failed monitored check or search is `none` with `outcome: 'error'`, counted in the run's errors and tried again next run (while the failure is within 24 hours). | Same rails as the queue path, applied to what can go wrong here. |
| 7 | **Signals.** A held failure logs `[queue-cleanup] loop_detected` (`kind: 'skipped_loop'`) once, since it is recorded once (D-21), and appears in the digest's held list; a retry search of a target the janitor searched on an earlier run within 7 days logs `kind: 'repeat_search'`. One info line per instance with fresh failures: `queue-cleanup failed downloads` (`failures`, `arrRetries`, `searched`, `held`, `errors`). The census, the /admin summary and the digest count the retry rows under `bad_release`. | Visible without reading the database, like D-13 rule 5. |
| 8 | **Rollout.** No new cell, no config change, no migration: the derived ladder stays L2. The coordinator turns Redownload Failed off in Sonarr and Radarr after the deploy, right after a janitor run (OPS-018). | A failure in the minutes between the last run and the change was already searched by the *arr; the retry skips it if that search grabbed something and searches once more if it did not. Changing the setting just after a run makes that window a minute or two. |

### D-25 — A delay-profile hold is `waiting`, not `unknown` (2026-10-03)

**Why.** The owner put a 120-minute Usenet delay on Sonarr's delay profile (2026-10-03, so a better release can turn up
before one is grabbed). The *arr keeps each release it is holding in the queue as a pending release: `status: delay`,
`trackedDownloadStatus: ok`, no messages, nothing sent to SABnzbd. None of D-03's signals match it, so every held release
fell through to `unknown` and was written as an `unknown` census row on each hourly run, then counted in the /admin
summary and the nightly digest. Nothing was ever acted on (`unknown` has no enforce cell), so the cost was noise: a
normal, intended wait read as a pile of unclassified queue items.

| # | Ruling | Reason |
|---|---|---|
| 1 | **The signal is `status: delay`, nothing else.** Any casing. `pending` is not an *arr queue status; `importPending` and `failedPending` are download states with their own handling (`retry_import`, D-23 rule 5), so they do not match. `downloadClientUnavailable` (a client that is down) is a fault someone should see, so it stays `unknown`. | Only the delay hold is a wait that fixes itself. |
| 2 | **It is checked last,** after `have_better`, `bad_release`, `retry_import` and `manual_match`, before `unknown`. A record with `status: delay` that also carries an error, a failed state or a stuck-import message keeps its actionable class. | A benign class must never hide a real one. |
| 3 | **It leaves the census whole.** The classifier returns `waiting`, which is not an Action Class: it has no `arr_queue_cleanup_actions` row (no migration, the class CHECK is unchanged), no verdict, no download group, and no count under any class, so it is never `unknown`, never `skipped_*`, and never counts toward the cap, the loop guard or the retry escalation. | "Never acted on and not counted as unknown", with nothing written about an item that is working as intended. |
| 4 | **It stays visible in the run.** `QueueCleanupInstanceReport.waiting` counts the records left out per *arr, and the `queue-cleanup evaluated` log line carries `waiting`. `itemsObserved` is the queue size less the waiting records. | A queue that is mostly held releases is still readable from the logs. |
| 5 | **It applies to every *arr.** Radarr and Lidarr hold releases the same way, so a delay profile on either gets the same treatment. | One classifier, one rule. |

Pinned by `queue-cleanup.test.ts` (the classifier cases, and the evaluator case: held records leave the census with
every cell enforced, only the real item is acted on, the report counts them).

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
| Q-01 | Which Lidarr `importPending` reason strings graduate out of `unknown`, and into which class? The 59-item pile is likely match-ambiguity from the soularr/slskd path; some may deserve a dedicated "manual match" class rather than A/B/C. | **Answered 2026-09-28 (D-12).** Evidence: Lidarr's live queue (62 records), the albums they are for, and the census since 2026-08-01 (234 downloads). The pile is SABnzbd and qBittorrent, not soularr/slskd, and mostly `importFailed`, not `importPending`. Lidarr's match rejections (52 of 62 records: "Album match is not close enough", "Has missing/unmatched tracks", "Couldn't find similar album", "Worst track match", "found multiple artists") become the new report-only class `manual_match`: no enforce cell, never acted on. "No files found are eligible for import" (9) and Lidarr's `importFailed` "Not an upgrade…" (1) stay `unknown`. Nothing graduates into A/B/C. Recorded in the PLAN-065 ladder log; migration 0083. |
| Q-02 | Retention sweep for `arr_queue_cleanup_actions` (append-only forever vs. 90-day prune)? | (open — revisit at L3. Volume was ≤ the *arr queue size per hour; ADR-095 adds LazyLibrarian's census, about 830 rows an hour at first (769 leftovers until cleared, about 60 fail loops), so the table now grows by roughly 20k rows a day more. The hot reads are bounded (24 h, 7 days, 48 h windows, SQL aggregation); a prune becomes worth doing once the table passes a few million rows.) |
| Q-03 | Should classifier patterns graduate to DB config for release-free tuning once stable? | (open — only if post-L3 tuning cadence demands it) |
| Q-04 | Should the janitor release block (D-14) also cover `bad_release` on Lidarr, or other sources as the janitor extends to the suite (books, comics)? | (open — each needs its own evidence of a same-name loop, and each new source is a new write-back under hard rule 4, ADR-094 C-08. ADR-095 extended the janitor to LazyLibrarian and Kapowarr without a name block: LazyLibrarian's own failed list already blocks a failed URL, and its fail loops (D-18 rule 7, reported nightly) are the evidence to read before any books name block. 2026-09-29, D-21 rule 2: that premise is only partly true, since Prowlarr re-encrypts its links and LazyLibrarian's title check misses SABnzbd's sanitized names; the same-release repeats seen were for books already held, which D-21 rule 9 removed, so a books name block still waits for evidence.) |
| Q-05 | Should LazyLibrarian move usenet downloads instead of copying them (`destination_copy = False`, with `KEEP_SEEDING` keeping torrents copied)? It would stop new leftovers at the source and leave `leftover` only the backlog. | (open — a LazyLibrarian setting for the owner; its config lives on its volume, not in git) |
| Q-06 | Should `leftover` also delete the completed folders of downloads LazyLibrarian failed (including strands the janitor removed, whose folders SABnzbd keeps)? | (open — reported as `unknown`, "Folder of a failed download left in SABnzbd", until the census shows how many there are and what they hold) |
| Q-07 | LazyLibrarian's `reject_audio` filter lists only German words, so a "[French]" audiobook was grabbed (the coordinator's audit, 2026-09-29). Should its filters reject other languages? | **Answered 2026-09-29 (D-21 rules 7 and 8): not safely.** LazyLibrarian re-checks a torrent's name with a raw substring match and no title exemption, then deletes the torrent, so `french` would reject "The French Lieutenant's Woman". No language tag was added, and `und` was removed for the same reason. A safe filter needs whole-word matching in that re-check (an upstream LazyLibrarian change). |
| Q-08 | Should the loop guard's count expire? It had no time window (D-13 rule 4, D-23 rule 1), so a title the janitor tried twice, months apart, was never searched by it again; RSS and a person still could. | **Answered 2026-10-03 (owner ruling, "Reset after 30 days"; D-23 rule 7):** at most two automatic janitor tries per title in any rolling 30 days, for every loop guard (the *arrs, the failed-download retry, the suite sources). |
