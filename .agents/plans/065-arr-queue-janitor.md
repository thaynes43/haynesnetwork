# PLAN-065: Arr queue janitor — build, census, promotion ladder

- **Status:** 🟢 CENSUS LIVE (2026-08-01, v0.95.0) — S1–S7 all complete same-session; the plan
  stays open as the ladder's book of record until L3. **Level: L2 since 2026-09-29** (L1 from 2026-09-25). Resume point: §Ladder log below.
- **Number note:** 065 assigned by the coordinator (numbers stable, never reused).
- **Docs of record:** [ADR-083](../../docs/adrs/083-arr-queue-janitor-census-first.md) ·
  [DESIGN-046](../../docs/designs/046-arr-queue-janitor.md) · glossary T-237..T-240.
- **Depends on:** nothing in flight. Touches the sync rail, `@hnet/arr`, `@hnet/domain`,
  `@hnet/db` (migration 0075), `@hnet/api`, `/admin` — all shipped surfaces.
- **THIS PLAN STAYS OPEN UNTIL L3.** It is the ladder's book of record: every promotion,
  spot-check, and blocker gets a dated entry in §Ladder log below. HANDOFF carries a pointer,
  not the state.

## The problem (owner request, 2026-07-31)

73 completed-but-unimported grabs sit in the *arr queues (Sonarr 11 `importBlocked`, Radarr 3
`importBlocked`, Lidarr 59 `importPending`) needing manual triage in three UIs. Owner wants a
periodic janitor: already-have-it → remove + blocklist; recoverable → resolve so it imports;
bad → blocklist + search; unclear reasons → surface, don't guess. Owner's named anti-goal:
census mode as a comfortable dead end — *"my only concern would be that we leave it in census
mode and miss out on fine tuning it to a point where it provides value."*

## Build stages

Conventional-commit type `feat` throughout; one PR is fine (the surfaces interlock), checks
`lint-and-typecheck` / `test` / `build` green, squash-merge. Heavy backend per the division of
labor; coordinator reviews before merge.

- **S1 — `@hnet/db`:** `'queue-cleanup'` → `SYNC_RUN_KINDS`; `QUEUE_CLEANUP_ACTION_CLASSES`,
  `QUEUE_CLEANUP_MODES`, `'arr_queue_cleanup_config'` → `APP_SETTING_KEYS`;
  `arr_queue_cleanup_actions` table; **migration 0075** (table + both CHECK rebuilds:
  `sync_runs.run_kind`, `app_settings.key`).
- **S2 — `@hnet/arr`:** whole-queue paged read on the three read clients (DESIGN-046 D-02);
  `deleteQueueItem(id, {removeFromClient, blocklist})` on `ArrWriteClientBase` (D-04);
  schema additions BC-03-minimal.
- **S3 — `@hnet/domain` (`queue-cleanup.ts`):** `classifyQueueItem` (D-03 pattern table);
  `evaluateQueueCleanup` single-writer (census rows always; enforce actions behind config
  cells; caps, min-age, monitored-check, retry escalation via action-row lookback; opaque
  write bundle — import guard stays green); config reader/validator/writer
  (`getArrQueueCleanupConfig` / `queueCleanupConfigError` / `setArrQueueCleanupConfig`,
  D-05); digest section composition (D-07).
- **S4 — `@hnet/sync`:** `--mode=queue-cleanup` wiring end-to-end (D-01: sync.ts usage/guards/
  clients/threading, orchestrator early-return, `SyncReport.queueCleanup`).
- **S5 — `@hnet/api` + `apps/web`:** `queueCleanup` router (`status` / `config.set`,
  adminProcedure, zod mirror); `/admin/janitor` panel (D-08 — mode grid, knobs, ladder
  readout, 7-day summary; ConfirmButton on census→enforce; reflow-safe, tokens only).
- **S6 — tests (D-09):** classifier table; evaluator on embedded PG with stubbed clients;
  config matrix; digest payload+render; stub-*arr canned errored queue for dev:local/e2e.
- **S7 — deploy:** merge → release-please → `v*` image → haynes-ops PR: `sync-queue-cleanup`
  CronJob (`25 * * * *`, `--mode=queue-cleanup`, `sync-incremental` shape) → flux reconcile →
  verify first census run (JSON logs + `arr_queue_cleanup_actions` rows + next digest email
  carries the section).

