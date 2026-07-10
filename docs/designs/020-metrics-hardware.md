# DESIGN-020: Metrics — Hardware sub-tab (SMART health + endurance, node load/temps, Proxmox showcase, SMART alerting)

- **Status:** Accepted
- **Last updated:** 2026-07-10
- **Satisfies:** PRD-001 R-129, R-130; governed by ADR-040 (source + alert delivery), ADR-037 /
  DESIGN-016 (`@hnet/metrics` reader, `metrics` section, level seam), ADR-034 / DESIGN-015 (outbox +
  delivery window), ADR-015 (in-place / no-reflow), ADR-030 C-04 (Grafana deep-linked).

## Overview

A **Hardware** sub-tab under Metrics, ungated (owner ruling — both `full` and `limited` see the same
payload), rendered from the in-cluster Prometheus via the ADR-037 `@hnet/metrics` reader. Four
groups, top to bottom:

1. **NVMe endurance** — the headline (R-129a). Per-pool framing (the appdata **mirror** vs the
   expendable **staging** pool) with a wear odometer, a wear-rate projection to 90 %, and the real
   end-of-life signals. This is the acceptance scenario.
2. **Drive health** — a table across every reporting SMART device (in-cluster NVMe + the NAS pool)
   with a healthy/warn/fail pill; a sleeping array disk that emits no series shows "asleep".
3. **Node load** — per-node load-per-core, memory, hottest temperature.
4. **Proxmox showcase** — host tiles (CPU/mem/uptime) each expanding **in place** to their VMs.

Plus **SMART alerting** (R-130): a `smart-alerts` sync mode that pages the owner once on a critical
transition and never on the known-bad staging pool, through the PLAN-016 outbox.

The whole tab reuses the 017/018/020 idioms: the ADR-037 reader + degrade posture (every field →
null/[] on a failed query, never a throw), the `metrics-meter`/`metrics-tile`/`metrics-group` CSS
classes, the bounded 45 s poll that pauses on a hidden/inactive tab (ADR-015 placeholderData), and
the muted per-group Grafana deep-link.

## Detailed design

### D-01 — Read model (`packages/metrics/src/hardware.ts`) — `getHardwareMetrics({ prometheus })`

One `Promise.all` of instant + range reads through the ADR-037 `PrometheusReader`, each degrading
independently. Series names are **verified live 2026-07-10** (see ADR-040 recon). Returns
`HardwareMetrics`:

```
HardwareMetrics {
  pools: NvmePool[]          // the endurance panel (curated Cache-apps + Cache-staging framing)
  drives: DriveHealth[]      // every reporting SMART device, grouped by role (nas | cluster)
  nodes: NodeLoad[]          // node-exporter per node (k8s + NAS)
  pveHosts: PveHost[]        // pve-exporter host tiles with nested vms[]
  unavailable: boolean       // true only when EVERY group failed (Prometheus unreachable)
}
```

- **PromQL** (exported consts, allow-list-style so the shape is auditable): the smartctl families
  (`smartctl_device_percentage_used`, `_smart_status`, `_critical_warning`, `_media_errors`,
  `_available_spare`, `_available_spare_threshold`, `_temperature`, `_power_on_seconds`,
  `smartctl_device` info); the node families (`node_load1`, the `count-by-(instance,cpu)` cores
  form, `node_memory_MemTotal/MemAvailable_bytes`, `node_hwmon_temp_celsius`) grouped `by (instance)`;
  and the pve families (`pve_up`, `pve_node_info`, `pve_guest_info`, `pve_cpu_usage_ratio`,
  `pve_memory_usage_bytes`, `pve_memory_size_bytes`, `pve_uptime_seconds`).
- **Drive identity** — `driveKey = instance + '/' + device` (unique across both smartctl jobs). A
  reading carries `role` (`nas`/`cluster`), `kind` (`nvme`/`hdd` from `rotation_rate`/device name),
  `model`/`serial` (from the info metric), and the SMART scalars. **Sleeping disks** simply do not
  appear (no series) — the table shows only awake devices; the NAS group caption notes array
  spinners that are asleep (never a red row).
