# DESIGN-018: Metrics — Apps sub-tab (\*arr + downloaders)

- **Status:** Accepted
- **Last updated:** 2026-07-10
- **Satisfies:** PRD-001 **R-125..R-126**; governed by **ADR-037** (the Metrics access model + the
  read-only Prometheus read path) — **no new ADR**: the per-group Grafana deep-link reuses the
  ADR-030 C-04 / ADR-037 C-09 "deep-link, never embed" decision, and the Full/Limited enforcement is
  ADR-037 C-03 verbatim. Extends **DESIGN-016** (the shell, the `@hnet/metrics` reader, the
  `metricsProcedure` gate, the meter/tile idioms, the ADR-015 no-reflow / bounded-poll posture).
  Companion **OPS-008** documents the two curated Grafana boards + the bazarr sidecar. Glossary
  **T-113**.

## Overview

The **Apps** sub-tab under Metrics (the DESIGN-016 shell) is a **curated, phone-friendly** view of how
the media-automation apps are doing away from the VPN: what is in the libraries, how fast the pipeline
is acquiring, and how the download clients and indexers are performing. It renders a trimmed set of
native tiles/rows read from the in-cluster Prometheus (via `@hnet/metrics`, per DESIGN-016 D-02),
grouped into **four panel groups**, each with a muted **"Open in Grafana ↗"** deep-link to the matching
curated board for the deep-dive. Grafana stays the verbose LAN power tool; the native panels are the
off-LAN surface (the DESIGN-013 / DESIGN-016 split).

This plan is **purely additive on the 017 foundation**: **no migration, no new column, no new section
id, no new `metrics_level`, no `no-direct-state-writes` guard edit, no nav change.** The `'apps'` tab
key already exists in `METRICS_TABS` (017 scaffolded it as a "coming soon" placeholder); this design
fills it in.

## Detailed design

### D-01 — No data model change (rides the 017 foundation)

The Apps sub-tab persists **nothing**. Visibility is the existing **`metrics`** Section Permission
(ADR-037 C-02, `disabled` no-row default ⇒ ships Admin-only); granularity is the existing
**`roles.metrics_level`** (ADR-037 C-01). No new `SECTION_IDS`, `METRICS_LEVELS`, `APP_SETTING_KEYS`,
or `permission_audit` action is introduced, so **there is no migration** and **no guard edit**. Stated
explicitly so a reader isn't surprised by the absence of a `00NN_*.sql` in this PR.

### D-02 — The read model: `getAppsMetrics` in `@hnet/metrics`

A new `packages/metrics/src/apps.ts` (exported from `index.ts`) mirrors `overview.ts`: exported PromQL
constants (verified live 2026-07-10 against the cluster `prometheus` datasource), typed group shapes,
and a single `getAppsMetrics({ prometheus, includeUserAware })` read that fires all instant queries in
parallel and **degrades each field independently to `null`** (the `readScalar` try/catch idiom — a
failed/empty query never throws). It reuses the DESIGN-016 D-02 `PrometheusReader` seam verbatim (no
client change: instant `query` is all Apps needs).

```ts
export interface GetAppsMetricsInput {
  prometheus: PrometheusReader;
  /** level === 'full'. Gates the full-only branch (present-but-empty today — see D-05). */
  includeUserAware: boolean;
}
export async function getAppsMetrics(input: GetAppsMetricsInput): Promise<AppsMetrics>;

export interface AppsMetrics {
  collection: CollectionGroup;   // Group A
  pipeline: PipelineGroup;       // Group B
  downloads: DownloadsGroup;     // Group C
  indexers: IndexersGroup;       // Group D
  /** FULL-ONLY seam (ADR-037 C-03). OMITTED at `limited`; present-but-empty (`[]`) at `full` — no
   *  *arr/downloader series names a user today, so nothing populates it yet (D-05). */
  requesterActivity?: RequesterActivityRow[];
}
```

Group shapes (each carries an `unavailable` flag = "every field in the group was unreadable"):

- **`CollectionGroup`** — `rows: ArrLibraryRow[]` for `radarr` (Movies) / `sonarr` (TV episodes) /
  `lidarr` (Albums), each `{ key, label, total, monitored, missing, cutoffUnmet }`
  (`cutoffUnmet` is `null` for lidarr — no `lidarr_*_cutoff_unmet_total` series exists).
- **`PipelineGroup`** — `rows: ArrPipelineRow[]` per \*arr `{ key, label, queue, grabsPerHour,
  healthIssues }`.
- **`DownloadsGroup`** — `usenet: SabLane[]` (`sabnzbd`, `sabnzbd-fast`) each `{ key, label, speedBps,
  downloaded24hBytes, remainingBytes, queueLength, up }`, plus `clients: ClientStatus[]` (qbittorrent,
  slskd) each `{ key, label, up, detail }`.
