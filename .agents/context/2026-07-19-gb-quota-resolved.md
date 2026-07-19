# 2026-07-19 — Google Books quota: RESOLVED (shared-key contention, not a ~100 cap). Key split + budget raise.

Authoritative resume point for the GB thread. **Supersedes the "~100/day" premise** in
[[2026-07-19-gb-quota-monitor-watch]] and [[2026-07-19-mam-demand-and-expansion-plan]] — that number was
wrong (see below). Owner drove this to resolution the evening of 07-19.

## What the problem actually was (GCP-console-verified)

NOT a ~100/day cap. The owner opened the GCP console: the project quota is a **genuine 1,000 Queries/day,
pinned at 100% (1,001/1,000) every day**, and it is **not raisable** (the increase-request link is the
well-known broken Books-API dead-end). The real root cause: **one Google Books key was SHARED by three
consumers** — haynesnetwork (pairing/goodreads/bookfix resolve), **LazyLibrarian** (internal addBook
metadata fan-out), and **Libretto** (the collection-resolve broker) — all pulling `media-stack ➜
GOOGLE_BOOKS_API_KEY` = one GCP project = one 1,000/day quota. Two of them spend it UNMETERED, so the app's
careful budget was rationing ~100 of a pie two other services ate without a plate. The earlier "~100/day"
was only the app's *slice*, mistaken for the project cap. (Correction of an even older note: **Libretto is
NOT GB-free** — it runs a GB resolve broker on that shared key.)

Also confirmed NOT a bug: the 08:32 daily trip is a genuine `Queries per day` 429 (Google's body says so),
correctly classified — no cheap "reclassify per-minute" win existed.

## What shipped (all live 07-19, full effect at the 07:00 UTC 07-20 reset)

1. **Key split** (haynes-ops #2159): owner minted TWO new GCP projects + Books API keys and stored them as
   `GOOGLE_BOOKS_API_KEY` in the dedicated 1Password items `lazylibrarian` and `libretto`. Their
   ExternalSecrets were repointed off `media-stack` to those items; ESO `SecretSynced` verified; both pods
   restarted onto their own keys (Libretto logged "resolve broker: Google Books configured"). haynesnetwork
   keeps the `media-stack` key, now **unshared** → three independent 1,000/day quotas.
2. **App budget raise** (haynes-ops #2160): `GB_DAILY_CALL_BUDGET_PAIRING/GOODREADS/BOOKFIX` set to
   **700 / 200 / 100** on the app container + the format-pairing and goodreads sync jobs (was code defaults
   60/25/15, sized for the shared-scraps era). Verified live on the app pod (`pairing=700`). The shared
   breaker stays the hard backstop, so aggressive is safe (worst case: a rare 503-heavy morning trips early).
3. **Doc correction**: the `gb-call-budget.ts` header + JSDoc no longer claim "~100/day" (this PR).

## What this unlocks
- The ~216-book pairing cohort drains in **~1 day** (700 legs/day on the app's own key), not ~7.
- **Tomorrow's collection expansion runs on Libretto's OWN dedicated 1,000/day** — fully clear of the app's
  pairing/goodreads. The contention that would have re-tripped the breaker mid-expansion is gone.

## Residual / optional
- Retry amplification: the goodreads `getText` retries up to ~3× on 503/per-minute-429, so Google-side
  PHYSICAL requests exceed our LOGICAL count on bad-weather mornings. Optional follow-up: cap retries so
  logical ≈ physical and we can run right up to the per-key cap without waste. Not urgent.
- If any single consumer's own demand ever exceeds its dedicated 1,000/day, its own project graph will show
  it — then give that one consumer a second project too. Unlikely near-term.
