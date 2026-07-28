# 2026-07-28 — ytdrivarr daily validation (day 8 of 14) — VERDICT: GREEN, 0 SEV

Per the standing order (`2026-07-21-ytdrivarr-validation-regime.md`). Observed ~18:25–18:30 UTC
via Prometheus/Loki (read-only; nothing changed). Window closes ~08-04.

## The five checks

1. **Nightly Peloton cycle: GREEN.** Last runs 02:01:47Z and 08:31:52Z both status ok. Latest:
   112.8s, discovered 300, added 9, emitted 1484, links_found 1707, **selector_drift_hits 0**,
   links_malformed 0, scroll_capped 0. Added last 48h: +12/+4/+8/+9 (no two-day-zero). Login
   failures 0/36h; `ytdrivarr_up=1`, `db_reachable=1`.
2. **Bearer freshness: GREEN.** Age ~9.9h (35601s) vs warn 30h / error 52h; status ok.
3. **Numbering integrity: GREEN — no re-key signal.** `sum(activity_entries)` strictly
   non-decreasing over 48h (1610 → 1643); `entries_removed_total` +0, `entries_windowed_out_total`
   +0 (window still no-op pre 08-05); per-activity total == existing + added for all 12
   activities; accounting consistent (1643 − 159 deduped = 1484 emitted).
4. **Downloaders: GREEN on errors.** Zero 401/429/403 lines across all three ytdl-sub pods (24h);
   throttle sleeps present. Peloton actively downloading (see W1); YouTube + Music both consuming
   (Music completed 5m before observation). Only Failed job is the known 4d-old
   FileNotDownloadedException nuisance, pre-window.
5. **Projections: GREEN.** All three emitted fresh from the 08:31Z cycle (~9.9h old). Sources
   stable at baseline (video 68 / music 5); Peloton 1643 library entries.

## Watch items (not SEVs)

- **W1 — Peloton pass runtime now exceeds 24h** (last complete 32h; current 25h+ and healthy).
  1484 subs × ~70s throttle ≈ 29h floor per pass ⇒ discovery-to-download latency ~1–2 days,
  every */15 tick Forbid-blocked meanwhile. Self-corrects when `PELOTON_EMIT_WINDOW_DAYS=15`
  activates (~08-05) and trims to donor scale; lengthens daily until then. No errors.
- **W2 — Age-gate error flood on ytdl-sub-youtube growing:** 8235 "Sign in to confirm your age"
  ERROR lines/24h (prior window 6265, +31%). NOT the bot-check ban signature; zero true 429/403 —
  inert re-attempts of age-restricted videos each tick. Candidate fix: cookies, or exclude the
  offending channel(s). Small, backlog-worthy.
- **W3 — Twice-daily Peloton scrape cadence** (02:01Z + 08:31Z, identical 07-27 and 07-28, both
  green; ~2.4 runs/day since pod start). Regime baseline says nightly-only ~22:00 ET — looks
  scheduled/established, not new today. **Owner: confirm intended.**
- **W4 — Pre-existing residue, flat all window:** `jobs{provider=peloton,status=error}=2` and
  `runs_total{provider=core,status=error}=2` unchanged 48h; core provider last_success 07-21
  (core runs appear on-demand); sources/projections unaffected.
