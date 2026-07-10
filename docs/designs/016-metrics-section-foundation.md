# DESIGN-016: Metrics section foundation — shell + Overview + Full/Limited access

- **Status:** Accepted
- **Last updated:** 2026-07-10
- **Satisfies:** PRD-001 **R-117..R-120**; governed by **ADR-037** (access model + Prometheus read path).
  Reuses ADR-021/DESIGN-009 section permissions, ADR-025 C-06 `app_settings`, and ADR-030/DESIGN-013
  (`getUtilization` snapshot, the `.storage-array` meter idiom, the Grafana deep-link, the ADR-015
  no-reflow posture). Glossary **T-106..T-109**.

## Overview

The **foundation** for a top-level **Metrics** section: a role-gated nav entry (after Bulletin), a
sub-tab **shell** (Overview live; Apps/Hardware/Network as "coming soon" placeholders for 018/019/020),
and a live **Overview** of the estate's most useful numbers — WAN upload/download **usage-vs-capacity**
meters, a cluster load + memory tile, and a storage-utilization snapshot (REUSING 013's `getUtilization`).
A per-role **metrics level** (`full` | `limited`) shapes the payload **server-side**; a `metrics` section
permission gates **visibility** and ships **Admin-only**. The read path is a new read-only `@hnet/metrics`
Prometheus client against the in-cluster `kube-prometheus-stack` (ADR-037).

## Detailed design

### D-01 — Data model + migration 0031 (additive)

One migration, `packages/db/migrations/0031_metrics_foundation.sql`, does four additive things (each a
CHECK rebuild copying the current full array verbatim + appending), plus the journal entry (`idx: 30`,
`tag: "0031_metrics_foundation"`, `version: "7"`):

1. **`roles.metrics_level`** — `text NOT NULL DEFAULT 'limited'` + CHECK `roles_metrics_level_enum`
   (`full` | `limited`). Seed: `UPDATE roles SET metrics_level='full' WHERE is_admin` (cosmetic — the
   session short-circuits admin ⇒ `full`). Column mirrors `grants_all` (a single value per role).
2. **`permission_audit` action CHECK** rebuilt to admit `'update_role_metrics_level'`.
3. **`role_section_permissions` section CHECK** rebuilt to admit `'metrics'`.
4. **`app_settings.key` CHECK** rebuilt to admit `'upload_capacity_mbps'` + `'download_capacity_mbps'`.

`enums.ts` is the single source of truth for all four (const arrays → TS types + the SQL lists):
`METRICS_LEVELS = ['full','limited']` (+ `METRICS_LEVEL_RANK = { limited:0, full:1 }`), `SECTION_IDS +=
'metrics'` (+ `SECTION_DEFAULT_LEVELS.metrics = 'disabled'`), `PERMISSION_AUDIT_ACTIONS +=
'update_role_metrics_level'`, `APP_SETTING_KEYS += 'upload_capacity_mbps','download_capacity_mbps'`.
No new state **table** ⇒ **no `no-direct-state-writes` guard edit** (`roles` + `app_settings` already
covered). A migration-parity test asserts the CHECKs admit the new values.

`@hnet/domain` `app-settings.ts`: `AppSettingValueMap` gains `upload_capacity_mbps: number` +
`download_capacity_mbps: number`; `APP_SETTING_DEFAULTS` seeds `300` / `2256` (download **provisional,
TODO Q-02**). Absent key ⇒ default (no seed row needed); the `typeof`-number guard keeps a garbage row safe.

### D-02 — `@hnet/metrics` package (read-only Prometheus client + read models)

New workspace package `@hnet/metrics` (raw TS, no build step, `exports: { ".": "./src/index.ts" }`, dep
`zod`), mirroring `@hnet/arr`'s skeleton. **No `/write` subpath, no import-confinement** (no write
surface — ADR-037 C-07).

