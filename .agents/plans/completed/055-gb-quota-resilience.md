# PLAN-055: Google Books quota resilience — the shared breaker + retryable book Fixes

- **Status:** Completed (v0.68.0 live; retry pass rides goodreads-sync hourly; the two owner Fix Failed rows auto-retry after the 07:00 UTC GB reset). Was: BUILT (see the bottom of this file). Docs: ADR-067 (Accepted) / DESIGN-039 /
  PRD R-218..R-220 / DDD T-191..T-193.
- **Depends on:** PLAN-041 (books Fix — the lifecycle this extends), PLAN-044 (GB client +
  goodreads-sync — the host run), PLAN-050 (format pairing — whose documented residual this
  closes).
- **Parallel-track protocol:** a sibling branch holds migration 0056 / journal idx 55,
  PRD R-215..R-217, and glossary T-187..T-189 — this track takes 0057 / idx 56, R-218.., and
  T-191.. and leaves the gaps deliberately; the coordinator reconciles at merge.

## The incident (owner live-tested 2026-07-16 ~20:00 UTC)

The books "Fix this" button hard-failed within SECONDS on two single-format titles
("Dead Ever After", "Whispers"): neither books item carried an `ll_book_id` seed, so the
fallback `gb.resolveVolume` hit the EXHAUSTED Google Books DAILY quota (429). The fix rows
honestly recorded the 429 (`actions_taken` step `failed`) — correct plumbing, terrible UX for
a transient condition that resolves itself at 07:00 UTC. Meanwhile the estate burns the dead
quota all day: goodreads-sync retries enrichment hourly against a quota that cannot return
before the reset (dozens of doomed 429s per run, each ×4 with the per-attempt retry loop),
and the format-pairing mint burns its 25-attempt cap on guaranteed-to-429 resolves — the
documented PLAN-050 residual.

## Decisions (ADR-067)

1. **One shared memory:** single-row `gb_quota_state` (the `mam_gate_state` class — unaudited
   rebuildable state, guard-listed in all six regex families, single-writer in
   `packages/domain/src/gb-quota-breaker.ts`). Migration 0057, journal idx 56.
2. **Classification:** daily 429 ("per day" in the body) ⇒ open until the NEXT 07:00 UTC
   (`GB_DAILY_RESET_UTC_HOUR`, env-tunable — the PST-winter knob); per-minute / unhinted 429
   ⇒ now + 2 min. Any completed GB call clears. Non-429 errors never touch the breaker.
3. **Half-open:** one consumer probes after expiry — `consultGbQuotaGate` claims the probe
   atomically (extends the window by the 2-min claim while it runs); success clears, a fresh
   429 re-trips.
4. **The seam:** `guardedGbResolve` in `packages/domain` wraps the injected (dumb, DB-free)
   GB resolver at every domain call site — outcome union
   `resolved | no_match | quota_blocked | quota_tripped`; non-429 rethrows. The only
   `packages/goodreads` change: the per-attempt retry loop stops retrying a daily-quota 429.
5. **book-fix:** breaker open / resolve 429 ⇒ the fix lands the NEW OPEN status `queued`
   (BOOK_FIX_STATUSES + status CHECK rebuild; dedupe holds) with an `actions_taken` step;
   copy per owner tone (no em-dashes, no jargon). `retryQueuedBookFixes` (oldest-first,
   10/run, breaker-honoring, hosted in the goodreads-sync run) completes queued fixes through
   the NORMAL chain; permanent failures still land `failed`.
6. **goodreads-sync enrichment:** gate peeked per run; open ⇒ ZERO GB calls + ONE log line +
   `skippedEnrichment` count; a mid-run trip flips the same skip for the remainder.
7. **format-pairing mint:** breaker open ⇒ GB-requiring attempts skip WITHOUT consuming the
   cap and WITHOUT advancing the want's `updated_at` (the retry-recency key);
   llBookId-reusing mints proceed. Closes the PLAN-050 residual.

## Build checklist

- [x] Docs: ADR-067 (Accepted), DESIGN-039, PRD R-218..R-220, glossary T-191..T-193.
- [x] Migration 0057 (idx 56): `gb_quota_state` + the `book_fix_requests` status CHECK
      rebuild admitting `queued`; Drizzle schema + exports; migration-block tests.
- [x] `gb-quota-breaker.ts` (classify / reset math / trip / clear / consult+probe / peek /
      `guardedGbResolve`); guard-listed in all six families.
- [x] book-fix: `queued` flow in `runBookFixRequest`; `OPEN_BOOK_FIX_STATUSES` +
      `recordBookFixAction` widened; `retryQueuedBookFixes`.
- [x] goodreads-sync: enrichment gate + one-line skip + `skippedEnrichment`; the retry pass
      wired after the integration loop (`fixRetries` on the report).
- [x] format-pairing: cap-preserving quota skip (`skippedQuota` on the report).
- [x] `packages/goodreads` http.ts: no retry on a daily-quota 429.
- [x] UI: queued PhaseChip in the book-fix dialog slot (owner tone). `/admin/fixes` is
      *arr-only (book fixes have no admin listing surface — pre-existing honest gap,
      unchanged; DESIGN-039 D-08).
- [x] Tests: breaker trip/expiry/half-open + classification; fix→queued + retry-pass
      end-to-end vs the LL stub; enrichment skip (one log, zero GB calls); pairing cap not
      burned; migration block; guard families.

## Residuals / deferred

- DESIGN-039 Q-01: an admin surface for the breaker state (chip on /admin or Integrations
  stats). Deferred.
- DESIGN-039 Q-02: a stale-`queued` sweep if goodreads-sync ever stops running. Deferred
  (the ADR-062 timeout-horizon idiom is the shape).
- `bookFix.adminList` remains unconsumed by any admin page (pre-existing).

## BUILT

2026-07-16 — all checklist items landed on `feat/plan-055-gb-resilience` (local commits,
not pushed). Local gate: `lint` (0 errors; pre-existing unused-import warnings only),
`typecheck`, `lint:css`, `test` (all packages green — two UNRELATED embedded-PG boot-hook
flakes on the first full run [domain arr-add-flow, api metrics/one sibling] each passed on
the sanctioned single rerun), `build` — five green. Owner follow-ups: none required at
deploy — the breaker seeds itself on first trip (no seed row needed); haynes-ops needs only
the usual image bump (the retry pass rides the existing sync-goodreads CronJob).
