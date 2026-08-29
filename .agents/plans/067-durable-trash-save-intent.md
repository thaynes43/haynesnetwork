# PLAN-067: Durable Trash save intent — build, backfill, verification

- **ADR:** ADR-086 (Proposed) · **Design:** DESIGN-048
- **Owner:** whoever holds the session — this plan is the tracked owner
- **Ships enforcing, not census-first** (ADR-086 D-9). There is no promotion ladder here, and that
  is deliberate: every action the reconciler takes is protective, idempotent, audited, and
  re-asserts an intent the owner already expressed. ADR-083's ladder governs *destructive*
  automation. **Do not add a ladder to this plan** — withholding protection is the risk-bearing
  direction, and the census channels (D-8 stale tags, D-4 same-key) already carry the observe-only
  reporting that a ladder would otherwise justify.

## The problem (diagnosed 2026-08-29)

A Save writes a Maintainerr exclusion keyed on the Plex ratingKey. A file replacement re-keys the
Plex item; Maintainerr's nightly `removeLeftoverExclusions()` deletes the dangling exclusion and the
save is erased with no error, while a leftover `dnd` tag keeps the wall painting an inert
"protected" check the owner cannot tap. One realised case (**Green Lantern**), re-protected by hand
2026-08-29 and verified off both Maintainerr's pool (437 → 436) and the app's wall snapshot.
Exposure is ongoing: 89–288 file replacements per week.

Evidence: `.agents/context/2026-08-29-trash-save-lapse-incident.md`.

## Status — SHIPPED AND VERIFIED LIVE (v0.96.0, 2026-08-29 19:46 ET)

S1..S9 all complete; full suite green (domain 908, api 534, web 382, sync 131, db 110) plus e2e.
Two build-time deviations from DESIGN-048 are recorded in the design itself: no new
`exclusionVerified` wire field (`protectedByExclusion` already is one), and the client mirror is
pinned by a parity test rather than a re-export (`apps/web/lib/*` cannot import `@hnet/domain`
values without dragging drizzle into the browser bundle).

**Deployed** via haynes-ops #2667 (owner ruled enforcing). Live results matched the pre-deploy
dry-run exactly: 108 open intents (100 movie / 8 tv); Green Lantern seeded on the old key `95267`
and deliberately not corrected (pool-scoped, see below); first tick silent with all four census
counters independently verified 0 in SQL. The reconciler is confirmed to have RUN rather than
been skipped — `trash-batch-sweep` shares the same secret, requires the write bundle, and
succeeded in the same tick.

## Build stages

| # | Stage | Deliverable | Gate |
|---|---|---|---|
| S1 | Schema | migration `0076_trash_save_intents` + journal `idx:75` (DESIGN-048 D-01); partial unique index `one_open_per_item` | `pnpm --filter @hnet/db migrate` clean; a test asserts the journal lists it (a `.sql` absent from `_journal.json` is silently skipped) |
| S2 | Guard | `trash_save_intents`/`trashSaveIntents` **and** the pre-existing `pending_pool_refresh` omission added to `no-direct-state-writes.test.ts` (ADR-086 D-14) | guard test fails on a planted out-of-domain write |
| S3 | Writers | `saveExclusion` upserts the intent on **both** paths incl. `alreadyExcluded`; `removeExclusion` revokes **even with no live exclusion** (ADR-086 D-3) | the D-3 regression test is the gate — without it the reconciler is unstoppable |
| S4 | Backfill | the `0076` one-off: latest event per item, `action='save'`, `reason IN ('user','batch_save')`, `arr_kind != 'lidarr'` | seeds exactly **108** rows on prod-shaped data (97 user + 11 batch_save); zero `watch_guardian` rows admitted |
| S5 | Reconciler | `trash-relink.ts` — detect (SQL, `IS DISTINCT FROM`) → verify live → relink → `schedulePoolRefresh`; `trash_relink_enabled` kill switch (default true) | same-key case writes **nothing** (`sameKeyCensus` only); revoked intents never resurrected |
| S6 | Sync wiring | post-step after `refreshTrashCandidates` **and** `drainDuePoolRefreshes`; `relink`/`relinkError` on `SyncReport` | outage ⇒ `relinkError` set, `totalFailure` stays false; no new mode, no new CronJob |
| S7 | Honest badge | narrow the `||` in `pendingWallGlyph` and `trash-shield.tsx:333-352`; new `exclusionVerified` wire field; tooltip copy | `apps/web/lib/__tests__/trash.test.ts:104-187` revised: tag-only ⇒ `'trash'` **and tappable** |
| S8 | Preview drift | drop the requester branch from `partitionPendingForExpedite`; collapse the three copies onto one shared derivation (ADR-086 D-11) | all three agree on one fixture set; `previewGuardian` behaviour unchanged |
| S9 | E2E | the lapse repro via `STUB_MAINT_RUNNER_ID` + `_stub/exclude`/`remove-pending`/`add-pending`; `purgeDanglingExclusions` added to `maintainerr-stub.ts` | inverted mirror of the existing `trash.spec.ts:404-414` assertion |

