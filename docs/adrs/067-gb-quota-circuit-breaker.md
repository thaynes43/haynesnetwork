# ADR-067: Shared Google Books quota circuit breaker + retryable book Fixes

- **Status:** Accepted (plan-loop authority per PLAN-055; incident-driven, owner live-tested
  2026-07-16 ~20:00 UTC)
- **Date:** 2026-07-16
- **Deciders:** Tom Haynes (incident report + owner tone rules), PLAN-055 build
- **Builds on / refines:** ADR-055 (the `@hnet/goodreads` GB client + mandatory per-attempt
  retry/backoff — STANDS; this ADR adds a cross-run breaker ABOVE it) · ADR-062 (books Fix — the
  `pending → search_triggered → completed | failed` lifecycle GROWS a `queued` state; C-05
  crash-safety and C-01 confinement untouched) · ADR-065 (format pairing — the C-06 mint cap
  stops being burned on doomed GB resolves, the documented PLAN-050 residual) · ADR-054/040
  (the `mam_gate_state`/`smart_drive_state` single-row unaudited state-table class this reuses).

## Context and problem statement

Google Books is the estate's ONE external book-identity resolver: goodreads-sync enrichment,
the format-pairing mint, and the books Fix GB fallback all call `resolveVolume`. Its API key has
a hard DAILY quota that resets at 07:00 UTC (Google's Pacific-midnight reset, owner-observed),
plus a per-minute burst quota. Today each caller discovers exhaustion independently, per call,
and none remembers:

- **The incident (2026-07-16 ~20:00 UTC):** the owner's "Fix this" on two single-format titles
  ("Dead Ever After", "Whispers") hard-failed within seconds. Neither books item had an
  `ll_book_id` seed, so `runBookFixRequest` fell back to `gb.resolveVolume` against the
  EXHAUSTED daily quota (429). The fix rows honestly recorded the 429 (`actions_taken` step
  `failed`) — correct plumbing, terrible UX for a *transient, self-resolving* condition.
- **The all-day burn:** goodreads-sync retries enrichment hourly against a quota that cannot
  return before 07:00 UTC — dozens of doomed 429s (each ×4 with the per-attempt retry loop)
  logged as errors every run.
- **The PLAN-050 residual:** the format-pairing mint spends its 25-attempt per-run cap on
  GB resolves that are guaranteed to 429, so the pairing backlog stops draining for the rest
  of the quota day even for work that needs no GB call.

A 429 against a quota with a KNOWN reset time is not an error to fail on — it is a state to
remember and wait out.

## Decision drivers

1. One shared memory: three consumers, one quota — the breaker must be consulted through one
   seam, not re-implemented per caller.
2. `packages/goodreads` stays dumb (no DB dependency) — ADR-055's client boundary holds; the
   breaker wraps at the DOMAIN call sites.
3. A user-facing Fix must never hard-fail on a transient condition the system can retry itself
   (the ADR-007/062 never-stuck spirit) — but PERMANENT failures must still fail honestly.
4. The state is rebuildable operational bookkeeping, not an audit subject — the
   `mam_gate_state` class (single row, unaudited, guard-listed, single-writer).
5. Compliance surface unchanged: no new external write, no governor interaction — GB is
   read-only enrichment.

## Considered options

**Where the breaker lives:** (a) inside the `@hnet/goodreads` client — rejected: the client
has no DB and must stay injectable/offline-testable; (b) in-process memory per runner —
rejected: the web app, the goodreads-sync CronJob, and the format-pairing CronJob are separate
processes; an in-memory breaker forgets exactly when it matters; **(c) CHOSEN — a single-row
`gb_quota_state` table written only by `packages/domain`, consulted via one `guardedGbResolve`
helper wrapping the injected resolver at every domain call site.**

**What a quota-blocked Fix does:** (a) fail with a friendlier message — rejected: still a dead
end the user must remember to retry; (b) block creation up front — rejected: loses the audited
intent; **(c) CHOSEN — the fix lands in a new `queued` status and a capped retry pass completes
it automatically once the quota returns.**

## Decision outcome

- **C-01** New single-row **`gb_quota_state`** table (migration 0057, journal idx 56):
  `id CHECK (id='gb')`, `exhausted_until timestamptz NULL`, `tripped_at`, `trip_reason`,
  `updated_at`. The `mam_gate_state` class: unaudited rebuildable operational state,
  guard-listed in ALL SIX no-direct-state-writes regex families, written ONLY by the
  `packages/domain` `gb-quota-breaker.ts` single-writers.
- **C-02** Trip classification (from the 429 body Google returns): a DAILY-quota 429
  (`per day` in the body/message) opens the breaker until the NEXT 07:00 UTC
  (`GB_DAILY_RESET_UTC_HOUR`, env-tunable); a PER-MINUTE 429 (or a 429 with no hint —
  conservative) opens it for 2 minutes (`GB_MINUTE_TRIP_MS`). Any completed GB call (a match
  OR an honest no-match) CLEARS the breaker. Non-429 errors never touch it.
- **C-03** Half-open semantics: after `exhausted_until` passes, ONE consumer may probe —
  `consultGbQuotaGate` atomically claims the probe (extending the window by the 2-minute claim
  so concurrent consumers stay blocked while it runs); the probe's success clears, a fresh 429
  re-trips. No thundering herd at reset time.
- **C-04** The seam: **`guardedGbResolve`** (`packages/domain`) wraps the injected resolver —
  gate consult → call → clear-on-success / trip-on-429 — returning a typed outcome union
  (`resolved | no_match | quota_blocked | quota_tripped`). All three consumers go through it;
  the GB client itself stays dumb. One client-side refinement rides along: the ADR-055
  per-attempt retry loop stops retrying a 429 whose body says `per day` (retrying a daily
  quota is pointless by definition) — a body-text check, still no DB in `packages/goodreads`.
- **C-05** Books Fix: `BOOK_FIX_STATUSES` grows **`queued`** (status CHECK rebuilt in 0057).
  When the breaker is open or the fallback resolve trips it, the fix does NOT fail: it lands
  `queued` with an `actions_taken` step recording why (`gb_quota`, the retry-after stamp).
  `queued` is an OPEN status — the one-open-per-(item, kind) dedupe still holds. Modal/done
  copy per owner tone (no em-dashes, no jargon): the fix is saved and fires automatically.
- **C-06** The retry pass **`retryQueuedBookFixes`** completes queued fixes: hosted in the
  goodreads-sync run (it already holds the GB client + the confined LL bundle) — oldest-first,
  capped at 10/run (`BOOK_FIX_RETRY_CAP_PER_RUN`, env-tunable), honors the breaker (an open
  gate skips the pass; a mid-pass trip stops it), and on a successful resolve continues the
  NORMAL ADR-062 chain (resolve → addBook → queueBook → searchBook → `search_triggered`) with
  `actions_taken` appended. Permanent failures (a GB no-match, a non-429 error, an LL step
  error) still land `failed` honestly — `queued` is for quota weather only.
- **C-07** goodreads-sync enrichment consults the breaker: when open, the run makes ZERO GB
  calls, logs ONE line, and reports the skipped items as `skippedEnrichment` (items still
  mirror with `gbVolumeId: null` + the text-marker comic fallback — the existing honest
  degradation). A mid-run trip flips the same skip for the rest of the run.
- **C-08** format-pairing mint: when the breaker is open (or trips mid-run), GB-REQUIRING
  attempts are skipped WITHOUT consuming the mint cap and WITHOUT touching the want row (no
  upsert — `updated_at` is the retry-recency key and must not advance on a non-attempt);
  llBookId-REUSING mints proceed and consume cap normally. **This closes the PLAN-050
  residual** (ADR-065 C-06's cap was documented as burnable on doomed resolves).
- **C-09** No notification/outbox row on a trip (unlike `mam_gate_state`'s transitions): quota
  exhaustion is routine daily weather, self-healing by construction; its trail is the state row
  + the one-line logs + the queued-fix `actions_taken` steps. A Bulletin/admin surface for the
  breaker is deferred (DESIGN-039 Q-01).

### Consequences

| ID | Consequence |
|----|-------------|
| C-a | Good: a quota-day Fix queues and self-completes — the incident class disappears for users. |
| C-b | Good: one 429 per quota episode instead of dozens per hour; logs say one honest line. |
| C-c | Good: the pairing backlog keeps draining on quota days (reuse-mints proceed; cap preserved). |
| C-d | Bad/accepted: a queued fix waits up to the quota reset + the next goodreads-sync run (hours) — slower than a lucky manual retry, but automatic and honest. |
| C-e | Bad/accepted: the breaker is estate-global (one key, one row) — a per-key generalization is speculative until a second key exists. |
| C-f | Neutral: `queued` fixes have no timeout horizon in v1 — the retry pass fails them honestly on permanent errors; a stale-queued sweep is deferred with Q-02. |

## More information

PRD R-218..R-220 (R-215..R-217 are held by a parallel track — see DESIGN-039 D-01 note).
Glossary T-191..T-193 (T-187..T-189 held by the same parallel track). Realized by DESIGN-039;
PLAN-055 (`.agents/plans/055-gb-quota-resilience.md` records the incident + decisions).
Google's daily quota resets at midnight Pacific — 07:00 UTC in DST (owner-observed); the hour
is env-tunable (`GB_DAILY_RESET_UTC_HOUR`) for the PST winter case.
