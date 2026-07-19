# 2026-07-19 — the daily GB CALL BUDGET: the last layer of the Google Books quota saga

Branch `feat/gb-daily-call-budget`. With LazyLibrarian's re-add amplification killed (#409: 193→15
GBRESULTS/day) and 429 classification fixed (#402), the shared Google Books (GB) key STILL exhausted its
per-day quota by ~07:41 UTC on 07-19. This change adds the machine that keeps our OWN first-party
consumers inside the (low) cap forever, unattended.

## PART 1 — the measured cap (~100/day, NOT 1000) and the per-consumer split

Read-only cluster evidence (frontend pod logs + read-only psql, image `ghcr.io/cloudnative-pg/postgresql:16.4-34`,
`envFrom haynesnetwork-secret`, deleted after), window 07:00→08:32:03 UTC:

| Consumer | GB calls (legs) | Evidence |
|---|---|---|
| format-pairing resolve (07:32 run) | **~40–60** | `attempted:25 minted:25 pushed:18 unmintable:7 skippedQuota:0` — quota healthy at 07:32; 54s of heavy 503-`backendFailed` retry |
| goodreads enrichment (07:41 run) | **~30–40** | ~10 of 73 items enriched then hit the per-MINUTE 429 (`retryAfter` +2 min), `skippedEnrichment:63` |
| LazyLibrarian `API-GBRESULTS` | **13** | all at `:32` — #409 confirmed (was ~213/day) |
| collections / books-sync / book-fix | **0** | none make GB calls in the window |
| **TOTAL before exhaustion** | **~100** | ≈ the effective daily cap |

The daily 429 `gb_quota_state` row: `tripped_at` 08:32:03 UTC, reason `daily`, on "Ghosts of the Shadow
Market 8", `exhausted_until` 07-20 07:00 UTC. **Key finding:** no scheduled GB consumer ran 07:43→08:32, so
the per-day quota was actually exhausted during the 07:32+07:41 burst — the 07:41 per-MINUTE 429 fired first
(a fast burst hits per-minute before per-day) and MASKED the daily exhaustion, which the 08:32 call surfaced.
So the cap ≈ pairing(~50) + goodreads(~35) + LL(13) ≈ **~100 calls/day** — the modern low default for a new
key, not the legacy 1000. GCP's console holds the authoritative number (unreadable from here); the budgeter
is built to a CONFIGURABLE cap.

DB ground truth (psql): pairing wants **96 resolved / 216 unresolved** (28 ISBN-bearing), ALL unresolved
`first_seen` 2026-07-10, `updated_at` 2026-07-16 (frozen); 1534 total unpaired non-comic candidates.

## PART 2 — what shipped (the budgeter)

1. **`gb_call_budget`** (migration 0070, journal idx 69) — the `gb_quota_state` sibling: single row
   (`id='gb'`), `quota_day` + per-consumer `*_calls`. Sole writer `recordGbCalls`
   (`packages/domain/src/gb-call-budget.ts`); the day-rolling upsert resets counters to 0 when the stored
   `quota_day` is stale (no cron). Guard-listed in all six no-direct-state-writes families; no audit row.
2. **Actual-leg counting** — `getText` (the shared `@hnet/goodreads` http wrapper) gains an `onCall` meter,
   fired ONCE per outbound GB query (a 503-retry is the same query, counted once; RSS reads carry no meter).
   Wired into the `GoogleBooksClient` only; the domain persists the meter's per-seam delta to the consumer's
   column, so the budget reflects the real 1–4-leg fan-out per `resolveVolume` that exhausts the quota.
3. **Per-consumer budgets (env, ~85% of ~100):** `GB_DAILY_CALL_BUDGET_PAIRING=60`, `_GOODREADS=25`,
   `_BOOKFIX=15` (bookfix METERED, never blocked — the reserved headroom for interactive Fix). When a
   consumer's slice is spent it skips GB as `skippedBudget` (no cap consumed, no want upsert, breaker NOT
   tripped — our own pacing, not a 429). Reuse/identity-holding mints still proceed free.
4. **Oldest-first drain (D-22)** — `mintPairingWants` ordering was the second starvation: it walked ALL
   fresh (newest library items) before ANY retry, so the frozen 07-10 cohort never got reached even on
   healthy-quota runs. Replaced with ONE order: `first_seen ASC → ISBN-bearing first → last-tried ASC → id`.
   The 07-10 cohort now drains front-to-back, ISBN-bearing first (the cheap `isbn:` leg).
5. **Fewer-bigger runs — considered, NOT implemented.** The budget ceiling makes it unnecessary: the first
   1–2 post-reset runs spend the pairing slice, later runs `skippedBudget`. No haynes-ops cron change from
   this repo. Owner option noted: raise `PAIRING_MINT_CAP_PER_RUN` for a single-window drain.

**Days-to-drain the 216 cohort** at 60 legs/day, oldest+ISBN-first: 28 ISBN anchors ~1 leg (day 1), ~188
title-only ~2 legs ≈ ~30 resolves/day ⇒ **~6–7 days** front-to-back, accelerated by free reuse mints.

## Tests / gates
Domain `gb-call-budget.test.ts` (day-boundary math, durable accounting + roll, tracker enforcement + split,
bookfix-unenforced), `format-pairing.test.ts` (oldest+ISBN ordering, skippedBudget + breaker-untouched,
free reuse mint), goodreads `google-books.test.ts` (onCall once/query, 503-retry counted once), db
migration 0070 singleton test, guard-list. `pnpm typecheck && lint && lint:css && test && build` green.

## NOT touched
haynes-ops cron schedules; the shared breaker (`gb-quota-breaker.ts`); the interactive api book-Fix path
(un-metered reserve headroom); LL config; collections. Owner-only D-16 key-separation remains the
belt-and-suspenders option if a future spike approaches the cap.
