# PLAN-019: Metrics — Hardware sub-tab (SMART health, node load/temps, Proxmox showcase)

- **Status:** Draft (2026-07-10, owner-scoped). <!-- Draft → Executing → Completed -->
- **Satisfies:** PRD-001 new R-NN block (Hardware metrics sub-tab; SMART surfacing + alerting;
  Proxmox host/VM capability showcase); new ADR-NN (Proxmox metric source: prometheus-pve-exporter
  primary / glances fallback + SMART-alert delivery reuse of the PLAN-016 outbox); new DESIGN-NN
  (Hardware sub-tab UX); glossary (SMART health, PVE node, hardware showcase). Migration only if a
  SMART-alert transition table is needed (see Build §4 — prefer reusing `notification_outbox`).
  **ID reconciliation:** ceilings at authoring — ADR-036, DESIGN-015, migration 0030, R-116,
  T-105, OPS-007. Take next-free at authoring; re-grep first — parallel round-2 plans (011-rescope,
  017, 018, 020–023) consume numbers tonight.
- **Depends on:** **PLAN-017** (Metrics shell, `@hnet/metrics` Prometheus client, sub-tab
  framework, access-level plumbing). Does NOT depend on 018/020. Rebase onto 017's `@hnet/metrics`
  package once it lands.
- **TODO source:** owner backlog `haynes-ops/zprompt.md` §"Metrics as a first class citizen" #2 +
  owner ruling 2026-07-10 (hardware ungated at both levels).

---

## Goal

A **Hardware** sub-tab under Metrics that showcases the homelab's physical capability and load:
drive health (SMART) with alerting, per-node CPU/load/temperature, and a Proxmox host→VM capacity
view. **Both access levels see everything** (owner ruling: hardware is NOT user-aware, so no
Full/Limited gating on this tab).

## Recon outcome (verified live 2026-07-10)

- **node-exporter** — bundled by `kube-prometheus-stack` (observability ns); `node_load1/5/15`,
  `node_cpu_seconds_total`, `node_memory_*`, `node_hwmon_temp_celsius`, `node_filesystem_*` all
  present. Covers the K8s worker/control nodes (the Talos VMs), not the Proxmox hosts.
- **smartctl-exporter** — deployed (`observability/smartctl-exporter`); config scrapes exactly
  **`/dev/nvme0n1`, `/dev/nvme1n1`, `/dev/nvme2n1`** (three NVMe) via `serviceMonitor`. Live series:
  `smartctl_device_temperature`, `_smart_status`, `_critical_warning`, `_media_errors`,
  `_percentage_used`, `_available_spare[_threshold]`, `_power_on_seconds`, `_capacity_bytes`. A
  `PrometheusRule` (`smartctl-exporter-rules`) already encodes the failure thresholds (temp>65,
  status!=1, media_errors!=0, spare-under-threshold) but the chart's own `prometheusRules` are
  disabled — the standalone rule file is the canonical set. **Coverage is one node's 3 NVMe only**
  today → expansion is a TODO-question.
- **Proxmox** — five hosts run **glances v4 on `:61208`** (from homepage `configuration.yaml`):
  `haynesintelligence`, `twin-top`, `twin-bottom`, `pve-filet02`, `pve04` (all `*.haynesnetwork`).
  **No `pve_*`/proxmox series exist in Prometheus yet** (verified empty) — Proxmox is currently
  glances-REST-only, not scraped.

## Build

1. **Proxmox source (ADR) — recommend `prometheus-pve-exporter` as the durable source, glances as
   fallback.** The owner is adding a 1Password `proxmox` item tonight (`PROXMOX_API_URL`,
   `PROXMOX_API_TOKEN_ID`, `PROXMOX_API_TOKEN_SECRET`) → pve-exporter is unblocked. Deploy it in
   `haynes-ops/kubernetes/main/apps/observability/pve-exporter/` (ExternalSecret → 1P `proxmox`;
   ServiceMonitor). It yields cluster-native `pve_*` (node CPU/mem, per-VM `pve_cpu_usage_ratio`,
   `pve_memory_usage_bytes`, up/status, storage) — the host→VM capability view. **glances fallback:**
   the existing `:61208` REST (composite/package temps, per-core) as an optional `@hnet/metrics`
   HTTP source if pve-exporter grain is thin; keep it read-only, no secret. ADR records the
   decision + why pve-exporter is primary (durable, Prometheus-native, survives glances restarts).
