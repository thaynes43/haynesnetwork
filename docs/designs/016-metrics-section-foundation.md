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
  export interface MetricsMeter {
    usageMbps: number | null;
    capacityMbps: number;
    pct: number | null;
  }
  export interface WanLink {
    id: string;
    label: string;
    capacityUpMbps: number | null;
    capacityDownMbps: number | null;
    usageUpMbps: number | null;
    usageDownMbps: number | null;
  }
  export interface NetworkOverview {
    upload: MetricsMeter;
    download: MetricsMeter;
    wanLinks?: WanLink[];
    unavailable: boolean;
  }
  export function getNetworkOverview(o: {
    prometheus: PrometheusReader;
    uploadCapacityMbps: number;
    downloadCapacityMbps: number;
    includeWanLinks: boolean;
  }): Promise<NetworkOverview>;

  export interface HardwareOverview {
    nodes: { count: number; coresTotal: number; load1Total: number; loadPerCorePct: number } | null;
    memory: { usedBytes: number; totalBytes: number; pct: number } | null;
    unavailable: boolean;
  }
  export function getHardwareOverview(o: {
    prometheus: PrometheusReader;
  }): Promise<HardwareOverview>;
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

| Procedure                      | Gate               | Input                  | Returns                                                                                              |
| ------------------------------ | ------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `metrics.access`               | `authedProcedure`  | —                      | `{ level: MetricsLevel; canSee: boolean }` (the caller's own level + whether the section is visible) |
| `metrics.overview`             | `metricsProcedure` | —                      | `MetricsOverview` (below), shaped by the caller's level                                              |
| `metrics.capacity.get`         | `adminProcedure`   | —                      | `{ uploadMbps: number; downloadMbps: number }`                                                       |
| `metrics.capacity.setUpload`   | `adminProcedure`   | `{ mbps: int 0..1e6 }` | audited `setAppSetting` result                                                                       |
| `metrics.capacity.setDownload` | `adminProcedure`   | `{ mbps: int 0..1e6 }` | audited `setAppSetting` result                                                                       |

```ts
export interface MetricsOverview {
  level: MetricsLevel; // echoed so the UI can label the Limited/Full view
  network: NetworkOverview; // wanLinks present ONLY when level === 'full'
  hardware: HardwareOverview; // ungated (both levels)
  storage: StorageArrayUtilization[]; // REUSE getUtilization (013) — not user-aware, both levels
  grafana?: OverviewGrafanaLinks; // ADMIN-ONLY (D-07) — the LAN-only Grafana footnote link
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

### D-07 — Grafana deep-links are ADMIN-ONLY (LAN-only URLs), enforced in the payload shape

**Refinement (2026-07-10, owner-approved).** Every Grafana deep-link across the Metrics surfaces — the
Overview footnote (D-05), the Apps per-group boards (DESIGN-018), the Network per-group boards
(DESIGN-019), and the Hardware pool / drive / node / Proxmox boards incl. the `nas-haynestower` board +
the Grafana Explore link (DESIGN-020) — targets `https://grafana.haynesops.com`, which resolves **ONLY on
the owner's LAN/VPN**. A non-admin viewer would only ever get dead links, so the deep-links are now
**admin-only**.

- **Gate on ADMIN status specifically — NOT the metrics level.** A `full` non-admin (e.g. a Family role
  with `metrics_level='full'`) has the _detail_ grant but not necessarily LAN/VPN reachability, so the
  gate is `role.isAdmin`, orthogonal to the `full`|`limited` shaping. (Admin already implies `full`, so an
  admin always both sees full detail and gets the links.)
- **Enforced SERVER-SIDE in the payload shape** (the same never-serialize seam ADR-037 C-03 established
  for the level-shaped keys): each read model gains an optional `grafana?` link object, attached **only**
  when the router passes `includeGrafanaLinks: ctx.user.role.isAdmin`. A non-admin response therefore
  **never contains a Grafana URL at all** — at BOTH levels. The link URLs live in one place,
  `@hnet/metrics` `grafana.ts` (`OverviewGrafanaLinks` / `AppsGrafanaLinks` / `NetworkGrafanaLinks` /
  `HardwareGrafanaLinks`), retiring the per-tab client constants that previously hard-coded them.
- **UI renders links only when present** — each tab reads `data.grafana?.…` and omits the anchor when the
  object is absent. This is **reflow-free (ADR-015)**: the object's presence is fixed for the session by
  the caller's admin status, so no link appears/disappears on an interaction; a member panel simply has
  the group heads/footnotes without a link (collapse-cleanly, not reserve — there is no armed/disarmed
  state to keep stable). `/admin/storage` is untouched (already admin-only by section).
- **Test invariant:** the router unit tests (`packages/api/__tests__/metrics.test.ts`) prove `grafana` is
  PRESENT for an admin and ABSENT for a non-admin at BOTH `full` and `limited`, for each of
  `overview`/`apps`/`hardware`/`network`; the `@hnet/metrics` read-model tests prove the same at the
  `includeGrafanaLinks` seam. No new ADR (reuses ADR-030 C-04 / ADR-037 C-09 "deep-link, never embed");
  no new PRD requirement or glossary term (a gating refinement, not a new concept).

### D-08 — Overview: admin-only inline WAN-capacity editor (closes the PLAN-017 UI gap)

**Gap-fix (2026-07-10, owner-approved).** The Overview upload/download meters chart usage against the WAN
capacity denominators, and the audited `metrics.capacity.set{Upload,Download}` mutations (`adminProcedure`,
`z.number().int().min(0).max(1_000_000)` → `setAppSetting`, D-04) **shipped with PLAN-017** — but no UI ever
called them, so an admin could only change a cap via a raw API call. D-08 adds the missing edit affordance;
**no new mutation, ADR, PRD, glossary term, or migration** — the `upload_capacity_mbps` /
`download_capacity_mbps` settings (ADR-037 C-06) and both mutations already exist. This is purely the
client control that was omitted.

- **Where** — `apps/web/app/(app)/metrics/overview-tab.tsx`. Each WAN meter (upload + download) gains an
  optional `editor` slot rendered under its foot. `metrics/page.tsx` resolves `role.isAdmin` server-side
  (like every admin affordance, ADR-012) and threads `viewerIsAdmin` through `MetricsClient` →
  `OverviewTab`; the editor renders **only** when `viewerIsAdmin`. A non-admin (read-only or full) receives
  **no edit control** — the meters render exactly as before. The mutation is itself `adminProcedure`-gated
  - audited, so this flag is UI convenience, not the security boundary.
- **Idiom (REUSE, don't invent)** — the `/settings/trash` storage-**target** editor verbatim: an
  always-present number input + tick **Save**, draft-over-stored, `describeMutationError` for failures, a
  client-side bound mirror (`capacityOutOfRange`, `int 0..1_000_000`) that rejects the same values the
  server zod would before a round trip. The editable value **is** the meter's own `capacityMbps` off the
  Overview payload — no extra admin-only `capacity.get` read.
- **Optimistic + reconcile** — `onMutate` patches `utils.metrics.overview` (`network[kind].capacityMbps`
  plus a `meterPct`-recomputed `pct`, a pure mirror of the server `@hnet/metrics` `meterPct`) so the
  denominator **and** the fill re-render instantly; `onError` rolls the cache back and surfaces the message;
  `onSettled` invalidates `overview` so the server (which recomputes pct off live usage) reconciles.
- **Reflow-free (ADR-015)** — the editor is **always mounted** for an admin (never a toggle), so no
  neighbor moves on interaction; the status label reserves its width so the `Saved`⇄`Whole 0–1,000,000`
  swap can't nudge the row (the storage-target reservation pattern). New CSS is token-only (no hex).
- **Tests** — pure `meterPct` / `capacityOutOfRange` unit tests in `apps/web/lib/__tests__/metrics.test.ts`
  (the optimistic-pct mirror + the bound guard); the `metrics.spec.ts` advisory e2e asserts an admin sees
  and can save the capacity control (denominator re-renders) while a read-only viewer never sees it. The
  set/read-back + audit is already covered by the D-04 router round-trip test; the mutation is unchanged.

## Alternatives considered

- **A pencil→input toggle affordance** — rejected: the storage-target idiom is an always-present input (a
  direct manipulation, not a form ceremony), and always-mounted is the cleanest way to guarantee ADR-015
  reflow-freedom (a toggle would have to reserve the input's height anyway). Reuse beats a new pattern.
- **A dedicated admin settings page for the caps** — rejected: the cap is only meaningful next to the meter
  it denominates; editing it in place (like the space target next to its utilization meter) keeps the
  denominator and its control colocated. The mutation stays audited regardless of where it's called.
- **Grant table for the level** — rejected (single scalar per role; a column is the right analog). ADR-037.
- **Gate the deep-links on the metrics `level` (full) instead of admin** — rejected (D-07): `full` is a
  _detail_ grant, not a LAN-reachability signal; a `full` Family viewer off-LAN would still get dead links.
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
  `app_settings` round-trip (audited); the migration-parity CHECK test; the **admin-only Grafana
  deep-link invariant (D-07)** — `grafana` PRESENT for an admin, ABSENT for a non-admin at BOTH levels,
  across `overview`/`apps`/`hardware`/`network`.
- **Pure helpers:** `apps/web/lib/metrics.ts` (mbps format, tone thresholds, pct — incl. the D-08 optimistic
  `meterPct` mirror + the `capacityOutOfRange` client bound guard).
- **e2e (advisory):** `metrics.spec.ts` — the section is Admin-only by default (a Default user sees the
  unavailable card until opted in); with `metrics` opened, the Overview renders both meters against the
  stub numbers, the poll dims in place (no reflow), Prometheus-`down` shows the degrade note while the
  storage snapshot keeps working, and the Grafana footnote is a link (never an iframe).

## Open questions

| ID   | Question                                                                                                                                                                    | Resolution                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Q-01 | Overview headline additions beyond upload/download + node load + memory + storage (e.g. active Plex streams once a live session source exists, GPU util once 019/021 land)? | Owner, morning. Plex streams deferred — no trivial live session read today (Tautulli is watch-stats-only). |
| Q-02 | Exact download capacity to seed `download_capacity_mbps` (upload seeded 300; live provider advertises 2256 Mbps down).                                                      | Seeded **2256 provisionally**; owner confirms.                                                             |
