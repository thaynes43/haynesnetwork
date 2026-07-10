# ADR-040: Hardware metrics source (pve-exporter + node + smartctl; glances deferred) and SMART-alert delivery via the app outbox

- **Status:** Accepted <!-- Draft | Proposed | Accepted | Superseded by NNN | Deprecated -->
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes

## Context and problem statement

PLAN-019 adds a **Metrics → Hardware** sub-tab (PRD R-129/R-130): drive health (SMART) with
alerting, per-node load/temperature, and a Proxmox host→VM capability showcase. Three questions
must be settled before code:

1. **What are the metric SOURCES**, and specifically — is the Proxmox host/VM grain read from
   `prometheus-pve-exporter` (Prometheus-native) or from the five hosts' **glances** REST
   (`:61208`, API v4)? The plan drafted glances as the temps/disk-IO supplement and left the
   in-this-release-or-defer choice to this ADR.
2. **How is a SMART degradation DELIVERED as an alert** — through this app's PLAN-016
   `notification_outbox` (in-app + Pushover, delivery window), or via the in-cluster
   Alertmanager→Pushover path (phone-only)?
3. **How is "a transition since the last check" DETECTED and made idempotent** so the owner is
   paged once on real deterioration and never re-paged on a drive's already-known bad state?

The live homelab is the acceptance case: the NAS **Cache-staging** pool (`nvme1`+`nvme2`, btrfs
striped, expendable) is already **past rated endurance** (`percentage_used` 100, `smart_status`
FAILED, `critical_warning` bit 2 set) but holding (`available_spare` 100, `media_errors` 0); the
**Cache-apps** mirror (`nvme0`+`nvme3`, the critical appdata pool) is 57–60 % worn. The owner
rides the staging pool until real failure and must NOT be paged on its known state — only on NEW
deterioration.

Recon (verified live 2026-07-10 against the cluster `prometheus` datasource):

- **smartctl** — TWO jobs are live: `smartctl-exporter` (in-cluster DaemonSet, 9 NVMe across 3
  control-plane nodes, `device="nvme0n1"…`) and `smartctl-exporter-haynestower` (the NAS scrape,
  `instance="haynestower"`, `role="nas"`, 34 devices = the 4 cache NVMe + 30 array spinners).
  Series present: `_percentage_used`, `_smart_status`, `_critical_warning`, `_media_errors`,
  `_available_spare[_threshold]`, `_temperature`, `_power_on_seconds`, `_capacity_bytes`, and the
  `smartctl_device{model_name,serial_number,…}` info metric. **Sleeping array spinners legitimately
  emit no per-device series** — absence must read as "asleep", never red.
- **node-exporter** — the 6 k8s nodes (`node-exporter`) + the NAS (`node-exporter-haynestower`);
  `node_load1`, `node_cpu_seconds_total`, `node_memory_*`, `node_hwmon_temp_celsius` (41 NAS
  series + 117 cluster series — the temperature source).
- **prometheus-pve-exporter** — NOW LIVE (was empty when the plan was authored; the owner added the
  1Password `proxmox` item overnight and the exporter deployed). One in-cluster instance
  (`job="prometheus-pve-exporter"`) scraping all **5 PVE nodes** (HaynesIntelligence, twin-top,
  twin-bottom, pve-filet02, pve04) + their 17 guests: `pve_up`, `pve_node_info`, `pve_guest_info`,
  `pve_cpu_usage_ratio`, `pve_memory_usage_bytes`, `pve_memory_size_bytes`, `pve_uptime_seconds`, …
- **glances** — NO `glances_*` series exist in Prometheus (verified empty); glances is REST-only
  today. Its win over pve-exporter is per-sensor temperature thresholds; but node_hwmon (NAS) +
  smartctl temperatures already cover the temperature need for THIS release.

## Decision drivers

- **Owner ruling (2026-07-10): hardware is UNGATED** — `full` and `limited` both see everything
  (hardware is not user-aware). Keep the level seam plumbed for consistency, but the payload is
  identical at both levels.