- **D-02 — NVMe pool framing.** A curated map `NVME_POOLS` (owner-normative, ADR-040) keys the four
  NAS cache NVMe by `device` → `{ pool: 'Cache-apps'|'Cache-staging', framing: 'critical'|'expendable',
  topology }`. `Cache-apps` = `nvme0`+`nvme3` (btrfs MIRROR, critical appdata); `Cache-staging` =
  `nvme1`+`nvme2` (btrfs striped, expendable). Each pool folds its members into: worst `wearPct`,
  min `availableSpare` vs `threshold`, total `mediaErrors`, any `critical_warning`, a
  `statusLine`, and a **projection** (D-03). Non-pool NVMe (the 9 in-cluster) are not framed as pools
  — they ride the Drive-health table only.
- **D-03 — Wear-rate projection.** A pure, unit-tested `projectWear(points, targetPct)`: fit the
  per-drive `percentage_used` history (a `query_range` over ~14 days) to a weekly rate; if there are
  < 2 samples spanning a usable window OR wear did not increase, return `{ insufficientHistory: true }`
  (the state until scraping accrues — scraping started 2026-07-10). Otherwise return
  `{ weeklyRatePct, projectedDaysTo90 }`. The pool takes the worst member's projection. Copy targets
  (R-129): "over rated endurance, spare 100 %, 0 media errors — holding" (staging) vs "57–60 % worn,
  projected N months to 90 %" (apps).
- **D-04 — Nodes.** Fold `node_load1` / cores / mem / `node_hwmon_temp_celsius` (max per instance)
  by `instance` into `NodeLoad { name, load1, cores, loadPerCorePct, memUsedBytes, memTotalBytes,
  memPct, hottestTempC }`. `count by (instance,cpu)(node_cpu_seconds_total{mode="idle"})` gives cores
  per node.
- **D-05 — Proxmox.** Fold `pve_node_info` (the node list) + `pve_up`/`pve_cpu_usage_ratio`/
  `pve_memory_*`/`pve_uptime_seconds` (per node) + `pve_guest_info`/`pve_up`/per-guest cpu/mem
  (nested by the guest's `node` label) into `PveHost { name, up, cpuPct, memUsedBytes, memTotalBytes,
  memPct, uptimeSeconds, vms: PveVm[] }`. GPU rows are out of scope (PLAN-021).

### D-06 — `getDriveSmartReadings({ prometheus })` (the alert evaluator's input)

A narrower read (SMART scalars only, no history/nodes/pve) returning `DriveSmartReading[]`
(`driveKey`, `label`, `pool`, `criticalPool`, `smartStatus`, `wearPct`, `mediaErrors`,
`availableSpare`, `availableSpareThreshold`, `criticalWarning`). Structurally compatible with the
domain evaluator's `SmartDriveReading` input (TS structural typing — no cross-package type import).
`criticalPool` is computed here from `NVME_POOLS`, so the domain layer stays generic.

### D-07 — tRPC (`metrics.hardware`)

```
hardware: metricsProcedure.query(async ({ ctx }): Promise<HardwareMetrics> =>
  getHardwareMetrics({ prometheus: resolveMetricsReader(ctx) }));