- **`client.ts`** — `createPrometheusClient({ baseUrl, fetchImpl?, timeoutMs? }): PrometheusReader` with
  `query(promQL, atSec?)` (instant `GET /api/v1/query`, vector) **and** `queryRange(promQL, start, end,
  step)` (range `GET /api/v1/query_range`, matrix). zod-validates both envelopes; throws plain `Error`s
  on HTTP/shape failure (callers catch into the degrade). `prometheusClientFromEnv(env)` reads
  `PROMETHEUS_URL ?? PROMETHEUS_DEFAULT_URL` where the default is
  `http://kube-prometheus-stack-prometheus.observability.svc.cluster.local:9090` (ADR-037 C-08).
- **`overview.ts`** — the two Prometheus-derived reads. Each fires its instant queries in parallel and
  **degrades independently** (a failed query ⇒ that field `null` / `unavailable:true`, never a throw):

  ```ts
  // Network — usage-vs-capacity; wanLinks only when includeWanLinks (full).
  export interface MetricsMeter { usageMbps: number | null; capacityMbps: number; pct: number | null }
  export interface WanLink { id: string; label: string; capacityUpMbps: number | null;
    capacityDownMbps: number | null; usageUpMbps: number | null; usageDownMbps: number | null }
  export interface NetworkOverview { upload: MetricsMeter; download: MetricsMeter;
    wanLinks?: WanLink[]; unavailable: boolean }
  export function getNetworkOverview(o: { prometheus: PrometheusReader;
    uploadCapacityMbps: number; downloadCapacityMbps: number; includeWanLinks: boolean }): Promise<NetworkOverview>

  export interface HardwareOverview {
    nodes: { count: number; coresTotal: number; load1Total: number; loadPerCorePct: number } | null;
    memory: { usedBytes: number; totalBytes: number; pct: number } | null; unavailable: boolean }
  export function getHardwareOverview(o: { prometheus: PrometheusReader }): Promise<HardwareOverview>
  ```

  **The verified PromQL (ADR-037 recon):** upload usage `sum(unpoller_site_transmit_rate_bytes{subsystem="wan"})`
  and download `sum(unpoller_site_receive_rate_bytes{subsystem="wan"})`, each `× 8 / 1e6` → Mbps;
  `pct = capacityMbps > 0 ? min(usage/capacity·100, …) : null`. WAN links (full only):
  `unpoller_wan_provider_upload_kbps` / `unpoller_wan_provider_download_kbps` keyed by `wan_name`
  (capacity `/1000` → Mbps), current per-link rate from `unpoller_device_wan_transmit_rate_bytes` /
  `unpoller_device_wan_receive_rate_bytes`. Nodes: `sum(node_load1)`, `count(node_load1)`,
  `count(count by (instance,cpu)(node_cpu_seconds_total{mode="idle"}))` (cores); memory:
  `sum(node_memory_MemTotal_bytes)` and `… - sum(node_memory_MemAvailable_bytes)` (used).

### D-03 — Session + gate (server-authoritative level enforcement)

- **`@hnet/auth` `session-extension.ts`**: `SessionRole` gains `metricsLevel: MetricsLevel`; the existing
  `users ⋈ roles` select adds `roles.metricsLevel`; the returned role sets
  `metricsLevel: row.isAdmin ? 'full' : row.metricsLevel` (admin short-circuit). **No extra query.**
- **`@hnet/api` `middleware/role.ts`**: `effectiveMetricsLevel(role)` (admin ⇒ `full`) + `metricsProcedure`
  = `sectionProcedure('metrics','read_only')` (visibility gate) — the resolver reads
  `effectiveMetricsLevel(ctx.user.role)` to shape the payload. Level enforcement is therefore in the
  **payload shape**, not the UI (ADR-037 C-03).

### D-04 — tRPC surface (`metricsRouter`) + capacity + the audited flip

`metrics` router registered in `routers/index.ts`. A Prometheus reader is injected on `ctx`
(`resolveMetricsReader(ctx)` — stub in tests, env singleton in prod, mirroring `resolvePrometheusReader`):

