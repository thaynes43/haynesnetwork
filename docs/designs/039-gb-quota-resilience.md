# DESIGN-039: Google Books quota resilience — the shared breaker + retryable book Fixes

- **Status:** Draft
- **Last updated:** 2026-07-19
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
  dependency): an error object with `status === 429` classifies by the RESPONSE BODY only
  (`bodySnippet`); a body naming the per-day window (`/per day|daily limit|dailyLimitExceeded/i`)
  ⇒ `daily`; any other 429 — per-minute, or body-less/unparsable ⇒ `minute`, the conservative
  short trip; anything else ⇒ `null` (not the breaker's business). See **D-02a** for why the body
  string (not `errors[].reason`) is the daily signal and why the error's own `.message` is excluded.

### D-02a — 429 classification: what actually distinguishes daily from a burst (2026-07-18)

A live capture of a genuine per-DAY exhaustion of the shared key (GCP `project_number:841331826441`)
settled two questions that the original `/per day|daily/i`-over-`message`-and-`bodySnippet` version
got subtly wrong:

- **`errors[].reason` is NOT a daily signal.** The real per-day 429 body was
  `{"error":{"code":429,"message":"Quota exceeded … limit 'Queries per day' …","errors":[{… "reason":"rateLimitExceeded"}], "status":"RESOURCE_EXHAUSTED", "details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}`
  — i.e. a genuine daily exhaustion reports `reason:"rateLimitExceeded"`, identical to a per-minute
  burst. Only the human-readable `message` names the window (`limit 'Queries per day'` vs
  `limit 'Queries per minute per user'`). So we classify on the message STRING, never the reason
  code — keying off the reason would misclassify every daily exhaustion as a 2-minute burst and
  hammer an empty quota all day.
- **Classify on `bodySnippet`, never the error's `.message`.** `GoodreadsHttpError.message` embeds
  the request URL (key-redacted, but title-bearing: `q=intitle:<title>…`). Scanning it for
  `daily`/`per day` meant a per-MINUTE burst 429 on a book whose title contains those words
  (e.g. "The Daily Stoic") false-armed the **24-hour** daily breaker — a self-inflicted day-long
  starvation. The body snippet carries the real signal without the title. Body-less/unparsable
  429 ⇒ `minute` (fail toward retrying the same day; a genuine daily re-trips on the next probe).

`google-books`'s `getText` mirrors this: the "don't retry a daily 429" short-circuit uses the same
`GB_DAILY_QUOTA_BODY` regex against the `bodySnippet` only, and per-minute/5xx retries now use
`nextBackoffMs` (jittered linear backoff, honoring a capped `Retry-After` when present — GB sends
none on quota 429s, so jitter is the norm; it de-synchronises the three consumers' retries).

**Not a code fix: the capacity problem.** The 2026-07-18 incident (pairing's first post-07:00 GB
call 429'd `daily` and starved 210 wants) was a *correct* classification of a genuinely empty daily
quota — the shared key's per-day allotment was already spent by ~07:32 UTC, 32 min after the reset,
by a consumer outside haynesnetwork's namespaces (books-sync makes no GB calls; the Libretto broker
made ~16). The ISBN-resolve path itself works when quota exists (07-17 minted 25+25 in the healthy
post-reset window). The durable remediation is quota capacity / consumption, not classification —
tracked as owner ops follow-up (raise the GB per-day quota on the shared project, or isolate the
competing consumer), not code here.
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

## Amendment — 2026-07-18: the FOURTH consumer (LazyLibrarian) is the real drain, and why our resolve paths can't source-swap out of it

This design opened "One Google Books key, three consumers" (the web Fix fallback, the
goodreads-sync enrichment, the format-pairing mint). A 2026-07-18 owner investigation
(`.agents/context/2026-07-18-gb-alternatives.md`) found a **fourth, unguarded, dominant
consumer** the breaker never knew about, plus a structural reason our own paths cannot swap
Google Books (GB) for another metadata source. Recorded here so the breaker's premise stays honest.

### D-14 — The estate-wide GB consumer inventory (evidence-based)

The GB key is one field, `GOOGLE_BOOKS_API_KEY`, in the shared **`media-stack`** 1Password item
(the same item as the Prowlarr/SAB keys). Two apps mount it:

1. **haynesnetwork** (namespace `frontend`) — pulled via `dataFrom: extract media-stack` into the
   web app + the `goodreads` (:41 hourly) and `format-pairing` (:32 hourly) CronJobs. All three GB
   call sites already route through `guardedGbResolve` (this design) — quota-aware, low-volume,
   and comparatively light.
2. **LazyLibrarian** (namespace **`downloads`** — outside the frontend/media namespaces the first
   pass checked) — `externalsecret.yaml` folds the SAME `media-stack` `GOOGLE_BOOKS_API_KEY` into
   `/config/config.ini [API] gb_api`, with `book_api=GoogleBooks`. LL is the **primary drain**: its
   pod log streams `gb.py:828 (API-GBRESULTS)` continuously (every `addBook` re-resolves the volume
   from GB, and LL periodically refreshes author/book metadata against GB). It has **no quota
   memory** — it burns the shared per-project quota unthrottled. The `:32` format-pairing GB bursts
   line up exactly with the LL `gb.py` bursts one row later: our hourly push feeds LL `addBook`,
   and LL then re-hits GB for each — a double-dip.

**Libretto is NOT a GB consumer** (correcting a prior assumption): its only external metadata host
is `api.hardcover.app`; ISBN handling is local checksum math (`src/identifiers.ts`). Readarr — the
owner's "never had this problem" reference — used its own `bookinfo.club` Goodreads proxy, never GB.

**Quota scope:** the GB "Queries per day" limit is a **Google Cloud per-project** quota
(project `841331826441`), aggregated across every API key in the project. A second key in the same
project does **not** add headroom. The owner cannot raise the cap.

### D-15 — Why our paths cannot source-swap GB (the coupling)

Our LL `addBook` key **is a Google Books volume id** (`@hnet/lazylibrarian/write` `addBook&id=`,
because LL's `book_api=GoogleBooks`). Open Library / Hardcover can verify ISBN→title/author
identity and classify comics, but **cannot produce a GB volume id** — so no alternate source can
replace the GB call on any *pushable* path without also changing LL's `book_api` and our id scheme
in lockstep (an ADR-level change, not a source swap). "Route pairing straight through LL" spends
LL's GB quota under the hood (same project) and loses our comic guard — no net win. Conclusion:
the starvation is **architectural/config**, not a metadata-source choice in our code.

### D-16 — Recommendation

- **Primary (owner action, highest leverage, config — cannot be done from the read-only pod):**
  **decouple LazyLibrarian from the shared key.** Because the quota is per-project, give LL a GB key
  from a **separate GCP project** (its own free daily quota) via `config.ini [API] gb_api` — this
  removes the dominant consumer from our key entirely and preserves the proven GB-volume-id
  `addBook` pipeline. (Alternatively switch LL to `book_api=OpenLibrary`, but that breaks the
  GB-volume-id `addBook` coupling — a coordinated program, not a tonight fix.) LL config lives on
  the PVC (written via LL `writeCFG`), not in git, so this is an owner UI/config action; the
  `media-stack` ExternalSecret only transports the value.
- **Shipped tonight (safe, in-scope, no new deps/egress):** the format-pairing `llBookId` reuse
  index now draws from **both** goodreads AND prior **pairing** wants (D-17), so a pairing want whose
  same-work sibling already resolved a GB volume id mints with **zero** GB calls — the backlog keeps
  draining on a quota-exhausted day.

### D-17 — Reuse-index widening (`mintPairingWants`)

`reuseByTitle` was built only from `origin='goodreads'` requests with a non-null `llBookId`. It now
selects `origin IN ('goodreads','pairing')` — a GB volume id is the same identity key on either
origin. A candidate's own want is still consulted first (the reuse lookup is only reached when it
has no id yet, and index rows require a non-null id, so there is no self-reference). Same
title-normalization + author-agreement contract as before; unaudited derived-cache discipline
unchanged. Test: a book resolves `gb-dune`; a same-work audiobook whose subtitle keeps the pairing
key distinct then mints by **reusing** `gb-dune` with the GB stub throwing.

### Egress note

App namespaces (`frontend`/`downloads`/`media`) carry **no** CiliumNetworkPolicy — egress is
open, so reaching a new host (e.g. `openlibrary.org`) from the app needs **no** haynes-ops PR. The
default-deny allowlist applies only to the `dev-env` pod and `upgrade-agent`. (Confirmed: the
dev-env pod cannot reach `openlibrary.org` — it is not on that pod's allowlist — which is why any
empirical OL probing must happen from the app, not the ops pod.)

## Amendment — 2026-07-18b: WE are the heavy consumer — the pairing re-push amplifies through LazyLibrarian, and the LL-config levers are already safe

Owner correction to the D-14..D-17 finding: the Google Books (GB) key is **brand new**, there is
**no** second GCP project available, and the estate itself — the app's own pushes amplified through
LazyLibrarian (LL) — is the heavy consumer, not a mystery outsider. A 24h read-only cluster
investigation (`.agents/context/2026-07-18-gb-call-budget.md`) quantified it and located the lever.

### D-18 — The pairing re-push is the amplifier; addBook is only needed once per volume

**Evidence (LL pod `gb.py:828 (API-GBRESULTS)` over 24h):** 213 GB-resolve events, **100% at `:32`**
— exclusively the format-pairing CronJob (goodreads `:22` and collections `:27` produce **zero**).
Only **23 distinct titles** account for all 213 events; the top titles re-resolve **12–24×/day**.
The amplification is therefore **temporal repetition** (~9× per title/day), NOT a whole-author
import — confirmed against live LL config (below). Each `addBook` also fans out inside LL to
author/series/pubdate GB lookups, so the logged `API-GBRESULTS` line is a **floor**, not the whole
cost — which is how a mere 23 titles can help exhaust the shared per-day quota shortly after reset.

**Root cause in our code:** `mintPairingWants` issued `addBook` on **every** push of a re-pushable
want, and `addBook` makes LL re-resolve the volume (plus its author/series/pubdate) from GB **every
time**, bypassing LL's own 30-day cache and — critically — bypassing OUR `guardedGbResolve` breaker
entirely (LL, not us, makes the call). A run sampled with the breaker OPEN still emitted `pushed:5`
→ 5 `addBook` → 5 LL-side GB re-resolves the breaker could not stop.

**The fix (this change):** `addBook` **only seats a volume LL does not already hold.** `runFormatPairing`
now reads LL's seated-book set once per run (a single `getAllBookStatuses` — an LL DB read, never a
GB call) and passes a `llHasSeededBook` predicate into `mintPairingWants`; a push whose `llBookId`
is already seated skips `addBook` and issues only `queueBook + searchBook` (neither touches GB), so
LL makes **zero** GB calls on a re-push. First-seat pushes (a volume genuinely new to LL) still
`addBook` normally. The same `getAllBookStatuses` read now feeds BOTH the gate and the existing
status reconcile (one read, two consumers — a freshly first-seated volume simply reconciles on the
next run, a benign one-run delay). On an LL read failure the predicate is absent → the gate degrades
to the exact pre-D-18 always-`addBook` behaviour (never skip a seat we cannot confirm). This caps the
pairing cron's LL-driven GB re-resolves at genuinely NEW volumes — the ~23-title/day re-add
amplification goes to ~0. No schema change, no new env knob, no audit surface (the push is not a
role/permission mutation); `PAIRING_MINT_CAP_PER_RUN` (25, env-tunable) remains the per-run attempt
governor. +1 focused domain test (`SKIPS addBook when LazyLibrarian already holds the volume`).

### D-19 — LazyLibrarian config levers (live values, 2026-07-18) — the hidden-multiplier suspects are already safe

Read live from LL (`cmd=readCFG` / `showStats` / `showJobs`, build `40a389ea`):

| Lever (LL config) | Live value | Recommended | GB-call impact | Ready-to-apply? |
|---|---|---|---|---|
| `[General] BOOK_API` | `GoogleBooks` | keep (see D-15 coupling) | switching to OpenLibrary breaks the GB-volume-id `addBook` contract our confined client depends on — a coordinated ADR change, not a config flip | **No** — blocked by id coupling |
| `NEWAUTHOR_BOOKS` (import other books by new authors) | **empty / OFF** | OFF | already OFF — no whole-author catalog import per `addBook` | already safe |
| `NEWAUTHOR_STATUS` | `Skipped` | Skipped/Paused | new authors never become Active → never periodically re-scanned | already safe |
| `NEWBOOK_STATUS` / `NEWAUDIO_STATUS` | `Skipped` / `Skipped` | Skipped | sibling books we didn't ask for are never tracked/refreshed | already safe |
| Author roster (`showStats.author_stats`) | **160 Authors, 0 Active, 160 Paused** | keep all Paused | the "ever-growing Active roster re-scanned daily" drain does **not** exist here — 0 Active, and `showJobs` reports "no authors needing update" (author update cadence ~15 days, idle) | already safe |
| `CACHE_AGE` | `30` (days) | keep | GB/GR response cache TTL | already safe |
| Cache persistence | **PVC-backed** (`/config`, claim `lazylibrarian`); survives restarts; `showStats.cache` hit 2120 / miss 3725 | keep | cache is NOT wiped on restart — not a hidden multiplier | already safe |

**Conclusion:** the coordinator's suspected hidden multipliers (perpetual Active-author re-scan; a
non-persistent cache) are **both absent** on this instance — the roster is fully Paused and the cache
is persistent. With `NEWAUTHOR_BOOKS` off and new books/authors landing `Skipped`, there is **no
safe LL-config lever left that materially cuts GB volume** except the source switch (D-15, blocked).
The remaining leverage is entirely app-side — D-18 — plus the owner-only options in D-16 (give LL a
key from a separate GCP project; or the coordinated `book_api=OpenLibrary` program). This is why the
"we are missing something" reduces to: our own re-push was the multiplier, and it lives in our code.

