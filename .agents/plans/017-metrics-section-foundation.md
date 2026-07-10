# PLAN-017: Metrics section foundation — top-level tab, Full/Limited access model, Overview

- **Status:** Executing (2026-07-10, Fable 5 build run). <!-- flips Draft → Executing → Completed -->
  IDs consumed: **ADR-037**, **DESIGN-016**, migration **0031**, PRD **R-117..R-120**, glossary
  **T-106..T-109**, audit action `update_role_metrics_level`, section id `metrics`, app-setting keys
  `upload_capacity_mbps`/`download_capacity_mbps`.
- **Satisfies:** PRD-001 new R-NN block (Metrics section; Full/Limited metric access levels;
  Overview upload/download-vs-capacity); new ADR-NN (metrics access model + in-cluster
  Prometheus read path); new DESIGN-NN (Metrics section UX); glossary (Metrics level,
  Full, Limited); migration NNNN (role metrics level). **ID reconciliation:** ceilings at
  authoring — ADR-036, DESIGN-015, migration 0030, R-116, T-105, OPS-007. Take next-free at
  authoring time; re-grep first (parallel round-2 plans consume numbers).
- **Depends on:** none (013's storage meters are prior art, untouched). Plans 018/019/020 build
  their sub-tabs ON this foundation — this plan ships the shell + Overview only.
- **TODO source:** owner backlog `haynes-ops/zprompt.md` §"Metrics as a first class citizen" +
  owner answers 2026-07-10 (RBAC ruling, recorded below verbatim-in-intent).

---

## Goal

A **top-level Metrics section, nav position after Bulletin**: sub-tabs where you land on an
**Overview** of the most useful information (headline: upload-speed consumption vs the ~300 Mbps
cap — the practical limit of the Plex server), with later plans (018 apps, 019 hardware,
020 network) filling dedicated drill-in tabs. Grafana stays the deep-dive tool (deep-link, not
embed — ADR-030 precedent); this section is the away-from-VPN, user-shareable view.

## Access model (owner ruling 2026-07-10 — normative for 017–020)

- Two **metric access levels** assignable per role: **`full`** and **`limited`**.
  Default role → `limited`; every other existing role (incl. Family) → `full`; Admin implicitly
  `full`. Level flips are admin actions, audited in the same tx (CLAUDE.md hard rule 6).
- **`limited` hides user-aware metrics**: anything naming users — who requested what, per-user
  space attribution, tags carrying usernames. Those appear at `full` only.
- **Hardware metrics: NO gating** — both levels see all of it (019 consumes this).
- **Network metrics:** `limited` sees ONLY upload/download usage vs capacity. `full` may see
  finer grain — but **performance/load only; NO device identities or anything identifying
  what is on the network, at ANY level** (020 consumes this).
- Ship gate: deliver with **Admin-only visibility ON at deploy**; the owner assigns
  Default→`limited` after his morning screenshot review (one admin action; screenshot-approval
  memory). The plan is not Complete until he has flipped it and the Limited view is verified live.

## Build

1. **Data path (ADR):** a read-only Prometheus HTTP-API client (instant + range queries) against
   in-cluster `kube-prometheus-stack` (`http://kube-prometheus-stack-prometheus.observability
   .svc.cluster.local:9090` — verify svc name live). New env `PROMETHEUS_URL`; **no secret
   needed** (unauthenticated in-cluster). Client lives in a new `@hnet/metrics` package
   (read-only — no write surface, so no import confinement needed; say so in the ADR). e2e/dev
   stub Prometheus server in `@hnet/test-utils` + `pnpm dev:local` wiring, mirroring the *arr
   stubs.
2. **Schema (migration NNNN):** per-role metrics level — follow the ADR-021/023 grant-table
   pattern (`role_metrics_level` or a column on roles; ADR decides; audited writes via the
   single-writer helpers in `packages/domain`; append table to the `no-direct-state-writes`
   guard).
3. **tRPC:** `metrics.overview` (+ `metrics.access` for the level) via a `sectionProcedure`-style
   gate that carries the session's level; server-side level enforcement (limited never receives
   full-only payload fields — enforce in the router shape, not the UI).
4. **UI:** top-level "Metrics" in the universal nav after Bulletin (role-gated like other
   sections); sub-tab shell (Overview live; Apps/Hardware/Network tabs render as "coming soon"
   placeholders ONLY if their plan hasn't landed — hide entirely is also fine, DESIGN decides);
   **Overview content:**
   - **Upload meter** — WAN upstream utilization vs capacity (unpoller metrics in Prometheus;
     verify the exact metric/interface live, e.g. `unpoller_*` WAN tx rate), the ~300 Mbps cap
     as an admin-editable setting in the ADR-025 `app_settings` store (audited), rendered with
     the 013 meter idiom (reuse `@hnet/ui` meter, no new hex).
   - **Download meter** — same, downstream.
   - Headline tiles: cluster node load summary (node-exporter via Prometheus), storage
     utilization snapshot (REUSE the 013 space-target data, do not duplicate), Plex stream
     count if cheaply available from existing Tautulli wiring (optional — drop if not trivial).
   - Time-range: sparkline/last-24h per meter is enough for Overview; deep history = Grafana
     deep-link (reuse the 013 deep-link pattern).
5. **ADR-015 discipline:** meters/tiles update in place, reflow-free; poll bounded (30–60s,
   stop when tab hidden).

## Verification

- Merge gate (lint, lint:css, typecheck, test, build) + unit tests for the level-gated router
  (limited payload provably excludes full-only fields) + Prometheus client against the stub.
- LIVE on staging + public origin: Overview renders real unpoller/node-exporter numbers; upload
  meter sanity-checked against the UniFi UI; `hnet-e2e` (Default→limited once flipped) sees no
  user-aware or fine-network data; admin sees full. Screenshots at 390px + desktop for the
  owner's morning review.

## Out of scope (later plans)

018 Apps/*arr sub-tab (exportarr dashboards + gap-fill); 019 Hardware (SMART/glances/PVE);
020 Network drill-in (unpoller deep, privacy-scoped); any Grafana dashboard authoring beyond
what Overview deep-links to; alerting.

## TODO-questions (owner, morning)

- **Q-01:** Overview headline set — anything you want promoted to the landing view besides
  upload/download + node load + storage (e.g. active Plex streams, GPU util once 019/021 land)?
- **Q-02:** exact upload/download capacity numbers to seed `app_settings` (assumed 300 Mbps up —
  what's the down cap?).
