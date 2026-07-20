# ADR-074: Adopt ytdrivarr — the *arr-shaped ytdl-content suite service (replaces ytdl-sub-config-manager)

- **Status:** **Accepted (owner, 2026-07-20 — "That all sounds good")**. All four fork positions
  (a)–(d) ratified as recommended. DESIGN-045 Q-01 (AGPL-3.0), Q-02 (own Postgres 16 instance in
  `downloads`), Q-05 (confirm-then-delete at M3), Q-06 (podcasts/RSS non-goal) resolved on the
  defaults; Q-04 (poster-guard fold-in) stays the recorded open fork. **Q-03 OVERRIDDEN at
  Acceptance:** "let's move away from audio as video right away and support that first class" —
  music is FIRST-CLASS from the M2 cutover (see the DESIGN-045 same-day acceptance amendment).
- **Date:** 2026-07-20
- **Deciders:** Tom Haynes (scoping rulings 2026-07-20, captured in PLAN-025 — the four gating
  questions Q-01/Q-04/Q-05/Q-06 and the plugin-architecture addendum are BINDING). The technical
  forks (a)–(d) in this ADR are the Opus design agent's recommendations off the two landed research
  notes; each is marked RECOMMENDED and is the owner's to ratify or veto at Acceptance.
- **Relates:** **PLAN-025** (the ytdl config-manager platform saga — the rulings this ADR codifies) ·
  the two research notes `.agents/context/2026-07-20-ytdrivarr-q02-source-matrix.md` (the Q-02 source
  sweep, cited "Q-02 §N") and `.agents/context/2026-07-20-ytdrivarr-q03-donor-audit.md` (the Q-03
  donor audit, cited "Q-03 §N") · **DESIGN-045** (the architecture of record realizing this ADR) ·
  **DESIGN-037 / Libretto** (the suite-repo AUTONOMY precedent — generic/reusable, own release train;
  CLAUDE.md rule 10. NOTE: Libretto is headless; ytdrivarr is NOT — the *arr split, owner 2026-07-20
  "arrs are not headless"; see C-11) · **ADR-072 / DESIGN-043** (the collections **direct-add**
  doctrine — caps per role, over-cap → ticket-materialize, admins unbounded, audit rows same-tx; the
  shape Q-05 reuses) · **ADR-070** (the `@hnet/libretto` confined read/write client — the template a
  new `@hnet/ytdl` follows exactly) · **ADR-038 / ADR-041 / ADR-047** (the current read-only ytdlsub
  Library surfaces + poster guard this adds write flows to) · **hard rules 4** (external software is
  the source of truth; the only write-backs are explicit) **6** (audit rows in the same transaction)
  **10** (suite-repo autonomy — build/PR/merge/deploy independently, generic/reusable; its *headless*
  clause is Libretto-specific and does NOT extend to ytdrivarr, which ships its own operator console —
  owner 2026-07-20 "arrs are not headless").

## Context and problem statement

The estate downloads YouTube and Peloton content through **ytdl-sub** (a yt-dlp wrapper) driven by
per-library `subscriptions.yaml` files, on `*/15` downloader CronJobs in namespace `downloads`
(Q-02 §4). The Peloton file is generated nightly by a bespoke service,
`thaynes43/ytdl-sub-config-manager` (deployed `0.7.0`): it logs into Peloton with headless Selenium,
scroll-scrapes new classes, mints a short-lived API bearer, regenerates the 1,454-line Peloton
`subscriptions.yaml`, and **PRs it to haynes-ops with auto-merge** — churning that file into git
daily (Q-03 §"Deployment"). The YouTube `subscriptions.yaml` is hand-edited git YAML (~80 channels).