- **`IndexersGroup`** — `{ enabled, unavailableCount, rows: IndexerRow[] }`, each `IndexerRow`
  `{ indexer, avgResponseMs, queriesPerHour }` (sorted by `indexer`).

### D-03 — The PromQL (live-verified 2026-07-10)

Instant queries only (fixed windows for rates — no Grafana `$__` tokens). Per-\*arr scalars use
`sum(...)` so a per-`download_state`/per-`indexer` label breakdown collapses to one number:

| Group | Field | PromQL |
|-------|-------|--------|
| A | total | `radarr_movie_total` · `sonarr_episode_total` · `lidarr_albums_total` |
| A | monitored | `radarr_movie_monitored_total` · `sonarr_series_monitored_total` · `lidarr_artists_monitored_total` |
| A | missing | `radarr_movie_missing_total` · `sonarr_episode_missing_total` · `lidarr_albums_missing_total` |
| A | cutoffUnmet | `radarr_movie_cutoff_unmet_total` · `sonarr_episode_cutoff_unmet_total` (lidarr: none) |
| B | queue | `sum(<arr>_queue_total)` |
| B | grabsPerHour | `sum(rate(<arr>_history_total[1h])) * 3600` |
| B | healthIssues | `sum(<arr>_system_health_issues)` |
| C | speedBps | `sabnzbd_speed_bps` (vector, legend `job` → `sabnzbd`/`sabnzbd-fast`) |
| C | downloaded24hBytes | `sum by (job) (increase(sabnzbd_downloaded_bytes[24h]))` |
| C | remainingBytes / queueLength | `sabnzbd_remaining_bytes` / `sabnzbd_queue_length` (by `job`) |
| C | client up | `up{job="qbittorrent"}` · `up{job="slskd"}`; qbt detail `sum(qbittorrent_torrents_count)`; slskd detail `slskd_enqueue_queue_depth_current` |
| D | enabled / unavailable | `sum(prowlarr_indexer_enabled_total)` / `sum(prowlarr_indexer_unavailable)` |
| D | avgResponseMs | `prowlarr_indexer_average_response_time_ms` (vector, legend `indexer`) |
| D | queriesPerHour | `sum by (indexer) (rate(prowlarr_indexer_queries_total[30m]) * 3600)` |

Vector reads (SAB lanes by `job`, indexers by `indexer`) fold samples by their label into rows, the
same way `mergeWanLinks` reads `s.metric.wan_name` in `overview.ts`.

### D-04 — The tRPC procedure `metrics.apps`

Added to `metricsRouter` (`packages/api/src/routers/metrics.ts`), gated by `metricsProcedure`
(section ≥ read_only — visibility) and shaped by `effectiveMetricsLevel` (granularity), exactly like
`metrics.overview`:

```ts
apps: metricsProcedure.query(async ({ ctx }): Promise<AppsMetrics> => {
  const level = effectiveMetricsLevel(ctx.user.role);
  return getAppsMetrics({
    prometheus: resolveMetricsReader(ctx),
    includeUserAware: level === 'full',
  });
}),
```

The read model catches per-field, so the procedure needs no extra try/catch; an entirely-down
Prometheus yields all-null groups (each `unavailable: true`) — the UI shows muted notes, never a 500.

### D-05 — Access: both-levels, but the full-only seam stays plumbed (ADR-037 C-03)

The 2026-07-10 label audit found **no \*arr/downloader series carries user/requester identity** — the
labels are `job`, `indexer`, `path`, `download_state`, `category` (the qbittorrent `category` label is
the \*arr client name — `radarr`/`sonarr`/`lidarr`/`Uncategorized` — **not a user**). So **the entire
Apps tab is both-levels**: `getAppsMetrics` returns the same four groups at `full` and `limited`.

The level seam is still wired so a future user-aware panel (e.g. a Seerr/Tautulli **requester** panel)
slots into the full-only branch **without a refactor**: `requesterActivity` is present (as `[]`) only
when `includeUserAware`, and **omitted** at `limited` — the identical never-fetch/never-serialize shape
the `network.wanLinks` seam uses. A unit test asserts `'requesterActivity' in payload === false` for a
`limited` caller and `=== true` (empty) for `full`. The **SABnzbd fast-lane split** frames *aggregate*
human-request throughput (no individual named), so it stays both-levels pending owner veto (Q-01).

### D-06 — The UI: `apps-tab.tsx`