## The promotion ladder (T-240) — criteria, obligations

**Standing obligation (until L3):** any session that reads HANDOFF while a criterion below is
met MUST either flip the config cell(s) (audited, via `/admin/janitor` or the domain writer)
or add a dated blocker entry to §Ladder log. The nightly digest prints level + age + next
criteria; subject gains `[janitor: promotion due]` when a criterion is met or level age > 14
days (D-07). Leaving the nag unactioned across sessions is a process violation, not a style
choice.

- **L0 → L1** (enforce `have_better` on Sonarr + Radarr): ≥ 3 digests carrying census data
  AND owner (or coordinator on owner's behalf) spot-checks the accumulated Sonarr/Radarr
  `have_better` census rows — ≥ 90% judged correct, zero "would have deleted something
  genuinely wanted". Record the spot-check in §Ladder log.
- **L1 → L2** (enforce everywhere, incl. `retry_import` + `bad_release` + Lidarr): ≥ 7 days
  at L1 with zero bad deletions (checked: no re-grab-of-same-media churn attributable to a
  janitor removal, no owner report) AND the Q-01 Lidarr classification decision is recorded
  (which reason strings leave `unknown`, with classifier tests) — Lidarr cells stay census
  until Q-01 lands, even if the calendar criterion is met.
- **L2 → L3** (stabilized): ≥ 14 days at L2 with the queues holding at/near zero stuck items
  and `unknown` residue characterized (either patterns graduated or explicitly accepted as
  the agentic-tail backlog, ADR-083 C-07). Then: move this plan to `completed/`, retire the
  HANDOFF block, drop the CLAUDE.md census warning (keep the janitor line), update the
  Fable memory file.

### The books and comics ladders (ADR-095, DESIGN-046 D-17)

Since ADR-095 the janitor covers LazyLibrarian (`books` family) and Kapowarr (`comics` family) through the source
adapter seam, each with its own ladder; the criteria above are the `arr` family's and do not change. **No calendar
waits** (owner direction, 2026-09-29):

- **L0 → L1:** enforce a cell as soon as the coordinator has spot-checked its census rows (≥ 90 % judged correct, zero
  would-be bad removals). Record the check here.
- **L1 → L2:** enforce the remaining cells once the enforced cells' first actions are audited clean (nothing wanted
  removed, no library file touched, the loop lines quiet or explained).
- **L2 → L3:** the source holds near zero stuck items and its fail loops are characterized (a person sets L3 here).

The nightly digest nags (`[janitor: promotion due]`) while a family is below L2 and has census evidence for one of its
cells in the last 24 h. **Cells** (all census at ship): `modes.lazylibrarian.retry_import`, `.bad_release`,
`.leftover`; `modes.kapowarr.bad_release`. **Flip one** from /admin/janitor ("Books and comics" grid) or, after the
image carrying ADR-095 is deployed, with this audited command (swap the instance and class; the stored *arr cells
are read back and kept):

```sh
kubectl -n frontend exec deploy/haynesnetwork-main -c app -- sh -c 'cd /sync && tsx -e "(async () => { const d = await import(\"@hnet/domain\"); const c = await d.resolveArrQueueCleanupConfig(); c.modes.lazylibrarian.retry_import = \"enforce\"; console.log(JSON.stringify(await d.setArrQueueCleanupConfig({ config: c, actorId: null }))); process.exit(0); })().catch((e) => { console.error(e); process.exit(1); })"'
```

**`leftover` needs its mounts first** (DESIGN-046 D-18 rule 6): the `sync-queue-cleanup` CronJob (haynes-ops
`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`) must mount NFS `gasha01.haynesnetwork` paths
`/hdd-nfs-repl/data/media/books` read-only at `/data/cephfs-hdd/data/media/books` and
`/hdd-nfs-repl/data/usenet/complete-k8s/lazylibrarian` read-write at the same path under `/data/cephfs-hdd`, and run as
uid/gid 1000. Until then the census logs `queue-cleanup: leftover census off` and records no leftover.

## Ladder log