The owner's standing assessment (PLAN-025, vision 2026-07-10): the config-manager is "old, hard to
work with," the Peloton logic is "fragile and buggy **but works**." The Q-03 audit confirms decent
engineering in the wrong shape — ~9.2k LOC, 87% coverage, but Peloton-hardcoded to the bone (its
"generic" `StrategyLoader`/`ScraperFactory` abstraction is aspirational; the `Config` dataclass and
run loop are Peloton all the way down), with **no HTTP server, health, or metrics** and a
silent-stall failure mode (bearer capture fails → the downloader keeps running an aging token →
downloads stop with no alarm).

Three forces make this more than a refactor:

1. **Fix-everywhere parity (PLAN-041).** YouTube/Peloton Library items can only get the TV/Movies
   "Fix" (re-download/replace a bad copy) if a **service** owns per-item remediation — a pure config
   manager cannot re-fetch a single item. This is the decisive driver for the *arr shape.
2. **Member self-service.** The `ytdlsub` section's `edit` permission rung exists in the schema but
   nothing consumes it (Q-03 §"App side"); the owner wants members to add/remove YouTube channels
   from haynesnetwork.com — the write grant it was reserved for.
3. **The bot-churn tax.** The nightly git-PR write-back de-noises nothing and floods haynes-ops
   history with a machine-owned 1,454-line file (Q-03 §"Surprises").

The owner ran a scoping session (2026-07-20) and RULED all four gating questions on the recommended
option, plus a binding addendum on the plugin architecture (PLAN-025). This ADR codifies those
rulings and takes explicit, vetoable positions on the technical forks the rulings left to design.

## Decision drivers

- **The four binding scoping rulings (owner, 2026-07-20, PLAN-025):**
  - **Q-01 → *arr-shaped service.** Own API/domain (sources, subscriptions, scheduling, media
    rules); haynesnetwork integrates it exactly like Sonarr/Radarr (one-way sync in, confined write
    client, hard-rule-4 source-of-truth). Suite doctrine applies (the Libretto precedent).
  - **Q-04 → service-owned state.** Its own DB; it GENERATES ytdl-sub configs itself — **no git-PR
    write path** (member mutations want instant effect; the Kometa PR-per-change friction was
    live-measured the same day). haynes-ops just deploys the service.
  - **Q-05 → direct member mutations with caps + audit.** Edit-granted roles add/remove channels
    directly (the ADR-072 collections direct-add doctrine: caps per role, over-cap → ticket, admins
    unbounded, audit rows same-tx). No suggest→approve.
  - **Q-06 → new repo; port the fragile-but-working Peloton logic behind the plugin seam.** The old
    manager keeps running untouched until cutover. The repo EXISTS: `github.com/thaynes43/ytdrivarr`
    (owner-created 2026-07-20, public; the name is owner-chosen).
