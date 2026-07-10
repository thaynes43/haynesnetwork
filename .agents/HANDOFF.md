# HANDOFF — cold-start resume point

> The single resume point for agents. A fresh session should be able to orient from **only this
> file + `CLAUDE.md`**. Update this in the same change as any milestone. Derive current state from
> the top down; you should not have to reconcile anything.

- **Last updated:** 2026-07-10 — **PLAN-011 Authentik hardening COMPLETE (owner-present): config-as-code
  blueprints + native-account MFA, live.** The Authentik login estate (brand · flows · sources · MFA) is
  now **GitOps blueprints** in `haynes-ops` (`…/network/authentik/app/blueprints/`, one file per concern,
  mounted onto the worker as a ConfigMap) — a **drift-zero** baseline (`10`/`20`/`30`, proven to change
  nothing on apply) with **native-account MFA** (`40-hnet-mfa`) on top. Native (internal-type) accounts —
  `thaynes`, `akadmin`, hand-created locals — now present a **WebAuthn passkey or TOTP** on the
  **username+password** path (enroll on first challenge; friendly chooser "Passkey (recommended)" /
  "Authenticator app (6-digit codes)"). **Plex-source logins are never challenged** (login-only source
  flow — owner ruling: `thaynes`' Plex path accepted, Plex 2FA covers it); the **`mfa-exempt`** group
  (`hnet-e2e`, `hnet-e2e-member`) skips MFA **fail-closed** so Playwright stays green. Owner enrolled a
  **1Password passkey + TOTP backup** on `thaynes` (round-trip verified). **Credentials now:** `akadmin`
  password **rotated + valid in 1Password** (the stale-bootstrap gotcha is GONE; akadmin is break-glass and
  MFA-enrolls on next interactive login); `hnet-e2e` / `hnet-e2e-member` passwords rotated (owner-stored in
  1P); the API token stays in the 1P `homepage` item; provider `client_secret` in the 1P `haynesnetwork`
  item. Live-verified: all four blueprints report `successful`; the MFA stage reads `configure` +
  `[totp, webauthn]`. **Client caveat:** Safari/WebKit fails the TOTP-setup flow — use Chrome (server
  healthy throughout). Docs: **ADR-042 / OPS-009 / R-133..R-136 / T-121..T-123**; haynes-ops PR #2014 +
  `a8bd665b`/`42347d80`/`58355768`. **Open:** Q-10 (akadmin: keep break-glass-with-MFA vs disable
  interactive login), Q-11 (blueprint the OIDC provider/app for full GitOps). Prior milestone — the
  ytdl-sub UX package (below).
- **Prior:** 2026-07-10 — **ytdl-sub UX package (the owner's morning-review fixes to PLAN-022).**
  One release, three items (ADR-041 / DESIGN-017 D-07..D-09 / R-131..R-132 / T-120; **no migration**):
  **(1) Wall perf** — the `/api/ytdlsub/poster` proxy now serves **fixed-size WebP variants** from
  k8plex's own photo-transcode endpoint (closed `size=grid|still` allow-list; original-art fallback on
  a transcode miss), memoized in an in-process byte-capped `ThumbLruCache` (NOT a store) with a strong
  `(size, thumb)` ETag → browser 304s. Measured pod→k8plex: **Peloton wall 29.3 MB → 46 KB (630×)**,
  YouTube 6.9 MB → 856 KB (8×). `MediaPoster` tiles fade in over the reserved 2:3 box (ADR-015-safe).
  **(2) Tab order** — Movies | TV | Music | Peloton | YouTube | **My Fixes last** (D-08).
  **(3) Read-only drill-in** — poster tiles click through to `/library/ytdlsub/[library]/[ratingKey]`:
  show → collapsible seasons → **lazily-loaded** episodes (title · air date · duration + a 16:9
  `size=still` thumb), via new `@hnet/plex` `getMetadataItem`/`listMetadataChildren` reads and
  `ytdlsub.detail`/`ytdlsub.episodes` (both `ytdlsubProcedure`-gated AND **section-confined** by
  `librarySectionID` — a cross-library ratingKey is found:false). No ledger, no actions, no write
  surface. The `ytdlsub` section is **still Admin-only** (no role rows as of this change — the owner's
  flip is still pending, plan Q-03), and the durable-poster sink (PRD **Q-06**) remains open — ADR-041
  C-07 keeps the override seam ready, nothing here makes it harder.
  Prior milestone — **PLAN-019 Metrics → Hardware sub-tab + SMART alerting shipped (v0.34.0), live** (below).
- **Prior:** 2026-07-10 — **PLAN-019 Metrics → Hardware sub-tab + SMART alerting shipped
  (v0.34.0), live.** The 017-scaffolded **Hardware** tab is now wired: an **UNGATED** (owner ruling —
  `full` and `limited` see the same payload) read off the live in-cluster Prometheus via a new
  `@hnet/metrics` `getHardwareMetrics`. Four groups: the headline **NVMe endurance** panel (per-pool
  framing — **Cache-apps** mirror [critical appdata, 57–60% worn] vs **Cache-staging** [expendable, over
  rated endurance but *holding*: spare 100%, 0 media errors] — wear odometer + projection-to-90% with a
  graceful "insufficient history" until it accrues + the real EOL signals), a **Drive health** table (a
  sleeping array disk emits no series → shown "asleep", never red), **Node load**, and a **Proxmox
  host→VM showcase** (in-place expander, ADR-015 exception). **SMART alerting** (ADR-040 / DESIGN-020,
  R-130): a **`smart-alerts` sync mode** + `evaluateSmartAlerts` single-writer + **`smart_drive_state`**
  table (migration 0033) — critical-only, transitions-only paging via the PLAN-016 `notification_outbox`
  (new `smart_degraded`/`smart_recovered` event types). **Baseline-on-first-sight NEVER pages** the known
  staging state; only NEW deterioration does; enqueue + state update commit in one tx. Live-proven on
  prod: a `smart-alerts` run over REAL Prometheus baselined **43/43 drives, enqueued 0**; a second run
  baselined 0 / enqueued 0 (no re-page). Sources (pve-exporter + node-exporter + smartctl) already
  scraped → **haynes-ops change was the image bump only**; **glances deferred** (ADR-040 Q-01).
  **OWNER FOLLOW-UPS:** (1) add a **`smart-alerts` CronJob** in haynes-ops (mirror the notify-outbox
  schedule) to run detection on a schedule — the mode ships in the image but no CronJob exists yet;
  (2) the parallel **ytdl-sub UX PR (#168) also claimed "ADR-040"** — it must renumber (mine merged
  first). ADR-040 / DESIGN-020 / R-129–R-130 / T-117–T-119 / migration 0033.
- **Prior:** 2026-07-10 — **PLAN-020 Metrics → Network sub-tab shipped (v0.33.0), live.**
  The 017-scaffolded **Network** tab now renders off the live in-cluster Prometheus via a new
  `@hnet/metrics` `getNetworkMetrics` read (which REUSES `getNetworkOverview` for the WAN meters —
  one denominator) + a `metrics.network` procedure. **`limited`** = the two WAN upload/download
  **usage-vs-capacity** meters + a **7-day WAN throughput history sparkline** (the only value-add
  over the Overview). **`full`** ADDS **infrastructure-performance** groups — per-gateway/switch/AP
  **CPU·mem·load**, **WAN health** (gateway speedtest + internet-path latency), per-uplink caps, and
  **site rollup COUNTS** (APs/switches/gateways/connected-device count) — each with an "Open in
  Grafana ↗" deep-link to the UniFi-Poller boards (Network Sites / USW / UAP; the **Client-Insights
  board is deliberately NOT linked**). **HARD PRIVACY INVARIANT — no client identities at ANY
  level** — enforced by construction: the allow-listed `network.ts` query module is the single place
  any `unpoller` series is named, and the unit test *"network privacy invariant — the allow-listed
  PromQL module"* proves every query names only `unpoller_(site|device|wan)_*` and matches none of
  the deny substrings (`unpoller_client_`/`_remote_user_`/`_info`/`mac`/`hostname`/`rssi`/`signal`);
  the `limited`/`full` payload is disjoint and server-authoritative (`includeInfra` — `limited` never
  fetches or receives the infra grain). UniFi device names (an AP "Garage") are infrastructure,
  allowed at `full`; the only client-adjacent number is the aggregate station COUNT. **NO migration /
  NO write surface** — rides 017's `metrics` section + `metrics_level`; ADR-039 **refines** (does not
  supersede) ADR-037 C-03/C-04. Pod-verified live: unauth `metrics.network` = 401; the v0.33.0 pod →
  Prometheus returns real WAN 46339 B/s up / gateway CPU 42.7% / 7 APs via the app's exact PromQL.
  Docs: ADR-039 / DESIGN-019 / R-127..R-128 / T-114..T-116. **OWNER's morning:** authenticated
  full-vs-limited visual confirm (SSO-gated; hermetic admin screenshots are the sanctioned
  substitution — desktop + 390px, dark/light); Q-01 promote PoE/port-errors/radio/topology? The
  `metrics` section still ships **Admin-only until the owner flips a role to `limited`**.
  Prior milestone — **PLAN-018 Metrics → Apps sub-tab shipped (v0.32.0), live.**
  The 017-scaffolded **Apps** tab now renders four curated, phone-friendly groups off the live
  in-cluster Prometheus via a new `@hnet/metrics` `getAppsMetrics` read + a `metrics.apps`
  procedure: **Collection** (radarr/sonarr/lidarr totals · monitored · missing · upgrades),
  **Acquisition pipeline** (queue · grabs/hr · health), **Download clients** (SABnzbd
  `sabnzbd`/`sabnzbd-fast` lanes + qbittorrent/slskd reachability — the collection wave's new
  exporters), **Indexers/Prowlarr** (fleet · response times · query rate) — each with a muted
  "Open in Grafana ↗" deep-link (`d/arr-library-overview`, `d/downloads-clients-indexers`,
  OPS-008). **Both-levels** (no *arr/downloader series names a user) with the full-only seam kept
  present-but-empty (`requesterActivity`, ADR-037 C-03) for a future requester panel. **NO
  migration / NO new ADR / NO guard edit** — rides 017's section + level model; visibility is
  still the `metrics` section (**Admin-only until the owner's flip**). Pod-verified live: totals
  9564/114118/55507 match Prometheus; unauth `metrics.apps` = 401. **OWNER's morning:** Q-01
  fast-lane split at `limited`? Q-02 bazarr panel group (sidecar live, not panelled)? Q-03 keep
  all 3 Grafana boards? Docs: DESIGN-018 / OPS-008 / R-125..R-126 / T-113.
  Prior milestone — **PLAN-022 ytdl-sub Library sub-tabs shipped (v0.31.0), live.**
  Two new **Library** sub-tabs (Peloton, YouTube) surface the k8plex ytdl-sub libraries
  (`HOps Peloton` / `HOps YT`), read **DIRECTLY** from the Plex server via a new
  `PlexReadClient.listSectionContents` — **no ledger sync** (this content has no *arr; ADR-038).
  Gated by the new **`ytdlsub`** Section Permission (`disabled` no-row default ⇒ **ships
  Admin-only**); posters stream through a session- + section-gated Plex-thumb proxy
  (`/api/ytdlsub/poster`, extends ADR-019) with a `MediaPoster` fallback tile. Migration 0032 (one
  CHECK rebuild) verified live; the deployed pod reads real k8plex data (12 Peloton / 71 YouTube
  shows). **OWNER's morning actions:** screenshot review → flip role(s)' `ytdlsub` to `read_only`
  (plan Q-03); answer the durable-poster sink (PRD **Q-06** — store deferred; resilient display
  shipped). Docs: ADR-038 / DESIGN-017 / R-121..R-124 / T-110..T-112.
  Prior milestone — **PLAN-017 Metrics section foundation (v0.30.0), live on staging:** a top-level
  **Metrics** section (nav after Bulletin) with an Overview (WAN usage-vs-capacity meters + cluster
  load/memory + storage snapshot), per-role **Full/Limited** (`roles.metrics_level`), and the
  read-only **`@hnet/metrics`** Prometheus client. Migration 0031 verified live. **Ships
  Admin-only** — the OWNER's morning action opens it to Default(limited) + verifies the Limited
  view live. Docs: ADR-037 / DESIGN-016 / R-117..R-120 / T-106..T-109. Q-02: download capacity
  seeded **2256 Mbps provisionally** — owner to confirm.
  Prior milestone — session-2 wrap: **v0.29.0 (signed), live at https://haynesnetwork.com**; every
  published image is keyless-cosign-signed under a Kyverno **Enforce** policy; the trash automation
  loop is armed AND proven in production (first real sweep 2026-07-09). Every buildable plan
  **002–017** is shipped, deployed, and live-validated. Session-2 chronicle:
  `.agents/context/2026-07-10-session-wrap.md`.

## Current state

**What this is.** haynesnetwork is the SSO front door for `*.haynesnetwork.com` — an Authentik-OIDC
(Plex-primary) web app giving Haynes-Plex users a permissioned dashboard, Plex library self-service,
and media fix/ledger/trash tooling backed by the *arr stack. Ten `@hnet/*` workspace packages
(+ **metrics** — a read-only Prometheus client, ADR-037):
**db** (Drizzle + Postgres 16), **domain** (single-writer logic; audit/ledger rows written in the
same tx as the mutation), **arr** (Sonarr/Radarr/Lidarr; `/write` import-confined to domain),
**plex** (server + plex.tv XML-ACL sharing; `/write` import-confined, ADR-017), **sync** (one-way
*arr→ledger + all the CronJob sync modes), **auth** (Better Auth + Authentik OIDC), **api** (tRPC
routers), **ui** (token-themed `data-theme` components; `tokens.css` = the only hex), **test-utils**
(embedded-PG16 + stub harness).

**Release train.** Conventional commits → **release-please** opens the release PR → merge tags `v*`
→ CI builds `ghcr.io/thaynes43/haynesnetwork`, **keyless-cosign-signs by digest + verifies in-run**
(the verify step **retries** on GHCR signature-propagation lag rather than red-flagging — see the
cosign-verify flake note below) → **manually bump the image tag in the sibling `haynes-ops` repo**
(`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`) → **Flux reconciles** →
`kubectl` context **`haynes-ops`** to observe. There is **no Flux image automation** — deploy is the
manual tag bump. Runbook: `docs/ops/004-deploy-runbook.md`.

**Workflow.** GATE A is executed (PR flow). `main` is branch-protected: branch `<type>/<slug>` → PR
→ required checks `lint-and-typecheck`, `test`, `build` green → squash-merge. `e2e` is advisory.
Local merge gate mirrors CI: `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`.
`pnpm dev:local` boots the whole app with no Docker (embedded PG16 + stub OIDC/*arr/Seerr) on :3000.

**Board status.** All release-sized plans **001–016 are in `.agents/plans/completed/`** (see
`.agents/plans/README.md`). Post-016, session 2 shipped v0.14.1→v0.29.0 as a run of owner-feedback
batches that hardened the trash automation loop into a proven production pipeline. Nothing buildable
is queued; the next session is owner-directed (agenda below).

## The trash automation pipeline — as-built and PROVEN

**First production sweep ran 2026-07-09 23:45 ET: 14/15 deleted, 90.7 GiB reclaimed.** The one
survivor was **honestly guardian-skipped** because it left the rule pool mid-window (the guardian
re-checks eligibility at the deletion gate — correct behavior, not a bug). Seerr entries for the
deleted items were cleared via **forceSeerr**; the **Pushover** run summary was delivered. This is
the loop working end-to-end against real Radarr/Sonarr/Maintainerr/Plex/Seerr.

The pipeline is a **separation of responsibilities**: *rules promote candidates, the app schedules
deletion, humans rescue.* Four layers:

1. **Rules (Maintainerr, source of truth for the candidate pool).**
   - **Movies:** IMDb rating **< 6.0** & votes **≥ 100** & **never-watched-on-HaynesOps** & **NOT a
     media request** → **~685 candidates**.
   - **TV:** rating **< 6.0** → **~8–13 candidates**.
   - `deleteAfterDays 9999` + `arrAction 0` (DO_NOTHING) so **Maintainerr never deletes on its own** —
     the app owns deletion timing. The **SAFE audit enforces Maintainerr aging invariants** so a rule
     pool can never self-delete out from under the app (v0.27.0).

2. **Pools → per-kind tabs.** `/trash` is **Overview · Movies · TV · Recently Deleted · Activity**.
   The pending walls are **poster walls served from a Postgres read-model** (`trash_candidates`,
   ADR-035, migration 0027) — *not* live Maintainerr crawls (that was the 9.5s→148ms fix; see the
   incident log). Candidates are **paginated**, **strategy-sorted** ("Next up" mirrors the deletion
   strategy), refreshed on an **8h Maintainerr cadence label** plus a **5-min post-save refresh**.

3. **Batches.** Admins **create** a batch with **GB- or count-targeting**, the **admin gate is ON**,
   deletion happens in **green-light windows**. Users get **family save windows** to rescue posters.
   An admin can **force-expire mid-window** behind a **typed confirmation** (audited). The **sweep
   runs at :45 hourly** (CronJob) and only ever deletes **expired, green-lit** batches. One open
   batch per kind is the enforced invariant.

4. **Notifications (Pushover).** Fired on **created / green-lit / final-warning (2h before) /
   day-before / swept**. Delivery uses an **all-day window by default** now (was 18–22). Transactional
   `notification_outbox` enqueued in the same tx as the transition; a `notify-outbox` CronJob drains it.

**Space policy (armed).** Over-target mode: **80% target vs 78.8% live**, **7-day cooldown**,
**minCandidates 10**, **per-kind caps**. A continuous mode is also available. The policy is
**propose-only** — it drafts batches into the normal admin gate; it never deletes or promotes.

**Separation-of-responsibilities ruling (owner-settled this session):** rules promote / the app
schedules / humans rescue. There is **NO requester guardian keep** — a requested item shows an
**info badge only** (it does not block deletion). The **recently-watched keep is retained** (real
protection). Cross-server watch visibility on the walls is **informational, not protection**.

## Roles

- **Admin ×2** — full control.
- **Family (KAH517)** — view + save/unsave + restore + window rescue.
- **Default** — view + save/unsave.
- **Mobile admin fully works** — Users role-select, the roles editor, and all settings are
  portrait-safe (fixed this session; the role editor works on phones).

## Owner's remaining personal items

- **MFA** — ✅ DONE (PLAN-011, 2026-07-10): native-account MFA live via Authentik blueprints; owner
  enrolled a 1Password passkey + TOTP backup. See the top block + ADR-042 / OPS-009. Only Q-10
  (akadmin interactive-login policy) / Q-11 (blueprint the OIDC provider/app) remain.
- **Optional Cloudflare WAF / HSTS** — deferred; the zone-scoped token was never provided, so this
  stays owner-gated.
- **Zscaler categorization** — RESOLVED (owner's request approved).

## NEXT SESSION AGENDA (owner-stated)

1. **Larger site features** (owner will direct).
2. **Authentik MFA hardening + blueprints/GitOps migration** — ✅ DONE (PLAN-011, 2026-07-10).
   The login estate is now config-as-code blueprints in `haynes-ops`
   (`kubernetes/main/apps/network/authentik/app/blueprints/`) with native-account MFA live; the
   executed record (objects, pks, apply/verify/rollback, the Safari caveat, credential locations) is
   **`docs/ops/009-authentik-blueprints-and-mfa.md`** and the decision is **ADR-042**. The branding-era
   API seed (`docs/ops/authentik-apply-seed/` + `docs/ops/001-authentik-provisioning.md`) remains the
   content-rollback source and the record for the still-API-managed OIDC provider (Q-11).

## Morning check owed

**Kometa runs at 6:30 AM.** Verify it does **not** re-import the 14 deleted movies. All 14 are below
the chart vote floors, so it shouldn't — but confirm. **Lever if it does:** set
`radarr_add_missing: false` per chart in Kometa config.

## Known flakes / backlog

- **57P01 CI flake** — embedded-PG teardown race hits `packages/auth` and `packages/sync`
  (`incremental-sync.test.ts`). **Rerun protocol:** just re-run the failed job; it's non-deterministic
  teardown, not a real failure.
- **Catalog keyboard-reorder e2e (T-8)** — known flaky.
- **Family-window e2e** — serial-state flake.
- **Rules tuning v2** — owner-requested: bring in **non-IMDb metrics** (the current pool is
  IMDb-rating-driven). Not yet built.
- **Recently-Deleted "By: System"** for cron sweeps — consider crediting the human who green-lit the
  batch instead of the cron actor.
- **`notification_outbox` cleanup** — old `saved_reason` / `requested_override` columns are now
  unread; candidates for a cleanup migration.

## Where to look

- **Docs index:** `docs/README.md`. Invariants: `packages/domain/README.md` (single-writer,
  audit-in-same-tx, arr-write import confinement).
- **Deploy:** `docs/ops/004-deploy-runbook.md` (manual tag bump in `haynes-ops`; the 1Password
  `haynesnetwork` secret contract).
- **Local verify (no Docker):** `docs/ops/003-local-verification.md`. Tests run embedded PG16 — never
  SQLite/MySQL; `@embedded-postgres/linux-x64` MUST stay in `pnpm-workspace.yaml` `allowBuilds`.
- **Cutover / edge:** `docs/ops/005-root-domain-cutover.md` (Executed). Post-cutover watch items live
  there.
- **Image signing / break-glass:** `docs/ops/006-image-signing.md` (dedicated Enforce policy;
  rollbacks must target signed tags v0.7.0+).
- **Trash wall perf (ADR-035 read-model):** `.agents/context/2026-07-09-trash-wall-perf.md`.
- **Session-2 full chronicle:** `.agents/context/2026-07-10-session-wrap.md`.

## History

- **Session-2 chronicle (v0.14.1→v0.29.0):** `.agents/context/2026-07-10-session-wrap.md`.
- **Session-1 board build (plans 002–016, v0.5.0→v0.22.0):** as-built records in
  `.agents/plans/completed/`; the pre-session-2 HANDOFF narrative is preserved in git history.
- **Bootstrap → v0.3.1 (waves 1–11) + historical gotchas:**
  `.agents/context/2026-07-04-waves-1-11-archive.md`. Kickoff decisions:
  `.agents/context/2026-07-03-kickoff.md`. Consolidated backlog:
  `.agents/context/2026-07-05-backlog-recon.md`.
