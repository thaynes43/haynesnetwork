# DESIGN-039: Google Books quota resilience — the shared breaker + retryable book Fixes

- **Status:** Draft
- **Last updated:** 2026-07-16
- **Satisfies:** PRD-001 R-218..R-220; governed by ADR-067 (the breaker + queued fixes),
  ADR-055 (GB client boundary), ADR-062 (books Fix contract), ADR-065 (pairing mint cap),
  hard rules 1/6 (state-table discipline), 8/9 (UI confirm/reflow).
- **Companions:** DESIGN-033 (books Fix — the lifecycle this extends), DESIGN-036 (format
  pairing — the mint pass this hardens), DESIGN-028 (goodreads-sync — the run that hosts the
  retry pass).

## Overview

One Google Books key, three consumers, zero shared memory — the 2026-07-16 incident (a user
Fix hard-failing in seconds against an exhausted daily quota) plus the all-day 429 burn.
This design adds a single-row `gb_quota_state` circuit breaker written only by
`packages/domain`, consulted by every GB call site through one `guardedGbResolve` seam;
a `queued` books-Fix status with an automatic retry pass hosted in the goodreads-sync run;
a one-line enrichment skip; and a mint pass that stops burning its cap on doomed resolves.

## Detailed design

### D-01 — Schema (migration 0057, journal idx 56)

`gb_quota_state`: `id text PK DEFAULT 'gb'` + `CHECK (id = 'gb')` (the `mam_gate_state`
singleton idiom), `exhausted_until timestamptz NULL` (open ⇔ non-null and in the future),
`tripped_at timestamptz`, `trip_reason text` (`daily` / `minute` + the redacted detail),
`updated_at`. Unaudited rebuildable operational state — guard-listed in all six
no-direct-state-writes regex families (SQL INSERT/UPDATE/DELETE + Drizzle
`.insert/.update/.delete`), written only by `packages/domain/src/gb-quota-breaker.ts`.

The same migration rebuilds `book_fix_requests_status_enum` to admit `queued`
(`BOOK_FIX_STATUSES = ['pending','queued','search_triggered','failed','completed']`).

**Numbering note:** a parallel track holds migration 0056 / journal idx 55 (and PRD
R-215..R-217 / glossary T-187..T-189) on its own branch — this track takes 0057 / idx 56 and
starts its PRD rows at R-218 and glossary at T-191, leaving the gaps deliberately; the
coordinator reconciles at merge (the established two-track protocol).

### D-02 — The breaker single-writer (`packages/domain/src/gb-quota-breaker.ts`)