- **The plugin-architecture addendum (owner, same evening — binding).** Near-verbatim: "It's
  important to remember how complex Peloton is vs YouTube so we need to 'plugin' like modularity like
  how *arrs let you plug in download clients etc." The complexity **spread** is the design driver: a
  trivial source (YouTube ≈ pure config generation over yt-dlp's native extractor) and a maximally
  complex one (Peloton: auth/session lifecycle, scrape cadence, bespoke season/duration mapping) must
  implement the **same stable contract**, the way Sonarr treats download clients / indexers / import
  lists as swappable modules. The contracts are specified **before** the Peloton port — the port
  validates the seam, it does not define it.
- **The estate already proves the pattern.** ytdrivarr is a **generalization** of a working
  service (the Peloton discover→emit→run loop), not a greenfield bet (Q-02 §"most important finding").
- **ytdl-sub's native surface is narrow.** Real prebuilt presets cover YouTube + SoundCloud +
  Bandcamp only; everything else is generic-preset or bespoke (Q-02 §2). This forces a **tiered**
  source matrix, not a flat "supports everything" promise.
- **Suite-repo autonomy (CLAUDE.md rule 10 / DESIGN-037).** ytdrivarr is a full-autonomy suite repo:
  generic/reusable (Kometa-for-ytdl-sub), its own release train, docs-first via its own README + PR
  descriptions — but **the design of record is this repo's DESIGN-045**.
- **The *arr model, NOT the headless model (owner 2026-07-20 — "arrs are not headless").** The
  Libretto headless doctrine does NOT extend to ytdrivarr. Like Sonarr/Radarr, ytdrivarr ships its
  OWN operator/admin console (source management, provider config + `test()`, run history,
  health/telemetry, logs), and haynesnetwork is the MEMBER-facing layer — members never touch
  ytdrivarr's UI, exactly as they never touch Sonarr's.
- **LAN-only, no user management (owner 2026-07-20).** ytdrivarr is LAN-only like the estate's *arrs
  (internal `*.haynesops.com` ingress, never a public `*.haynesnetwork.com` host) and has NO user
  management — no accounts, no OIDC, no roles; a single API key (the `X-Api-Key` idiom) guards its
  API, same as every *arr. ALL per-user identity, grants, caps, and audit live app-side in
  haynesnetwork; the app exposes SELECTED ytdrivarr capabilities over ITS OWN tRPC API and talks to
  ytdrivarr server-side via `ytdrivarr.downloads.svc.cluster.local` + the API key.

## Considered options

**Q-01 shape** — (1) keep a pure config manager; (2) **an *arr-shaped service** (CHOSEN, owner-ruled).
Only (2) can do per-item Fix parity (PLAN-041) and give the app a clean sync-in + confined-write
integration.

**Q-06 codebase** — (1) rework `ytdl-sub-config-manager` in place; (2) **a new repo, Peloton ported
behind the plugin seam** (CHOSEN, owner-ruled). The donor's plugin abstraction is aspirational; "port
behind the seam" means BUILD the seam, not reuse the donor's (Q-03 §TL;DR).

**(a) RUNTIME** — (a1) a Python core (reuse the donor's Selenium stack wholesale); (a2) **a
TypeScript core with out-of-process, job-dispatched heavy plugins** (RECOMMENDED); (a3) a TS core
that shells Python inline per run. (a1) forfeits the `@hnet` integration idioms and the estate's TS
gravity; (a3) couples a 6Gi Chromium lifecycle to the core process.

**(b) CONFIG DELIVERY** — (b1) keep the git-PR round-trip (rejected by Q-04 — it is the churn being
killed); (b2) the service writes a git ConfigMap via the k8s API (needs cluster-write RBAC; 1MiB
ConfigMap ceiling); (b3) **service-owned state projecting rendered per-library `subscriptions.yaml`
to a downloader-mounted volume (NFS-backed, the bearer.txt/cookies.txt mechanism already proven), no
git and no k8s-API write** (RECOMMENDED).

**(c) EXECUTION ENGINE** — (c1) ytdrivarr vendors yt-dlp and downloads itself; (c2) **ytdl-sub stays
the execution engine as short-lived Job/CronJob pods** (RECOMMENDED). Vendoring yt-dlp buys the
weekly extractor-break treadmill (Q-02 §5); the throttle machinery + 6Gi memory profile are already
proven in the ytdl-sub image.

**(d) POSTER GUARD / assets (C8)** — (d1) fold the app-side Peloton poster guard into ytdrivarr now;
(d2) **leave the poster guard app-side for v1 (working, ledgered), record the fold-in as a later
fork** (RECOMMENDED). It works today (`runPelotonPosterGuard`, durable PNGs, `poster_guard_applications`
ledger, its own `:37` cron — Q-03 §"App side"); moving it is a net-new risk with no v1 payoff.

## Decision outcome

Adopt **ytdrivarr** as the *arr-shaped ytdl-content suite service that replaces
`ytdl-sub-config-manager`, with *arr-style plugin extension points (the C1–C8 provider contracts,
refined into DESIGN-045 D-04…D-11) specified before the Peloton port. The four scoping rulings are
codified as-ruled; the technical forks resolve as:

- **(a) TypeScript core + out-of-process, job-dispatched heavy plugins** (RECOMMENDED). The core
  (state, config emission, scheduling, the app-facing REST API) is TypeScript — matching the estate
  and the `@hnet` integration idioms. Tier-1 URL-list sources (YouTube et al.) run **in-core** (pure
  yt-dlp URL enumeration; no browser). Heavy plugins (Peloton) run **out of process**: the core
  enqueues a discovery/remediation job that a plugin-owned worker container (Python + Selenium +
  Chromium, 6Gi) executes and reports back through the C2/C3/C6 transport. Justified by browser
  isolation (a 6Gi Chromium crash must not take the core down), retryability (a job can be re-run
  without restarting the service), and blast-radius containment (the fragile scrape lives in its own
  pod). DESIGN-045 D-03.
- **(b) Service-owned state, projected to the downloader-mounted volume** (RECOMMENDED). ytdrivarr
  holds sources/subscriptions/runs in its own DB and **renders** per-library `config.yaml` +
  `subscriptions.yaml` to a volume the existing ytdl-sub downloader CronJobs mount (NFS-backed — the
  same media-volume path bearer.txt/cookies.txt already use). **No git round-trip, no k8s-API
  ConfigMap write** — a member's edit takes effect on the next downloader tick, and the daily
  haynes-ops bot churn is killed. DESIGN-045 D-14.
- **Audit answer (Q-04/Q-05).** The GitOps audit trail the old PR write-back provided is replaced by
  **audit rows written in the same transaction as the source mutation, in ytdrivarr's own DB** (the
  estate doctrine — hard rule 6 applied service-side), with **haynesnetwork mirroring** the source
  list + the audit for visibility (hard rule 4: ytdrivarr is the source of truth; the app syncs in).
  DESIGN-045 D-08/D-18.
- **(c) ytdl-sub stays the execution engine.** Pinned to its calendar-versioned image
  (`ghcr.io/jmbannon/ytdl-sub:YYYY.MM.DD`) and tracked by Renovate; **ytdrivarr never vendors
  yt-dlp**. Extractor breakage becomes a per-source HEALTH signal ytdrivarr surfaces (C7), not a
  treadmill it owns. DESIGN-045 D-16.
- **(d) The poster guard stays app-side for v1.** C8 (assets) is declared an **optional** provider
  capability; the Peloton poster guard keeps running in haynesnetwork unchanged. Folding it into
  ytdrivarr is **recorded, not decided** — a later fork (DESIGN-045 D-11 / Q-04 below).
- **Service surface + auth (owner 2026-07-20 — NOT headless; LAN-only; no user management).**
  ytdrivarr is API-first but **not headless**: it ships its own **operator/admin console** (DESIGN-045
  D-20 — source list, provider config + `test()`, runs, health, logs), LAN-only on a
  `traefik-internal` ingress matching the estate's live *arr pattern (`sonarr.haynesops.com` — LAN
  only, no login form, Authentik front door optional/later), guarded by a **single API key** with
  **no user management** (DESIGN-045 D-21). All per-user identity/grants/caps/audit live app-side
  (Q-05, DESIGN-045 D-18). Per the owner's **division-of-labor** ruling, the operator console is
  **Fable-built**; Opus builds the service internals.

