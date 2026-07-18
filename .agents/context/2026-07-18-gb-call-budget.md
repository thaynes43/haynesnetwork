# 2026-07-18 — Google Books daily call budget: WE are the heavy consumer (pairing re-push → LL)

Owner correction to the earlier "mystery outsider" finding (`2026-07-18-gb-alternatives.md`): the GB
key is BRAND NEW, there is NO second GCP project, and the estate itself is the heavy consumer — the
app's own pushes amplified through LazyLibrarian (LL). This note quantifies it, checks the LL config
levers against live values, and records the app-side fix shipped.

## PART 1 — quantify (24h read-only cluster evidence)

**LL GB calls (pod `lazylibrarian-6db7d4875d-g47dr`, `gb.py:828 (API-GBRESULTS)`):**
- **213 events / 24h**, bucketed by minute-past-hour: **100% at `:32`** — the format-pairing CronJob
  (`32 * * * *`). goodreads-sync (`:22`) and collections (`:27`) produced **ZERO** GBRESULTS.
- Only **23 distinct titles** account for all 213. Top titles re-resolved **12–24×/day** (e.g. "The
  Ballad of Never After" 24×, "Once Upon a Broken Heart" 23×, ~14 titles at 10–12×).
- **Amplification factor:** temporal repetition ~**9× per title/day** (213 / 23). NOT whole-author
  import — the log is ~1 book per `addBook` (rare +1 "Series :Book is new"), and LL config confirms
  author-import is OFF. Each `addBook` ALSO fans out inside LL to author/series/pubdate GB lookups,
  so 213 GBRESULTS is a **floor** on real GB HTTP calls (est. ×3–5).

**Our own GB calls (frontend crons + `gb_quota_state`):**
- Sampled pairing run (16:32, breaker OPEN): `candidates:1534 attempted:5 minted:0 pushed:5
  skippedQuota:1467 reconciled:34 requeued:1`. Even with our breaker OPEN, `pushed:5` → 5 `addBook`
  → 5 LL-side GB re-resolves our breaker cannot stop (LL, not us, makes the call).
- `gb_quota_state`: daily breaker armed 03:32 EDT (07:32 UTC), `exhausted_until` next 07:00 UTC;
  trip_reason a genuine per-day 429 on our `intitle:…+inauthor:…` resolve. Our own key use is
  capped (`PAIRING_MINT_CAP_PER_RUN=25`) + breaker-guarded; ~0 on a quota-exhausted day.

**DB ground truth (book_requests):** pairing 282 total / 72 resolved (llBookId); 210 in `requested`
(all unresolved — stuck at the GB-resolve step). The 23 re-added titles are RESOLVED wants whose
missing format cycles through pushable state → re-`addBook` every run.

## PART 2 — LL config levers (live values, build `40a389ea`, via `readCFG`/`showStats`/`showJobs`)

The coordinator's two prime "hidden multiplier" suspects are **both already safe on this instance**:

| Lever | Live value | Verdict |
|---|---|---|
| `BOOK_API` | `GoogleBooks` | keep — OpenLibrary switch breaks GB-volume-id `addBook` (D-15 coupling); NOT ready-to-apply |
| `NEWAUTHOR_BOOKS` (import other author books) | **empty/OFF** | already safe — no whole-author import |
| `NEWAUTHOR_STATUS` | `Skipped` | already safe — new authors never Active |
| `NEWBOOK_STATUS` / `NEWAUDIO_STATUS` | `Skipped`/`Skipped` | already safe — siblings never tracked |
| Author roster | **160 Authors, 0 Active, 160 Paused**; "no authors needing update"; author-update cadence ~15d idle | already safe — the "perpetual Active re-scan" drain does NOT exist |
| `CACHE_AGE` | `30` days | keep |
| Cache persistence | **PVC-backed** (`/config`, claim `lazylibrarian`), survives restart; `cache` hit 2120 / miss 3725 | already safe — NOT wiped on restart |

429 backoff: LL's `commandText` retries 429/5xx with linear backoff (3 retries) — it does NOT hammer
hard, but it has **no daily-quota memory**, so with a shared key it burns the per-project quota
unthrottled. That is why pacing our push (which drives its `addBook`) is the lever, not LL backoff.

**Net:** with author-import off, new items `Skipped`, roster Paused, and cache persistent, there is
**no safe LL-config lever left** that materially cuts GB volume except the blocked source switch.
The multiplier was OUR re-push. Owner-only options remain (D-16): give LL a key from a SEPARATE GCP
project (own free quota, preserves the `addBook` pipeline), or the coordinated `book_api=OpenLibrary`
program. Config writes to LL are owner calls; none of the above are "unambiguously safe + reversible
app-side" toggles to apply autonomously (they are all already in the recommended state).

## PART 3 — app-side fix shipped (DESIGN-039 D-18)

`addBook` only seats a volume LL does not already hold. `runFormatPairing` reads LL's seated-book set
once per run (single `getAllBookStatuses`, no GB call) and passes an `llHasSeededBook` predicate into
`mintPairingWants`; a re-push of an already-seated `llBookId` skips `addBook` and issues only
`queueBook + searchBook` (no GB). First-seat pushes still `addBook`. Same read feeds the existing
reconcile (one read, two consumers). LL-read failure → predicate absent → exact pre-D-18 behaviour.
Effect: the ~23-title/day re-add amplification → ~0; LL GB load falls to genuinely-new volumes/day,
comfortably inside ~1000/day and NON-growing with the backlog (re-pushes are now GB-free). No schema
change, no new env knob, no audit surface; `PAIRING_MINT_CAP_PER_RUN` stays the attempt governor.
+1 domain test. NOT touched: Trash lane, collections page UI, /admin (parallel agents).