### D-20 — Daily GB budget (24h evidence + steady state)

| Consumer | Measured 24h GB events | Note |
|---|---|---|
| LL, driven by pairing `:32` push (`API-GBRESULTS`) | **213** (floor; ×~3–5 internal fan-out per addBook) | 23 distinct titles, ~9× repetition — the amplifier D-18 removes |
| LL, driven by goodreads `:22` / collections `:27` | **0** | goodreads-sync pushes only unpushed wants (no re-add loop) |
| haynesnetwork pairing resolve (`guardedGbResolve`) | ≤25/run, breaker-guarded; ~0 on a quota-exhausted day (skippedQuota 1467 in the sampled run) | our own key use, already capped |
| haynesnetwork goodreads enrichment / book-fix | low, breaker-guarded, on-demand | quota-aware |

**Drain-phase vs steady state:** the 210-want pairing backlog + 154 collection + Mia's 41 drain at
`PAIRING_MINT_CAP_PER_RUN` (25 attempts/run) reuse-first, so most drain-phase pushes need no fresh
GB on our side. After D-18, LL's re-resolve load falls from ~213/day (re-adds) to roughly the count
of **genuinely new volumes seated that day** (bounded by the cap and by real new library items) —
comfortably inside ~1000/day with wide margin, unattended, and it does not grow with the backlog
(re-pushes are now free of GB). The owner-only D-16 key-separation remains the belt-and-suspenders
move if a future spike ever approaches the cap.

