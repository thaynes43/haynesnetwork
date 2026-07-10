# ADR-039: Network metrics — the allow-listed PromQL module + the never-expose-clients invariant

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes (owner ruling 2026-07-10) · ratified by Fable 5 (PLAN-020 build run)
- **Relates:** Refines — does NOT supersede — [ADR-037](037-metrics-section-access-and-prometheus-read-path.md)
  C-03/C-04 (the Metrics access model + the "no device identities at any level" network ruling). Reuses
  ADR-037 C-06 (admin-editable WAN capacity `app_settings`), C-07 (`@hnet/metrics` read-only Prometheus
  client), C-09 (Grafana deep-link, never embed). Realized by [DESIGN-019](../designs/019-metrics-network.md).
  Implements PRD **R-127..R-128**; glossary **T-114..T-116**.

## Context and problem statement

PLAN-020 adds the **Metrics → Network** sub-tab. ADR-037 C-04 already ruled the *policy*: `limited` sees
only WAN upload/download usage-vs-capacity; `full` may see finer WAN performance; and **no client/device
identities at any level**. But ADR-037 framed the finer grain as *per-uplink* performance only and left the
*enforcement mechanism* at "the router never fetches/serializes the full-only key" (C-03).

The owner's 2026-07-10 ruling for Network is sharper and two-layered, and needs its own decision record:

1. `full` should be allowed to see genuinely useful **infrastructure-device performance** — the UniFi
   gateway / switches / APs (CPU, memory, load, WAN health, port/radio grain). This is *broader* than
   ADR-037 C-04's "uplink performance only" wording, so it must be recorded explicitly — is a UniFi AP a
   "device" we may name? (Yes: infrastructure, not a client.)
2. The privacy line — **no client identities at ANY level** — must be provable by a reviewer and by CI,
   not just asserted. `unpoller_client_*` (per-client hostname/MAC/RSSI/rate), `unpoller_site_remote_user_*`
   (VPN users), and `*_info` (name-bearing) series all exist live and are one autocomplete away.

## Decision drivers

- The privacy invariant is the whole point of the plan — it must be **structural and testable**, not a
  code-review convention that erodes.
- `full` must be *useful* (infra performance the owner actually wants), without ever crossing into
  "what/who is on the network."
- Reuse the 017 foundation (capacity denominators, the reader, the meter idiom, the deep-link posture) —
  extend, never re-invent.
- ADRs are immutable once Accepted; ADR-037 stands. This ADR **refines** it.

## Considered options

### Enforcement — how "no client series" is guaranteed

1. **Convention + code review** — name only safe series, trust review. Rejected: erodes silently; a future
   edit adds `unpoller_client_signal_db` and nobody notices.
2. **Post-fetch filtering** — fetch broadly, strip client fields before serializing. Rejected: the client
   data still transits the server process and one missed key leaks it; also wasteful.
3. **Allow-list by construction + a unit test that proves it (CHOSEN).** A single query module
   (`packages/metrics/src/network.ts`) is the *only* place any unpoller series is named for this tab; every
   PromQL string it can issue is enumerated in an exported `NETWORK_ALLOWLIST_QUERIES`, and a unit test
   asserts each names only allow-listed `unpoller_(site|device|wan)_*` series and matches **none** of the
   deny substrings (`unpoller_client_`, `_remote_user_`, `_info`, `mac`, `hostname`, `rssi`, `signal`). A
   reviewer reads one file; CI proves the invariant.

### Grain — what `full` may see (refining ADR-037 C-04)

`full` may see **infrastructure-device performance** (gateway/switch/AP CPU, memory, load-average; WAN
health = gateway speedtest + internet-path latency; per-uplink capacity; site rollup COUNTS). A UniFi
device `name` label ("Garage U7 Outdoor", "Switch Pro Max 48 PoE", the gateway "Westford DMSE") is an
**infrastructure identifier, not a client identity** — allowed at `full`. There are **no per-client /
per-station rows** at any level; the only client-adjacent number is the aggregate `unpoller_site_stations`
COUNT (a scalar, not an identity).

### Capacity denominator — controller-live vs admin-pinned

