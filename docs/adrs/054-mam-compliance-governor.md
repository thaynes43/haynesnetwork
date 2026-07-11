# ADR-054: MAM compliance governor — cap-aware torrent-fallback pacing via the Prowlarr indexer seam

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Tom Haynes

## Context and problem statement

LazyLibrarian (LL) is usenet-first with MyAnonaMouse (MAM) as a torrent fallback (OPS-013). MAM enforces
an **unsatisfied-torrent cap** by rank (New Member 20 → User 50 → PU 100 → VIP 150); exceeding it **blocks
downloads for up to 24h** ("unsatisfied" = snatched but not yet seeded 72h — the compliance contract in
`.agents/context/2026-07-11-mam-rules-scrape.md`). A large wanted list with a run of usenet misses would
burst-grab straight past the cap. No off-the-shelf cap-aware governor exists for the LL+Prowlarr+MAM combo,
so we build one — and it must add **ZERO new MAM API surface** (the compliance invariant: automation stays
"Prowlarr search + `dynamicSeedbox.php`" only; the governor must never call MAM).

The owner ruled (2026-07-11 eve): **build the governor BEFORE any list automation drives grabs**. v1
visibility is **logs + Pushover only** (Q-03); an in-app Metrics tile is a later nicety.

## Decision drivers

- **Zero new MAM API surface** — count locally, gate an internal component; never touch MAM.
- **Durability** — the gate must not be silently undone by another controller.
- **No self-inflicted breakage** — the gate must not trip LazyLibrarian's provider-failure blocklist (LL
  auto-blocks a provider after repeated errors, which would fight the governor).
- **Fail-closed** — if we cannot count, assume at-cap and pause (never risk a 24h block).
- **Single seam, small blast radius, idempotent, directly observable.**
- **Fits the estate's sync-mode pattern** (PLAN-019 smart-alerts): a standalone `@hnet/sync` mode + a
  `packages/domain` single-writer + a state table + transitions-only Pushover via the `notification_outbox`.

## Considered options

Counting was never in doubt: **count unsatisfied LOCALLY from qBittorrent** (category `books-mam`, torrents
with `seeding_time < 72h` PLUS still-downloading — owner ruled conservative, Q-01). Verified live 2026-07-11
from the `frontend` namespace: qBittorrent's WebAPI answers **unauthenticated** cross-namespace
(`GET /api/v2/torrents/info?category=books-mam` → the 13 live torrents), so the governor CronJob runs in
`frontend` alongside the other sync modes with **no qB credential** and no relocation to `downloads`.

The gate SEAM had two candidates:

- **(a) LazyLibrarian's own provider toggle** (`changeProvider&name=Torznab_0&enabled=0/1`, LL apikey). LL-
  native; a disabled provider is simply not queried (no error storm). Verified working live. **BUT** — the
  decisive fact — Prowlarr runs a **LazyLibrarian application with `syncLevel=fullSync` (app id 4)**:
  Prowlarr **owns** LL's `[Torznab_*]`/`[Newznab_*]` provider entries and **clobbers manual LL-side edits on
  every sync** (it overwrote a manual `dlpriority=0` with 26 within the hour; mapping is
  LL `dlpriority = 51 − Prowlarr indexer priority`). So an LL-side `enabled=false` is **not durable** — the
  next fullSync re-enables it. **Rejected.**
- **(b) Pause the MyAnonaMouse Prowlarr indexer (id 17)** via Prowlarr's API. The original worry was that a
  disabled indexer would error LL's Torznab feed and trip LL's blocklist. Verified live this is **not** what
  happens: toggling indexer 17 `enable=false` **triggers a Prowlarr application sync that propagates
  `enabled=false` down to LL's `Torznab_0`** (verified: within ~6s LL `listNabProviders` flips MAM
  `Enabled` 1→0 and `config.ini` drops the `enabled` line), so **LL stops QUERYING the provider entirely** —
  no failed Torznab searches, so the provider-failure blocklist is **never tripped**. Re-enabling propagates
  back cleanly (verified end-to-end, restored to enabled both sides). The Prowlarr `enable` flag is the
  **durable source of truth** (fullSync respects it — that is what fullSync propagates).

## Decision outcome

