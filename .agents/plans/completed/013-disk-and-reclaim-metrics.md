# PLAN-013: Disk utilization + reclaim metrics (banked — post-cutover)

- **Status:** **Completed (2026-07-07)** — shipped v0.17.0; live-validated on the PUBLIC origin:
  `/admin/storage` renders real diskspace (HaynesTower 78.8% used vs the 80% target — set + audited
  via `app_settings` `space_targets`; Music 25.4%), reclaim attribution empty-state correct (accrues
  from batch sweeps; expedite forward-capture in place), Grafana deep-link to the dashboards-as-code
  `media-storage-utilization` board. HYBRID per ADR-030 (deep-link not embed; *arr diskspace =
  utilization source of record; exportarr = trend — node-exporter can't see the media libraries).
  Was Draft/BANKED → Executing (backend + Grafana half + native `/admin/storage` page UX on
  `feat/storage-metrics`, e2e'd in `storage.spec.ts`).
- **Satisfies:** PRD-001 **R-108..R-111** (space target + utilization/reclaim visibility);
  **ADR-030** (THE surface decision — ratifies HYBRID: native reclaim + deep-linked Grafana trend);
  **DESIGN-013** (the metrics vertical + the native page contract for the UX agent); **OPS-007**
  (dashboard-as-code). Glossary **T-95..T-97**. Relates ADR-023/DESIGN-010 (Trash), PLAN-012
  (deletion snapshots — the reclaim data source).
- **Depends on:** **PLAN-012** (per-deleted-item size/resolution/quality/category snapshots
  must exist and be accumulating — this plan consumes, never backfills) and PLAN-008 (owner:
  post-cutover).
- **TODO source:** owner vision 2026-07-06 ("LATER, separate plans, decisions after the core
  queue").

> **ID reconciliation (resolved 2026-07-07):** ADR-030, DESIGN-013, OPS-007, migration **0021**,
> PRD R-108..R-111, glossary T-95..T-97. Q-01 resolved to HYBRID (owner-ratified). Q-02 resolved:
> utilization source of record = *arr `GET /diskspace` (only source with a total); trend = exportarr
> freeSpace via Grafana. Q-03 stands: 013 stores/displays the target, 014 acts on it. Q-04 (collection
> cadence) deferred — the diskspace read is live-on-demand, no new CronJob.

## Goal

Make the space story measurable. Two halves — **collection first, surface second**:

1. **Collect / expose:**
   - **Disk utilization per server/rootfolder** — candidate sources to evaluate (enumerated,
     not yet chosen): Radarr/Sonarr rootfolder free-space APIs (`GET /api/v3/rootfolder`
     `freeSpace`, `GET /api/v3/diskspace`) via the existing `@hnet/arr` read clients;
     **node-exporter filesystem metrics already scraped in-cluster** (Prometheus/Grafana stack
     lives in haynes-ops) for the volumes backing the libraries; Plex/Tautulli library sizes as
     a cross-check.
   - **Fill/drain rate over time** — utilization as a time series, so the owner gets
     steady-state evidence against the space target ("are we draining toward <80% or still
     filling?").
   - **Reclaim attribution** — from PLAN-012's deletion snapshots: reclaimed bytes by category
     (**TV vs Movies**) AND by **quality format/resolution** — the bang-for-buck view the owner
     described: "15 720p movies = 10% of the reclaim, 3 4K = 90%".
2. **Surface — THE core open decision (Q-01):** an **embedded/internal Grafana dashboard**
   (the estate already runs Grafana behind Authentik) **vs a native in-app metrics page**.
   Decision criteria to weigh and record in the ADR: auth integration (embed auth/cookies
   through the app vs a link-out), **mobile experience** (the owner curates from a phone),
   build effort, visual-identity fit (DESIGN-006), and where the reclaim-attribution queries
   naturally live (Postgres snapshots favor native; node-exporter series favor Grafana — a
   hybrid "Grafana for infra series, native for reclaim attribution" is a legitimate outcome).
   **The owner decides when the criteria are laid out** — present, don't presume.
3. **Configurable space target** (e.g. HaynesTower < 80%) — the number everything is judged
   against. Lives in the PLAN-012 app-settings store (Q-06 there). **Reconcile at slot time
   whether the target's OWNERSHIP sits here (a displayed threshold) or in PLAN-014 (a policy
   input)** — default: this plan stores + displays it; 014 acts on it.

## Docs-first artifacts (enumerated for the executing agent)

- PRD block (utilization visibility, fill/drain trend, reclaim attribution, space target —
  next free R-NN).
- The surface ADR (Q-01 decision + criteria; author, present options to owner, ratify after
  the owner picks).
- DESIGN-NN only if native surfaces are built (charts/pages/wire contracts); if Grafana wins,
  an OPS-NN records the dashboard provisioning (dashboard-as-code in haynes-ops) instead.
- Glossary: **Space Target**, **Fill/Drain Rate**, **Reclaim Attribution** (next free T-NN).

## Open decisions (Q-NN)

- **Q-01 — Grafana embed vs native in-app** (the core one; owner decides — see criteria above).
- **Q-02 — Utilization source of record** per server (arr rootfolder APIs vs node-exporter vs
  both with reconciliation) and where the time series persists (Prometheus retention vs our PG).
- **Q-03 — Space-target ownership** here vs PLAN-014 (default split above).
- **Q-04 — Collection cadence** (piggyback the existing 6h harvest CronJob vs its own job).

## Verification sketch + DoD (expand at slot time)

Hermetic tests for any new collectors/queries; LIVE: utilization numbers cross-checked against
`df`/Grafana ground truth on at least one server; reclaim attribution reproduces a known 012
deletion batch's totals; the surface renders on a phone. DoD: docs authored (ADR ratified after
the owner's Q-01 call), merge gate green, live checks pass, plan moved to `completed/`.

## Out of scope

Rule changes / policy action on the metrics (PLAN-014); any deletion behavior; historical
backfill of pre-012 deletions (no snapshots exist for them).

## Rollback

Read-only/additive throughout — remove the dashboard/page + collectors; no deletion path is
touched.