## Amendment — 2026-07-19: the cap is ~100/day, and WE are the last consumer — a persistent daily CALL BUDGET

The D-18 fix landed (#409: LL re-adds 193→15/day) and 429 classification is correct (#402). Yet on
2026-07-19 the shared key STILL exhausted its per-day quota, and a fresh read-only cluster investigation
(`.agents/context/2026-07-19-gb-call-budget-machine.md`) found the "~1000/day" premise was wrong and the
last remaining consumer is our OWN first-party volume. This amendment records the measured cap and the
budgeter that keeps us inside it forever, unattended.

### D-20a — The measured cap is ~100 calls/day, not 1000 (2026-07-19 evidence)

Read-only from the `frontend` pod logs + read-only psql over 07:00→08:32:03 UTC (the day's window from
reset to the daily 429):

| Consumer | Window | GB calls (legs) | Note |
|---|---|---|---|
| format-pairing resolve (07:32 run) | 07:32:03→07:32:57 | ~40–60 | 25 attempts, `skippedQuota:0` (quota healthy at 07:32); 54s of heavy 503-`backendFailed` retry — each `getText` leg counted once |
| goodreads enrichment (07:41 run) | 07:41:02→07:41:29 | ~30–40 | ~10 of 73 items enriched, then hit the per-MINUTE 429 (retryAfter +2 min) and skipped the rest (`skippedEnrichment:63`) |
| LazyLibrarian (`API-GBRESULTS`) | 07:32–07:33 | **13** | all at the `:32` push — #409 confirmed working (was ~213/day) |
| collections / books-sync / book-fix | 07:00→08:32 | 0 | none make GB calls in the window |

The daily 429 first surfaced at **08:32:03** (`gb_quota_state.tripped_at`, reason `daily`, on "Ghosts of
the Shadow Market 8"). But NO scheduled GB consumer ran between 07:43 and 08:32 — so the per-day quota was
actually exhausted during the 07:32+07:41 burst; the 07:41 per-MINUTE 429 fired FIRST (a fast burst hits
the per-minute limit before the per-day one) and MASKED the daily exhaustion, which the next call (08:32)
then surfaced. The total spent before exhaustion — pairing (~50) + goodreads (~35) + LL (13) ≈ **~100
calls** — is the effective daily cap. This is the modern low default for a new key, **not** the legacy
1000. GCP's console holds the authoritative number (unreadable from here); the budgeter is built to a
**configurable** cap so the owner can raise it once confirmed.

### D-21 — Persistent daily call accounting (`gb_call_budget`, migration 0070)

A NEW single-row table `gb_call_budget` (the `gb_quota_state` sibling; migration 0070, journal idx 69) —
`id='gb'` CHECK singleton, `quota_day date` (the `GB_DAILY_RESET_UTC_HOUR` boundary the counts belong to),
`pairing_calls` / `goodreads_calls` / `bookfix_calls int`, `updated_at`. The sole writer is
`recordGbCalls` (`packages/domain/src/gb-call-budget.ts`); its day-rolling upsert resets every counter to 0
in the SAME statement when the stored `quota_day` is stale, so the row is self-resetting with no cron.
Derived, rebuildable operational state (the `mam_gate_state` class): NO audit/outbox row; guard-listed in
all six no-direct-state-writes families.

**Counting the ACTUAL legs.** Every outbound GB call is counted in the shared `@hnet/goodreads` http
wrapper (`getText`) via an injected `onCall` meter — fired once per PHYSICAL outbound request. The
isbn / title / pre-colon / confirm legs of a single `resolveVolume` are separate `getText` calls and so
counted separately, AND every transient-retry re-send is counted too (see the 2026-07-20 amendment
below — the original "count the logical query once, not per retry" rule undercounted retries and tripped
the breaker at ~half the counted budget). The meter is wired only into the `GoogleBooksClient` (RSS shelf
reads carry no meter), so only GB legs count. The domain reads the meter's per-seam delta around each
resolve and persists it to the consumer's column — so the counted number matches what Google actually
meters against the daily quota, not the resolve count.

### D-22 — Oldest-first drain (ISBN-priority)

The `mintPairingWants` ordering was the second half of the starvation: it walked ALL `fresh` candidates
(which include today's NEWEST library items) before ANY `retry`, so the frozen oldest cohort (the 216
unresolved wants, all `first_seen` 2026-07-10, last tried 2026-07-16) never got reached — every run's 25
attempts went to newer items. Even on a healthy-quota run (07:32, `skippedQuota:0`) the 25 GB calls went
to fresh items, not the cohort. The fix replaces the fresh-then-retry split with ONE deterministic order
over all GB-eligible candidates: **(1) `first_seen_at` ASC** (oldest cohort first — ends the newest-first
churn); **(2) ISBN-bearing first** within the same `first_seen` (the `isbn:` leg is the cheap, reliable
one — cheapest drain); **(3) last-tried ASC** (a no-match advances `updated_at` and sinks below its
not-yet-tried siblings, so a bounded daily budget MARCHES through the cohort instead of re-hammering the
top items); **(4) `id` ASC** (deterministic tiebreak). So the 2026-07-10 cohort drains front-to-back,
ISBN-bearing first, before any newer item is touched.

### D-23 — Per-consumer daily budgets (env-tunable, ~85% of the cap)

`makeGbBudgetTracker(consumer)` reads the start-of-run usage once, then the run enforces the remaining
allowance locally (persisting each meter delta durably so the next run / a concurrent process sees it).
Before a GB-requiring candidate, `canSpend()` gates it; when spent, the candidate is skipped as
`skippedBudget` — the same non-attempt discipline as `skippedQuota` (no cap consumed, no want upsert so
`updated_at` does not advance, no per-item error spam) and, crucially, **WITHOUT tripping the shared
breaker** (this is our own pacing, not a real 429; the breaker stays for genuine 429s). Reuse/identity-
holding candidates (no GB needed) still mint free. `canSpend()` is a **reserve-before-commit** gate:
it requires `used + reserve <= budget` (reserve = `GB_MAX_RESOLVE_LEGS`, the worst-case 4-leg structural
fan-out of one `resolveVolume`), so a multi-leg crossing resolve cannot overshoot its slice (the
2026-07-20 amendment — goodreads had spent 201 of a 200 slice because the old `used < budget` gate started
a resolve at used=199 and committed to 201). Env-tunable defaults sum to ~85 = ~85% of the measured
~100 cap:

| Env | Consumer | Default | Share |
|---|---|---|---|
| `GB_DAILY_CALL_BUDGET_PAIRING` | format-pairing resolve | **60** | lion's share — owns the backlog drain |
| `GB_DAILY_CALL_BUDGET_GOODREADS` | goodreads enrichment | **25** | a slice — its comic-text fallback still classifies without GB |
| `GB_DAILY_CALL_BUDGET_BOOKFIX` | book Fix | **15** | metered, NOT enforced — the reserved headroom for the person waiting |

The ~15 unallocated + the un-enforced `bookfix` slice are the reserve for INTERACTIVE book Fix (low-volume,
on-demand, breaker-guarded). Raise these only after confirming a higher real cap in the GCP console.

### D-24 — Book-Fix metering + the fewer-bigger-runs question

The queued-fix retry pass (`retryQueuedBookFixes`, hosted in the goodreads cron) meters its GB legs into
the `bookfix` slice for a complete daily accounting but is never budget-blocked (completing a user's queued
Fix rides the reserve). The interactive api book-Fix path is left un-metered reserve headroom (its shared
`envGoogleBooksClient` is on-demand + breaker-guarded).

**Fewer-bigger runs (item considered, NOT implemented):** with the budget ceiling in place, concentrating
draining into one big post-reset window is UNNECESSARY. The 24 hourly runs each read the durable budget and
drain a little; the first 1–2 runs after 07:00 UTC (07:32, 08:32) spend the pairing slice (25-attempt cap ×
~2 legs ≈ 50 legs vs the 60 budget), and every later run finds the budget spent and skips (`skippedBudget`)
— so draining ALREADY concentrates into the first post-reset runs, and the budget guarantees we never
exceed the cap regardless of run count. **No haynes-ops cron change is made from this repo.** Owner option
(noted, not applied): raising `PAIRING_MINT_CAP_PER_RUN` lets the single 07:32 run consume the full daily
pairing budget alone if a one-window drain is ever preferred.

**Days-to-drain the 216 frozen cohort** at the pairing budget (60 legs/day, oldest+ISBN-first): the 28
ISBN-bearing anchors resolve at ~1 leg each (drain day 1); the ~188 title-only at ~2 legs each ≈ ~30
resolves/day ⇒ the cohort clears in roughly **6–7 days**, front-to-back, ISBN-bearing first — accelerated
further by reuse (free) mints. Steady state afterward: only genuinely-new unpaired items compete, always
behind any older unresolved item.

## Amendment — 2026-07-20: count PHYSICAL requests, not logical queries (the first budgeted day still tripped)

The dedicated-key split (both other consumers moved onto their own GCP-project keys) and the D-21..D-24
call budget landed, and 2026-07-20 was the first genuinely-budgeted day on the app's own ~1,000/day key.
The morning held perfectly (breaker clear, pairing minting 24–25/run). Yet at **13:32:17 UTC** a
format-pairing resolve run hit a REAL daily-signature 429 (`gb_quota_state.trip_reason` = `daily: GET
…/volumes?q=isbn:9780141328034… → HTTP 429 "Quota exceeded for quota metric"`, `exhausted_until`
2026-07-21T07:00Z) with only **484 counted calls** in `gb_call_budget` (pairing 282, goodreads 201,
bookfix 1) — less than half the 700/200/100 = 1,000 budget.

**Root cause (code-proven): the meter counted LOGICAL queries, not PHYSICAL requests.** The
`@hnet/goodreads` `getText` wrapper fired its `onCall` meter ONCE, *before* the retry loop — so every
transient-retry re-send (the mandatory backoff retry on 5xx / per-minute-429; #402) went uncounted.
Google Books meters **every HTTP request** against the daily quota, including retries, so the physical
requests Google saw were ~2× the counted number: 484 counted vs a GCP-verified ~1,000/day cap ⇒
**physical : counted ≈ 2.07 : 1**. The morning's heavy 503-`backendFailed` weather (the D-20a run logged
"54s of heavy 503-backendFailed retry") is exactly the retry burst this undercounts; a `getText` leg that
exhausts its 3 retries is 4 physical requests counted as 1. (The secondary `/volumes/{id}` comic-confirm
fetch was already counted — it is a separate `getText` — so the gap is retries, not the confirm leg.)

**External-draw ruled out.** LazyLibrarian (`downloads` ns) and Libretto (`media` ns) both restarted
2026-07-19 ~22:19 UTC onto their OWN ExternalSecrets, live-verified pulling `GOOGLE_BOOKS_API_KEY` from
distinct 1Password items (`lazylibrarian`, `libretto`) — the app keeps `media-stack`. Libretto logged
"resolve broker: Google Books configured" on its own key post-restart. (Secret *values* aren't readable
from the dev pod, so this is inferred from the distinct item references + the split PR intent + the
GCP-verified per-key cap, not a value diff.)

**Fix:** move `onCall` INSIDE `getText`'s retry loop so it fires once per physical `fetchImpl` call
(initial + every retry). The counted unit is now physical-request-accurate, so the **700/200/100 budgets
stand unchanged** — they now sum to the real ~1,000/day cap in the same unit Google meters, and the
per-day resolve throughput is (correctly) lower because each resolve now costs its true physical price.
No haynes-ops env change is required.

**Off-by-one (goodreads 201/200):** `canSpend()` became a reserve-before-commit gate,
`used + GB_MAX_RESOLVE_LEGS <= budget` (reserve = the worst-case 4-leg structural fan-out of one
`resolveVolume`), so an enforced consumer never STARTS a resolve it can't fully afford and a crossing
resolve can't push the slice past its budget. Transient-retry inflation beyond the structural legs stays
the shared breaker's job (the hard backstop); with the enforced pairing+goodreads slices summing to 900
of the ~1,000 cap, the remaining ~100 (the unenforced `bookfix` reserve) absorbs it — worst-case physical
stays under 1,000.
