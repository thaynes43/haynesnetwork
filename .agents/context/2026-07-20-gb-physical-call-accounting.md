# 2026-07-20 — the GB call budget counted LOGICAL queries, not PHYSICAL requests

Branch `fix/gb-physical-call-accounting`. The first genuinely-budgeted day on the app's own dedicated
Google Books (GB) key still tripped the daily breaker — far below the 700/200/100 = 1,000 budget. Root
cause: the budgeter counted logical GB queries, but Google meters every PHYSICAL HTTP request, including
retries, so physical ≈ 2× counted. Fix: count physical requests (retries included) + a reserve-before-commit
gate for the small overshoot. This note records the trip evidence, the ratio, the external-draw verdict,
and the change.

## The trip (read-only cluster evidence)

- Dedicated-key split (#2159) live: LazyLibrarian (`downloads`) and Libretto (`media`) restarted
  2026-07-19 ~22:19 UTC onto their own ExternalSecrets; the app owns its own ~1,000/day key (GCP-verified).
- Morning held (verified ~12:44 UTC): breaker clear, pairing minting 24–25/run, 265/700 spent; goodreads
  201/200 then clean `skippedBudget`.
- **13:32:17 UTC** a format-pairing resolve run (pod `…-format-pairing-29742572-hfwxb`) hit a REAL
  daily-signature 429 and tripped the breaker:
  - `gb_quota_state`: `exhausted_until` = 2026-07-21T07:00Z, `tripped_at` = 2026-07-20T13:32:17Z,
    `trip_reason` = `daily: GET …/volumes?q=isbn:9780141328034… → HTTP 429 "Quota exceeded for quota metric"`.
  - `gb_call_budget` at trip (frozen — every later GB call was `skippedQuota`/`skippedBudget`):
    **pairing 282, goodreads 201, bookfix 1 = 484 counted** (quota_day 2026-07-20, last write 13:32:02 UTC).

484 counted against a GCP-verified ~1,000/day cap ⇒ **physical : counted ≈ 2.07 : 1**.

## Root cause (code-proven)

`@hnet/goodreads` `getText` fired its `onCall` budget meter **ONCE, before the retry loop** — so every
transient-retry re-send (mandatory 5xx / per-minute-429 backoff retry; #402/#441) went UNCOUNTED. Google
Books meters every HTTP request against the daily quota, retries included. A `getText` leg that exhausts
its 3 retries is 4 physical requests counted as 1; the morning's heavy 503-`backendFailed` weather (a
single run logged "54s of heavy 503-backendFailed retry") is exactly that burst. The design's own D-21
note ("a transient-503 retry is the SAME query, counted once") was the flawed assumption; a unit test even
asserted it ("counts a 503-retried query ONCE"). The multi-leg fan-out of one `resolveVolume`
(isbn/title/pre-colon/confirm) was already counted correctly — each is a separate `getText` — so the gap
is purely retries.

Note the exact multiplier can't be decomposed from logs (per-attempt retries aren't individually logged);
the ~2.07× is the trip arithmetic (484 counted vs ~1,000 physical). The retry-undercount mechanism itself
is certain from the code.

## External draw — ruled out

All three consumers pull `GOOGLE_BOOKS_API_KEY` from DISTINCT 1Password items (live-verified in-cluster
ExternalSecret specs): app → `media-stack`, LazyLibrarian → `lazylibrarian`, Libretto → `libretto`. Both
other pods restarted onto them 07-19 ~22:19 UTC; Libretto logged "resolve broker: Google Books configured"
on its own key. Caveat: secret VALUES aren't readable from the dev pod (RBAC), so this is inferred from the
distinct item references + the split-PR intent + the GCP-verified per-key cap, not a value diff. The app's
own GB usage is fully captured by the metered `GoogleBooksClient` (the only GB HTTP path), so the trip is
the app's own retries, not an outside consumer.

## The fix

1. **Physical accounting** (`packages/goodreads/src/http.ts`): move `onCall` INSIDE `getText`'s retry loop
   so it fires once per physical `fetchImpl` call (initial + every retry), covering both the
   retryable-status and network/timeout retry paths. Counted = what Google meters.
2. **Budgets unchanged (700/200/100)**: now physical-request-accurate and summing to the real ~1,000/day
   cap, so no haynes-ops env change is needed. Per-day resolve throughput is (correctly) lower — each
   resolve now costs its true physical price; that is the whole point (we were exceeding quota before).
3. **Off-by-one (goodreads 201/200)** (`packages/domain/src/gb-call-budget.ts`): `canSpend()` is now a
   reserve-before-commit gate, `used + GB_MAX_RESOLVE_LEGS <= budget` (reserve = the worst-case 4-leg
   structural fan-out of one `resolveVolume`), so an enforced consumer never STARTS a resolve it can't fully
   afford — a crossing resolve can't push its slice past budget. Transient-retry inflation beyond the
   structural legs stays the breaker's job; enforced slices sum to 900 of ~1,000, and the ~100 unenforced
   `bookfix` reserve absorbs the rest, keeping worst-case physical under 1,000.

Tests: `google-books.test.ts` now asserts a 503-retried query counts PER physical attempt (was ONCE) and
the `/volumes/{id}` confirm counts as its own request; `gb-call-budget.test.ts` adds the 201/200
reserve-before-commit regression. Full suite green (`pnpm typecheck && pnpm lint && pnpm test`).

Did NOT touch `gb_quota_state` — the breaker correctly protects the dead quota until 2026-07-21T07:00Z.
The fix reaches the cluster on the next release/deploy (coordinator sequences that); the very next
post-reset day is the live confirmation window.
