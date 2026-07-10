# ADR-037: Metrics section — per-role Full/Limited access model + in-cluster Prometheus read path

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (PLAN-017 build run)
- **Relates:** [ADR-021](021-section-level-role-permissions.md) / [DESIGN-009](../designs/009-ledger-section.md)
  (section-level role permissions — the visibility mechanism this reuses), [ADR-012](012-unified-roles.md)
  (DB-backed roles + the audited single-writer pattern), [ADR-025](025-trash-curation-pipeline.md) C-06
  (the generic audited `app_settings` store this reuses for capacities), [ADR-030](030-disk-and-reclaim-metrics-surface.md)
  / [DESIGN-013](../designs/013-disk-and-reclaim-metrics.md) (the storage-metrics prior art — the meter
  idiom, the Prometheus read client, and the `getUtilization` snapshot this REUSES, does not duplicate).
  Realized by [DESIGN-016](../designs/016-metrics-section-foundation.md). Implements PRD **R-117..R-120**;
  glossary **T-106..T-109**.

## Context and problem statement

The owner wants **"Metrics as a first-class citizen"** (backlog `haynes-ops/zprompt.md`): a top-level
**Metrics** section — nav position after Bulletin — where a user lands on an **Overview** of the most
useful numbers away from the VPN, with later plans (018 Apps, 019 Hardware, 020 Network) filling
dedicated drill-in sub-tabs. Grafana stays the deep-dive tool (deep-link, not embed — the ADR-030 C-04
precedent). The headline the owner named is **upload-speed consumption vs the ~300 Mbps cap** — the
practical limit of the Plex server's outbound streaming.

Two decisions are load-bearing and must be settled before any code:

1. **Who sees what.** This surface is going member-facing (not admin-only like the storage tooling), so
   it needs an access model. The owner's 2026-07-10 ruling (normative for 017–020): metrics carry an
   access **level** per role — **`full`** or **`limited`** — where `limited` hides **user-aware** metrics
   (who requested what, per-user space attribution, any tag/label carrying a username). Hardware is
   ungated; network at `limited` is upload/download **usage-vs-capacity only**; and **no device
   identities / "what is on the network" at any level**.
2. **Where the numbers come from.** The estate already runs a `kube-prometheus-stack` Prometheus that
   scrapes `unpoller` (UniFi/UDM), `node-exporter`, `smartctl-exporter`, and the *arr `exportarr`
   sidecars. The Overview's WAN throughput, cluster load, and memory all live there. ADR-030's 2026-07-09
   amendment already built a thin read-only Prometheus **range** client (`packages/api/src/prometheus.ts`)
   for the storage free-space trend. The question is whether to grow a shared client and where it lives.

Live recon (2026-07-10, against the `haynes-ops` Prometheus datasource) fixed the real metric names and
magnitudes the Overview will hardcode, so the queries are not guessed:

- **WAN usage.** `unpoller_site_transmit_rate_bytes{subsystem="wan"}` = the current upstream (upload)
  byte-rate; `unpoller_site_receive_rate_bytes{subsystem="wan"}` = downstream (download). Live: 1.45 MB/s
  up (~11.6 Mbps) / 0.84 MB/s down (~6.8 Mbps). These are gateway-level aggregate rates — **no client
  device identity, no user**.
- **WAN capacity (informs the seed, NOT the source of record).** `unpoller_wan_provider_upload_kbps`
  = 316 000 (Internet 1) / 350 000 (Internet 2 failover); `unpoller_wan_provider_download_kbps` = 2 256 000
  / 2 300 000. The speed-test gauge `unpoller_site_xput_up_rate` reads 327 — all three corroborate the
  owner's "~300 Mbps up" framing.
- **Cluster.** 6 Talos nodes (`node_load1`), 132 cores total, 145.2 / 529.6 GB memory used (~27%).

## Decision drivers

- **Owner ruling is normative** — Full/Limited, user-aware-hiding, hardware-ungated, network-usage-only
  at limited, no device identities anywhere.
- **Server-authoritative enforcement** — level must be enforced in the tRPC **payload shape**, never
  client-hidden only (the AC-13 posture every section gate already holds).
- **Ship-safe rollout** — deliver with **Admin-only visibility ON at deploy**; the owner opens it to the
  Default role (`limited`) after his morning screenshot review. One admin action, fully reversible.
- **Reuse over duplication** — the storage vertical (013) already owns the meter idiom, the `app_settings`
  audited store, the `getUtilization` snapshot, and a Prometheus client. Consume them; do not re-port.
