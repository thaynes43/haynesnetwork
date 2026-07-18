# DESIGN-039: Google Books quota resilience — the shared breaker + retryable book Fixes

- **Status:** Draft
- **Last updated:** 2026-07-18
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
