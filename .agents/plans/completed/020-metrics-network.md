# PLAN-020: Metrics — Network sub-tab (WAN usage-vs-capacity; privacy-scoped fine grain)

- **Status:** Completed (2026-07-10, v0.33.0 live). <!-- Draft → Executing → Completed -->
  Shipped the Metrics → Network sub-tab: `limited` = WAN up/down usage-vs-capacity meters + 7-day history
  sparkline; `full` = infra performance (gateway/switch/AP CPU·mem·load + WAN health + per-uplink caps +
  site rollup counts). Privacy invariant proven by construction: the allow-listed `network.ts` module +
  the `network privacy invariant — the allow-listed PromQL module` unit test (no query names
  `unpoller_client_*`/`_remote_user_`/`*_info`); disjoint server-authoritative `limited`/`full` payload.
  Live-validated on staging + public (v0.33.0 pod: `/api/health` ok, `metrics.network` unauth = 401, pod→
  Prometheus returns real WAN 46339 B/s up / gateway CPU 42.7% / 7 APs via the app's exact PromQL).
  IDs consumed: **ADR-039**, **DESIGN-019**, **R-127/R-128**, **T-114/T-115/T-116**. No migration; ADR-039
  refines (not supersedes) ADR-037 C-03/C-04. Q-02 resolved (reuse 017 capacity `app_settings`); Q-03
  resolved (7-day sparkline); Q-01 shipped the curated infra set (PoE/port-errors/radio/topology deferred
  to Grafana — owner may promote).
- **Satisfies:** PRD-001 new R-NN block (Network metrics sub-tab; Limited = WAN up/down
  usage-vs-capacity; Full = infra performance grain; **hard privacy invariant: no client/device
  identities at ANY level**); new ADR-NN (unpoller series allow-list + the never-expose-clients
  rule); new DESIGN-NN (Network sub-tab UX + verification-checkable privacy boundary); glossary
  (WAN capacity, upstream/downstream utilization, infra-device performance). No migration expected
  (reuses 017's role metrics level). **ID reconciliation:** ceilings at authoring — ADR-036,
  DESIGN-015, migration 0030, R-116, T-105, OPS-007. Take next-free at authoring; re-grep first —
  parallel round-2 plans consume numbers tonight.
- **Depends on:** **PLAN-017** (Metrics shell, `@hnet/metrics` Prometheus client, the `full`/
  `limited` access-level plumbing this tab enforces). Coordinate with 017's Overview so the WAN
  meters share one query helper rather than duplicating the PromQL.
- **TODO source:** owner backlog `haynes-ops/zprompt.md` §"Metrics as a first class citizen" #3 +
  owner ruling 2026-07-10 (network access levels + privacy rule).

---

## Goal

A **Network** sub-tab under Metrics. The headline the owner cares about: **how much of the ~300 Mbps
upload the Plex server is consuming** — the practical limit of the whole ecosystem. `limited` roles
see only WAN upload/download usage-vs-capacity (the same meters as 017 Overview, optionally longer
history). `full` roles see finer **infrastructure performance** (per-AP/switch/port load, WAN health,
latency) — but **NEVER client identities or what is on the network.** Grafana deep-links for depth.

## Recon outcome (verified live 2026-07-10 — unpoller v3.3.0 → Prometheus)

- **WAN usage vs capacity (limited + full):** `unpoller_wan_provider_upload_kbps` /
  `unpoller_wan_provider_download_kbps` = the ISP plan (capacity denominator, ~300 Mbps up);
  `unpoller_wan_peak_upload_percent` / `_peak_download_percent` = utilization %;
  `unpoller_device_wan_transmit_rate_bytes` / `_receive_rate_bytes` and `unpoller_site_xput_up_rate`
  / `_xput_down_rate` = live throughput; `unpoller_wan_uptime_percentage`.
- **Infra performance (full only):** `unpoller_device_*` — `_cpu_utilization_ratio`,
  `_memory_utilization_ratio`, `_load_average_1/5/15`, `_port_*` (PoE watts, port speed, rx/tx
  bytes/errors/drops), `_uplink_latency_seconds`, `_speedtest_download/upload/latency_seconds`,
  `_vap_*_latency_*`; site rollups `unpoller_site_{aps,switches,gateways,stations,latency_seconds}`;
  `unpoller_topology_link_experience_score`.
- **PRIVACY-SENSITIVE — MUST NEVER render at any level:** every `unpoller_client_*` series (per
  client hostname/MAC/RSSI/rates), `unpoller_site_remote_user_*` (VPN remote users),
  `unpoller_site_stations`/`_users`/`_guests` **counts are fine** but **no per-client rows**, and
  `unpoller_device_info`/`unpoller_controller_info` may carry names — surface infra device
  performance only, keyed by anonymized/role-appropriate labels (AP/switch model + generic id), not
  by anything identifying an end-user device.

## Build

1. **Data path:** consume via 017's `@hnet/metrics` Prometheus client — no new package/env. Add a
   `network.ts` query module holding the **allow-listed** PromQL only; the module is the single
   place any unpoller series is named, so review has one file to audit.
2. **Server-side level enforcement (the invariant lives in the router, not the UI):**
   `metrics.network` returns two disjoint shapes — `limited` gets `{ wan: {up,down}, capacity,
   utilizationPct, history? }` and **nothing else**; `full` adds `{ infra: {...device perf...},
   wanHealth, latency }`. **Neither shape ever contains a client series** — enforce by construction
   (the query module has no `unpoller_client_*`/`remote_user`/`info` PromQL at all), not by
   filtering after the fact. Mirror 017's level gate (`sectionProcedure` carrying the session level).
3. **UI (DESIGN):**
   - **Limited view / shared header:** upload meter (WAN tx vs `provider_upload_kbps` cap) + download
     meter, reusing the 013/017 meter idiom (no new hex). Optionally a longer sparkline than
     Overview (last 7d range query) — that is the only `limited` value-add over Overview.
   - **Full view:** adds infra cards — per-AP/switch **load** (cpu/mem/load-avg), port utilization,
     WAN health (uplink latency, uptime %, last speedtest), site rollup counts. All performance/
     capacity, zero client rows.
   - Grafana deep-link to the UniFi/unpoller dashboards for true depth (reuse 013/017 pattern).
4. **ADR-015 discipline:** meters/cards update in place, bounded poll (30–60s, pause on hidden tab).

## Verification (privacy is a first-class, checkable acceptance test)

- Merge gate (lint, lint:css, typecheck, test, build). Unit tests:
  - `limited` payload provably contains ONLY the WAN usage/capacity fields (snapshot-asserted key
    set) — no infra, no history-of-clients.
  - **Privacy invariant test:** assert the `network.ts` query module's PromQL never references
    `unpoller_client_`, `_remote_user_`, `_info`, MAC, or hostname; and that the `full` payload,
    dumped end-to-end against the 017 stub, contains no field that could name a client/device.
- LIVE on staging + public origin: a `full` admin sees infra performance; a `limited` (Default,
  once 017's flip is applied) sees only the two WAN meters. **A reviewer must be able to open the
  Network tab at BOTH levels and confirm no client hostname, MAC, or device list renders anywhere**
  — call this out explicitly in the DoD, with 390px + desktop screenshots at each level.

## Out of scope

Any per-client / per-station view (permanently — it's the privacy line, not a later phase); UniFi
write actions (this app never mutates the network); firewall/DPI/flow analytics; authoring new
Grafana dashboards beyond deep-link targets; the hardware/host side (PLAN-019).

## TODO-questions (owner, morning)

- **Q-01:** Which UniFi/unpoller panels do you actually want on the **Full** view — is per-AP +
  per-switch load + WAN health + latency the right set, or do you want PoE draw, port errors, or
  the topology experience score promoted too?
- **Q-02:** Confirm the **capacity denominators**: use `unpoller_wan_provider_upload_kbps` /
  `_download_kbps` live from the controller, or pin admin-editable numbers in 017's `app_settings`
  (assumed ~300 up — what's the down cap)?
- **Q-03:** For `limited`, is a longer history sparkline (7d) worth the extra range queries, or keep
  it identical to Overview and let Grafana own history?