- **Owner ruling (2026-07-10): alerts are critical-only, transitions-only**, via the app outbox,
  and the known staging-pool state must be a recorded baseline that never pages.
- **Durability + Prometheus-native** for the durable host/VM grain (survives glances restarts, one
  read path, cluster-native).
- **Minimize `haynes-ops` blast radius this release** — the plan constrains cluster changes to the
  image bump plus (only if chosen) an additive glances scrape.
- **Reuse over reinvention** — the Prometheus read path (ADR-037 `@hnet/metrics`), the outbox +
  delivery window (ADR-034), the sync-mode precedent (`notify-outbox`/`space-policy`), and the
  single-writer/audit discipline (CLAUDE.md hard rule 6) all already exist.

## Considered options

- **Proxmox source:** (A) pve-exporter primary, glances deferred; (B) pve-exporter + glances
  scrape bridge THIS release; (C) glances REST only (no pve-exporter).
- **SMART-alert delivery:** (D) the app `notification_outbox` (in-app + Pushover, delivery window);
  (E) in-cluster Alertmanager→Pushover (phone-only).
- **Transition detection state:** (F) a dedicated `smart_drive_state` table (persisted last-known
  state per drive) written by a domain single-writer; (G) derive transitions from Prometheus
  history each run (no app state); (H) reuse Alertmanager's own for/resolved dedup (implies E).

## Decision outcome

**Proxmox source: option A — `prometheus-pve-exporter` primary; glances DEFERRED.** The host/VM/
storage grain reads cluster-native `pve_*`. Temperatures for this release come from
`node_hwmon_temp_celsius` (NAS) + `smartctl_device_temperature` (drives) — both already scraped —
so the tab is built on **pve + node + smartctl** with **no new scrape**. Glances would need a
Prometheus bridge (its prometheus export or a json_exporter/ScrapeConfig following the haynestower
precedent); that is additive `haynes-ops` risk for a marginal temperature/disk-IO gain this
release. **`haynes-ops` change for PLAN-019 is the image bump only.** Glances (per-sensor
temperature thresholds + per-disk IO) is a documented **follow-up** (see More information Q-01) —
the `@hnet/metrics` read model leaves room for an optional glances source without a refactor.

**SMART-alert delivery: option D — the app `notification_outbox`.** The alert is then visible
IN-APP (future surfacing) and pushed to the phone through the same delivery-window + disabled-safe
machinery PLAN-016 already ships, rather than living only in Alertmanager. New event types
`smart_degraded` / `smart_recovered` join `NOTIFY_OUTBOX_EVENT_TYPES` (a CHECK relax, the
0024/0030 pattern); the renderer deep-links `…/metrics?tab=hardware`. Alertmanager→Pushover remains
available in-cluster and is complementary, not replaced.

**Transition detection: option F — a `smart_drive_state` table + a domain single-writer.** A
`smart-alerts` sync mode (the `notify-outbox`/`space-policy` early-return precedent — no `sync_runs`
row) reads the smartctl series through `@hnet/metrics`, and `evaluateSmartAlerts` (in `@hnet/domain`)
compares each drive's reading to its persisted last-known state. On a critical transition it
enqueues **one** `smart_degraded` outbox row AND updates the drive's state row **in the same
transaction** (the outbox row is the durable transition record — the audit pattern, hard rule 6).
**First sight of a drive records its state as a baseline and enqueues nothing** — this is the
guarantee that the known staging-pool state (wear 100, `critical_warning` bit 2, FAILED) is
recorded, not paged. Dedup is structural: a still-failing drive whose state is unchanged produces
no second push.

### The paging bar (owner ruling, R-130), evaluated per drive against its stored state

