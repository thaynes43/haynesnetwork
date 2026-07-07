# ADR-030: Disk-utilization + reclaim-metrics surface (HYBRID: Grafana infra series + native PG reclaim)

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (PLAN-013 build run)
- **Relates:** [ADR-023](023-trash-and-maintainerr.md) / [DESIGN-010](../designs/010-trash-and-maintainerr.md)
  (Trash), [ADR-025](025-trash-curation-pipeline.md) / [DESIGN-011](../designs/011-trash-curation-pipeline.md)
  (the deletion-snapshot columns this consumes), [ADR-018](018-library-metadata-modeling.md)
  (`media_metadata.resolution`). Realized by [DESIGN-013](../designs/013-disk-and-reclaim-metrics.md)
  + [OPS-007](../ops/007-media-storage-dashboard.md). Implements PRD **R-108..R-111**; glossary
  **T-95..T-97**.

## Context and problem statement

The owner wants the space story made **measurable** (PLAN-013): current disk utilization per media
server against a **space target** (e.g. "HaynesTower < 80%"), the fill/drain **trend** over time, and
**reclaim attribution** from the Trash pipeline's deletions — reclaimed bytes by category (TV vs
Movies) and by resolution ("15 × 720p = 10% of the reclaim, 3 × 4K = 90%"). The core open decision
(PLAN-013 Q-01) was **where this surfaces**: an embedded/internal **Grafana** dashboard (the estate
already runs Grafana behind Authentik) vs a **native in-app** metrics page.

Recon (live-verified 2026-07-07 against `main`, the CNPG primary, the `haynes-ops` Prometheus, and the
live *arr APIs) surfaced three load-bearing facts that steer the decision:

1. **The media libraries are invisible to node-exporter AND kubelet.** node-exporter scrapes only the
   six Talos node system disks; `kubelet_volume_stats` covers only the *arr/Plex config PVCs. The
   media-library free-space series exists **only** via the `*-exportarr` sidecars
   (`{radarr,sonarr,lidarr}_rootfolder_freespace_bytes`, labelled with the mount `path`) — and that
   metric carries **freeSpace only, no total**.
2. **The only source with a `totalSpace`** (needed for a utilization %) is the *arr `GET /diskspace`
   API. Live it agrees with exportarr's freeSpace to ~0.03% (HaynesTower: 112.43 TB free / 529.96 TB
   total = **78.8% used**).
3. **The rich, frozen reclaim dataset is Postgres, not Prometheus** — the `trash_batch_items`
   deletion-snapshot columns (`deleted_size_bytes`, `deleted_resolution`, `deleted_*_rating`,
   `deleted_at`) written in the same tx as `state='deleted'` by the batch sweep. Category (movie/tv)
   is on the parent `trash_batches`; attribution is `trash_batches.greenlit_by`.

## Decision drivers

- **Mobile experience** — the owner curates from a phone; the surface must be excellent there.
- **Auth integration that survives the cutover** — the app moves to `haynesnetwork.com` (PLAN-008
  R-64) while Grafana stays `grafana.haynesops.com`.
- **Where the data naturally lives** — utilization % + reclaim attribution favor native (arr API +
  Postgres); the historical time-series favors Grafana (Prometheus retention).
- Read-only / additive throughout; the *arr write-back guard and Trash deletion paths untouched.
- Visual-identity fit (DESIGN-006) for anything rendered in-app.

## Considered options

1. **Embed Grafana in an iframe** for everything. Rejected for v1 — see C-04: the embed is
   **same-site only today** (app + Grafana share `haynesops.com`, so the SameSite=Lax Grafana session
   cookie flows into the iframe), but at the `haynesnetwork.com` cutover it becomes **cross-site**, the
   Lax cookie stops flowing, and the in-iframe redirect to Authentik login is refused by Authentik's
   framing headers. Making it work would need `GF_SECURITY_COOKIE_SAMESITE=none` (a real CSRF
   loosening) and still likely fails at the Authentik-login step.
2. **Pure native** — recompute the fill/drain trend in-app from periodic diskspace snapshots into our
   own table. Rejected for the trend: Prometheus already retains the exportarr series with history; a
   second, lossier time-series store is wasteful. (Native is chosen for the *point-in-time* utilization
   and for reclaim, which Prometheus does not hold.)
