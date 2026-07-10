# OPS-008: Apps metrics dashboards (\*arr + downloaders) — dashboard-as-code

- **Status:** Accepted — the two boards are **live** in Grafana (verified 2026-07-10 via the Grafana
  API: `arr-library-overview` in folder **Media**, `downloads-clients-indexers` in folder **Downloads**;
  both tagged `plan-018`). They are the deep-link targets of the Metrics → Apps sub-tab (DESIGN-018 D-06).
- **Implements:** the Grafana half of the DESIGN-018 curated/deep-link split (the ADR-030 C-04 /
  ADR-037 C-09 "deep-link, never embed" posture); sibling of **OPS-007** (media storage dashboard).
- **Sibling repo:** `haynes-ops` — the board JSON + the exportarr sidecars are delivered there
  (`feat/exportarr-metrics`, PR #2013). **This app repo only deep-links to the boards + reads the
  series; it does not own the JSON.** Secret *values* never appear here.

## 0. What they show, in one breath

The media-automation apps expose Prometheus series via **exportarr** sidecars (radarr/sonarr/lidarr/
prowlarr/sabnzbd(+fast)/**bazarr**) and first-party/sidecar exporters (**slskd** `/metrics`,
**qbittorrent** community exporter). Two curated boards turn those into **metrics-first** views (totals,
rates, trends) laid out to **mirror the app's Apps-tab panel groups**, so each group's "Open in Grafana ↗"
deep-link lands on the matching board:

- **`arr-library-overview`** (folder Media) — the **Collection** + **Acquisition pipeline** deep-dive
  (Groups A+B): library totals/monitored/missing/cutoff-unmet per \*arr, queue depth, grab/import rates,
  system-health issues, root-folder free space.
- **`downloads-clients-indexers`** (folder Downloads) — the **Download clients** + **Indexers** deep-dive
  (Groups C+D): SAB speed/volume/queue by `job` (sabnzbd vs sabnzbd-fast), Prowlarr indexer
  enabled/unavailable/response-time and query/grab/failed rates, target reachability.

> **Reconciliation with the existing `media-pipeline-resilience` board:** that board is
> **health/reachability-first** (up-targets, health issues, import-lag) and stays the on-call/alerting
> view. The two OPS-008 boards are **metrics-first** and are the app's deep-link targets. All three are
> kept (owner Q-03 — carried).

## 1. The boards (uids + the live-verified series they use)

**`arr-library-overview`** — title "Media \*arr — Library & Acquisition", folder Media
(uid `bfre4dl5p9xq8b`), datasource `prometheus`. Series (all live 2026-07-10):
`radarr_movie_total` (9564), `sonarr_episode_total` (114118), `lidarr_albums_total` (55507),
`*_{monitored,missing}_total`, `radarr_movie_cutoff_unmet_total` / `sonarr_episode_cutoff_unmet_total`,
`sum by (job)(*_queue_total)`, `sum(rate(*_history_total[1h]))*3600`, `*_system_health_issues`,
`*_rootfolder_freespace_bytes{path=…}`.

**`downloads-clients-indexers`** — title "Downloads — Clients & Indexers", folder Downloads
(uid `bfrnsjoddw1dse`), datasource `prometheus`. Series (all live 2026-07-10):
`sabnzbd_speed_bps{job}`, `sum by (job)(increase(sabnzbd_downloaded_bytes[24h]))` (sabnzbd ≈ 848 GB /
sabnzbd-fast ≈ 60 GB in 24h at sample), `sabnzbd_remaining_bytes`, `sabnzbd_queue_length`,
`sum(prowlarr_indexer_enabled_total)` (4), `sum(prowlarr_indexer_unavailable)`,
`prowlarr_indexer_average_response_time_ms{indexer}` (DrunkenSlug 335 / NZBgeek 339 / NinjaCentral 225 /
NZBFinder 237 ms), `sum by (indexer)(rate(prowlarr_indexer_{queries,grabs,failed_queries}_total[30m]))*3600`,
`up{job=~"sabnzbd|sabnzbd-fast|prowlarr|qbittorrent|slskd"}`.

## 2. Exporter coverage (live-verified 2026-07-10 — all targets UP)

| App | Kind | Exporter | Metrics on the Apps tab |
|-----|------|----------|-------------------------|
| radarr / sonarr / lidarr | \*arr | exportarr ✅ | Collection + Acquisition groups |
| prowlarr | indexer mgr | exportarr ✅ | Indexers group |
| sabnzbd (+ sabnzbd-fast) | usenet | exportarr ✅ | Download clients group (lane split by `job`) |
| **bazarr** | subtitles | **exportarr sidecar ✅ (new)** | instrumented; **not panelled** this round (owner Q-02) |
| **qbittorrent** | torrent | community sidecar ✅ (new) | reachability/status tile (`up`, `sum(torrents_count)`) |
| **slskd** | soulseek | first-party `/metrics` ✅ (new) | reachability/status tile (`up`, `enqueue_queue_depth`) |
| soularr / ytdl-sub | bridge / batch | none | no HTTP metrics surface (out of scope) |

The **bazarr exportarr sidecar** is the one \*arr that was un-instrumented before this wave; exportarr
v2.3.0 (the cluster's version) supports bazarr, mirroring the radarr/sonarr/lidarr/sabnzbd sidecar
pattern (metrics port 9712 + ServiceMonitor). It populates `bazarr_*` (live: `bazarr_subtitles_*_total`,
`bazarr_system_health_issues`). qbittorrent (`qbittorrent_up`/`_connected`/`_torrents_count`) and slskd
(`slskd_*`) were also deployed this wave and are live.

## 3. Deep-link (NOT embed) — the app coupling

The Apps sub-tab renders one muted **"Open in Grafana ↗"** footnote per group
(`https://grafana.haynesops.com/d/arr-library-overview` for Groups A+B,
`.../d/downloads-clients-indexers` for Groups C+D), opening behind the same Authentik SSO. As with
OPS-007, the boards are **deliberately not iframe-embedded**: post the `haynesnetwork.com` cutover the
Grafana session cookie is cross-site and Authentik refuses in-iframe login — and `grafana.haynesops.com`
resolves **LAN-only**, so the deep-link is a footnote. The app's **native tiles are the off-LAN
surface**; the boards are the verbose LAN deep-dive.

## 4. Dashboard-as-code delivery + rollback

The board JSON is committed to `haynes-ops` (PR #2013) and delivered by a `configMapGenerator`
(`grafana_dashboard: "true"`, `grafana_folder: Media` / `Downloads`); the Grafana sidecar auto-imports.
The JSON is **token-free** (`$__range`/`$__rate_interval` stripped for fixed `now-…` windows) so Flux
`postBuild.substitute` can't blank Grafana's built-ins — the OPS-007 discipline. **This app repo does
not modify that JSON** (owned by haynes-ops). Rollback is read-only/additive: revert the haynes-ops
commit and reconcile; the app's deep-links then 404 gracefully (a footnote link, not a data source).

## Related

- OPS-007 (media storage dashboard — the dashboard-as-code pattern + the deep-link-not-embed rationale),
  DESIGN-018 (the native Apps sub-tab + the per-group deep-link), ADR-037 (the Metrics read path),
  ADR-030 C-04 (deep-link, never embed).