- `classifyGb429(error): 'daily' | 'minute' | null` — structural (no `@hnet/goodreads`
  dependency): an error object with `status === 429` classifies by body/message text
  (`/per day|daily/i` ⇒ `daily`; any other 429 ⇒ `minute`, the conservative short trip);
  anything else ⇒ `null` (not the breaker's business).
- `nextGbDailyReset(now): Date` — the next `GB_DAILY_RESET_UTC_HOUR` (default 07:00 UTC,
  env-tunable) strictly after `now`.
- `tripGbQuotaBreaker({ db, kind, detail?, now? }): Promise<Date>` — upserts the singleton:
  `daily` ⇒ `exhausted_until = nextGbDailyReset(now)`; `minute` ⇒ `now + GB_MINUTE_TRIP_MS`
  (2 min). Returns the new `exhausted_until`.
- `clearGbQuotaBreaker({ db, now? })` — any completed GB call clears (`exhausted_until`,
  `tripped_at`, `trip_reason` → NULL). Cheap no-op when already clear.
- `consultGbQuotaGate({ db, now? })` → `{ state: 'closed' } | { state: 'open'; until; reason }
  | { state: 'probe'; until }` — the write-capable gate: a row whose `exhausted_until` has
  PASSED is claimed atomically (row lock; `exhausted_until` extended by the 2-minute claim
  window) so exactly ONE consumer probes half-open while the rest stay blocked (ADR-067 C-03).
- `peekGbQuotaGate({ db, now? })` → `{ open, until, reason }` — the read-only run-level check
  (never claims the probe; used for the one-line skip decision).

No outbox/audit rows (ADR-067 C-09) — the trail is the state row + logs.

### D-03 — The seam: `guardedGbResolve`

```ts
guardedGbResolve<T extends { volumeId: string }>(input: {
  db?: DbClient;
  gb: { resolveVolume(q: { isbn?: string | null; title: string; author?: string | null }): Promise<T | null> };
  query: { isbn?: string | null; title: string; author?: string | null };
  now?: Date;
}): Promise<
  | { outcome: 'resolved'; volume: T }
  | { outcome: 'no_match' }
  | { outcome: 'quota_blocked'; until: Date; reason: string | null }
  | { outcome: 'quota_tripped'; until: Date; kind: 'daily' | 'minute' }
>
```

Gate consult → (open ⇒ `quota_blocked`, no call) → `resolveVolume` → success/no-match clears
the breaker; a 429 trips it (`quota_tripped`); any non-429 error RETHROWS untouched (the
caller keeps its existing honest-failure semantics). Generic over the resolver's volume shape
so the enrichment `GbVolume`, the pairing `{ volumeId }`, and the fix `{ volumeId }` all ride
the same helper. The GB client stays dumb; the only `packages/goodreads` change is D-10.

### D-04 — Books Fix: the `queued` state

`runBookFixRequest`'s LL leg replaces the raw `gb.resolveVolume` fallback with
`guardedGbResolve`. `quota_blocked` / `quota_tripped` ⇒ `recordBookFixAction` lands the fix
**`queued`** with a step `{ step: 'queued', reason: 'gb_quota', kind?, retryAfter }` and the
orchestrator returns `{ status: 'queued' }` — never `failed` for quota weather. `no_match`
keeps the existing honest `BookFixUnroutableError → failed`. `queued` joins
`OPEN_BOOK_FIX_STATUSES` (dedupe holds: no second fix on a queued item) and
`recordBookFixAction`'s status union.

### D-05 — The retry pass (`retryQueuedBookFixes`, hosted in the goodreads-sync run)

`packages/domain` export; `runGoodreadsSync` calls it after the per-integration loop (that
run already holds the GB client + the confined LL bundle — no new CronJob, no new wiring).
Contract: select `status='queued'` fixes oldest-first (`created_at ASC`), cap
`BOOK_FIX_RETRY_CAP_PER_RUN` (10, env-tunable); skip everything with one log line when the
gate peeks open; per fix, `guardedGbResolve` → on resolve continue the NORMAL ADR-062 chain
(`addBook → queueBook(format) → searchBook(format)` → `search_triggered`), appending
`actions_taken` steps to the existing trail; a mid-pass `quota_blocked/tripped` stops the
pass (remaining fixes stay `queued` — no churn); a GB no-match, a non-429 resolve error, or
an LL step error lands `failed` honestly. Paced by the 250ms politeness pacer. Report:
`{ queued, attempted, completed, failed, skippedQuota }` surfaced on the
`GoodreadsSyncReport` as `fixRetries`.

### D-06 — goodreads-sync enrichment skip

`runGoodreadsSync` peeks the gate once per run: open ⇒ ONE log line
(`goodreads-sync: GB quota exhausted — enrichment skipped this run` + until/reason) and every
item enriches as `gbVolumeId: null` (the existing text-marker comic fallback still applies),
counted as `skippedEnrichment` on the report. Gate closed ⇒ items enrich through
`guardedGbResolve`; the FIRST `quota_blocked/tripped` outcome logs one line and flips the
run-local skip for the remainder. Non-429 enrichment errors keep today's per-item error log +
null degradation.

### D-07 — format-pairing mint: cap preservation

`mintPairingWants` stops pre-slicing the worklist: it walks the full ordered candidate list
(fresh oldest-first, then retries least-recently-tried), counting only REAL attempts against
the cap. A candidate whose LL identity needs GB (no existing-want id, no goodreads-reuse id)
while the breaker is open (run-local flag, set by the first `quota_blocked/tripped` outcome)
is skipped WITHOUT: consuming the cap, upserting the want (so `updated_at` — the
retry-recency key — does not advance), or logging per-item errors; it is counted as
`skippedQuota` on the report. Identity-holding candidates proceed normally. A GB no-match or
a non-429 resolve error keeps today's semantics (an honest unmintable ATTEMPT — cap
consumed). The first GB-needing candidate of a run IS the half-open probe when the window has
expired (D-02). Closes the PLAN-050 residual (ADR-067 C-08).