```

Gated by section visibility only (`metricsProcedure` ≥ read_only). **No level shaping** — the payload
is identical for `full` and `limited` (ungated, R-129). The level seam stays consistent with the
other tabs (the client still receives its level from `metrics.access`) but hardware fetches/serializes
the same shape either way.

### D-08 — `smart_drive_state` table (migration 0033) + the single-writer

```
smart_drive_state(
  drive_key       text PRIMARY KEY,   -- instance/device
  label           text,
  pool            text,               -- 'Cache-apps' | 'Cache-staging' | null
  smart_status    text NOT NULL,      -- 'pass' | 'fail'  (CHECK)
  wear_pct        integer NOT NULL,
  media_errors    integer NOT NULL,
  available_spare integer NOT NULL,
  critical_warning integer NOT NULL,
  last_event_type text,               -- 'smart_degraded' | 'smart_recovered' | null
  updated_at      timestamptz NOT NULL
)
```

Derived, rebuildable operational state (the ADR-035 `trash_candidates_state` class): written ONLY by
`@hnet/domain` `evaluateSmartAlerts`; registered in the `no-direct-state-writes` guard (both SQL +
Drizzle forms). Its transitions produce outbox rows (the durable audit trail), so the state writer
itself appends no ledger row.

### D-09 — `evaluateSmartAlerts` (`packages/domain/src/smart-alerts.ts`) — the single-writer

`evaluateSmartAlerts({ db?, drives: SmartDriveReading[], now?, actorId? }) → SmartAlertsReport`.
Per drive, in ONE transaction (per drive, or a batched tx): read the stored `smart_drive_state` row
`FOR UPDATE`; if **absent**, INSERT the baseline and enqueue **nothing** (R-130 baseline rule);
if present, evaluate the D-10 transitions; on a fired transition, `enqueueOutbox(tx, …)` **one**
`smart_degraded` (or `smart_recovered`) row with `earliest_send_at = computeEarliestSend(now, window)`
(the ADR-034 delivery window, read before the tx) AND update the state row — same tx. Unchanged
drives update nothing (idempotent). Returns `{ evaluated, baselined, degraded, recovered, enqueued }`.

### D-10 — The transition rules (owner ruling, ADR-040 table)

`smart_status` pass→FAIL; `media_errors` 0→n; `available_spare` crossing `threshold + MARGIN`
(MARGIN = 10); a NEW `critical_warning` bit (`current & ~prior`); critical-pool wear crossing 80/90.
Temperature + warn-tier are not triggers. The staging pool at baseline (FAILED, bit 2, wear 100) is
recorded, never paged; only NEW deterioration on those drives fires. `smart_recovered` on FAIL→pass.
The outbox renderer (`renderOutboxMessage`) gains `smart_degraded`/`smart_recovered` cases that
deep-link `…/metrics?tab=hardware` and name the drive + reason.

### D-11 — `smart-alerts` sync mode

The `notify-outbox`/`space-policy` early-return precedent (`packages/sync/src/orchestrator.ts`):
`smart-alerts` joins `SYNC_RUN_KINDS`; the CLI `--mode=smart-alerts` (no `--source`, writes no
`sync_runs` row); the orchestrator block reads the smartctl series via `@hnet/metrics`
`getDriveSmartReadings` (a `smartReader` passed on `RunSyncOptions`, isolated in try/catch) and calls
`evaluateSmartAlerts`, returning a `smartAlerts` report field. The CronJob (a `haynes-ops`
follow-up, not this repo) mirrors the notify-outbox schedule; the mode is disabled-safe (no Pushover
creds ⇒ the enqueue still records the transition, the drainer no-ops — ADR-034 C-03).

### D-12 — UI (`apps/web/app/(app)/metrics/hardware-tab.tsx`)

Wire the already-reserved `hardware` branch in `metrics-client.tsx` to `<HardwareTab active … />`
(replacing the "coming soon" card). Reuse the Network-tab component grammar (local `GroupCard`,
`Meter`, `GrafanaLink`, tables). New, token-only presentational pieces: a **PoolCard** (framing badge
+ topology line + per-member wear meter + status line + spare/media-error/critical-warning facts +
projection line or "insufficient history") and a **StatusPill** (healthy/warn/fail — color via
existing meter-tone tokens, never new hex). The Proxmox showcase host tile is a `<details>`-style
in-place expander (ADR-015 allowed exception) revealing its VM rows; no neighbor reflow. Deep-links:
NAS drives → the `nas-haynestower` board (Hardware folder); Drive health → the smartctl board; Node
load → Node Exporter Full; Proxmox → Grafana Explore (no dedicated pve board yet). Formatters
(`apps/web/lib/metrics.ts`): `formatHours`, `formatWearProjection`, reuse `formatCapacity` (bytes)
from `lib/storage`, reuse `meterTone`/`meterWidth`/`formatPct`.

### D-13 — Access

Ungated: `page.tsx` still gates the whole `metrics` section (`disabled` ⇒ unavailable card), but
inside, Hardware renders the same payload at both levels. A `full` and a `limited` role see identical
hardware data — verified live (R-129).

> **Amendment (2026-07-10) — the per-group Grafana deep-links are ADMIN-ONLY (DESIGN-016 D-07).** The
> board URLs (the `nas-haynestower` pool board, the smartctl drive board, Node Exporter Full, and the
> Grafana Explore Proxmox link) are LAN-only, so `metrics.hardware` attaches the `grafana` link object
> (`{ nas, smart, nodes, pve }`) ONLY for an admin caller (`includeGrafanaLinks: role.isAdmin`). Hardware
> is ungated by metrics LEVEL (R-129), but the Grafana links are still admin-gated (LAN reachability, not
> detail); the tab renders each `GrafanaLink` only when its `href` is present (reflow-free, ADR-015).

## Alternatives considered

- **glances scrape THIS release** (temps/disk-IO) — deferred (ADR-040 option A): temps already exist
  via node_hwmon + smartctl; the bridge is additive `haynes-ops` risk for marginal gain.
- **Alertmanager→Pushover for SMART** (phone-only) — rejected for the app outbox (ADR-040 option D):
  the app-outbox path is in-app-visible + reuses the delivery window + is disabled-safe.
- **Deriving transitions from Prometheus history each run** (no state table) — rejected: correctness
  would then depend on retention/step alignment, and "first sight = baseline, don't page" is far
  cleaner as an explicit persisted state (ADR-040 option F).

## Test strategy

- **Unit (`@hnet/metrics`):** `hardware.test.ts` — the read model against a stubbed reader (pool
  framing folds the four NAS NVMe correctly; the endurance status lines; `projectWear` (insufficient
  vs projected); a sleeping disk absent = not red; node/pve folds; each field degrades to null/[] on a
  failing query; `unavailable` only when all groups fail).
- **Unit (`@hnet/domain`, embedded Postgres):** `smart-alerts.test.ts` — **baseline run over the
  known staging state enqueues 0 outbox rows** (records baseline); a forced `media_errors` 0→1 (or
  pass→FAIL, or a NEW critical_warning bit, or critical-pool wear crossing 80/90) enqueues **exactly
  1** `smart_degraded` row + updates state; a re-run with the same reading enqueues 0 (no double-push);
  the expendable staging pool crossing a wear mark does NOT page; a FAIL→pass enqueues 1
  `smart_recovered`. The outbox row commits with the state update (same tx).
- **Merge gate:** lint, lint:css (no new hex), typecheck, test, build.
- **e2e (advisory):** `stub-prometheus.ts` gains the smartctl + pve + node instant series and the
  percentage_used range; `metrics.spec.ts` asserts the Hardware tab renders the endurance panel + a
  status pill + node/pve groups, that a `limited` and `full` session see the SAME payload, and that a
  `down`-mode degrade shows the muted note (no crash). Screenshot capture at 390 px + desktop.
- **LIVE:** the deployed pod's Hardware tab shows the real pool states (staging holding at 100 %
  wear / spare 100 / 0 media errors; apps 57–60 %); unauth gate holds; a scripted `smart-alerts`
  evaluation over the known state enqueues ZERO rows and a forced transition enqueues exactly ONE.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Glances Prometheus bridge (per-sensor temp thresholds + per-disk IO) and/or expanded smartctl coverage (glances `smart` plugin per host; more nodes)? | Deferred to owner — a `haynes-ops`-only follow-up (ADR-040 Q-01), out of PLAN-019 scope. The read model leaves room for an optional glances source. |
| Q-02 | A dedicated Proxmox Grafana board to deep-link the showcase to (none exists today)? | Deferred — the showcase deep-links to Grafana Explore for now; a curated pve board is a later `haynes-ops` follow-up. |
