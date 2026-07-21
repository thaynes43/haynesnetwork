# 2026-07-21 — THE YTDRIVARR VALIDATION REGIME (owner-mandated, runs through ~2026-08-04)

Owner ruling (2026-07-21, near-verbatim): agents must "validate for the next two weeks that this
app did not regress what we had before and it works just as good if not better. **Especially
Peloton since that was very tricky.** Agents will use our metrics to validate" and the owner
helps via the Grafana dashboard. This note is the protocol; the HANDOFF top block points here.

## What was cut over (what "before" means)

- **YouTube video:** hand-edited git YAML → ytdrivarr projection (haynes-ops #2179). Baseline:
  68 channels, `Plex TV Show by Date`, Only Recent 24mo/300, heavy throttle
  (`subscription_download_probability: 0.5`), */15 downloader, no bans.
- **YouTube music (NEW capability):** 5 music channels split to a music library (#2188), offset
  downloader (:07/:22/:37/:52), `YouTube Releases` family, Plex "YouTube Music" (key=6).
- **Peloton:** the donor config-manager (nightly Selenium scrape → git PR) → ytdrivarr
  out-of-process worker + projection (#2180/#2181). Baseline: nightly discovery ~22:00 ET;
  ~238-entry sliding window (15-day; ytdrivarr parity via `PELOTON_EMIT_WINDOW_DAYS=15`,
  no-op until the seed cohort ages ~2026-08-05); per-(activity,duration) episode numbering
  MONOTONIC and never re-keyed; bearer minted nightly (SLA 21600s); ~12 activities, ~975
  links/scrape scale; downloader substitutes `${PELOTON_BEARER}` with zero 401s.
- **Donor retirement:** haynes-ops #2182 (merges after the first green nightly, ~02:37 UTC
  07-22 gate). After it, ytdrivarr is the ONLY Peloton discovery path.

## The daily validation check (every session in the window; ~one Opus dispatch or inline reads)

Use the Prometheus metrics + the "ytdrivarr" Grafana dashboard (built 2026-07-21, ytdrivarr
issue #19) as the primary instruments; the console Activity page (Run summaries in the
Changes/Health/Issues shape) for drill-in; downloader pod logs for ground truth.

1. **Nightly Peloton cycle GREEN:** last run status ok · bearer age < SLA (21600s) ·
   selector-drift hits = 0 · login succeeded (attempts ≤ retries) · new classes discovered at
   donor scale (typically 1–25/activity/day; ZERO across all activities two days running is a
   red flag, not a quiet day).
2. **Numbering integrity (the tricky part):** per-(activity,duration) episode numbers only ever
   INCREASE; any re-key/renumber of an existing entry = SEV-1 regression (Plex matching breaks).
3. **Downloaders consuming:** all three ytdl-sub CronJobs completing; no config parse errors; no
   `${PELOTON_BEARER}` 401s; downloads landing (archive growth / Plex recently-added); no
   429/ban signals (the resolution-assert detector, throttle sleeps present in logs).
4. **Projection sanity:** per-library entry counts + last-emit fresh; Peloton file bounded
   (~donor scale once the window activates ~08-05); YouTube projections stable at 68/5.
5. **Regression verdict logged** in the session (and any SEV to the owner immediately).

## What regression looks like → response

- Bearer stale past 2× SLA, selector-drift alarms, login failures → the worker's hardened path
  is failing like the donor used to; diagnose via worker logs; the donor's failure playbook is
  in `.agents/context/2026-07-20-ytdrivarr-q03-donor-audit.md`.
- Fewer new classes/videos than the donor trend over 48h+ → discovery regression.
- Any numbering re-key → STOP the emit (set the library disabled or `PELOTON_EMIT_WINDOW_DAYS`
  untouched — do NOT hand-edit projections) and escalate.
- **Rollback levers (all single reverts):** #2181 (Peloton repoint) / #2179 (YouTube) /
  #2188 (music) restore the git-config path; reverting #2182 restores the donor if it was
  already retired. Non-destructive: the DB ledger + media files survive any rollback.

## Standing constraints

The estate rules apply: non-destructive, no MAM spend, the owner reviews UX. ytdrivarr code
work stays in its repo; this app (haynesnetwork) is NOT the validation surface — the metrics
are. The window closes ~2026-08-04: if two clean weeks pass, retire this regime in the HANDOFF
and fold a one-line "validated" verdict into the saga record.