- **A foundation for 018–020** — the client + section shell must be the thing three later plans build on.
- Read-only / additive throughout; the *arr write-back guard, Plex share guard, and Trash deletion paths
  are untouched.

## Considered options

### Access-level storage — where the `full|limited` level lives

1. **A per-role `metrics_level` column on `roles`** (chosen). One value per role, exactly like the
   existing `grants_all` boolean. The `roles` row is already selected during session hydration and is
   already covered by the `no-direct-state-writes` guard, so this adds **zero** extra queries and **zero**
   guard edits. Admin implies `full` via the session short-circuit (like admin implies section `edit`).
2. **A `role_metrics_permissions` grant table.** The `role_section_permissions` shape. Correct only when
   a role holds *many* values; metrics is a single scalar per role. Rejected as overweight for one column.

### Section visibility — how "Admin-only at deploy" is achieved

3. **Reuse the existing section-permission mechanism** (chosen). Add `'metrics'` to `SECTION_IDS` with a
   **`disabled` default** (the `trash`/`ledger` rollout pattern — hidden for non-admins until a role row
   opts them in; admin implies `edit`). At deploy, no role has a `metrics` row ⇒ Admin-only. The owner
   opens it in the morning by setting the Default role's `metrics` section to `read_only`. **Level** and
   **visibility** are orthogonal knobs: visibility gates *whether* you see Metrics; level shapes *how much*.
4. **A bespoke feature flag.** Rejected — the section mechanism already does exactly this, audited.

### Prometheus client — package home

5. **A new read-only `@hnet/metrics` package** (chosen). PLAN-017 calls for it and three later plans build
   on it; the repo's taxonomy already gives each external system a client package (`@hnet/arr`,
   `@hnet/plex`). `@hnet/metrics` owns the Prometheus HTTP client (instant `query` **and** range
   `query_range`) plus the Prometheus-derived read models (WAN network, node/memory hardware). It has
   **no write surface at all** — so, unlike `@hnet/arr/write` and `@hnet/plex/write`, it needs **no
   import-confinement** (there is nothing to confine).
6. **Grow the inline `packages/api/src/prometheus.ts` client.** Rejected as the home — a shipped, live
   storage vertical (013) depends on it, and it is not a reusable package for 018–020. **Consequence
   C-07** records the deliberate, documented duplication and the deferred consolidation.

### Surface — native vs embed

7. **Native meters + tiles, Grafana deep-linked (not embedded).** Chosen — the ADR-030 C-04 precedent
   (the cross-site Grafana cookie breaks an iframe after the `haynesnetwork.com` cutover; native is the
   best mobile experience). Grafana stays the LAN power tool behind a muted footnote.

## Decision outcome