| Trigger | Fires when | Notes |
|---------|-----------|-------|
| `smart_status` pass→FAIL | prior state not `fail`, current `fail` | The staging pool is already `fail` at baseline ⇒ never re-pages |
| `media_errors` 0→n | prior `media_errors` 0, current > 0 | Any nonzero = start decom |
| `available_spare` crossing threshold margin | prior spare > `threshold + MARGIN`, current ≤ that | `MARGIN = 10` percentage points above `available_spare_threshold` |
| NEW `critical_warning` bit | `(current & ~prior) !== 0` | The staging pool's bit 2 is in the baseline ⇒ only a NEW bit pages |
| Critical-pool wear 80 % / 90 % | prior wear < 80/90, current ≥ 80/90, AND the drive is in the appdata (mirror) pool | The expendable staging pool is excluded from the wear-crossing page |

Temperature and warn-tier are dashboard-only (not paging triggers). A `smart_recovered` push fires
on a FAIL→pass recovery (a transition, low-noise). The NVMe **pool topology** (which device belongs
to which pool + its `critical`/`expendable` framing) is a curated map in `@hnet/metrics`, surfaced
on each reading as `criticalPool` so the domain evaluator stays generic.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: `haynes-ops` change for PLAN-019 is the **image bump only** — pve-exporter/node/smartctl are all already scraped; no glances bridge, no new ScrapeConfig, nothing destructive, no forced disk spin-up. |
| C-02 | Good: the alert is visible **in-app** (outbox row) and phone-pushed through the existing delivery-window + disabled-safe drainer; no new transport, no new secret (Prometheus needs none; Pushover reuses the PLAN-016 env). |
| C-03 | Good: the **baseline-on-first-sight** rule makes "the known bad staging pool never pages, only NEW deterioration does" a structural property — provable by a unit test (baseline ⇒ 0 rows; forced transition ⇒ exactly 1 row; unchanged re-run ⇒ 0 rows). |
| C-04 | Good: transition detection is **cheap and self-contained** — an instant read of the smartctl series + a per-drive state compare; no dependence on Prometheus retention/history for correctness (history is used only for the endurance-panel projection, which degrades to "insufficient history"). |
| C-05 | Bad/known: temperature is available but there is **no per-sensor warn/crit threshold** this release (glances' win) — temps are shown from node_hwmon/smartctl for context only. Deferred to Q-01. |
| C-06 | Bad/known: SMART-on-host (per-PVE-host disk SMART) and expanded smartctl coverage stay a **haynes-ops follow-up** (glances `smart` plugin is not enabled; the host NVMe are vfio-passed-through). The tab surfaces the drives that DO report. |
| C-07 | Bad/known: a new guarded table (`smart_drive_state`) + two new outbox event types + one new sync mode widen three CHECK constraints (migration 0033) and the `no-direct-state-writes` guard list — the standard, low-risk additive-CHECK + guard-append pattern (0024/0030). |
| C-08 | Neutral: `@hnet/sync` gains a `@hnet/metrics` dependency (read-only, no write surface, no import-confinement) so the `smart-alerts` mode can read the smartctl series; the domain evaluator stays Prometheus-agnostic (it consumes a plain readings array). |

## More information

- **PRD:** R-129 (Hardware sub-tab), R-130 (SMART alerting). **Design:** DESIGN-020. **Glossary:**
  T-117 (NVMe Endurance / Pool Framing), T-118 (SMART Alert Transition), T-119 (Proxmox Showcase).
- **Reuses:** ADR-037 / DESIGN-016 (`@hnet/metrics` Prometheus reader, `metrics` section, level
  seam), ADR-034 / DESIGN-015 (`notification_outbox` + delivery window + disabled-safe drainer),
  ADR-015 (in-place, no-reflow; host→VM expansion is a deliberate in-place expansion), ADR-030 C-04
  / ADR-037 C-09 (Grafana deep-linked, never embedded), CLAUDE.md hard rule 6 (single-writer audit).
- **Q-01 (deferred, owner):** enable the glances Prometheus bridge (per-sensor temp thresholds +
  per-disk IO) and/or expand smartctl coverage (glances `smart` plugin per host; more nodes) — a
  `haynes-ops`-only follow-up, out of scope for PLAN-019.
