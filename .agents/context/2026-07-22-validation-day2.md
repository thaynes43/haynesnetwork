# 2026-07-22 — ytdrivarr validation DAY 2 (verdict)

Regime: [[2026-07-21-ytdrivarr-validation-regime]] (owner-mandated, runs ~through 08-04).
Day-1 verdict was the green-nightly gate ([#478], merged). This is the day-2 log: the five
morning-check findings + the verdict. Overnight 02:37 gate facts (nightly GREEN — 144 added,
fresh bearer 02:01Z, 0 drift, numbering superset, donor's 238 IDs 100% present; retirement
executed via haynes-ops #2182 + #2209) were verified at the gate and are NOT re-litigated here.

Instruments: cluster reads (kubectl, ns `frontend`/`downloads`), Prometheus (`ytdrivarr_*`),
Loki, sync-CronJob logs. Read-only + non-destructive; probe Jobs (envFrom `haynesnetwork-secret`)
deleted after. No MAM spend. Owner lanes (Libretto recipes, haynesnetwork product) untouched.

## 1. Conversion moment — UNDERDELIVERED (GB-quota-bound, not the hoped burst)

`books-collections-sync` 07:27Z run on v0.89.1 (86s, ok): `resolved:13 reused:106 minted:0
removed:0`, force-search `candidates:13 searched:13 failed:0`. Fresh Libretto GB quota converted
only **+13** collection-wants, not the hypothesised hard climb.

DB truth (`book_requests`, origin=`collection`): **441 total, 322 still NULL `ll_book_id`**
(≈27% resolved). The 140+51 "baseline" was pre-population-growth; the want set has since grown
(pairing + wave-2 members), so NULL is *higher* in absolute terms, not lower. **Expanse mains:
mostly still NULL** — Caliban's War, Cibola Burn, Nemesis Games, Persepolis Rising, Leviathan
Falls (ebook variant), etc. carry `ll=NULL`; only a few audio variants resolved (Abaddon's Gate,
Leviathan Falls audio, Nemesis Games audio). Root cause is GB quota (finding 3), not a code fault.

## 2. MAM — GATE 185 CROSSED; now capacity-bound at the 200 cap

Governor 07:49Z: `unsatisfied:189` (was 127 @ 13:49Z 07-21 → **+62 / 18h ≈ +3.4/h**), `total:263`,
`limit:200 threshold:185 buffer:15 headroom:11`, `seedingUnder72:189`, `downloading:0`,
`gateOpen:false desiredOpen:false indexerEnabled:false actuated:false enqueued:0`.

VERDICT: the force-search injector + day's grabs drove demand **past the 185 gate** — the demand
case is proven. But the pool is now pressed against the 200 cap (headroom 11 < 15 buffer), so the
governor holds the MAM indexer **closed** (no enqueues this cycle). All 189 unsatisfied are
seeding <72h — the pool skews YOUNG, so the 72h decay won't relieve the cap soon; it'll plateau
near 189–200. Expansion (more slots) is the live lever, not more injection.

## 3. GB day 2 — breaker CLEAN; daily 429 cap IS hit every day (by design)

Correction to the "no daily 429s" expectation: the daily 1000-call/3-key budget **saturates
daily**. Hourly goodreads runs 02:41–06:41Z each logged `GB quota exhausted … reason: daily …
HTTP 429 … until 07:00` — the app detects the daily 429, backs off to the 07:00 reset, `failed:0
totalFailure:false transientBlips:0`. Zero `breaker-open`/`circuit-open` events (Loki 15h). Post
07:00 reset the fresh quota was spent within ~40 min (07:41 run: short-window guard, retryAfter
07:43, plus one transient GB `503` handled gracefully). So: self-heal/breaker **clean**, but GB is
**fully saturated** and is the binding constraint on both goodreads enrichment and the collection
conversion in finding 1. Not an alarm — it's the documented steady state.

## 4. ytdrivarr day-2 residuals

- **(a) Fresh-projection tick — PENDING, not an error.** The running `ytdl-sub-peloton` job
  (29744580) started **23:00Z (pre-nightly)** and is still going (~8h; throttle-protection sleeps
  ~60–80s/subscription → ~13h runtime; Forbid concurrency blocks new ticks). It consumes the
  *prior* projection cleanly (active downloads, no 401/429/ban). The fresh 02:01Z projection is
  consumed by the **next** tick (~12:00Z when this finishes) — window overlaps heavily, nothing lost.
- **(b) v0.6.1 bearer-SLA deploy — LANDED & healthy.** Pod + deploy on `ytdrivarr:v0.6.1`,
  `ytdrivarr_build_info version=0.6.1`. New SLA live: `bearer_sla_seconds=108000` (30h warn),
  `bearer_age_seconds=21360` (~5.9h, minted 02:01Z) → GREEN; `selector_drift_hits=0`,
  `db_reachable=1`, `last_run_status=0`. NOTE: v0.6.1 reached main via image-automation
  **haynes-ops #2211** (merged 02:53Z), so the human SLA PR **#2208 is now a dangling OPEN
  duplicate** — its only unmerged unique content is the Grafana `ytdrivarr.json` dashboard tweak;
  close or rebase-to-dashboard-only. (ytdrivarr lane; flag only.)
- **(c) JVKE — resolved; FileNotDownloadedException moved on.** JVKE is now GREEN (✔, 0 new, 47
  archived). The `FileNotDownloadedException` **recurs but on different channels** — this pass it
  hit Daft Punk (video `kCzI_UxSGMg`) + Taylor Swift in `ytdl-sub-youtube-music` (29745007), which
  marks the whole job `Failed` despite **+49 tracks landing**. Prior run (29744917) had 7 such
  retries yet Completed. Intermittent, non-fatal, self-recovering — inherent ytdl-sub behaviour
  (one bad/age-gated video → non-zero exit). Music is a NEW capability, not a cutover regression.
  Low-priority nuisance; no SEV.

## 5. Other overnight reality

- Peloton worker crashed once 19:18Z (`TransportError` / "No route to host" to the ytdrivarr svc
  during a console blip), auto-restarted, ran the 02:00 nightly fine — self-healed, one-off.
- No crashloops; all `frontend` sync CronJobs Complete. (Stale unrelated: one 4d-old ai-usage job
  Failed; sabnzbd 8 restarts 7d ago — neither overnight.)

## Day-2 verdict

**No Peloton/ytdrivarr regression** — nightly green, v0.6.1 bearer SLA live & healthy, numbering
integrity intact, downloaders consuming (throttle-bound by design), 0 selector drift. Day-2 status:
**PASS** for the cutover. Open threads are demand-side, not correctness: GB daily quota is the
throttle on book/collection resolution (conversion +13, 322 collection-wants NULL) — GB self-heals
cleanly but is saturated; MAM demand has crossed the 185 gate and is capacity-bound at 200 (young
pool, slow 72h decay) — expansion is the lever. Housekeeping: close/rebase dangling haynes-ops #2208.