2. **Data path:** consume via 017's `@hnet/metrics` Prometheus client (instant + range). No new
   package. If glances-REST is used, add a small read-only glances client to `@hnet/metrics` with a
   dev/e2e stub mirroring the 017 Prometheus stub.
3. **tRPC:** `metrics.hardware` (single procedure, ungated beyond the section grant — both levels
   get the full payload). Shapes: `drives[]` (SMART), `nodes[]` (load/temp/cpu/mem), `pveHosts[]`
   with nested `vms[]`.
4. **SMART alerting (reuse PLAN-016 outbox pattern).** Surface SMART health in the UI AND push on
   degradation. Preferred wiring: a `sync`-run branch (like `notify-outbox`) that evaluates the
   smartctl series against thresholds and **enqueues into the existing `notification_outbox`** (new
   event types `smart_degraded` / `smart_recovered`) so it inherits the delivery-window + no-creds
   no-op behavior — **no new table if `notification_outbox` fits** (confirm its channel/event enum
   is CHECK-relaxed; extend enum + migration only if needed). Dedup on transition (don't re-push a
   still-failing drive). Alertmanager→Pushover is the in-cluster alternative already available; the
   ADR picks app-outbox so the alert is visible in-app, not just as a phone push.
5. **UI (DESIGN):** Hardware sub-tab —
   - **Drive health** cards/table: each device with SMART status pill (healthy/warn/fail), temp,
     `percentage_used` (NVMe wear) as a 013-idiom meter, power-on hours, media-error count.
   - **Node load**: per-node `node_load1` vs core count, memory used vs installed, hottest
     `node_hwmon_temp_celsius`, rendered with the reused `@hnet/ui` meter (no new hex).
   - **Proxmox showcase**: host tiles (CPU/mem/uptime) each expanding **in place** (ADR-015) to its
     VMs — a "what this homelab is made of" capability view; GPU rows appear here once 021 lands
     (out of scope now).
   - Grafana deep-link per section (reuse 013/017 deep-link pattern) for history.
6. **ADR-015 discipline:** tiles/meters update in place, bounded poll (30–60s, pause on hidden tab);
   host→VM expansion is a deliberate in-place expansion (allowed exception).

## Verification

- Merge gate (lint, lint:css, typecheck, test, build). Unit tests: SMART threshold→enqueue
  transition (incl. no-creds no-op + no-double-push), hardware router shape against the 017 stub.