The migration is phased so nothing user-visible breaks: the walking skeleton + contracts land first,
the YouTube YAML takeover is the clean first cut (no auth), the Peloton plugin port is hardened en
route (explicit waits, retries, health), then the app Edit and per-item Fix surfaces arrive. Both
downloader CronJobs, the app read surfaces, and the poster guard stay untouched until each cutover.
DESIGN-045 D-19 (M1–M5); PLAN-025 the executable build plan.

### Consequences

| ID | Consequence (→ originating ruling / fork) |
|----|-------------|
| C-01 | Good (→ Q-01): Fix-everywhere parity becomes reachable — YouTube/Peloton Library items get the same per-item Fix as TV/Movies because ytdrivarr owns remediation (C6 / D-09). This is the whole reason for the *arr shape; a pure config manager could never deliver it. |
| C-02 | Good (→ Q-06 + addendum): the C1–C8 provider contracts are specified BEFORE the Peloton port, sized by the YouTube↔Peloton complexity spread. A trivial source declares almost nothing (capability negation keeps YouTube in-core and stateless); Peloton declares auth+scrape+tokenMint+assets against the SAME interface. The port validates the seam rather than defining it. |
| C-03 | Good (→ Q-04 + fork b): the daily haynes-ops bot-PR churn of the 1,454-line Peloton `subscriptions.yaml` is eliminated — the service projects rendered config to the downloader volume directly. haynes-ops just deploys the HelmRelease; config is no longer git-tracked churn. |
| C-04 | Cost/accepted (→ Q-04): the GitOps audit trail the PR write-back gave up is REPLACED by same-transaction audit rows in ytdrivarr's DB + app-side mirroring. This is the estate's audit-in-same-tx doctrine (hard rule 6) applied service-side; visibility moves from `git log` to the app's read model. A deliberate trade: instant effect + no churn, for a DB audit instead of a git audit. |
| C-05 | Good (→ Q-05, via ADR-072): member self-service reuses the collections direct-add doctrine wholesale — Edit-granted roles add/remove channels directly, capped per role; over-cap opens an ADR-050 ticket carrying the source definition that materializes on one-click admin approve; admins are unbounded; audit rows commit same-tx. No new approval queue. The `ytdlsub` section's dormant `edit` rung finally has a consumer (roles grid flips toggle→tri). |
| C-06 | Good (→ fork a): heavy-plugin isolation — the 6Gi Selenium/Chromium Peloton worker runs out-of-process in its own container/Job, so a browser crash or hang cannot take down the core API, and a failed discovery/remediation is a retryable job, not a service restart. Tier-1 URL sources stay in-core (no browser tax). |
| C-07 | Good (→ fork c): ytdl-sub stays the execution engine (pinned + Renovate), so ytdrivarr never inherits the weekly yt-dlp extractor-break treadmill. Extractor breakage surfaces as a per-source health signal (C7), turning today's silent-stall failure mode into an alarm (bearer-age + selector-drift, D-10). |
| C-08 | Cost/accepted (→ fork a + Q-06): ytdrivarr is a NEW polyglot service — a TS core plus a Python worker image — and a new DB to run in `downloads`. More moving parts than a single batch CronJob, justified by parity + isolation + the app integration story. The donor's ~9.2k LOC is re-SHAPED, not rescued: the Peloton login/session/scrape/metadata/bearer logic and the episode-numbering are PORTED (hardened); the git-PR write-back, the Peloton `Config` dataclass, the string-import DI, most of the 896-line disk-repair layer, and the text-summary metrics are DISCARDED (Q-03 §"Port vs discard"). |
| C-09 | Good (→ Q-01, hard rule 4): haynesnetwork integrates ytdrivarr exactly like an *arr — one-way sync in, a confined `@hnet/ytdl/write` client import-guarded to `packages/domain` (the `@hnet/libretto` template; the `arr-write-import-guard` test extends to `@hnet/ytdl/write`), the browser never touches the write surface. ytdrivarr is the source of truth for sources/subscriptions; the app mirrors. |
| C-10 | Neutral/recorded (→ fork d): the app-side Peloton poster guard is UNTOUCHED in v1 (C8 = optional capability). Whether to fold poster durability into ytdrivarr is a later fork, recorded here and re-opened as DESIGN-045 Q-04 — not decided now, so v1 carries no asset-management risk. |
| C-11 | Good (→ owner 2026-07-20 "arrs are not headless" + rule 10 autonomy): ytdrivarr follows the *arr split, not the headless model — it ships its own LAN-only operator console (source/provider/run/health management, like Sonarr's, D-20) while haynesnetwork is the MEMBER-facing layer (Edit-grant mutations, Fix, walls) via the confined `@hnet/ytdl` client; members never touch ytdrivarr's UI, exactly as they never touch Sonarr's. It stays generic/reusable (standalone-valuable to anyone running ytdl-sub) and keeps its own release train. |
| C-13 | Good (→ owner 2026-07-20 — no user management): a single `X-Api-Key` guards ytdrivarr, same as every *arr, so there is no second identity system to run — no accounts, no OIDC, no roles in the service. ALL per-user identity, grants, caps, and audit stay app-side (the Q-05 machinery is firmly in haynesnetwork, reusing the ADR-072 direct-add model); ytdrivarr never knows which member did what, exactly like Sonarr. The app calls it server-side via `ytdrivarr.downloads.svc.cluster.local` + the key; the browser never sees it. |
| C-14 | Neutral (→ division-of-labor ruling, owner 2026-07-20): the operator console (D-20) is **Fable-built**; Opus builds the service internals (core, providers, emission, scheduling, remediation, the API). The console is scoped honestly as an operator surface (source/provider/run/health/logs over the same REST API), NOT a duplicate of the app's member UX. |
| C-12 | Cost/accepted (→ Q-06): the vestigial static `PELOTON_BEARER` 1Password secret on the `ytdl-sub-peloton` downloader (the real bearer comes from NFS `bearer.txt`) is flagged for cleanup — but only AFTER confirmation it is truly unused (DESIGN-045 Q-05). Removing it blind risks the downloader; confirm-then-delete. |

## More information

- Realized by **DESIGN-045** (the ytdrivarr architecture of record — the C1–C8 contracts as D-04…D-11,
  the tiered source matrix, config emission at library grain, the scheduling split, the deployment
  shape, the `@hnet/ytdl` integration, and the M1–M5 migration). Executed by **PLAN-025** (the M1–M5
  build plan; DO-NOT-DISPATCH gate lifted for docs — code waits on this ADR's Acceptance).
- The two research foundations: `.agents/context/2026-07-20-ytdrivarr-q02-source-matrix.md` (Q-02 —
  the tiered source matrix, estate usage, nine design tensions) and
  `.agents/context/2026-07-20-ytdrivarr-q03-donor-audit.md` (Q-03 — the Peloton deep-dive, port-vs-
  discard, the C1–C8 contract candidates, the runtime fork).
- The suite-autonomy precedent: **DESIGN-037 / Libretto** (generic/reusable, own release train;
  CLAUDE.md rule 10 — though Libretto is headless and ytdrivarr, per owner 2026-07-20, is not). The
  *arr LAN-ingress pattern to match: `kubernetes/main/apps/media/sonarr` in haynes-ops
  (`traefik-internal`, `sonarr.haynesops.com`, no login form). The RBAC/write precedent:
  **ADR-072 / DESIGN-043** (collections direct-add).
  The confined-client precedent: **ADR-070 / `@hnet/libretto`** (read/write split, arr-write-import-guard).
- Glossary: this change adds T-214…T-224 (ytdrivarr, Source, Source Provider/Plugin, SubscriptionEntry,
  ytdrivarr Library, ytdrivarr Run, RemediationJob, Discovery, Remediation, `@hnet/ytdl`, ytdrivarr Operator Console)
  in the same PR (DDD-001).
- Owner rulings of record: **PLAN-025** (the four Q-rulings + the plugin addendum, 2026-07-20), plus
  the three same-evening rulings (owner 2026-07-20): "arrs are not headless" (own operator console);
  LAN-only + no user management + single API key; the app exposes selected capabilities over its own
  API. The PLAN-025 note on `main` is amended in parallel by the coordinator.