Reuse ADR-037 C-06's admin-editable `app_settings` (`upload_capacity_mbps`=300 / `download_capacity_mbps`
=2256), **not** a second setting. Live-verified 2026-07-10: `unpoller_wan_provider_upload_kbps`=316000 /
`_download_kbps`=2256000 — the pinned numbers match the controller, so pinning is safe and keeps one
denominator across Overview + Network (resolves PLAN-020 Q-02).

### History — is a `limited` sparkline worth extra queries

`limited`'s only value-add over the Overview is a **7-day WAN throughput sparkline** (one range query per
direction on the aggregate `unpoller_site_*_rate_bytes{subsystem="wan"}` — no client data). Cheap and
justifies the tab's existence at `limited` (resolves Q-03).

## Decision outcome

Chosen: **an allow-listed `network.ts` query module + a unit-test-proven privacy invariant**, with
`full` seeing infrastructure-device performance (never client identities) and `limited` seeing the WAN
meters + a 7-day history sparkline. Capacity + reader + deep-link posture reuse ADR-037.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **The allow-listed PromQL module is the enforcement.** `packages/metrics/src/network.ts` is the single place any unpoller series is named for the Network tab; `NETWORK_ALLOWLIST_QUERIES` enumerates every query it can issue (including the WAN meters/links it reuses from `overview.ts`). `network.test.ts` proves each query names only allow-listed infra series and contains none of the deny substrings — so "no client identities at any level" is machine-checked, not convention. |
| C-02 | **Infrastructure-device performance is permitted at `full` (refining ADR-037 C-04).** UniFi gateway/switch/AP `name` + `type` (`udm`/`usw`/`uap`) + CPU/mem/load are infrastructure, not client identity, and are shown at `full`. Non-network gear (`pdu`/`uci`) is dropped. **No per-client/per-station rows at any level**; the aggregate `unpoller_site_stations` COUNT is the only client-adjacent number (a scalar). |
| C-03 | **The `limited`/`full` payload is disjoint and server-authoritative.** `metrics.network` resolves `effectiveMetricsLevel(role)` (admin ⇒ `full`) → `includeInfra`. `limited` gets `{ level, wan, history }` and the `infra` key (device perf + WAN health + site rollups) plus `wan.wanLinks` are **never fetched and never serialized** — the same never-fetch/never-serialize seam as ADR-037 C-03's `network.wanLinks`. A unit test asserts `'infra' in payload === false` and the infra queries were never issued for a `limited` caller. |
| C-04 | **Capacity denominators reuse ADR-037 C-06's `app_settings`** (`upload_capacity_mbps`/`download_capacity_mbps`) — no second setting; the Network meters and the Overview meters share one denominator and one query helper (`getNetworkOverview`). |
| C-05 | **A 7-day WAN throughput history sparkline is both-levels** (aggregate bytes/sec → Mbps; no client data). It is `limited`'s value-add over the Overview. Degrades to "no history" independently. |
| C-06 | **Grafana deep-links are per-group and privacy-aware** (reuse ADR-037 C-09): the Network Sites / USW Insights / UAP Insights boards are linked; the **Client-Insights board is deliberately NOT linked** — the privacy line holds in the deep-links too. |
| C-07 | Every field degrades INDEPENDENTLY to null/[] on a failed/empty query (the `overview.ts` posture) — a down gateway or absent speedtest never crashes the tab. No new package, env, migration, table, or write surface — this rides the 017 foundation. |

## More information

- Realized by [DESIGN-019](../designs/019-metrics-network.md); PLAN-020.
- Live-verified series (2026-07-10, unpoller v3.3.0, cluster `prometheus`): WAN
  `unpoller_site_{transmit,receive}_rate_bytes{subsystem="wan"}`, caps `unpoller_wan_provider_{upload,download}_kbps`,
  device `unpoller_device_{cpu,memory}_utilization_ratio` / `_load_average_1` / `_speedtest_*` /
  `_uplink_latency_seconds`, site `unpoller_site_{aps,switches,gateways,stations,latency_seconds}`.
- Forbidden (exist live, never named): `unpoller_client_*`, `unpoller_site_remote_user_*`,
  `unpoller_{controller,device}_info`.
- Refines [ADR-037](037-metrics-section-access-and-prometheus-read-path.md) C-03/C-04; does not supersede it.
