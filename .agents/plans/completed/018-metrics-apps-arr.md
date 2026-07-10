# PLAN-018: Metrics — Apps sub-tab (*arr + downloaders)

- **Status:** Completed (2026-07-10) — **shipped as v0.32.0, live** (PR #162 → release PR #163 →
  haynes-ops `7659c485` → Flux rollout green, `/api/health` ok on both origins). The Apps sub-tab
  renders the four curated groups off live Prometheus (pod-verified: 9564 movies / 114118 episodes /
  55507 albums, SAB 848 GB/60 GB 24h lanes, qbittorrent+slskd up, prowlarr 4 indexers); unauth
  `metrics.apps` = 401 UNAUTHORIZED; both-levels payload with the full-only seam present-but-empty.
  Docs consumed: DESIGN-018 / OPS-008 / R-125..R-126 / T-113 — **no ADR, no migration, no guard
  edit** (as predicted). Owner morning: Q-01 (fast-lane split at limited), Q-02 (bazarr panel
  group), Q-03 (keep 3 boards), Q-05 (deep-link split — confirmed as built).
  - **As-built ID reconciliation (re-grepped 2026-07-10 on `main` @ v0.31.0):** 017 consumed
    DESIGN-016 / OPS(none — 017 authored no OPS doc) / R-117..R-120 / T-106..T-109; 022 consumed
    ADR-038 / DESIGN-017 / R-121..R-124 / T-110..T-112. **018 takes next-free: DESIGN-018, OPS-008,
    R-125..R-126, T-113.** No new ADR (the deep-link contract reuses ADR-030 C-04 / ADR-037 C-09 —
    no new decision). **No migration** — the Apps sub-tab rides 017's `metrics` Section Permission
    + `roles.metrics_level`; nothing new is persisted. **No `no-direct-state-writes` guard edit**
    (read-only). The `'apps'` tab key already exists in `METRICS_TABS` (017 scaffolded it).
  - **Live-verified series (2026-07-10, cluster `prometheus` datasource):** all Group A–D series UP;
    plus the collection-wave additions are now LIVE and reconciled INTO this build (not deferred):
    **bazarr** exportarr (`bazarr_*`), **qbittorrent** sidecar (`qbittorrent_up`/`_connected`/
    `_torrents_count`), **slskd** first-party (`slskd_*`). Per the orchestrator directive, Group C
    now carries qbittorrent + slskd **reachability/status** tiles (no byte-throughput series exists
    for slskd; qbittorrent's cumulative counters need history) — curated, not verbose. bazarr stays
    owner-decide (Q-02) — instrumented, not yet panelled.
- **Satisfies:** PRD-001 new R-NN block (Metrics → Apps sub-tab; curated *arr/downloader panels;
  deep-link per group). Reuses PLAN-017's access model, `@hnet/metrics` Prometheus client, and
  `role_metrics_level` migration — **no new ADR/migration expected** (add a small ADR only if the
  dashboard-deep-link contract wants one). New DESIGN-NN (Apps sub-tab UX) and new OPS-NN
  (the two Grafana boards, sibling of OPS-007). Glossary: add "Apps metrics" if the DDD wants it.
  - **ID reconciliation:** ceilings re-grepped 2026-07-10 — ADR-036, DESIGN-015, OPS-007,
    migration 0030, R-116. **Plans 017/019/020 are authored in parallel tonight and consume
    numbers**; take next-free at authoring time and **re-grep first**. 018 most likely lands
    DESIGN-017-ish + OPS-009-ish + an R-block ≥ R-118 (after 017 takes its DESIGN-016/OPS-008/
    R-117). Do not hard-code — these are hints, not reservations.
- **Depends on:** **PLAN-017** (ships the Metrics shell, the `full`/`limited` access model, the
  read-only in-cluster Prometheus client, and the `metrics.*` tRPC router). 018 adds an *Apps*
  sub-tab + a `metrics.apps` query onto that foundation. Also depends on the **haynes-ops PR
  (below)** being merged so the exportarr/dashboard series exist — though every panel here reads
  metrics that are **already live** except the bazarr sidecar.
- **TODO source:** owner backlog "Metrics as a first class citizen"; owner RBAC ruling 2026-07-10
  (PLAN-017 §Access model); this recon session's live Prometheus verification.

---

## Companion infra: haynes-ops PR (opened, NOT merged — Flux applies main)

**PR:** https://github.com/thaynes43/haynes-ops/pull/2013 (`feat/exportarr-metrics`).
Additive & read-only. Contains:

1. **bazarr exportarr sidecar** — the one *arr that was un-instrumented. exportarr **v2.3.0**
   (the version the cluster already runs) supports bazarr (upstream since v1.6.0), so this
   mirrors the radarr/sonarr/lidarr/sabnzbd sidecar pattern (metrics port 9712 + ServiceMonitor,
   API key wired from `media-stack/BAZARR_API_KEY`). Populates `bazarr_*` series post-deploy.
2. **Two curated dashboard-as-code boards** (OPS-007 pattern, token-free JSON):
   `arr-library-overview` (folder Media) and `downloads-clients-indexers` (folder Downloads).

### Exporter coverage gap table (live-verified — all 6 existing targets UP)

| App | Kind | Before | After PR | If no exporter — why |
|-----|------|--------|----------|----------------------|
| radarr / sonarr / lidarr | *arr | exportarr ✅ | ✅ | — |
| prowlarr | indexer mgr | exportarr ✅ | ✅ | — |
| sabnzbd (+ sabnzbd-fast) | usenet | exportarr ✅ | ✅ | — |
| **bazarr** | subtitles | ❌ | **exportarr sidecar ✅** | — |
| qbittorrent | torrent | ❌ | ❌ (TODO Q-04) | exportarr can't do qbt; needs community `qbittorrent-exporter`, on a VPN pod with WebUI-auth nuance |
| slskd | soulseek | ❌ | ❌ (TODO Q-04) | first-party `/metrics` (`SLSKD_METRICS`), but enabling forces a 40–70 min share rescan on restart |
| soularr | Lidarr↔slskd bridge | ❌ | ❌ | cron/loop script — no HTTP metrics surface |
| ytdl-sub | batch downloader | ❌ | ❌ | one-shot job — no metrics surface |

### Dashboards imported + the live-verified series they use

- **`arr-library-overview`** (uid `arr-library-overview`): `radarr_movie_total` (live 9564),
  `sonarr_episode_total` (114118), `lidarr_albums_total` (55507),
  `*_movie/series/artists_monitored_total`, `*_movie/episode/songs_downloaded_total`,
  `radarr_movie_missing_total` / `sonarr_episode_missing_total` / `lidarr_albums_missing_total`,
  `radarr_movie_cutoff_unmet_total` / `sonarr_episode_cutoff_unmet_total`,
  `sum by (job)(*_queue_total)`, `rate(*_history_total[1h])*3600`,
  `*_system_health_issues`, `*_rootfolder_freespace_bytes{path=…}`.
- **`downloads-clients-indexers`** (uid `downloads-clients-indexers`): `sabnzbd_speed_bps{job}`,
  `increase(sabnzbd_downloaded_bytes[24h])`, `sabnzbd_remaining_bytes`, `sabnzbd_queue_length`,
  `prowlarr_indexer_enabled_total`, `sum(prowlarr_indexer_unavailable)`,
  `prowlarr_indexer_average_response_time_ms{indexer}`,
  `sum by (indexer)(rate(prowlarr_indexer_{queries,grabs,failed_queries}_total[30m]))*3600`,
  `up{job=~"sabnzbd|sabnzbd-fast|prowlarr"}`.

> **Reconciliation with the existing board:** `media-pipeline-resilience` already spans *arr +
> download clients but is **health/reachability-first** (up-targets, health issues, import-lag).
> The two new boards are **metrics-first** (totals, rates, trends) and are laid out to mirror the
> app sub-tab's panel groups so each group deep-links to a focused board. Keep all three; the
> resilience board stays the on-call/alerting view.

---

## Goal

The **Apps** sub-tab under Metrics (PLAN-017 shell): a curated, away-from-VPN view of how the
media-automation apps are doing — **what's in the libraries, how fast the pipeline is acquiring,
how the download clients and indexers are performing**. The app renders a trimmed set of native
panels (read from in-cluster Prometheus via `@hnet/metrics`, per 017) grouped into four groups,
each with a muted "open in Grafana" deep-link to the matching board for the deep-dive. Grafana
stays the power tool (deep-link, not embed — ADR-030 precedent; `grafana.haynesops.com` is
LAN-only so the deep-link is a footnote, and the in-app panels are the real surface off-LAN).

## Access model (inherit PLAN-017 — normative)

`full` / `limited` per role. **Key finding from the label audit:** every exportarr series this tab
uses is labelled only by `job`, `indexer`, `path`, `download_state`/`download_status`, `folder` —
**none carry user or requester identity**. Per the owner's ruling ("anything naming users/
requesters = full"), that means:

- **The entire Apps tab is BOTH-levels.** There is no full-only panel here, because no *arr/
  downloader metric names an individual. (This matches the task's expectation: *arr metrics are
  infrastructural.)
- **One nuance to confirm (Q-01):** the **sabnzbd-fast** lane is "the Seerr request fast lane" vs
  sabnzbd = automation. Splitting throughput by lane frames *aggregate* human-request activity,
  not individuals — so still both-levels under the ruling. Flag it so the owner can veto the
  lane-labelled framing at `limited` if he wants.
- Enforce level in the router shape (017 pattern), not the UI. Since nothing is full-only today,
  `metrics.apps` returns the same payload at both levels — **but keep the level-gated procedure
  wrapper** so that if a user-aware series is ever added (e.g. a future Tautulli/Seerr requester
  panel), it slots into the full-only branch without a refactor.

## Panel groups (app-native; curated subset; deep-link per group)

All queries below are **live-verified** against the cluster Prometheus (datasource `prometheus`,
`http://…observability.svc…:9090`, the 017 read path). Ranges use **fixed** windows (no
`$__` tokens — app issues instant + range queries directly).

### Group A — Collection (both levels) → deep-link `d/arr-library-overview`
- **Library size** (tiles): `radarr_movie_total`, `sonarr_episode_total`, `lidarr_albums_total`.
- **Monitored**: `radarr_movie_monitored_total`, `sonarr_series_monitored_total`,
  `lidarr_artists_monitored_total`.
- **Backlog — missing**: `radarr_movie_missing_total`, `sonarr_episode_missing_total`,
  `lidarr_albums_missing_total`.
- **Backlog — upgrades pending**: `radarr_movie_cutoff_unmet_total`,
  `sonarr_episode_cutoff_unmet_total`.

### Group B — Acquisition pipeline (both levels) → deep-link `d/arr-library-overview`
- **Queue depth by app**: `sum by (job) (radarr_queue_total)` (+ sonarr, lidarr, and
  `sabnzbd_queue_length` for the client side).
- **Grabs + imports rate (events/hr)**: `sum by (job) (rate(radarr_history_total[1h])) * 3600`
  (+ sonarr, lidarr). *(Live: sonarr ≈ 18/hr, radarr ≈ 0/hr at sample time — the counter moves.)*
- **System health issues**: `sum by (job) (radarr_system_health_issues)` (+ sonarr, lidarr).
- Optional queue-by-state detail: `sum by (job, download_state) (radarr_queue_total)` (label
  live-confirmed: `download_state ∈ {importPending, importBlocked, importFailed, …}`).

### Group C — Download client throughput (both levels) → deep-link `d/downloads-clients-indexers`
- **SAB speed now / trend**: `sabnzbd_speed_bps` (legend `{{job}}` → `sabnzbd`, `sabnzbd-fast`).
- **Downloaded (24h)**: `sum by (job) (increase(sabnzbd_downloaded_bytes[24h]))`.
- **Queue remaining**: `sabnzbd_remaining_bytes`; **queue length**: `sabnzbd_queue_length`.
- **(Pending exporters, Q-04):** torrent throughput (qbittorrent-exporter) + soulseek throughput
  (slskd `/metrics`) drop in here as extra series once the owner opts into those exporters.

### Group D — Indexers / Prowlarr (both levels) → deep-link `d/downloads-clients-indexers`
- **Fleet**: `sum(prowlarr_indexer_enabled_total)`, `sum(prowlarr_indexer_unavailable)`.
- **Avg response time**: `prowlarr_indexer_average_response_time_ms` (legend `{{indexer}}` —
  live: DrunkenSlug 425ms, NZBgeek 340ms, NinjaCentral 282ms, NZBFinder 244ms).
- **Query / grab / failed-query rate (per hr)**:
  `sum by (indexer) (rate(prowlarr_indexer_{queries,grabs,failed_queries}_total[30m])) * 3600`.
- **Reachability**: `up{job=~"sabnzbd|sabnzbd-fast|prowlarr"}` (and the *arr side in Group B).

## Build

1. **tRPC**: add `metrics.apps` to the 017 `metrics` router behind the level-gated procedure.
   Server issues the instant/range queries above via `@hnet/metrics`; shape the payload as the
   four groups. Keep the full-only branch present-but-empty (see Access model).
2. **UI**: an **Apps** sub-tab in the Metrics shell (017). Four grouped cards; reuse the 013/017
   meter + tile idioms and `@hnet/ui` (no new hex). Each group header carries a muted
   "Open in Grafana ↗" deep-link to its board uid (`grafana.haynesops.com/d/<uid>`, behind
   Authentik SSO, LAN-only — mirror the 013 footnote treatment). ADR-015 discipline: tiles/charts
   update in place, reflow-free; bounded poll (30–60s; stop when tab hidden).
3. **Ranges**: sparkline/last-24h in-app is enough; Grafana holds long history. Use fixed windows
   in the client (`[1h]`, `[30m]`, `[24h]`, `now-7d`) — no Grafana interval tokens.
4. **Stub**: extend the 017 stub Prometheus in `@hnet/test-utils` + `pnpm dev:local` to serve a
   handful of these `*_total` / `*_bps` / `prowlarr_indexer_*` series so the tab renders offline.
5. **OPS doc**: author OPS-NN describing the two boards + the app's deep-link coupling (sibling of
   OPS-007), and note the bazarr sidecar in the coverage table.