### D-08 — UI

`book-fix-dialog.tsx`'s post-submit reserved slot (ADR-015 — recolor, never reflow) gains the
`queued` phase: PhaseChip tone `info`, label/copy per owner tone (no em-dashes, no jargon) —
"Fix queued. It will run by itself." with the title text "The book lookup is at its daily
limit. Your fix is saved and runs automatically when the limit resets. Nothing else to do."
`/admin/fixes` lists only the *arr `fix_requests` statuses — book fixes have no admin listing
surface yet (`bookFix.adminList` exists unconsumed; an honest gap, unchanged by this design),
so no status-filter change lands there. `queued` flows through the existing `bookFix` wire
(`fixWire` passes `status` verbatim).

### D-09 — Test strategy

Domain: breaker trip (daily → next 07:00 UTC; minute → +2 min) / clear-on-success / expiry /
single-probe half-open under two consecutive consults; `classifyGb429` daily-vs-minute-vs-null;
`guardedGbResolve` outcome matrix (open ⇒ no call; 429 ⇒ trip persisted; non-429 rethrown +
state untouched). Fix: breaker-open create lands `queued` (zero LL calls, step recorded, dedupe
still blocks); resolve-429 lands `queued`; `retryQueuedBookFixes` completes a queued fix
end-to-end against the LL stub bundle (chain order + `search_triggered` + appended steps),
honors an open breaker (attempted 0), fails a no-match honestly, respects oldest-first + cap.
Pairing: an open breaker skips GB-needing candidates without cap consumption or want upsert
while reuse-mints still push; a mid-run trip stops further GB calls. Sync: an open-breaker
`runGoodreadsSync` makes ZERO GB calls, logs ONE skip line, reports `skippedEnrichment`, and
its retry pass completes a seeded queued fix when the gate is closed. DB: migration block —
`gb_quota_state` columns + singleton CHECK (default row inserts; `id <> 'gb'` rejected) + the
rebuilt status CHECK admits `queued` and still rejects garbage. Guard: the six regex families
cover `gb_quota_state`/`gbQuotaState`.

## Alternatives considered

In-process breaker (rejected — three separate processes share the quota); failing quota-blocked
fixes with friendlier copy (rejected — still a dead end); blocking fix CREATION while open
(rejected — loses the audited intent); a dedicated retry CronJob (rejected — the goodreads-sync
run already holds every dependency); notifying on trip (rejected v1 — routine daily weather,
ADR-067 C-09).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Surface breaker state to admins (a chip on /admin or the Integrations stats page)? | OPEN — deferred; the state row + logs suffice for v1. |
| Q-02 | A stale-`queued` sweep (a fix queued for days because goodreads-sync stopped running)? | OPEN — deferred; the ADR-062 timeout-horizon idiom is the shape if needed. |
| Q-03 | Winter clock: the daily reset is 08:00 UTC under PST. | Mitigated — `GB_DAILY_RESET_UTC_HOUR` env knob; worst case the half-open probe re-trips once at 07:00. |