| Procedure | Gate | Input | Returns |
| --------- | ---- | ----- | ------- |
| `metrics.access` | `authedProcedure` | — | `{ level: MetricsLevel; canSee: boolean }` (the caller's own level + whether the section is visible) |
| `metrics.overview` | `metricsProcedure` | — | `MetricsOverview` (below), shaped by the caller's level |
| `metrics.capacity.get` | `adminProcedure` | — | `{ uploadMbps: number; downloadMbps: number }` |
| `metrics.capacity.setUpload` | `adminProcedure` | `{ mbps: int 0..1e6 }` | audited `setAppSetting` result |
| `metrics.capacity.setDownload` | `adminProcedure` | `{ mbps: int 0..1e6 }` | audited `setAppSetting` result |

```ts
export interface MetricsOverview {
  level: MetricsLevel;                 // echoed so the UI can label the Limited/Full view
  network: NetworkOverview;            // wanLinks present ONLY when level === 'full'
  hardware: HardwareOverview;          // ungated (both levels)
  storage: StorageArrayUtilization[];  // REUSE getUtilization (013) — not user-aware, both levels
}
```

The **audited role-level flip** lives on the roles router (kept with the rest of role editing):
`roles.setMetricsLevel({ roleId, level })` (`adminProcedure` → `setRoleMetricsLevel` single-writer);
`roles.list` gains `metricsLevel` per role so the editor can render + change it.

**Level enforcement (the testable invariant):** for `limited`, `metrics.overview` calls
`getNetworkOverview({ …, includeWanLinks: false })` so `network.wanLinks` is `undefined` and never
serialized; for `full`, `includeWanLinks: true`. Unit test: a `limited` caller's `overview()` has no
`network.wanLinks`; a `full` caller's does (and a `disabled`-section caller gets `FORBIDDEN`).

### D-05 — UI: section shell + Overview (ADR-015, no new hex)

- **Nav** — `apps/web/components/top-bar.tsx`: `showMetrics = (perms.metrics ?? 'disabled') !== 'disabled'`,
  a `<Link href="/metrics">Metrics</Link>` inserted immediately after Bulletin; the structural
  `TopBarUser.sectionPermissions` union gains `'metrics'`.
- **Route + gate** — `apps/web/app/(app)/metrics/page.tsx` (server component, copies `bulletin/page.tsx`):
  `effectiveSectionLevel(role,'metrics') === 'disabled'` ⇒ a `data-testid="metrics-unavailable"`
  empty-state card; else render `<MetricsClient level={level} />`.
- **Shell** — `apps/web/app/(app)/metrics/metrics-client.tsx` (`'use client'`, `useSearchParams`-driven
  `?tab=` tabs mirroring `trash-client.tsx`): `Overview` live; `Apps`/`Hardware`/`Network` render a muted
  "Coming soon" placeholder (they land with 018/019/020). Reuses the shared `.library-tabs` `role="tablist"`
  grammar (no new tab CSS).
- **Overview** — `apps/web/app/(app)/metrics/overview-tab.tsx`: polls `trpc.metrics.overview` bounded at
  **45s**, `enabled` only when Overview is the active sub-tab, `refetchOnWindowFocus:false` (React Query
  auto-pauses `refetchInterval` while `document.hidden` — free tab-hidden stop), `placeholderData:(p)=>p`
  so refetches **dim in place** (ADR-015). Renders:
  - **Upload meter** + **Download meter** — the `.storage-array` meter idiom (a `role="meter"` div, fill
    width `= pct`, a tick at 100%, tone deepening ok → warn (≥ 75%) → danger (≥ 90%) via `--meter-tone`
    set to `--color-accent`/`--color-warning`/`--color-danger`). Caption: "`{usage} of {capacity} Mbps`".
    `unavailable` ⇒ a muted "couldn't reach the gateway" state, never an error.
  - **Cluster tile** — nodes · load-per-core % · memory %.
  - **Storage snapshot** — one compact row per `StorageArrayUtilization` (reuse `formatCapacity` /
    `utilizationTone` from `apps/web/lib/storage.ts`), NOT a re-query of diskspace.
  - **Full-only:** a per-WAN-link mini-list (primary/failover capacity + current), shown only when
    `overview.network.wanLinks` is present (i.e. the caller is `full`). A muted note under the meters
    tells a `limited` viewer they're seeing the shared summary. Grafana footnote (deep-link, LAN only).
  - Pure helpers in `apps/web/lib/metrics.ts` (mbps formatting, meter tone, pct) are unit-tested.
- **Admin role editor** — `apps/web/app/(app)/admin/roles/page.tsx`: a **Metrics** section column
  (Edit/Read-only/Disabled, the Ledger-style cell — metrics has no fine-grained action grants) for
  visibility, plus a **metrics level** control (Full/Limited select → `roles.setMetricsLevel`) for the role.

### D-06 — dev/e2e stub

Extend the existing `apps/web/e2e/support/stub-prometheus.ts` with an `/api/v1/query` (instant vector)
handler answering canned `unpoller_*` WAN + `node_*` series (deterministic magnitudes matching the live
shapes), reusing its `POST /_stub/state {mode:'ok'|'down'}` toggle for the degrade path. `PROMETHEUS_URL`
already points at this stub for `dev:local` + e2e (no harness/env change). `@hnet/metrics`'s client is
the production reader; the stub speaks the same wire shapes.

## Alternatives considered

- **Grant table for the level** — rejected (single scalar per role; a column is the right analog). ADR-037.
- **A bespoke `metrics_visible` flag** instead of the section mechanism — rejected; the section-permission
  machinery already gives audited, per-role, Admin-defaults-on visibility for free. ADR-037.
- **Embedding Grafana** — rejected (ADR-030 C-04 cross-site cookie break; native is best on mobile).
- **A shared `@hnet/ui` meter component** — the "013 meter" is the hand-rolled `.storage-array` idiom, not
  a shared component; the Overview mirrors that idiom (a small local `MetricMeter`) rather than the
  `@hnet/ui` `ProgressMeter` (a `role="progressbar"` — wrong semantics for usage-vs-capacity).

## Test strategy

- **Hermetic (embedded PG16 + stubbed reader):** `setRoleMetricsLevel` writes the audit row in-tx +
  rejects Admin + is idempotent (no-op writes no audit row); the `metrics.overview` **level invariant**
  (limited omits `network.wanLinks`, full includes it, disabled-section ⇒ FORBIDDEN); `getNetworkOverview`
  / `getHardwareOverview` PromQL→shape mapping + independent degrade (a down query ⇒ `unavailable`, never
  a throw); the Prometheus client's instant/range URL + zod contract + HTTP-failure throw; the capacity
  `app_settings` round-trip (audited); the migration-parity CHECK test.
- **Pure helpers:** `apps/web/lib/metrics.ts` (mbps format, tone thresholds, pct).
- **e2e (advisory):** `metrics.spec.ts` — the section is Admin-only by default (a Default user sees the
  unavailable card until opted in); with `metrics` opened, the Overview renders both meters against the
  stub numbers, the poll dims in place (no reflow), Prometheus-`down` shows the degrade note while the
  storage snapshot keeps working, and the Grafana footnote is a link (never an iframe).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Overview headline additions beyond upload/download + node load + memory + storage (e.g. active Plex streams once a live session source exists, GPU util once 019/021 land)? | Owner, morning. Plex streams deferred — no trivial live session read today (Tautulli is watch-stats-only). |
| Q-02 | Exact download capacity to seed `download_capacity_mbps` (upload seeded 300; live provider advertises 2256 Mbps down). | Seeded **2256 provisionally**; owner confirms. |