Chosen option: **(b) toggle the MyAnonaMouse Prowlarr indexer's `enable` flag** — because it is the only
**durable** seam (Prowlarr owns the LL provider entry, so the LL-side toggle is clobbered; the Prowlarr flag
is what fullSync propagates), it **avoids the LL blocklist entirely** (LL stops querying rather than erroring),
and it is a single idempotent seam with blast radius = the one MAM indexer. The toggle is a **GET-then-PUT of
the full indexer object changing ONLY `enable`** (`GET /api/v1/indexer/17` → set `enable` → `PUT`) so it never
disturbs owner-tuned fields (indexer priority is pinned to 50 → LL `dlpriority` 1, keeping usenet strictly
first). Prowlarr's key comes from the shared `media-stack` 1Password item, already `extract`ed into the
haynesnetwork ExternalSecret — one added template line (`PROWLARR_API_KEY`), **no new 1Password item**.

The governor is a standalone `@hnet/sync` **`mam-governor`** mode (~15-min CronJob) calling the
`packages/domain` single-writer **`evaluateMamGovernor`**, which: counts (fail-closed on error), decides the
gate (`unsatisfied ≥ limit − buffer` ⇒ pause; below ⇒ resume), idempotently actuates the Prowlarr indexer,
then in ONE transaction upserts the single-row `mam_gate_state` AND — on a gate transition or a >48h
zero-headroom episode — enqueues a `notification_outbox` row (ADR-034 C-01 same-tx). First sight records a
baseline and pages nothing.

The Prowlarr indexer WRITE lives in **`@hnet/downloads/write`**, import-confined to `packages/domain` exactly
like `@hnet/arr/write` / `@hnet/plex/write` (the `arr-write-import-guard` test is extended to cover it). The
qBittorrent count read and the Prowlarr indexer-enable read live in `@hnet/downloads/read` (safe everywhere).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the gate is DURABLE — the Prowlarr `enable` flag is exactly what fullSync propagates, so nothing silently re-enables MAM; and LL never sees a Torznab error, so its provider-failure blocklist is never tripped. |
| C-02 | Good: ZERO new MAM API surface — counting is qBittorrent-local, gating is a Prowlarr-local config PUT; neither calls MAM (compliance invariant preserved). |
| C-03 | Good: fail-closed — a failed qBittorrent count is treated as at-cap and the gate is (attempted) closed, so a counting outage can never let grabs breach the cap. Disabled-safe: the transition enqueue always records; the notify-outbox drainer no-ops without `PUSHOVER_*`. |
| C-04 | Good: reuses the smart-alerts shape end-to-end (standalone sync mode, domain single-writer, state table, transitions-only outbox), and `@hnet/downloads/write` extends the existing import-confinement guard. |
| C-05 | Bad/limit: the buffer (default 5) is the ONLY anti-flap / cap-safety margin — grabs already past Prowlarr's search when we pause can still land, so `buffer` slots are reserved below the hard `limit`. A mis-set `buffer ≥ limit` is clamped to `limit − 1` so the gate can never wedge permanently closed. |
| C-06 | Bad: the seam couples us to Prowlarr's fullSync behaviour. If the LL application's sync level were changed to a non-syncing mode, disabling the indexer would stop propagating and the disabled-indexer-Torznab-error/blocklist risk would return. Documented in OPS-013; the indexer `enable` read is the drift check. |
| C-07 | Future (PLAN-040): the limit/buffer/stuck-hours resolve through ONE seam — `resolveGovernorConfig()` (env-backed in v1, called once per run). PLAN-040 moves them to an audited DB-backed `app_setting` with governor-state visibility behind that same call, WITHOUT reworking the mode. The owner manually bumps `MAM_UNSATISFIED_LIMIT` at each MAM rank promotion until then. |

## More information

- **Requirements:** PRD-001 R-172..R-177 (this change). **Design:** DESIGN-027. **Glossary:** T-156..T-160.
- **Migration:** `0041_mam_governor_state` (the single-row `mam_gate_state` table; `SYNC_RUN_KINDS` +=
  `mam-governor`; `NOTIFY_OUTBOX_EVENT_TYPES` += `mam_gate_paused`/`mam_gate_resumed`/`mam_gate_stuck`).
- **Precedent:** ADR-040 (smart-alerts sync mode + single-writer + state table + same-tx outbox), ADR-034
  (the transactional outbox), ADR-008/017 (confined external write surfaces).
- **As-built + break-glass:** OPS-013 §10 (the governor section) — includes the live-verified indexer↔LL
  propagation and the fullSync-clobber fact.
- **Strategy:** MAM stays a rating-governed FALLBACK; continuous 24/7 seeding raises the account rank until
  the cap stops binding (the owner bumps the limit at each promotion; PLAN-040 makes it an admin setting).
