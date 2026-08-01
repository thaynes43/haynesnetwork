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
| 2026-08-01 | L0 | **First census (manual Job `janitor-first-census`, 05:38Z): PASSED the verification contract.** 73 rows = the exact live queue (Sonarr 11 / Radarr 3 / Lidarr 59), 0 actions, 0 errors, 96 ms; queue metrics unchanged after the run (Sonarr's 11→12 is a NEW organic grab, not janitor activity). Early classes — Sonarr: 5 `bad_release` + 6 `unknown` (**0 `have_better`** — the owner's expected "already have it" class hasn't appeared yet; the reason strings in tonight's digest will say why); Radarr: 3 `unknown`; Lidarr: 7 `bad_release` + 52 `unknown` (Q-01 as predicted). NEXT: read the digest sections as they accrue, tune the D-03 patterns against the real reason strings (a `fix:` PR), then run the L0→L1 spot-check. |

## Verification contract (S7 / census)

First-census checks: CronJob completes rc=0; one `queue-cleanup evaluated` JSON log line per
instance with counts; `arr_queue_cleanup_actions` rows ≈ live queue size, all
`mode:'census'`/`action:'none'|'skipped_young'`; zero *arr mutations (queue counts unchanged
by the run); next 21:05 digest email renders the janitor section with the ladder line.