**Hard rule: S3 lands before S5 is ever enabled.** The reconciler may be built earlier; it may not
run against real data until un-save can revoke a lapsed intent. Otherwise the owner has no brake.

## Invariants a reviewer must not let regress

1. **No keep-signal changes.** `trash-flow.ts:886`, `trash-batches.ts:414`/`:531`/`:1307` keep
   reading `protectedByTag` untouched. The display reads the **new** field. If a diff changes what
   `shapePendingItems` puts in `protectedByTag`, it is wrong (ADR-086 D-6).
2. **`previewGuardian` stays a mirror of `classifyGuardian`** (ADR-023 C-07b). S8 changes the
   *server* copy to match it, never the reverse.
3. **Relink only on a changed key.** The `IS DISTINCT FROM` clause is the carve-out that stops the
   reconciler fighting a human un-exclusion (ADR-086 D-4). Removing it is a behaviour change
   requiring an owner ruling.
4. **The batch wall's `protected` state is NOT reclassified** (ADR-086 D-7) — it is a keep decision,
   not a claim; making it "honest" would make a kept item deletable.
5. **`watch_guardian` saves never become intents** (ADR-086 D-10).

## Verification (live, after deploy)

- The backfill seeds 108 intents. **Dry-run against production 2026-08-29 returns exactly
  108 (97 `user` + 11 `batch_save`; 100 movie / 8 tv)** — the gate is pre-verified, so a different
  number after deploy means something changed, not that the estimate was loose.
- **Green Lantern backfills with the OLD key `95267`** (verified by the same dry-run) — but it will
  **not** be corrected on the first tick, and that is correct. The hand-repair during the incident
  re-protected it, so it is no longer in any pool, and the reconciler joins **only against pool
  members**. Expect its intent to sit on the stale key indefinitely.

  **This is the reconciler's scope, deliberately: it acts on titles that are actually at risk.** A
  stale key on a non-pooled intent is inert — if that title ever re-enters a pool under a new key,
  the reconciler sees pool key ≠ saved key and self-corrects then, hitting the `alreadyExcluded`
  branch (`relinked = 0`, `alreadyExcluded = 1`) because the exclusion is already in place. Do not
  "fix" this by making the reconciler scan outside the pool: that would re-key intents for titles
  no rule is targeting, spend Maintainerr reads on non-problems, and lose the property that every
  write it makes is protecting something genuinely slated.

  Covered by the `relinks lazily` unit test.
- The wall shows no inert `check` on any item lacking a live exclusion.
- Census counters land in the sync log: `sameKeyCensus`, `staleTagCensus`, `unlinkedSaves`.
  Expected at first run: `staleTagCensus` ≥ 0 (Green Lantern's tag is now backed by a real
  exclusion, so it should NOT appear), `unlinkedSaves` = 0.

## Follow-ups (recorded, not silently dropped)

- **DESIGN-048 Q-01** — whether the stale-tag census graduates to stripping `dnd` tags. Deliberately
  unasked: the premise is unverified (one known case), and an owner question built on an unchecked
  inference wastes his attention. Ask once the census has real counts.
- **DESIGN-048 Q-02** — whether a relink notifies. Leaning ledger-only; the analogous ADR-084
  Pushover audit notifications were **rejected** by the owner on 2026-08-20.
- **ADR-035 C-06 discrepancy (observed, not fixed here):** the ADR claims the wall renders during a
  Maintainerr outage from the stale snapshot, but `listTrashPendingPage` calls `fetchLiveExclusions`
  unconditionally and that fails closed (`guardMaintainerrCall` throws), so the paginated wall
  errors instead. Pre-existing, orthogonal to this plan, and worth its own small change — recorded
  so it is not rediscovered a third time.
