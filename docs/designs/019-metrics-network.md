# DESIGN-019: Metrics — Network sub-tab (WAN usage-vs-capacity; privacy-scoped infra grain)

- **Status:** Accepted
- **Last updated:** 2026-07-10
- **Satisfies:** PRD-001 **R-127..R-128**; governed by **ADR-039** (the allow-listed PromQL module + the
  never-expose-clients invariant, refining ADR-037 C-03/C-04). Extends **DESIGN-016** (the section shell,
  the `@hnet/metrics` reader, the `metricsProcedure` gate, the meter/tile/group idioms, the ADR-015
  no-reflow / bounded-poll posture) and reuses its `getNetworkOverview` WAN meters verbatim. Glossary
  **T-114..T-116**.

## Overview

A **Network** sub-tab under Metrics. The headline the owner cares about: **how much of the WAN
upload/download capacity the Plex ecosystem is consuming** (~300 Mbps up is the practical ceiling of the
whole thing). Two access levels, one `metrics_level` (T-107):

- **`limited`** — ONLY the two WAN usage-vs-capacity meters (reusing the Overview's capacity denominators)
  **plus a 7-day WAN throughput history sparkline** (its only value-add over the Overview).
- **`full`** — ADDS **infrastructure-performance** groups: per-gateway/switch/AP CPU·memory·load, WAN
  health (gateway speedtest + internet-path latency), per-uplink caps, and site rollup COUNTS.

**No client identities at ANY level** — never a client hostname/MAC/IP, never a per-device/per-station
row. Grafana remains the verbose LAN layer, deep-linked per group.

## Detailed design

### D-01 — No data model change (rides the 017 foundation)

No migration, table, column, env, or write surface. The tab rides the T-106 `metrics` section (visibility)
+ T-107 `metrics_level` (`full`/`limited`) already shipped by DESIGN-016, and the ADR-037 C-06 capacity
`app_settings`. Read-only.

### D-02 — The read model: `getNetworkMetrics` in `@hnet/metrics`

New module `packages/metrics/src/network.ts` (exported from `index.ts`). It is the **allow-listed query
module** (ADR-039 C-01) — the single place any unpoller series is named for this tab.

```ts
interface NetworkMetrics {
  level: 'full' | 'limited';          // the disjoint-shape driver, echoed like metrics.overview
  wan: NetworkOverview;               // REUSE of 017 getNetworkOverview; wan.wanLinks is full-only
  history: WanHistory;                // both-levels 7d WAN throughput sparkline data
  infra?: NetworkInfra;               // FULL-ONLY — omitted (never fetched) at limited
}
interface NetworkInfra {
  devices: DevicePerfRow[];           // {name, category: gateway|switch|ap, type, cpuPct, memPct, load1}
  wanHealth: WanHealth;               // gateway speedtest down/up/latency + site + uplink latency (ms)
  site: SiteRollup;                   // {aps, switches, gateways, stations} — aggregate COUNTS
}
```

The WAN meters are **not** duplicated — `getNetworkMetrics` calls `getNetworkOverview({ includeWanLinks:
includeInfra })` so the meter PromQL + the admin capacity denominators live in exactly one place
(overview.ts). Every field degrades independently to null/[] on failure (the `readScalar`/`readVector`
posture). Pure helpers `ratioToPct`, `deviceCategory`, `mergeDevicePerf`, `matrixToMbps` are unit-tested.

### D-03 — The PromQL (allow-listed; live-verified 2026-07-10)

| Group | Field | PromQL |
|-------|-------|--------|
| WAN meters (both) | upload / download B/s | `sum(unpoller_site_{transmit,receive}_rate_bytes{subsystem="wan"})` (reused from overview.ts) |
| WAN caps (full) | per-uplink kbps | `unpoller_wan_provider_{upload,download}_kbps` (reused) |
| History (both) | throughput matrix | range query on the two WAN-meter expressions, 7d @ 1h step |
| Device perf (full) | cpu / mem / load | `unpoller_device_{cpu,memory}_utilization_ratio`, `unpoller_device_load_average_1` |
| WAN health (full) | speedtest / latency | `max(unpoller_device_speedtest_{download,upload,latency_seconds})`, `max(unpoller_site_latency_seconds{subsystem="www"})`, `max(unpoller_device_uplink_latency_seconds)` |
| Site rollup (full) | counts | `sum(unpoller_site_{aps,switches,gateways,stations})` |

Device perf carries `name` (the UniFi device label) + `type` (`udm`/`usw`/`uap` → gateway/switch/AP;
`pdu`/`uci` dropped). **Never named:** `unpoller_client_*`, `unpoller_site_remote_user_*`, `*_info`.

### D-04 — The tRPC procedure `metrics.network`

| Procedure | Gate | Input | Returns |
|-----------|------|-------|---------|
| `metrics.network` | `metricsProcedure` (section ≥ read_only) | — | `NetworkMetrics` shaped by `effectiveMetricsLevel` |

The resolver reads `level = effectiveMetricsLevel(role)` (admin ⇒ `full`), fetches the capacity
`app_settings`, and calls `getNetworkMetrics({ includeInfra: level === 'full' })`. `limited` therefore
never issues the infra queries and never receives the `infra`/`wanLinks` keys — server-authoritative.

### D-05 — Access + the privacy invariant (ADR-039 C-01/C-02/C-03 — the testable boundary)

This is the plan's non-negotiable, and it is **two-layered and checkable**:

1. **Structural allow-list (never-name).** `network.ts` exports `NETWORK_ALLOWLIST_QUERIES` — every PromQL
   string the module can issue. The unit test **`network privacy invariant — the allow-listed PromQL
   module`** iterates it and asserts (a) each query names ONLY allow-listed `unpoller_(site|device|wan)_*`
   metrics (checked against an explicit `ALLOWED_METRICS` set) and (b) no query contains a deny substring
   (`unpoller_client_`, `_remote_user_`, `_info`, `mac`, `hostname`, `rssi`, `signal`). A third assertion
   dumps a full end-to-end payload and greps the JSON for `client`/`mac`/`hostname`/`rssi`/`remote_user`
   → none. So "no client identities at any level" is **proven by construction + CI**, not asserted.
2. **Disjoint level shape (never-fetch/never-serialize).** `getNetworkMetrics` gates the infra queries on
   `includeInfra`; the `metrics.network` router test asserts a `limited` caller's payload has
   `'infra' in payload === false`, `wan.wanLinks === undefined`, and that the infra/cap queries were
   never issued — the identical seam DESIGN-016 D-04 established for `network.wanLinks`.

Infrastructure device names (an AP "Garage U7 Outdoor") are allowed at `full` (ADR-039 C-02) — they are
gear, not clients. The only client-adjacent number is the aggregate `unpoller_site_stations` COUNT.

**How `limited` gets exercised:** an admin flips a role's Network detail Full→Limited via the
`metrics-level-<role>` select on `/admin/roles` (the audited `roles.setMetricsLevel` single-writer,
ADR-037 C-01); that one `metrics_level` re-shapes Overview, Apps, AND Network uniformly — there is no
per-tab level knob.

### D-06 — The UI: `network-tab.tsx`

Reuses the 017/018 idioms wholesale (no new hex): `.metrics-meter*` for the two WAN meters, `.metrics-tile*`
for WAN-health/site/uplink numbers, `.metrics-group*` + `.metrics-apps-table*` for the device tables,
`.metrics-wanlinks` idiom for per-uplink caps. The ONLY new geometry is a fixed-size SVG **sparkline**
(`.metrics-spark*`, tokens only, `stroke: var(--color-accent)`) driven by the pure `sparklinePolyline`
helper. Bounded 45s poll (paused when the sub-tab is hidden/inactive), `placeholderData` dims in place
(ADR-015 — no reflow). Device tables cap at 8 rows/group with a "+N more in Grafana" note (curated,
phone-friendly). Each group deep-links to its board; the Client-Insights board is never linked (ADR-039
C-06).

### D-07 — e2e stub extension

`e2e/support/stub-prometheus.ts` gains the Network instant vectors (device cpu/mem/load with `name`+`type`,
speedtest, site rollups — plus a `pdu` row to prove it's dropped) and a WAN-throughput **range** branch
(synthesizes a deterministic diurnal bytes/sec series for the sparkline). `metrics.spec.ts` gains an
advisory Network describe: the full admin view renders meters + history + infra groups, the Client board
is absent, and no `unpoller_client`/`rssi` text leaks. `capture-metrics-network.ts` renders the full
admin view at desktop + 390px (dark/light) — the sanctioned hermetic substitution.

## Alternatives considered

- **Post-fetch filtering of client fields** — rejected (ADR-039 Considered options): the data still
  transits the process; one missed key leaks. The allow-list-by-construction module is stronger.
- **A dedicated Network capacity setting** — rejected: reuse ADR-037 C-06; one denominator across tabs.
- **Embedding Grafana panels** — rejected (ADR-037 C-09): deep-link only; Grafana is LAN-only + verbose.
- **Per-client "top talkers" panel** — rejected permanently: that IS the privacy line (PLAN-020 out of scope).

## Test strategy

- **`@hnet/metrics` `network.test.ts`** — the privacy-invariant allow-list proof (D-05.1); the disjoint
  limited/full shape (limited omits `infra`+`wanLinks` and never fetches them; full adds both); the
  degrade-to-empty path; the pure helpers (`ratioToPct`, `deviceCategory`, `matrixToMbps`, `mergeDevicePerf`).
- **`@hnet/api` `metrics.test.ts`** — `metrics.network` full vs limited shape + never-fetch assertions;
  disabled-section ⇒ FORBIDDEN.
- **`apps/web` `lib/__tests__/metrics.test.ts`** — the `sparklinePolyline` geometry (empty/single/flat/scaled).
- **e2e (advisory)** — the full admin Network render + the "no client leak" DOM assertions (D-07).
- **LIVE (DoD)** — a `full` admin sees real WAN + device numbers matching direct Prometheus; a reviewer
  opens the tab and confirms NO client hostname/MAC/device list renders; unauth is gated; 390px + desktop
  screenshots attached.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Which `full` panels does the owner want beyond gateway/switch/AP load + WAN health + site counts — promote PoE draw, port errors, radio channel utilization, or the topology experience score too? | Shipped the curated set; the extras stay in Grafana. Owner may promote in a follow-up. |
| Q-02 | Capacity denominators — controller-live or admin-pinned? | Resolved (ADR-039 C-04): reuse the ADR-037 C-06 `app_settings` (300/2256), live-consistent with the controller's provider caps. |
| Q-03 | Is a `limited` 7-day history sparkline worth the range queries? | Resolved (ADR-039 C-05): yes — it's `limited`'s only value-add over the Overview; one cheap range query per direction. |