Chosen options **1 + 3 + 5 + 7**. A per-role `metrics_level` column, section-permission-based visibility
defaulting to Admin-only, a new read-only `@hnet/metrics` package, and a native deep-linked surface.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **`metrics_level` is a `text` column on `roles`** (`full` \| `limited`, CHECK-constrained, default `limited`), written ONLY by the `@hnet/domain` `setRoleMetricsLevel` single-writer, which co-writes a `permission_audit` **`update_role_metrics_level`** row in the SAME transaction (hard rule 6). The Admin role is immutable (rejected with `SystemRoleImmutableError`) and implies `full` via the session short-circuit. Migration **0031** adds the column (seed Admin → `full`, cosmetic) and rebuilds the `permission_audit` action CHECK. Guard: no edit needed (`roles` is already guarded). |
| C-02 | **Visibility reuses `role_section_permissions`.** `'metrics'` joins `SECTION_IDS` with a **`disabled`** no-row default (`SECTION_DEFAULT_LEVELS.metrics`), so at deploy only Admin sees the section (admin implies `edit`). The Overview data procedure is gated by BOTH `metricsProcedure` (section `read_only`) **and** the level (payload shape). Migration **0031** rebuilds the `role_section_permissions` section CHECK. No new session query — hydration already loops `SECTION_IDS`. |
| C-03 | **`limited` hides user-aware metrics by never fetching or serializing them.** Server-side: the router resolves `effectiveMetricsLevel(role)` (admin ⇒ `full`) and, when `limited`, omits the full-only payload keys entirely (they are `undefined`, never sent). For the **Overview foundation** the one full-only field is the per-WAN performance breakdown (`network.wanLinks`); 018/019/020 add their own full-only, user-aware fields (requesters, per-user space) behind the same seam. A unit test proves the `limited` payload excludes the full-only keys. |
| C-04 | **Network gating (owner ruling).** `limited` sees ONLY aggregate upload/download **usage-vs-capacity** (gateway-level `unpoller_site_*_rate_bytes{subsystem="wan"}` — no client, no user). `full` may additionally see **per-WAN-link** performance/capacity (primary vs failover; `network.wanLinks`). **No device identities / "what is on the network" at ANY level** — the finer grain is uplink performance only, never client devices, never ISP-identifying ASN/provider strings (`wan_name` labels are the generic "Internet 1/2"). |
| C-05 | **Hardware is ungated** (owner ruling) — cluster node load (`node_load1` + core counts) and memory (`node_memory_*`) render at both levels. Node hostnames are cluster infra, not user-aware; 019 consumes this. |
| C-06 | **The upload/download capacity is admin-editable, audited `app_settings`** (ADR-025 C-06 store) under two new keys `upload_capacity_mbps` (default **300** — the owner's practical Plex cap) and `download_capacity_mbps` (default **2256**, the live provider figure, **provisional pending owner Q-02**). Written via the existing `setAppSetting` single-writer (audited `update_app_setting`); migration **0031** relaxes the `app_settings.key` CHECK. Capacity is the meter denominator, NOT the usage source. |
| C-07 | **A new `@hnet/metrics` package houses the read-only Prometheus client** (instant `query` + range `query_range`, zod-validated wire shapes, in-cluster default URL, `PROMETHEUS_URL` override, **no secret**) plus the WAN/node/memory read models. It has NO write surface, so — unlike `@hnet/arr/write`/`@hnet/plex/write` — it needs no import-confinement (stated so a future reader isn't surprised). ADR-030's inline `packages/api/src/prometheus.ts` (range-only, storage-trend) is **left untouched** to keep the shipped 013 vertical stable; the small client-core overlap is a **deliberate, documented duplication** — a future cleanup MAY re-home `packages/api/src/prometheus.ts` onto `@hnet/metrics` (deferred; not tonight). |
| C-08 | **The in-cluster Prometheus service is `kube-prometheus-stack-prometheus.observability.svc.cluster.local:9090`** (verified live 2026-07-10 — the query-API service; ADR-030's `prometheus-operated…:9090` is the operator's headless per-pod service and also works). `@hnet/metrics` defaults to `kube-prometheus-stack-prometheus…` and is overridable by `PROMETHEUS_URL` (the e2e/dev-local stub sets it). Unreachable Prometheus degrades each tile to a muted "unavailable", **never a crashed tab** (the ADR-030 C-03 posture, extended). No new helmrelease env line is required (the default resolves in-cluster). |
| C-09 | **Grafana is deep-linked, never embedded** (ADR-030 C-04), and stays the LAN power tool behind a muted footnote. The Overview's own numbers are native + mobile-first. |
| C-10 | (Cost/risk) **The Overview depends on the `unpoller` + `node-exporter` scrapes staying up.** If `unpoller` stops, the WAN meters degrade to "unavailable" (the meters, capacities, and hardware/storage tiles still render); if Prometheus itself is down, every Prometheus-backed tile degrades while the storage snapshot (live *arr `/diskspace`) keeps working. No second time-series store is built. |

## More information

- **Ship gate / rollout.** Deploy with `metrics` section `disabled` for all non-admin roles (Admin-only).
  The owner, after his morning 390px + desktop screenshot review, sets the Default role's `metrics`
  section to `read_only` (level stays `limited` — the DB default) to open the **Limited** Overview to
  members, and may set other roles (e.g. Family) to `full`. PLAN-017 is **not Complete** until that flip
  is made and the Limited view is verified live. Both knobs live in the existing admin role editor.
- **Owner morning decisions (Q-01/Q-02, carried from the plan):** (Q-01) any Overview headline additions
  beyond upload/download + node load + memory + storage — e.g. active Plex streams once a session source
  exists (there is no trivial live Plex-session read today; Tautulli is watch-stats-only, so streams are
  deferred, not shipped). (Q-02) confirm the real download capacity (live provider advertises 2256 Mbps;
  seeded provisionally).
- **Live metric verification (2026-07-10, `haynes-ops` Prometheus):** the exact series names + magnitudes
  above were queried live before being hardcoded, per the plan's "verify the real metric names" mandate.
- **Why not admin-only like storage (013).** 013 is operational tooling (diskspace, reclaim attribution)
  reached from the user menu — adminProcedure by design. Metrics is the owner's away-from-VPN, **user-
  shareable** view, so it carries the member-facing Full/Limited model instead.
