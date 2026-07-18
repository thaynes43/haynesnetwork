# 2026-07-18 — GB quota 429 classification (fix/gb-429-classification)

## Headline anomaly investigated
The format-pairing cron's first post-07:00-UTC GB call 429'd `daily` and armed the shared
breaker for 24h, starving 210 unresolved pairing wants (27 with ISBNs). Suspected: a burst/rate
429 misclassified as day-quota exhaustion.

## What the evidence actually showed (read-only cluster verify)
- **Not a misclassification.** Live capture of the shared key's 429 (GCP `project_number:841331826441`,
  ~07:40 UTC): HTTP 429, body `message: "Quota exceeded … limit 'Queries per day' …"`,
  `status: RESOURCE_EXHAUSTED`, and — critically — `errors[].reason: "rateLimitExceeded"` /
  `details[].reason: "RATE_LIMIT_EXCEEDED"`. So a **genuine per-day exhaustion reports
  `rateLimitExceeded`**, identical to a per-minute burst; only the message string names the window.
  Keying off `errors[].reason` (the original task hypothesis) would MISclassify every daily
  exhaustion as a burst and hammer an empty quota all day.
- The 07:32:04 trip (`gb_quota_state.trip_reason`) was `intitle:Dirty Beasts+inauthor:Roald Dahl`
  → genuine `daily` (body said "per day"). The quota was really empty at 07:32, 32 min after reset.
- The quota DOES reset ~07:00 and the ISBN-resolve path works when quota exists: 07-17 pairing
  `minted:25` at 07:33 and 08:33 (`skippedQuota:0`); goodreads enrichment `skippedEnrichment:0`
  at 07:24/07:43. 07-18's fresh window was simply spent before pairing (07:32) ran.
- No haynesnetwork-side burner found: books-sync makes 0 GB calls; Libretto broker (media ns)
  made ~16 GB-ish calls in the window; media ns had no GB 429s. The consumer that spends the
  shared per-day allotment is outside the namespaces observed here (shared GCP project).

## Root cause
Quota CAPACITY, not code: the shared Google Books per-day quota is genuinely exhausted before
haynesnetwork's crons reach it. The breaker was correctly reflecting reality.

## Latent bug fixed anyway (real, in the flagged code path)
`classifyGb429` scanned the error's `.message`, which embeds the request URL
(`GET …?q=intitle:<title>… → HTTP 429 — <body>`). A per-MINUTE burst 429 on a book titled
"…Daily…"/"…Per Day…" therefore false-armed the **24h** daily breaker — self-inflicted day-long
starvation. Fix: classify on the RESPONSE BODY (`bodySnippet`) only; daily signal is the body's
`/per day|daily limit|dailyLimitExceeded/i`; body-less/unparsable 429 → `minute` (short cool-off).
`getText` aligned (same regex on snippet; per-minute/5xx retries now jittered + Retry-After-aware
via `nextBackoffMs`, capped 5s — GB sends no Retry-After).

## Cron stagger — NOT shipped
Schedules live in haynes-ops (no CronJob defs in this repo). No 07:00-sharp haynesnetwork
competitor confirmed, so no speculative stagger PR. Recommendation for owner: raise the GB per-day
quota on the shared project, or isolate the competing consumer. Staggering pairing/goodreads to
07:0x is a plausible-but-unproven mitigation only if a fresh window exists that a competitor grabs.

## Secondary (report-only)
`haynesnetwork-sync-ai-usage` back-to-back Error pods 06:12–06:13 UTC: `durationMs:30002/30010`,
`error: "This operation was aborted"` — a 30s AbortController timeout on the upstream AI-usage
fetch (both the run and its retry). Transient upstream slowness/unreachability, not a crash.