3. **HYBRID (chosen).** Native in-app pages for point-in-time utilization + reclaim attribution
   (Postgres + the arr diskspace API); **Grafana, deep-linked (not embedded)** for the fill/drain
   time-series off exportarr. The owner ratified HYBRID on 2026-07-07.

## Decision outcome

Chosen option: **3 (HYBRID)**, with Grafana **deep-linked, not iframe-embedded**.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Reclaim attribution is a native in-app page** sourced from Postgres `trash_batch_items` deletion snapshots (batch-swept items only — the clean, frozen dataset). Category × resolution, cumulative-by-day, and per-batch rollup (attributed to `greenlit_by`) all come from `getReclaim`. Direct-expedites lack frozen size/resolution historically, so they are a **best-effort second-class series** (see C-01b), never the resolution breakdown. |
| C-01b | **Direct-expedite forward-capture.** The direct-Expedite path previously froze NO size/resolution into any durable record. PLAN-013 enriches the `trash_expedited` ledger-event payload **and** the deletion-audit notification payload with frozen `{sizeBytes, resolution, imdbRating, tmdbRating}` from the same live/pending row already in scope (jsonb payloads — no new table/migration). `getReclaim` UNIONs a best-effort expedite total from those payloads; the owner's 2 pre-capture historical expedites carry no size and are excluded (documented). |
| C-02 | **Infra disk trend (fill/drain) surfaces via Grafana** off exportarr `{radarr,sonarr,lidarr}_rootfolder_freespace_bytes` — **not** node-exporter/kubelet, neither of which observes the media libraries. Dashboard-as-code in `haynes-ops` (OPS-007), sidecar-imported into the **Media** folder. |
| C-03 | **Utilization source of record = the *arr `GET /diskspace` API** (the only read carrying `totalSpace`, so the only source for a utilization %). exportarr freeSpace is the trend/history source; the two agree to ~0.03% live. The native card reads diskspace; a downed *arr yields a partial result (`unavailable`), never a crash. |
| C-04 | **Grafana surface = deep-link, not iframe embed, for v1.** The cross-site Grafana session cookie breaks the embed after the `haynesnetwork.com` cutover and Authentik refuses in-iframe login. `GF_SECURITY_ALLOW_EMBEDDING: true` is left as-is so a *later* same-root embed remains possible, but v1 links out to the dashboard by uid (`media-storage-utilization`), which opens behind the same Authentik SSO the user already holds — best mobile experience, zero cross-site-cookie risk, no `SameSite=none` loosening. |
| C-05 | **The space target lives in `app_settings`** under a new `space_targets` key (jsonb, keyed by `plex_servers.slug` → percent-used ceiling; default `{}`), set through the audited `setAppSetting` single-writer. Owned + displayed here (013); **acted on by PLAN-014** (Q-03 split). CHECK-relax migration **0021** admits the key (mirrors 0019's `motd`). A documented slug→rootfolder-path map (DESIGN-013 §4) reconciles the owner's per-server model with the physical mounts. |
| C-06 | (Cost/risk) **The media-library disk trend depends on the exportarr sidecars staying scraped.** There is **no HaynesTower node-exporter/SMART fallback** — it is external to the cluster and unscraped. If exportarr stops, the Grafana trend goes blank (the native diskspace card still works, as it reads the live *arr API). A utilization-% *trend* additionally needs the total baked in as a constant (exportarr has no total), which is fragile as the array grows — hence the trend plots free-bytes with a static target line, not a %. |

## More information

- Native reads are **admin-gated** for v1 (`storage.*` = adminProcedure): operational data. DESIGN-013
  notes a future section-permission if it ever goes member-facing.
- Live verification 2026-07-07: HaynesTower `/data/haynestower` 112.43 TB free / 529.96 TB total =
  78.8% used (diskspace API); `/data/cephfs-hdd` 130.45 TB free / 174.84 TB total = 25.4% used;
  exportarr vs diskspace freeSpace differ by ~28 GiB (0.03%). `trash_batch_items` state='deleted' rows
  = 0 today (the reclaim page starts empty and accrues from sweeps — "consumes, never backfills").
- Grafana dashboard uid `media-storage-utilization` in the Media folder; deep-link
  `https://grafana.haynesops.com/d/media-storage-utilization` (OPS-007).