## Verification

- Merge gate (lint, lint:css, typecheck, test, build) + a router test proving the level wrapper is
  in place (both levels currently equal; the full-only branch is exercised by a fixture series).
- LIVE on staging + public origin: Apps tab renders real numbers (movies/episodes/albums match the
  *arr UIs; SAB speed matches the SAB UI during a download; indexer latencies plausible). Deep-links
  resolve on-LAN. Screenshots at 390px + desktop for the owner's morning review.
- After the haynes-ops PR merges + Flux reconciles: confirm `bazarr_*` series appear and (if a
  bazarr panel group is added later) the sidecar target is UP.

## Out of scope

qbittorrent/slskd/bazarr *app panels* beyond what live series support today (they arrive with the
exporters / a later iteration); alerting; any per-user/requester attribution (that would be a
full-only addition in a later plan once a user-aware source is wired).

## TODO-questions (owner, morning)

- **Q-01 (access):** OK to show the **sabnzbd-fast vs sabnzbd** lane split at `limited`? It frames
  aggregate human-request throughput (no individuals named). Keep, or collapse the two lanes into
  one "usenet" series at `limited`?
- **Q-02 (scope):** Is a **bazarr** panel group wanted on this tab (subtitle backlog / provider
  health), or is bazarr instrumentation just for Grafana/alerting? The sidecar ships either way.
- **Q-03 (dashboards):** Keep the two new boards **plus** `media-pipeline-resilience` (3 boards),
  or fold the resilience board's unique panels into these two and retire it? (I kept all three.)
- **Q-04 (exporters):** Do you want **torrent (qbittorrent)** and **soulseek (slskd)** throughput
  on the downloads group? Both are additive but each has a cost:
  - qbittorrent → community `qbittorrent-exporter` sidecar on the VPN pod; needs WebUI-auth
    handling and **no readiness probe** (its Mullvad-egress readiness gate pages Gatus — a failing
    exporter must not flip the pod NotReady).
  - slskd → first-party `SLSKD_METRICS=true` (+ `SLSKD_METRICS_NO_AUTH` for in-cluster scrape),
    but the env change **restarts slskd = a 40–70 min NFS share rescan**. Schedule deliberately.
  Say the word and I'll add either/both as a follow-up haynes-ops PR (ready-to-apply patterns
  already scoped).
- **Q-05 (deep-link vs native):** Same call as PLAN-013 — the in-app panels are the off-LAN
  surface and Grafana is the LAN footnote. Confirm that's still the desired split for this tab.
