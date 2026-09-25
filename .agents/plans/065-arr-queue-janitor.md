# PLAN-065: Arr queue janitor — build, census, promotion ladder

- **Status:** 🟢 CENSUS LIVE (2026-08-01, v0.95.0) — S1–S7 all complete same-session; the plan
  stays open as the ladder's book of record until L3. Resume point: §Ladder log below.
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

## Ladder log

| Date | Level | Entry |
|---|---|---|
| 2026-08-01 | L0 (pre-ship) | Plan opened; docs landed. Build not yet merged; census not yet running. |
| 2026-08-01 | L0 | S1–S6 merged (hnet #524, Opus-built + coordinator-reviewed), released **v0.95.0** (image signed), deployed via haynes-ops #2324 (`sync-queue-cleanup` CronJob `25 * * * *`); rollout 3/3 on v0.95.0, `/api/health` ok. |
| 2026-08-19 | L0 | **The stuck pile is GROWING and now has a named class the classifier can't see.** Census this date: 196 rows (Sonarr **131** / Radarr 4 / Lidarr 61 — Sonarr was 11 on 08-01). 107 of Sonarr's are one cohort: `T.O.T.S.` singles orphaned `importBlocked` by the series' removal from Sonarr ("release was matched to series by ID" — currently classed `unknown`; a candidate D-03 pattern: orphaned-series items are safe `bad_release`-style removals, they can never import). Context: `.agents/context/2026-08-19-nzb-dupe-loop-incident.md` (the NZB Finder dupe-loop incident that surfaced this — the janitor itself was checked FIRST and exonerated, census-only confirmed). The incident is promotion pressure, not a blocker: an enforcing janitor would have cleared the orphans and surfaced the pile a week earlier. Session was consumed by the incident; L0→L1 spot-check still owed. |
| 2026-08-01 | L0 | **First census (manual Job `janitor-first-census`, 05:38Z): PASSED the verification contract.** 73 rows = the exact live queue (Sonarr 11 / Radarr 3 / Lidarr 59), 0 actions, 0 errors, 96 ms; queue metrics unchanged after the run (Sonarr's 11→12 is a NEW organic grab, not janitor activity). Early classes — Sonarr: 5 `bad_release` + 6 `unknown` (**0 `have_better`** — the owner's expected "already have it" class hasn't appeared yet; the reason strings in tonight's digest will say why); Radarr: 3 `unknown`; Lidarr: 7 `bad_release` + 52 `unknown` (Q-01 as predicted). NEXT: read the digest sections as they accrue, tune the D-03 patterns against the real reason strings (a `fix:` PR), then run the L0→L1 spot-check. |
| 2026-09-23 | L0 | **Dated blocker (standing obligation): the L0→L1 spot-check is still owed.** The janitor has been at L0 since 2026-08-01 (53 days), and the digest's `[janitor: promotion due]` nag has fired since early August (≥ 3 census days at L0, `getQueueCleanupLadder`). Context from issue #556 (a read-only count that day): Sonarr's queue is back to **212** items, with 200 `importBlocked` in the first 200 (Radarr 10, Lidarr 57). The 08-20 orphan removal had cut it to 10, so the pile regrew in about a month. Once `activity-scan` is scheduled (PLAN-048 §Scheduling), the same pile also appears in the nightly digest as about 270 "stuck imports", every night until it clears — more promotion pressure. Not done this session: it was scoped to the #556 app fix, and the spot-check needs the owner, or the coordinator on his behalf, to judge the accumulated `have_better` census rows (≥ 90% correct). |
| 2026-09-25 | L0 | **L0→L1 spot-check DONE (coordinator, on the owner's behalf): criterion MET.** 55 nightly digests carried census data (2026-08-02..09-25; 53 with `promotionDue`), 1,334 hourly census runs, all census (no `arr_queue_cleanup_config` row yet). All **69** distinct Sonarr/Radarr `have_better` items since 08-01 were checked against the live library (target file quality + CF score): **69/69 correct (100%), zero would have deleted anything wanted** (cohorts: Star Wars Visions S01, The Gentlemen S02, Deadliest Catch S01–S03, Lioness.2023 S01 [mis-tagged for the 2021 show; safe but the one risky shape], single episodes of House of the Dragon, The Pitt, 30 for 30, Dark Matter, The Paper, American Dad, Kitchen Nightmares; Radarr The Chronology of Water). Census composition (distinct since 08-01): Sonarr 2,095 unknown / 68 have_better / 17 bad_release / 66 retry_import; Radarr 82/1/0/1; Lidarr 155/0/24/51. **Four prerequisites found and fixed first** (DESIGN-046 D-10, `fix/janitor-l1-prereqs`): removals now pass `skipRedownload=true` (all three *arrs run `autoRedownloadFailed`, so a blocklisting removal re-searched by itself, contradicting D-04); an identity-mismatch message sends a have_better item to `unknown`; the stored reason is the message, not the release name; release-defect patterns (sample, archive) read release-level messages only. **Next:** after the fix deploys, flip Sonarr + Radarr `have_better` to enforce (audited, `setArrQueueCleanupConfig`) and log it here as L1. Pattern candidates for L2: the 129 Sonarr/Radarr "matched to series/movie by ID" unknowns and "Episode file on disk contains more episodes" (48). |

## Verification contract (S7 / census)

First-census checks: CronJob completes rc=0; one `queue-cleanup evaluated` JSON log line per
instance with counts; `arr_queue_cleanup_actions` rows ≈ live queue size, all
`mode:'census'`/`action:'none'|'skipped_young'`; zero *arr mutations (queue counts unchanged
by the run); next 21:05 digest email renders the janitor section with the ladder line.
