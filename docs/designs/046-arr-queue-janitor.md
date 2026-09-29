# DESIGN-046: Arr queue janitor — classifier, census, promotion ladder

- **Status:** Accepted
- **Last updated:** 2026-09-28 (D-12: Q-01 answered from Lidarr's live queue and its census since 2026-08-01. Lidarr's
  match rejections become the report-only class `manual_match`; nothing Lidarr shows graduates into an acting
  class; migration 0083). Prior: 2026-09-28 (D-11: one action per download, so a season pack is removed once,
  not once per episode; a removal that answers 404 is `skipped_gone`, not an error; retry escalation counts
  runs, not rows; issue #583 item 1, before L2). Prior: 2026-09-25 (D-10: four classifier/action fixes from the L0→L1
  census spot-check, made before any cell enforces: `skipRedownload` on every removal, the identity-mismatch
  guard, message-only reasons, release-level-only release-defect signals). Prior: 2026-08-01.
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
| `manual_match` | Since D-12: one of Lidarr's own match rejections ("Album match is not close enough…", "Worst track match…", "Has missing tracks", "Has unmatched tracks", "Couldn't find similar album for…", "Unable to import automatically, found multiple artists…"). Lidarr could not match the files to an album with confidence, so only a person can decide. **Report only**: no enforce cell, never acted on, like `unknown`. Also takes a `have_better` match that carries one of these messages. |
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
  the blocklist only.
- `unknown` → never acted on (ADR-083, normative). `manual_match` → never acted on either (D-12); it has no
  enforce cell.

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
  modes matrix is unchanged, so a stored config stays valid.
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
`skipped_mixed|skipped_gone`, migration 0082),
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
| Q-02 | Retention sweep for `arr_queue_cleanup_actions` (append-only forever vs. 90-day prune)? | (open — revisit at L3; volume is small: ≤ queue size per hour) |
| Q-03 | Should classifier patterns graduate to DB config for release-free tuning once stable? | (open — only if post-L3 tuning cadence demands it) |