- LIVE on staging + public origin: Hardware tab renders real node-exporter + smartctl numbers;
  pve-exporter host/VM data present (after tonight's 1P item + deploy); a forced SMART threshold in
  the stub produces exactly one Pushover enqueue. Both a `full` and a `limited` role see the SAME
  hardware payload (ungated). Screenshots at 390px + desktop for the owner's morning review.

## Out of scope

GPU/DCGM metrics (PLAN-021 brings the GPU story); network/UniFi hardware (PLAN-020); authoring new
Grafana dashboards beyond deep-link targets; expanding smartctl device coverage to more nodes
(TODO-question below — may be a haynes-ops-only follow-up); per-VM control actions (read-only only).

## TODO-questions (owner, morning)

- **Q-01:** SMART alert thresholds — keep the existing PrometheusRule set (temp>65°C, status!=1,
  media_errors!=0, spare-under-threshold, `percentage_used` wear) as the app's push triggers, or a
  different bar for phone pushes (e.g. only fail/critical, not warn)?
- **Q-02:** Which Proxmox nodes to surface in the showcase — all five glances hosts
  (haynesintelligence, twin-top, twin-bottom, pve-filet02, pve04), or a curated subset? And should
  smartctl coverage expand beyond the current 3 NVMe (which hosts/disks) so drive health isn't
  one-node-only?
- **Q-03:** SMART-alert delivery — reuse the `notification_outbox` (in-app + Pushover, delivery
  window) as recommended, or route via in-cluster Alertmanager→Pushover instead (phone-only)?

## Live glances probe (2026-07-10 ~02:40, coordinator — from in-cluster against HaynesIntelligence)

Owner supplied the five glances URLs (all `http://<node>.haynesnetwork:61208`:
haynesintelligence, pve-filet02, twin-top, pve04, twin-bottom). **Not secrets — already in git via
Homepage's config; no 1Password item needed.** Probe results (glances **API v4**):

- **`sensors` WORKS and is the win**: real temps with per-sensor warning/critical thresholds
  (e.g. NVMe Composite 55°C, warn 81 / crit 84) — the temperature source pve-exporter lacks.
  `diskio`/`fs`/`cpu`/`mem`/`network` also live. Plugin list also shows `npu`.
- **`gpu` returns `[]`** on HaynesIntelligence — expected: passed-through GPUs are invisible to
  the PVE host (vfio), and the host has no NVIDIA driver stack. GPU telemetry must come from
  IN-CLUSTER DCGM/nvidia exporters on the GPU worker (PLAN-021's story), NOT glances.
- **`smart` plugin NOT enabled** (400; absent from pluginslist) — enabling it is a per-host
  config change (owner-present, pairs with the smartctl-coverage question in Q-02).

Implication for the build: pve-exporter = primary (host/VM/storage), glances = the
**sensors/temps + disk-IO** supplement (scrape via glances' Prometheus export or a json_exporter
bridge — decide in the ADR), GPU stays out of scope here (021), SMART-on-host stays a Q-02
owner decision.

## HaynesTower (Unraid) SMART — INSTALLED + owner requirement (2026-07-10 ~02:20)

Owner installed `prometheuscommunity/smartctl-exporter:latest` (v0.14.0) on HaynesTower via CA:
privileged + **Extra Parameters `--user=root`** (required — the image runs as `nobody` and every
device open fails Permission-denied without it). All **34 devices** report on
`haynestower.haynesnetwork:9633`; scrape + a verbose NAS Grafana board are queued in the
collection wave. 30 array spinners clean (0 realloc/pending/media-errors).

**Live finding + pool topology (owner-confirmed, normative for this plan's UX):**
- **Cache-staging** = nvme1+nvme2 (CT2000P3PSSD8, btrfs ~4TB striped, NOT mirrored) — the
  download/mover staging pool that "gets hammered". BOTH report SMART FAILED: `percentage_used`
  100 %, `critical_warning` bit 2, but `available_spare` still 100 % and `media_errors` 0.
  Owner is AWARE and will ride them until real failure (cache feature can be disabled; little
  data to clear for decom). **Expendable pool — do not page repeatedly on its known state.**
- **Cache-apps** = nvme0+nvme3 (btrfs MIRROR, 2TB) — appdata for the HNet Plex libraries +
  dockers, heavily used, **the critical pool**; wear 57 % / 60 %.

**Owner requirement (verbatim intent): "a way to know how far I can push it on
haynesnetwork.com — this is the sort of critical information to monitor there."** The Hardware
tab must carry an **NVMe endurance panel**, per-pool framed (Cache-apps vs Cache-staging), with:
wear odometer (`percentage_used`), **wear-rate trend + projection** (Δ%/week from Prometheus
history once scraping accrues), and the REAL end-of-life countdown for the ridden-past-100%
pool: `available_spare` vs `available_spare_threshold`, `media_errors` (any nonzero = start
decom), and new `critical_warning` bits. Alerting: transitions only (spare crossing threshold
margin, media_errors 0→n, new warning bits, Cache-apps wear crossing 80/90 %) — NOT a steady
re-page of the already-known staging-pool state. This live case is the plan's acceptance
scenario: the panel must clearly show "staging pool: over rated endurance, spare 100 %, 0 media
errors — holding" vs "apps mirror: 57–60 % worn, projected N months to 90 %".