| Date | Level | Entry |
|---|---|---|
| 2026-08-01 | L0 (pre-ship) | Plan opened; docs landed. Build not yet merged; census not yet running. |
| 2026-08-01 | L0 | S1–S6 merged (hnet #524, Opus-built + coordinator-reviewed), released **v0.95.0** (image signed), deployed via haynes-ops #2324 (`sync-queue-cleanup` CronJob `25 * * * *`); rollout 3/3 on v0.95.0, `/api/health` ok. |
| 2026-08-19 | L0 | **The stuck pile is GROWING and now has a named class the classifier can't see.** Census this date: 196 rows (Sonarr **131** / Radarr 4 / Lidarr 61 — Sonarr was 11 on 08-01). 107 of Sonarr's are one cohort: `T.O.T.S.` singles orphaned `importBlocked` by the series' removal from Sonarr ("release was matched to series by ID" — currently classed `unknown`; a candidate D-03 pattern: orphaned-series items are safe `bad_release`-style removals, they can never import). Context: `.agents/context/2026-08-19-nzb-dupe-loop-incident.md` (the NZB Finder dupe-loop incident that surfaced this — the janitor itself was checked FIRST and exonerated, census-only confirmed). The incident is promotion pressure, not a blocker: an enforcing janitor would have cleared the orphans and surfaced the pile a week earlier. Session was consumed by the incident; L0→L1 spot-check still owed. |
| 2026-08-01 | L0 | **First census (manual Job `janitor-first-census`, 05:38Z): PASSED the verification contract.** 73 rows = the exact live queue (Sonarr 11 / Radarr 3 / Lidarr 59), 0 actions, 0 errors, 96 ms; queue metrics unchanged after the run (Sonarr's 11→12 is a NEW organic grab, not janitor activity). Early classes — Sonarr: 5 `bad_release` + 6 `unknown` (**0 `have_better`** — the owner's expected "already have it" class hasn't appeared yet; the reason strings in tonight's digest will say why); Radarr: 3 `unknown`; Lidarr: 7 `bad_release` + 52 `unknown` (Q-01 as predicted). NEXT: read the digest sections as they accrue, tune the D-03 patterns against the real reason strings (a `fix:` PR), then run the L0→L1 spot-check. |
| 2026-09-23 | L0 | **Dated blocker (standing obligation): the L0→L1 spot-check is still owed.** The janitor has been at L0 since 2026-08-01 (53 days), and the digest's `[janitor: promotion due]` nag has fired since early August (≥ 3 census days at L0, `getQueueCleanupLadder`). Context from issue #556 (a read-only count that day): Sonarr's queue is back to **212** items, with 200 `importBlocked` in the first 200 (Radarr 10, Lidarr 57). The 08-20 orphan removal had cut it to 10, so the pile regrew in about a month. Once `activity-scan` is scheduled (PLAN-048 §Scheduling), the same pile also appears in the nightly digest as about 270 "stuck imports", every night until it clears — more promotion pressure. Not done this session: it was scoped to the #556 app fix, and the spot-check needs the owner, or the coordinator on his behalf, to judge the accumulated `have_better` census rows (≥ 90% correct). |
| 2026-09-25 | L0 | **L0→L1 spot-check DONE (coordinator, on the owner's behalf): criterion MET.** 55 nightly digests carried census data (2026-08-02..09-25; 53 with `promotionDue`), 1,334 hourly census runs, all census (no `arr_queue_cleanup_config` row yet). All **69** distinct Sonarr/Radarr `have_better` items since 08-01 were checked against the live library (target file quality + CF score): **69/69 correct (100%), zero would have deleted anything wanted** (cohorts: Star Wars Visions S01, The Gentlemen S02, Deadliest Catch S01–S03, Lioness.2023 S01 [mis-tagged for the 2021 show; safe but the one risky shape], single episodes of House of the Dragon, The Pitt, 30 for 30, Dark Matter, The Paper, American Dad, Kitchen Nightmares; Radarr The Chronology of Water). Census composition (distinct since 08-01): Sonarr 2,095 unknown / 68 have_better / 17 bad_release / 66 retry_import; Radarr 82/1/0/1; Lidarr 155/0/24/51. **Four prerequisites found and fixed first** (DESIGN-046 D-10, `fix/janitor-l1-prereqs`): removals now pass `skipRedownload=true` (all three *arrs run `autoRedownloadFailed`, so a blocklisting removal re-searched by itself, contradicting D-04); an identity-mismatch message sends a have_better item to `unknown`; the stored reason is the message, not the release name; release-defect patterns (sample, archive) read release-level messages only. **Next:** after the fix deploys, flip Sonarr + Radarr `have_better` to enforce (audited, `setArrQueueCleanupConfig`) and log it here as L1. Pattern candidates for L2: the 129 Sonarr/Radarr "matched to series/movie by ID" unknowns and "Episode file on disk contains more episodes" (48). |
| 2026-09-25 | **L1** | **Promoted to L1 (coordinator, on the owner's behalf, after the 69/69 spot-check and the D-10 prerequisites).** v0.99.0 deployed (haynes-ops #3191); a manual census on the new classifier cut Sonarr `have_better` 17 → 9 (the 8 mis-tagged Lioness.2023 grabs now `unknown`), Radarr 1. Then Sonarr + Radarr `have_better` → **enforce** via `setArrQueueCleanupConfig` (audited `update_app_setting`, actor null = coordinator), ~23:00Z; everything else census; knobs 10/2/6. **First enforcing runs:** 23:25Z Sonarr 9 + Radarr 1, 00:25Z Sonarr 9, 01:25Z Sonarr 7 — all `removed_blocklisted`, 0 errors. **Read-only L1 audit (2026-09-26):** every removal gone from the queue, exactly one blocklist row and one `downloadFailed` each, **no re-grab and no automatic search** (`skipRedownload` works), every target's library file intact and older than the removal. Sonarr's fixed 212 was never truncation: each SABnzbd client shows Sonarr only its newest 60 history entries and `removeCompleted` leaves just the never-imported ones, so every removal slides the window and exposes older leftovers (262 now; the pager read its first second page cleanly at 01:25Z). Follow-ups for L2/L3 in issue #583. **L1 → L2 clock starts: ≥ 7 days with zero bad deletions (earliest 2026-10-02), plus Q-01.** |
| 2026-09-28 | L1 | **L2 prerequisite fixed: one action per download (issue #583 item 1, DESIGN-046 D-11, hnet #608).** A season pack is one queue record per episode; the evaluator now groups records by `downloadId`, sends one call per download and counts the cap per download, and records the other records as covered by that call. A download whose records do not all qualify for the same action is left alone (`skipped_mixed`). A removal answering 404 is `skipped_gone` (observed, not an error; still counts against the cap). A `bad_release` pack is searched once for all its monitored episodes, and retry escalation counts runs, not rows (a pack escalated after one run before). Migration 0082 widens the `action` CHECK. **No config change**, all other cells stay census; L1 is unaffected. Goes live with the next release and deploy; L2 needs this deployed first. Still open in #583: item 2 (the L3 "queues near zero" wording), 3 (the dead Fireman Sam packs), 4 (`includeUnknownSeriesItems`) and 5 (pattern candidates); Q-01 still gates the Lidarr cells. |
| 2026-09-28 | L1 | **Q-01 decided: the Lidarr classification (DESIGN-046 D-12, hnet #611).** Read-only evidence: Lidarr's live queue (62 records: 51 `importFailed`, 9 `importPending`, 2 with no known artist that the census does not read), the album each is for, the download folders of the undecided shapes, the Lidarr census since 08-01 (234 downloads) on a database replica, and the hourly run logs (every run since 09-20 put 56 to 67 Lidarr records in `unknown`). The pile is SABnzbd (58) and qBittorrent (2), not soularr/slskd. **Decision:** Lidarr's match rejections ("Album match is not close enough" 28, "Has missing/unmatched tracks" alone 11, "Couldn't find similar album" 8, "Worst track match" 3, "found multiple artists" 2) become the new class `manual_match`, **report only**: no enforce cell, never acted on, like `unknown`; a `have_better` match carrying one goes there too. the albums of 49 of the 50 such census records have no files and all 50 are monitored, so a removal would delete the only copy of a wanted album that may be the right one in another edition; the one complete album is a wrong grab (a live bootleg for the compilation "1" at 42.1 %), and the score does not separate the two. **Stays `unknown`:** "No files found are eligible for import" (9: six `.wvp` WavPack vinyl rips Lidarr cannot read, two torrents of guitar tabs, one missing folder; the rips are a Lidarr profile question for the owner, issue #610) and Lidarr's `importFailed` "Not an upgrade…" (1: its album has 0 of 21 tracks, so the verdict is about another album's files; `importFailed` stays outside the stuck-import states). **Nothing graduates into an acting class**, so at L2 the Lidarr cells enforce only `bad_release` (failed downloads such as "Duplicate NZB", release defects) and `retry_import` (the empty-message hour after completion). Migration 0083 widens the `action_class` CHECK. **No config change; the level stays L1.** The Q-01 half of the L1 → L2 criterion is met with this merge (the classifier goes live with the next release and deploy); the calendar half (≥ 7 days at L1 with zero bad deletions) is met on 2026-10-02 at the earliest. |

| 2026-09-29 | L1 | **Owner ruling: `manual_match` acts on Lidarr, no waiting period (DESIGN-046 D-13 + D-14, ADR-094, hnet #617).** The owner approved the action by hand twice that day (remove with blocklist and `skipRedownload`, then an album search; about half imported) and ruled it ships and is enabled as soon as deployed; a second ruling: "You can monitor for loops." The coordinator's hand sweep of the same day (74 records: 55 of 66 albums grabbed, 22 imported, 27 stuck again) found **18 albums grabbing a same-titled re-post of the release that had just failed** (Lidarr's blocklist blocks a posting, not a title), so the action now **blocks the failing release name first** (coordinator ruling by default, ADR-094): a whole-name term, which must name the artist, in a janitor-owned Lidarr release profile marked by the sentinel `haynesnetwork-janitor-managed-do-not-edit`, written and read back before the removal; 365-day terms, cap 3,000, hourly drift and expiry upkeep; a name that cannot be blocked safely is `skipped_unblockable`. Then the removal, then one `AlbumSearch` for albums that are monitored and still missing tracks (a record without an album is never searched). **Loop guard:** an album already removed as `manual_match` on 2 earlier downloads, still monitored and missing tracks, is `skipped_loop`; every held download and every target searched on 2+ runs in 7 days is in the nightly digest (subject `[janitor: loop detected]`) and logged `[queue-cleanup] loop_detected`. Migration 0084 (`skipped_loop`, `skipped_unblockable`, `target_id`, the block-term records). **The new cell `modes.lidarr.manual_match` ships census** (a stored config without the key reads as census); the coordinator flips it after the deploy through `setArrQueueCleanupConfig` or the /admin grid's Lidarr toggle. **Ladder note:** the derived L2 now needs this cell enforced too. The stored config read on 2026-09-29 already enforces all nine shared cells (L2), so from this deploy until the cell is flipped the derived level reads L1; enforcing the cell restores L2. |
| 2026-09-29 | **L2** | **Promoted to L2 (coordinator, on the owner's behalf; owner ruling 2026-09-29: no waiting on the calendar criterion).** The L1 → L2 clock (≥ 7 days, earliest 2026-10-02) was waived by the owner; the other criteria stand as evidenced below. **Spot-check evidence.** L1 made 51 removals (Sonarr 50 / Radarr 1) across 88 runs with 0 errors and 0 bad deletions. Live checks: `retry_import` 127/127 correct; Sonarr `bad_release` 3/3 correct after D-10 (the 14 pre-D-10 false positives are gone); Radarr `bad_release` 1/1; Lidarr `bad_release` 26/26; Lidarr `have_better` 0 rows ever, guarded by D-12. None of the blockers in #583 items 3-5 or #597 affects these cells. **The flip.** One audited `setArrQueueCleanupConfig` call (actor null = coordinator, `update_app_setting`), run with tsx from `/sync` in a `haynesnetwork-main` pod at 13:16Z: `sonarr.retry_import`, `sonarr.bad_release`, `radarr.retry_import`, `radarr.bad_release`, `lidarr.retry_import`, `lidarr.bad_release`, `lidarr.have_better` → **enforce** (Sonarr/Radarr `have_better` already enforced); knobs unchanged (cap 10, min age 2 h, retry escalation 6 runs). `manual_match` is report-only and is not part of the config matrix. Read back: all nine cells `enforce`, `getQueueCleanupLadder` reports **level 2**. **First enforcing runs.** 13:25Z: Radarr `bad_release` enforced 1 (Carlos.2010.1080p.BluRay.x264-DEiMOS, `Found archive file, might need to be extracted`, a ~30 GB rar pack): `blocklisted_searched`; Sonarr 0 / Lidarr 0 actions (Sonarr 233, Radarr 3 and Lidarr 1 `unknown`; Lidarr 24 `manual_match`, report-only, `skipped_young`; all census), 0 errors, no cap reached. 14:25Z: 0 actions on all three, 0 errors. No `skipped_*` outcome on any enforced class. **Read-only checks on the Carlos removal.** Gone from Radarr's queue (queue 4 → 3, the three `unknown` importBlocked items untouched); one blocklist row and one `downloadFailed` (`Manually marked as failed`); `MoviesSearch [9747]` ran once. The movie had no file before (`hasFile` false), so no library file was at risk. **Re-grab:** the search then grabbed the same title from another indexer (NZBgeek, 33 GB), which SABnzbd rejected at once as `Duplicate NZB` (`downloadFailed`), and Radarr's own failed-download search grabbed `Carlos.2010.Part.3.FiNAL.MULTi.1080p.WEB.H264-CiELOS` (4.6 GB), which imported at 13:27Z; the movie now has its file. No loop, and the janitor took no further action on it. The same-title/`Duplicate NZB` shape is the one the title-level block being built targets. **Not exercised yet:** the Sonarr and Lidarr enforce cells had nothing to act on in these two runs (the Lidarr album-history check for `bad_release` had no album to check). The next runs that act on them are the ones to audit. **Next:** L2 → L3 needs ≥ 14 days at L2 with the queues near zero and the `unknown` residue characterized (humans set L3 via this plan). |
| 2026-09-29 | `arr` L2 (above); `books` L0, `comics` L0 | **The janitor covers the download suite (owner direction: generic, loops monitored, no calendar waits; ADR-095, DESIGN-046 D-15..D-20, migration 0085).** LazyLibrarian and Kapowarr come in through a source adapter under the same rails and rows. LazyLibrarian: `retry_import` (`forceProcess`, escalating), `bad_release` (the SABnzbd history-job delete that lets LazyLibrarian abort the snatch; SABnzbd only, MAM torrents are `skipped_seeding`), `leftover` (the completed SABnzbd folder of a Processed download, deleted once every library copy is confirmed; needs the mounts above), `fail_loop` (report only: 5+ failed grabs, still Wanted; 60 on the day, the worst 173). Kapowarr: `bad_release` (queue removal with blocklist, then one volume search). The loop guard holds a book format or volume after two janitor removals; `loop_detected` gains `kind: 'fail_loop'`; the digest lists fail loops and one ladder line per family. **Config back-compat:** the stored config of 2026-09-29 (nine shared cells enforced, no `manual_match` key, no suite instance) resolves cell for cell (a test loads it verbatim). **The ladder is per family:** `arr` keeps this plan's ladder and its L2 flip above; since D-13 its derived level also counts `modes.lidarr.manual_match`, which the stored config lacks, so `getQueueCleanupLadder` reads L1 on an image with D-13 until the coordinator enforces that cell, and L2 after. The new `books` and `comics` ladders start at L0 and cannot move it. Every new cell ships census; the coordinator enables them (the command above). Open for the owner: Q-05 (LazyLibrarian could move instead of copy), Q-06 (folders of failed downloads), Q-07 (LazyLibrarian's German-only `reject_audio`). |

## Verification contract (S7 / census)

First-census checks: CronJob completes rc=0; one `queue-cleanup evaluated` JSON log line per
instance with counts; `arr_queue_cleanup_actions` rows ≈ live queue size, all
`mode:'census'`/`action:'none'|'skipped_young'`; zero *arr mutations (queue counts unchanged
by the run); next 21:05 digest email renders the janitor section with the ladder line.