A new `apps/web/app/(app)/metrics/apps-tab.tsx` mirrors `overview-tab.tsx`. It is branched into
`metrics-client.tsx` at `active === 'apps'` (the tab button already exists). It reuses the Overview's
**bounded poll**: `trpc.metrics.apps.useQuery(undefined, { enabled: active, refetchInterval: active ?
45_000 : false, refetchOnWindowFocus: false, placeholderData: (prev) => prev })` — polling only while
the sub-tab is mounted+active, React-Query auto-pausing while `document.hidden`, and dimming in place
(ADR-015 — no reflow). It reuses the `.metrics-tile` / `.metrics-meter` idioms and the `lib/metrics`
presentation helpers; new byte/rate/count formatters live in `lib/metrics.ts` (pure, unit-tested).

Layout: four **`.metrics-group`** cards, each a header row (`h2` group title + a muted "Open in
Grafana ↗" `<a target="_blank" rel="noreferrer">` to the group's board uid) over a `.metrics-overview__grid`
of tiles / a compact `.metrics-apps-table`. Deep-link targets:
`https://grafana.haynesops.com/d/arr-library-overview` (Groups A+B) and `.../d/downloads-clients-indexers`
(Groups C+D). Any group whose `unavailable` is true renders a muted "unavailable" note in place of its
tiles. **No sparklines in-app** — the time-series live in Grafana (owner philosophy: curated app, verbose
Grafana). **No new hex** — new `.metrics-group` / `.metrics-apps-table` classes use `--color-*` tokens in
`app.css` (the DESIGN-016 block).

### D-07 — e2e stub extension

`apps/web/e2e/support/stub-prometheus.ts` gains canned instant vectors for the D-03 app series
(substring-matched on `query`, most-specific first), so the Apps tab renders deterministic numbers
offline. `apps/web/e2e/metrics.spec.ts` gains an advisory Apps step (open `?tab=apps`, assert the group
headings + a known reading, and that the Grafana deep-links resolve to the two board uids). `mode:'down'`
already degrades every `/api/v1/query` to 500 → the Apps degrade path is exercised by the existing
toggle.

## Alternatives considered

- **A bazarr subtitle-backlog group now.** The bazarr exportarr sidecar is live (`bazarr_*` series),
  but per the plan's "fewer panels when in doubt" and owner Q-02, bazarr stays **instrumented, not
  panelled** this round — it slots in behind the same idioms later if the owner wants it.
- **In-app sparklines / trend charts.** Rejected for the curated tab — Grafana is the verbose layer and
  `@hnet/ui` has no sparkline primitive; adding one is scope the owner explicitly deprioritized.
- **A shared `@hnet/ui` meter/tile.** Same call as DESIGN-016 — the tile/meter is a local component +
  CSS classes; the `@hnet/ui` `ProgressMeter` is `role="progressbar"`, the wrong semantics.
- **A new ADR for the deep-link contract.** Unnecessary — ADR-030 C-04 / ADR-037 C-09 already decided
  deep-link-not-embed; this reuses it.

## Test strategy

- **`packages/metrics/__tests__/apps.test.ts`** — a stub `PrometheusReader` returns canned vectors;
  assert each group maps correctly (per-\*arr rows, SAB lanes by `job`, indexers by `indexer`), that a
  throwing/empty query degrades that field to `null` (and its group's `unavailable`), and the
  `includeUserAware` seam (`requesterActivity` present-but-empty at full, absent at limited).
- **`packages/api/__tests__/metrics.test.ts`** — extend with `metrics.apps`: a `disabled`-section
  member is `FORBIDDEN`; a `read_only` member and an admin both receive the four groups; the
  full-only-seam invariant (`'requesterActivity' in payload`) matches the caller's level.
- **Merge gate** — `lint`, `lint:css` (no new hex), `typecheck`, `test`, `build` all green.
- **Live** — the deployed pod's Apps tab renders real numbers matching direct Prometheus queries
  (movies/episodes/albums; indexer latencies), gates hold (unauth 401/UNAUTHORIZED), 390px + desktop
  screenshots for the owner's morning review.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Show the **sabnzbd-fast vs sabnzbd** lane split at `limited` (aggregate human-request throughput, no individuals named)? | Kept both-levels (D-05); owner may veto the lane framing at `limited` in the morning. Carried from PLAN-018 Q-01. |
| Q-02 | Add a **bazarr** subtitle-backlog panel group (the sidecar is live), or keep bazarr for Grafana/alerting only? | Deferred — instrumented, not panelled (Alternatives). Carried from PLAN-018 Q-02. |
| Q-03 | Add **qbittorrent/slskd byte-throughput** panels once history accrues / a throughput series exists? | This round ships reachability/status tiles only (no slskd byte series; qbt counters need history). Follow-up. |
