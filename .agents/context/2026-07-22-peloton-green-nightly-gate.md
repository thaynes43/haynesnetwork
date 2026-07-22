# 2026-07-22 — Peloton green-nightly gate PASSED + donor config-manager RETIRED

First unattended ytdrivarr nightly (v0.6.0) validated at the ~02:37 UTC retirement gate.
Regime day-1 (see [[2026-07-21-ytdrivarr-validation-regime]]); resumes from
[[2026-07-21-overnight-handoff]]. **Verdict: GREEN on all four checks → retirement executed
(owner-approved, autonomous).**

## The nightly (run f6606d74, trigger cron, 02:00:00 → 02:01:22Z, status ok)

- **Bearer**: fresh — `/media/peloton/bearer.txt` 950 bytes, mtime 02:01:22Z (minted in-run,
  login attempt 1/3, 21 cookies). Clears the RED bearer-age callout.
- **Scrape**: 12 activities, 1176 links, `malformed: 0`, `selectorDrift: false` every activity,
  `alarms: []`. `discovered 300 → deduped 159 → added 144` (`windowedOut: 0` — 15-day window
  still a no-op, seed cohort young, as expected).
- **Per-activity adds** (all donor-scale 1–25, none atCap/overCap): Bike Bootcamp 0, Cardio 5,
  Cycling 23, Meditation 5, Row Bootcamp 5, Rowing 15, Running 24, Strength 23, Stretching 10,
  Tread Bootcamp 1, Walking 17, Yoga 16 = 144.
- **Numbering integrity**: `counts.updated: 0` + `windowedOut: 0` + code-enforced re-key guard.
  S30 high-waters are a monotonic SUPERSET of the donor's maxes (cardio 242≥224, cycling
  2221≥2121, bootcamp 907≥874). No re-key.

## Projection + consumption

- `subscriptions.yaml` updated post-run (mtime 02:01:22Z, 288 KB, **1022** entries = emitted).
- Downloader consumption clean: the in-flight `ytdl-sub-peloton` tick was mid-run on the
  pre-nightly projection (169 subs downloading, throttle sleeps ~75s, **no 401s / no parse
  errors / no ban**); the 02:01 projection awaits the next */15 tick.

## Structural comparison (superset)

Donor's 238 emitted class IDs are **100% present** in ytdrivarr's 1022-entry projection
(0 missing, 784 surplus from the re-air guard). ytdrivarr ⊇ donor, donor-bound entries verbatim.
Donor's own final nightly ran (started 02:20Z) but was interrupted mid-scrape by the prune
(never committed / no PR) — expected, was ignored anyway.

## Retirement executed

- **haynes-ops #2182** merged (02:50Z, b36ef42): removed the config-manager Kustomization +
  helmrelease + the vestigial `PELOTON_BEARER` ExternalSecret.
- **haynes-ops #2209** merged (02:53Z, bf00f3d): swept the dead unmounted config snapshots
  (`youtube/config/*`, `peloton/config/{subscriptions.yaml,.bak,subscription-history.json}`);
  kept `peloton/config/config.yaml` (still mounted). kustomize green on all overlays.
- Flux reconciled (cluster-apps @ bf00f3d): config-manager HelmRelease/CronJob/pod GONE,
  `ytdl-sub-peloton` ExternalSecret GONE. Downloaders (peloton/youtube/youtube-music CronJobs)
  + ytdrivarr core/worker/postgres all Ready/healthy and untouched. **ytdrivarr is now the only
  Peloton discovery path.**

## For the 07:51 morning check

- Confirm a POST-02:01 `ytdl-sub-peloton` tick ran and consumed the fresh projection cleanly
  (the 02:37 in-flight tick held the pre-nightly copy).
- Parallel agent's **ytdrivarr v0.6.1** (haynes-ops #2208, bearer-SLA calibration) deploys
  ~03:01Z → expect a ytdrivarr core pod restart; verify warn ~30h / error ~52h thresholds live.
- Unrelated: `ytdl-sub-youtube-music` had a `FileNotDownloadedException` on the JVKE channel
  (other music channels fine) — YouTube-music downloader, NOT a Peloton concern; watch for recurrence.
- Regime day-2 continues: bearer GREEN, per-activity adds not zero-across-the-board two nights running.
