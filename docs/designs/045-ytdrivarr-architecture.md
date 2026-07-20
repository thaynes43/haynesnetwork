# DESIGN-045: ytdrivarr — the *arr-shaped ytdl-content suite service

- **Status:** Draft (owner-review artifact — this is the **design of record** for ytdrivarr, the
  suite-repo precedent from DESIGN-037/CLAUDE.md rule 10: ytdrivarr is docs-first via its own README +
  PR descriptions, but the normative architecture lives HERE, in this repo, mirroring how Libretto's
  design of record is DESIGN-037.)
- **Last updated:** 2026-07-20
- **Satisfies:** the PLAN-025 scoping rulings (owner 2026-07-20 — Q-01 *arr-shaped, Q-04 service-owned
  state, Q-05 direct capped+audited mutations, Q-06 new repo + plugin seam) and the Library
  **Fix-everywhere parity** goal (PLAN-041); **governed by ADR-074**.
- **Foundation:** the two research notes, cited throughout as "Q-02 §N" and "Q-03 §N" rather than
  restated: `.agents/context/2026-07-20-ytdrivarr-q02-source-matrix.md` (the source sweep + estate
  usage + the nine design tensions) and `.agents/context/2026-07-20-ytdrivarr-q03-donor-audit.md` (the
  Peloton donor audit + the C1–C8 contract candidates + the runtime fork). UNVERIFIED flags from those
  notes carry forward unchanged.
- **Companions:** **DESIGN-037 / Libretto** (the suite-repo AUTONOMY precedent — though ytdrivarr
  follows the *arr model, not Libretto's headless one; owner 2026-07-20 "arrs are not headless"),
  **DESIGN-043 / ADR-072** (collections direct-add — the caps/tickets/audit model D-18 reuses),
  **ADR-070 / `@hnet/libretto`** (the confined read/write client D-18 clones as `@hnet/ytdl`),
  **ADR-038 / ADR-041 / ADR-047** (the read-only ytdlsub Library surfaces + poster guard this adds
  write flows to). Glossary terms T-214…T-224 (DDD-001) are introduced in the same change.

## Overview

ytdrivarr is a **standalone, public-repo, API-first Node/TS service — with its own operator console,
NOT headless** — that does for ytdl-sub what an
*arr does for a download client: it owns the domain of **Sources** (subscribe-able content origins),
renders them into per-**Library** ytdl-sub config, schedules discovery, and exposes an API the app
integrates with exactly like Sonarr/Radarr — one-way sync in, a confined write client, ytdrivarr as
the source of truth (hard rule 4). It is a **generalization of a proven estate service**: today's
`ytdl-sub-config-manager` already runs the discover→emit→run loop for Peloton (Q-02 §"most important
finding"); ytdrivarr lifts that loop out of Peloton-hardcoding into *arr-style **provider** extension
points, so a trivial source (YouTube ≈ pure yt-dlp URL enumeration) and a maximally complex one
(Peloton: credentialed browser, scraped catalog, minted bearer, bespoke season/duration mapping)
implement the **same stable contract** — the way Sonarr treats download clients, indexers, and import
lists as swappable modules (the owner's binding addendum, PLAN-025).

What makes ytdrivarr an *arr rather than a batch job is everything the donor lacks: a resident service
with a real REST API, service-owned state (its own DB), a scheduler, per-item **remediation** (the
Fix leg), health/telemetry that turns today's silent-stall failure mode into an alarm, and — the
correction to any earlier "headless" framing — **its own operator/admin console** (source list,
provider config + `test()`, runs, health, logs), the way Sonarr/Radarr ship a console (owner
2026-07-20 "arrs are not headless"; D-20). It follows the estate's real **\*arr split**: ytdrivarr
owns the OPERATOR surface (LAN-only, single-API-key, no user management — D-21), while
**haynesnetwork is the MEMBER-facing layer** (the Library walls, the channel editor, per-item Fix,
the poster tiles) through the confined `@hnet/ytdl` client — members never touch ytdrivarr's UI,
exactly as they never touch Sonarr's. ytdrivarr stays generic/reusable and keeps its own release
train (rule 10 autonomy), valuable to anyone running ytdl-sub with no haynesnetwork at all.

Two hard boundaries frame the whole design. **ytdl-sub stays the execution engine** — ytdrivarr never
vendors yt-dlp; it renders config that the existing pinned ytdl-sub downloader CronJobs consume
(D-16). And **the contracts come before the port** — the C1–C8 provider interfaces (D-04…D-11) are
specified first; the Peloton plugin validates the seam, it does not define it (ADR-074 C-02).

## Detailed design

### D-01 — Service shape: *arr-shaped, operator-console-fronted, service-owned state

One Node/TS service exposing a **REST API** (zod for every request/response schema; OpenAPI generated
from the schemas) plus a background scheduler, a job dispatcher, and its **own operator/admin console**
(D-20 — NOT headless; owner 2026-07-20 "arrs are not headless"). Unlike Libretto (which is
Kometa-style stateless), ytdrivarr **is stateful by ruling**
(Q-04): sources, subscription entries, per-provider state, runs, and remediation jobs are durable
rows the service owns and re-renders config from. The recommended store is **PostgreSQL 16** — the
estate/hnet idiom (hard rule 1 is an hnet rule, but matching it keeps the test harness, the migration
discipline, and operator familiarity), its own instance in namespace `downloads` (or a new database on
the shared cluster — an owner infra call, Q-02 below). The database earns its place because the domain
is genuinely relational and the audit trail must be transactional (D-08); a stateless read-back model
(Libretto's choice) does not fit a service whose whole value is owning cross-library source identity
and per-item run history.

- **Connection config = environment/secrets only** (downloader-volume paths, provider secret
  material via ESO, the app-facing API keys). Nothing behavioral lives in env beyond caps/toggles.
- **No user management** (D-21): a single API key (`X-Api-Key`) guards the API and the console — no
  accounts, no OIDC, no roles (the *arr idiom, owner 2026-07-20). All per-user identity/grants/caps/
  audit live app-side (D-18).
- ytdrivarr **never writes git and never writes a k8s ConfigMap via the API**; it projects rendered
  config to a downloader-mounted volume (D-14). haynes-ops just deploys the HelmRelease (D-17).

### D-02 — Domain model (aligned to the glossary, DDD-001 T-214…T-224)

Seven aggregates. Names are the glossary nouns verbatim so the app and any future provider render the
same shapes:

- **Source** (T-215) — a subscribe-able content origin the service manages: `{ id, libraryId,
  providerId, kind, displayName, ref, settings, enabled, createdBy, capsContext }`. `ref` is the
  provider-specific handle (a YouTube channel URL/handle; a Peloton discipline). Sources are the
  cross-**Library** identity ytdl-sub has no representation for (Q-02 §5, tension #2/#7) — dedup across
  subscriptions is the service's job, not ytdl-sub's. **A Source is what a member's Edit mutates**
  (D-18).
- **Source Provider** (T-216, aka **Plugin**) — the *arr-style extension point that implements the
  C1–C8 contract for a source class: `{ id, kind, capabilities[], settingsSchema, runtime
  (in_core | out_of_process) }`. Providers are swappable modules behind a typed registry (NOT the
  donor's string-import DI, Q-03 §"discard"). Tier-1 URL providers run in-core; heavy providers run
  out of process (D-03). Capability **negation** keeps a trivial provider trivial: YouTube declares
  almost nothing; Peloton declares `auth`, `scrape`, `tokenMint`, `assets` (D-04).
- **SubscriptionEntry** (T-217) — the atomic thing a discovery run produces: one ytdl-sub
  subscription row `{ sourceId, entryKey, downloadRef, preset, overrides (season/episode/dir),
  ytdlOptions (cookies/headers), assets? }`. `discover(ctx) → SubscriptionEntry[]` is the provider's
  core output (D-06); the CORE owns YAML assembly, dedup, and persistence — the entry backend may be a
  yt-dlp playlist URL (URL-list sources) or a bespoke authenticated scraper (Peloton). This is the
  crux the owner's ruling names (Q-02 §6 #9): "the plugin contract is PRODUCE SUBSCRIPTION ENTRIES."
- **Library** (T-218) — the emit unit: one `{ config.yaml + subscriptions.yaml + downloader
  CronJob }` tuple per `library × player × media-root` (Q-02 §5). Sources are rows rendered INTO a
  library's files; a library maps 1:1 to an existing ytdl-sub downloader (YouTube, Peloton) at
  cutover. `{ id, name, player (plex|jellyfin|…), mediaRoot, libraryKind (video|music), projectionPath }`.
- **Run** (T-219) — a first-class discovery/emit record: `{ id, scope (all | libraryId | sourceId),
  trigger (cron | api | edit), providerId?, startedAt, finishedAt, status (running | ok | warn |
  error), counts (discovered, new, deduped, emitted), telemetry (selectorDriftHits, credentialAgeSec),
  logExcerpt }`. Runs are how health surfaces (D-10).
- **RemediationJob** (T-220) — the per-item Fix unit (the WHY of the *arr shape): `{ id, entryKey,
  sourceId, action (redownload | replace), requestedBy, status, providerRunId? }`. For a URL source
  this is a stateless re-download; for Peloton it is an auth-gated re-fetch needing a live session
  (D-09). Maps to the app's Library "Fix" action.
- **Audit Row** — every Source mutation (add/remove/edit) and every RemediationJob writes an audit row
  **in the same transaction** as the mutation it records (D-08; hard rule 6 applied service-side).

### D-03 — Runtime architecture: TS core + out-of-process job-dispatched heavy plugins (fork a)

**RECOMMENDED (ADR-074 fork a; owner-vetoable at Acceptance).** The core is TypeScript; providers
declare a `runtime`:

- **`in_core`** — Tier-1 URL-list providers (YouTube, SoundCloud, Bandcamp, generic-channel). Their
  `discover()` is pure yt-dlp URL enumeration + preset selection; no browser, no credentials, cheap.
  They run inside the core process.
- **`out_of_process`** — heavy providers (Peloton). The core **enqueues a job** (discovery or
  remediation) onto a queue; a **plugin-owned worker container** (Python + Selenium + Chromium, 6Gi,
  the donor's proven image lineage) claims it, does the credentialed scrape / bearer mint / re-fetch,
  and reports `SubscriptionEntry[]` (or a remediation result) + telemetry back through the C2/C3/C6
  transport. The worker is a Kubernetes Job (or a long-poll worker Deployment) in the plugin's own
  pod, `Forbid`/`backoffLimit` bounded.

Rationale (Q-03 §"runtime fork"): **isolation** (a 6Gi Chromium crash/hang cannot take down the core
API that the app depends on); **retryability** (a failed scrape is a re-runnable job, not a service
restart — the donor's `RuntimeError`-fails-whole-run brittleness is designed out); **blast-radius
containment** (the fragile browser scrape lives in a pod sized for it, while the core stays light).
The transport (a DB-backed job table + a claim/heartbeat protocol, or a light broker) is an
implementation detail the C2–C7 contracts abstract; the core never imports Selenium.

### The provider contract (C1–C8 → D-04…D-11)

The eight capabilities, each sized YouTube-trivial ↔ Peloton-full (Q-03 §"contracts"). A provider
implements the subset it declares (C1); capability **negation** is what keeps YouTube a few lines and
Peloton a full lifecycle against the *same* interface.

### D-04 — C1 · Capability declaration

`{ id, kind, settingsSchema (zod), capabilities: (auth | scrape | tokenMint | assets | remediation)[],
runtime, test(ctx) → HealthResult }`. YouTube declares `[]` (plus `remediation` as stateless
re-download) and `runtime: in_core`; Peloton declares `[auth, scrape, tokenMint, assets, remediation]`
and `runtime: out_of_process`. The registry is **typed** (a compile-time provider map), not
string-import DI — a provider that fails to load is a startup error, never a silent skip (Q-03
§"discard"). `test()` is the reachability/credential probe surfaced by `GET /health` and the app's
status read.

### D-05 — C2 · Auth / session + secret lifecycle (incl. short-lived-credential delivery)

The core injects ESO-provided secret material into a provider's context and persists the session
artifacts a provider mints; it never hardcodes any of it. YouTube: **no-op** (public URLs; an optional
`cookies.txt` for age-gated content rides the same delivery path). Peloton: the **full credential
lifecycle** — username/password from ESO → headless login (hardened: explicit `WebDriverWait`s
replacing the donor's fixed `time.sleep`s, retries, MFA/redirect awareness) → **bearer mint** (the
most fragile leg: CDP-sniff the `Authorization: Bearer` to `api.onepeloton.com`, with retries and a
**hard health signal on capture failure** instead of the donor's silent RuntimeError) → **delivery of
the short-lived bearer + cookies to the downloader's reach**. Delivery is to the downloader-mounted
volume (`bearer.txt` / `cookies.txt` on NFS, the read-only-rootfs-compatible path already proven,
Q-02 §4) — the downloader's `__preset__` injects `${PELOTON_BEARER}` at runtime. The bearer's
freshness is an SLA the scheduler enforces (D-07) and telemetry alarms on (D-10) — closing today's
"aging token → downloads silently stop" gap.

### D-06 — C3 · Discovery → SubscriptionEntry[] with CORE-owned YAML assembly + dedup

`discover(ctx) → SubscriptionEntry[]`. The provider produces entries; **the CORE owns** YAML
assembly, cross-source/library dedup, and persistence (Q-02 §6 #2/#9). URL-list providers return
entries whose backend is a yt-dlp playlist/channel URL under a named preset. Peloton returns entries
whose backend is a per-class `download:` URL with per-item `overrides` (season = parsed duration
minutes, episode = 1 + max across disk + existing subscriptions — ported, with the donor's latent
rounding-vs-raw inconsistency resolved, Q-03 §"Peloton logic"). The core assembles per-Library
`subscriptions.yaml` by **preset composition** (named prebuilt presets + a few overrides — the
estate's exact altitude, D-13), dedups against the download-archive-and-cross-source identity it owns,
and holds **season/episode numbers immutable once published** (Plex/Jellyfin matching breaks on
re-key — the repo's IDs-never-renumbered doctrine, Q-02 §6 #8).

### D-07 — C4 · Scheduling (discovery cadence + the bearer-freshness SLA)

Two clocks, deliberately split from the downloader clock (D-15). A provider declares its scheduling
shape: YouTube is **event-driven** (re-emit on an admin/member edit — a Source change enqueues a
discovery+emit for that Library) with an optional slow safety cadence; Peloton is **cron** (nightly
scrape, the donor's 22:00 lineage) **plus a bearer-freshness SLA** — the scheduler mints/refreshes the
bearer on a cadence tighter than its expiry so the downloader never runs an expired token. Runs
serialize per Library through a single worker queue (no concurrent writes to one Library's files —
the `concurrencyPolicy: Forbid` instinct). Central **throttle/ban governance** (Q-02 §6 #4) is a
core concern: one cookie/account identity per provider, shared-fate rate limits enforced across
Sources so a discovery storm can't get the estate banned.

### D-08 — C5 · Per-provider state namespaces + the audit answer

Each provider gets a **durable, namespaced state area** in ytdrivarr's DB. YouTube's "state" IS the
user-editable Source list (what Edit mutates — D-18); Peloton's is machine state (the last bearer,
scrape history + the 15-day stale-subscription timeout [likely CORE state, not Peloton-specific, Q-03
§"port"], dedup ids, run records). **The audit trail** the retired git-PR write-back used to provide (Q-02 §6 #6) is replaced by TWO
complementary logs (owner 2026-07-20 — all per-user audit lives app-side): (1) ytdrivarr keeps a
**machine-level change history** — Runs + a source-change log scoped to the calling API key, with NO
user identity (it has no user management, D-21); (2) the **user-attributed audit** (which member
added/removed/edited which channel, under what role/cap) is written **app-side in haynesnetwork, in
the same transaction as the tRPC mutation** (hard rule 6; the ADR-072 direct-add model — D-18).
ytdrivarr stays the source of truth for the source LIST (hard rule 4; the app syncs it in and mirrors
it for the walls); the app owns the identity story. Visibility moves from `git log` to the app's read
model + the service's run history; the trade (instant effect + no churn) is ADR-074 C-04.

### D-09 — C6 · Per-item remediation (Fix parity — the reason for the *arr shape)

`remediate(entryKey, action) → RemediationResult`. For a URL provider (YouTube) this is a **stateless
re-download** of the single entry (re-enqueue the one subscription line, force past the download
archive). For Peloton it is an **auth-gated re-fetch** needing a live session — so it dispatches to the
out-of-process worker (D-03) with a fresh bearer (D-05). This is what a pure config manager could
never do (ADR-074 C-01) and what lets the app offer the identical TV/Movies-style **Fix** on
YouTube/Peloton Library items (D-18). RemediationJobs are first-class rows (D-02) so the app can poll
status and audit who fixed what.

### D-10 — C7 · Health / telemetry (the biggest gap vs the donor)

Every provider exposes per-source **health** (`test()`, D-04) and every Run carries **telemetry**.
Two alarms are first-class because they are today's silent failures (Q-03 §"C7"/"Surprises"):
**credential-age** (bearer minted > SLA ago → alarm, not silent stall) and **selector-drift** (a
scrape whose `data-test-id`/CSS selectors returned zero or malformed hits → alarm before the estate
notices missing downloads). Also per-source: extractor-break health (a ytdl-sub/yt-dlp extractor that
started failing — the treadmill turned into a signal, D-16), last-successful-discovery age, dedup/new
counts. Surfaced as `GET /health` + structured metrics (Prometheus `/metrics` — the estate has
grafana-mcp), and mirrored into the app's status read. This replaces the donor's text-summaries-into-
logs approach (Q-03 §"discard").

### D-11 — C8 · Assets (optional; poster guard stays app-side v1 — RECORDED, not decided)

`assets` is an **optional** capability (C1 negation). Peloton generates thumbnails and owns three art
fragilities (Q-03 §C8); YouTube has none. **For v1 the app-side Peloton poster guard is UNTOUCHED**
(`runPelotonPosterGuard`, durable PNGs in `@hnet/sync` assets, the `poster_guard_applications` ledger,
its `:37` cron — Q-03 §"App side"). Folding poster durability into ytdrivarr (so the service owns its
own assets) is a **later fork, recorded not decided** (ADR-074 C-10 / Q-04 below). Declaring the
capability now means the seam exists when that fork is taken; exercising it is out of v1 scope.

### D-12 — The tiered source matrix (what "supported" means, per tier)

ytdl-sub's native first-class surface is narrow (Q-02 §2); the matrix is tiered honestly:

| Tier | Sources | Mechanism | Provider |
|---|---|---|---|
| **1 — core-native** | YouTube channel/playlist/releases/full-albums, SoundCloud discography, Bandcamp | named prebuilt presets (`{player} TV Show by Date` / `Collection`, `YouTube Releases`/`Full Albums`, `SoundCloud Discography`, `Bandcamp`) over yt-dlp's native extractor | `in_core` URL-list provider (capability `[]` + stateless remediation) |
| **2 — provider** | (a) generic channel-shaped (Twitch VODs, Vimeo, Patreon, Nebula, Floatplane, PeerTube, Bilibili, Dailymotion, Mixcloud, Reddit) via generic TV-Show/music presets; (b) the **authenticated-scraper** class (Peloton — estate-proven, bespoke) | generic presets for (a); (b) = credentialed browser → scraped catalog → minted bearer → entries with per-item overrides | (a) `in_core` "generic-channel" provider; (b) `out_of_process` "authenticated-scraper" provider (Peloton is the first) |
| **3 — honest non-goals** | podcasts / RSS (no yt-dlp extractor — generic best-effort only), one-off pasted URLs (bare subscription) | none for podcasts/RSS; a bare subscription line for one-offs | none — an explicit non-goal (Q-04 below), not a promise |

"Supported" is uniform across tiers via four verbs → mechanisms (Q-02 §3): **subscribe** = URL
enumeration + download-archive + scope (Only Recent / Chunk) + throttle · **download** = format /
media-quality + audio_extract + ytdl_options (cookies/headers) · **organize** = output_options +
season/episode or artist/album pathing + retention · **present** = NFO / music_tags / thumbnails per
player. **Music-vs-video is a subscribe-time classification the service owns** (disjoint preset
families/dirs/library kinds — Q-02 §6 #1); v1 **preserves the estate's existing behavior at cutover**
(music artists currently filed as video TV-shows) and treats the music/video split as a later
capability, not a cutover change (see Q-03 below on preserving behavior).

### D-13 — Config emission at library grain by preset composition

The emit unit is the **Library** (D-02); Sources are rows rendered into that Library's `config.yaml` +
`subscriptions.yaml`. Emission is by **preset composition** — named prebuilt presets plus a few
overrides and `= Genre` chips (the estate's exact altitude: the YouTube library is a single
`Plex TV Show by Date` preset + ~80 channels as genre chips; Peloton is `TV Show by Date` + per-class
`download:` URLs with per-item season/episode + per-instructor dirs, Q-02 §4) — **never hand-written
plugin config**. The core holds the throttle machinery (sleeps, per-sub caps,
`subscription_download_probability`, Only Recent windows) as library-level policy it renders in, and
owns cross-source dedup and immutable episode numbering (D-06).

### D-14 — Config delivery: service-owned projection to the downloader volume (fork b)

**RECOMMENDED (ADR-074 fork b; owner-vetoable).** ytdrivarr renders each Library's `config.yaml` +
`subscriptions.yaml` and **projects them to a volume the existing ytdl-sub downloader CronJobs mount**
— **NFS-backed**, the same media-volume mechanism `bearer.txt`/`cookies.txt` already use (Q-02 §4), at
a `projectionPath` per Library (D-02). **No git round-trip** (kills the daily haynes-ops bot churn of
the 1,454-line Peloton file — ADR-074 C-03) and **no k8s-API ConfigMap write** (avoids cluster-write
RBAC and the 1MiB ConfigMap ceiling). A member's edit → a discovery+emit run → the new
`subscriptions.yaml` is on the volume → the next `*/15` downloader tick consumes it. Emission is
atomic (write-temp-then-rename) so a downloader never reads a half-written file. haynes-ops just
deploys the HelmRelease + the shared volume (D-17).

### D-15 — Scheduling split: discovery cadence vs the */15 downloader crons

Two clocks stay separate. ytdrivarr's **discovery/emit** cadence is per-provider (D-07: YouTube
event-driven on edit; Peloton nightly cron + bearer-freshness SLA). The **downloader** cadence is the
existing ytdl-sub `*/15` CronJobs (`Forbid`, calendar-pinned image, 6Gi, read-only rootfs — Q-02 §4),
UNTOUCHED. The downloaders keep the incremental-sync primitive (the download-archive) and the throttle
protection where they already live and are proven. ytdrivarr only changes WHAT config the downloaders
read, not HOW/WHEN they run — until each cutover (D-19). Over-running is what gets accounts banned
(Q-02 §1); the split keeps the proven download cadence intact while giving discovery its own,
gentler clock.

### D-16 — ytdl-sub stays the execution engine (fork c)

**RECOMMENDED.** ytdl-sub remains the download/organize/present engine, pinned to its calendar image
(`ghcr.io/jmbannon/ytdl-sub:YYYY.MM.DD`) and tracked by **Renovate**; **ytdrivarr never vendors
yt-dlp** (the weekly extractor-break treadmill stays upstream, Q-02 §5). Extractor breakage becomes a
per-source **health** signal ytdrivarr surfaces (D-10), not a maintenance burden it owns. This is the
control/data-plane split (Q-02 §5): ytdrivarr = state + emit + scheduling; ytdl-sub = execution, as
short-lived Job/CronJob pods with the throttle machinery + memory profile already proven there.

### D-17 — Deployment shape

- **Repo/image:** `github.com/thaynes43/ytdrivarr` (owner-created, public); images
  `ghcr.io/thaynes43/ytdrivarr` (the TS core) + `ghcr.io/thaynes43/ytdrivarr-peloton-worker` (the
  Python/Selenium/Chromium out-of-process worker, D-03), the hnet release-train idiom (conventional
  commits, release-please, `v*` tags), driven **independently** of the haynesnetwork release train
  (rule 10).
- **haynes-ops HelmRelease** (`kubernetes/main/apps/downloads/ytdrivarr/`): bjw-s app-template — one
  Deployment (the core + in-process scheduler), the Peloton worker (Job/worker Deployment, 6Gi), a
  Postgres 16 (own instance in `downloads`, or a shared-cluster database — Q-02 below), the shared
  **projection volume** the downloaders mount (D-14), **ExternalSecrets** from 1Password `HaynesKube`
  (the existing `peloton-scraper` item: `PELOTON_USERNAME`/`PASSWORD`; the ytdrivarr API key,
  `YTDRIVARR_API_KEYS`), an **internal, LAN-only ingress** `ytdrivarr.haynesops.com` on
  `className: traefik-internal`, **never a public `*.haynesnetwork.com` host** (owner 2026-07-20;
  hardens DESIGN-041 D-11) — matching the estate's live *arr pattern
  (`kubernetes/main/apps/media/sonarr`: `traefik-internal`, `sonarr.haynesops.com`, no login form,
  "swap to Forms/Authentik later"). The operator console (D-20) is reached on LAN like the *arr
  consoles; an Authentik forward-auth front door on the internal ingress is **optional/later**,
  matching whatever gating the estate's *arrs carry (none today). Egress allowlist for `onepeloton.com`
  / `api.onepeloton.com` and any Tier-2 hosts.
- **Cleanup, confirm-first:** the `ytdl-sub-peloton` downloader carries a **vestigial static
  `PELOTON_BEARER`** 1Password value (the real bearer comes from NFS `bearer.txt` — Q-03
  §"Deployment"). Flag it for removal, but **confirm it is truly unused before deleting** (Q-05
  below). The three existing Kustomizations (`ytdl-sub-youtube`, `ytdl-sub-peloton`,
  `ytdl-sub-peloton-config-manager`) stay live until their respective cutovers (D-19); the
  config-manager Kustomization is removed only at M3 completion.

### D-18 — App integration: `@hnet/ytdl`, the edit rung, roles grid, direct capped+audited mutations

haynesnetwork integrates ytdrivarr exactly like an *arr (hard rule 4), on the `@hnet/libretto`
template (ADR-070). The app **exposes SELECTED ytdrivarr capabilities over its OWN tRPC API** (owner
2026-07-20) and calls ytdrivarr **server-side** at `ytdrivarr.downloads.svc.cluster.local` with the
single API key (D-21) — members consume the app's API, never ytdrivarr's, exactly as they hit the app
and never Sonarr. Caps and the user-attributed audit are app-side (D-08):

- **`@hnet/ytdl`** — a new confined client package with the three-file split: the barrel (`index.ts`,
  errors/config/schemas, safe everywhere), **`@hnet/ytdl/read`** (list sources, runs, health,
  per-item remediation status — import-unrestricted), and **`@hnet/ytdl/write`** (add/remove/edit a
  Source, trigger a Fix/RemediationJob — the content-driving surface). `@hnet/ytdl/write` is
  **import-confined to `packages/domain`** and its own package, enforced by extending the existing
  **`arr-write-import-guard`** test: add `packages${sep}ytdl${sep}` to `ALLOWED_DIR_PREFIXES` and
  `ytdl` to the `IMPORT_PATTERN` alternation (`packages/domain/__tests__/arr-write-import-guard.test.ts`).
  The browser never reaches the write surface — every call goes through a role-gated tRPC procedure →
  the domain orchestrator → `@hnet/ytdl/write` → ytdrivarr's API.
- **The `edit` rung, finally consumed.** The `ytdlsub` section has an `edit` permission level in the
  schema that nothing gates on today (`apps/web/lib/role-sections.ts`: `ytdlsub: 'toggle'`, with the
  in-code note "flips to 'tri' per PLAN-025"). ytdrivarr's write flows make it real: the roles grid
  entry **flips `toggle → tri`** (`SECTION_CONTROL.ytdlsub = 'tri'`), and `ytdlsubProcedure` gains an
  `edit`-gated variant for the mutation routes. No grid rewrite — the map was built for exactly this
  (ADR-049 C-01).
- **Direct, capped, audited mutations (Q-05, the ADR-072 doctrine).** Edit-granted roles add/remove
  YouTube channels **directly** — no suggest→approve. A **per-role cap** on Source count is the only
  friction on the safe path (the `collection_size_cap` analog — an app_setting / role attribute); an
  add that would exceed the cap opens an **ADR-050 ticket** carrying the full Source definition
  (provider + ref + library + settings), materializing on one-click admin approve (a new ticket
  category, e.g. `ytdl_source_override`). **Admins are unbounded** and may remove any Source. **All of
  this — caps, tickets, and the user-attributed audit — is app-side** (owner 2026-07-20): the
  mutation, its role/cap context, and the audit row commit in ONE app transaction (hard rule 6);
  ytdrivarr just applies the source change and keeps its machine-level history (D-08). (Admins can
  also manage sources directly in ytdrivarr's own operator console, D-20 — the *arr split; that path
  is API-key-scoped, not member-attributed.)
- **Per-item Fix parity (D-09).** The Library walls' TV/Movies-style **Fix** action extends to
  YouTube/Peloton items: a role-gated tRPC route → the domain orchestrator → `@hnet/ytdl/write`
  triggers a RemediationJob; the app polls status through `@hnet/ytdl/read`. Same UX language as
  every other media Fix (the unified media-action doctrine).
- **Read surfaces + poster guard UNTOUCHED until cutover.** The current `ytdlsubRouter` (Plex-direct
  reads), the poster proxy, and the app-side poster guard keep working through M1–M3; the app only
  gains write flows (M4) and Fix (M5) after the service owns the config.

### D-19 — Migration phases (M1–M5)

Phased so nothing user-visible breaks; both downloader CronJobs, the app read surfaces, and the
poster guard stay untouched until each cutover (Q-03 §"Migration inventory").

- **M1 — Walking skeleton + the contracts.** Stand up the TS core (REST API, DB/migrations, the typed
  provider registry, the job dispatcher), define the C1–C8 provider interfaces (D-04…D-11) and the
  zod schemas, and ship a trivial in-core provider end to end. Exercises C1/C3/C5 with no auth. No
  estate cutover yet — the old config-manager still runs.
- **M2 — YouTube YAML takeover (the clean first cut).** Implement the `in_core` URL-list provider,
  import the ~80 YouTube channels as Sources, and project the rendered `subscriptions.yaml` to the
  YouTube downloader's volume (D-14). Cut the `ytdl-sub-youtube` downloader from hand-edited git YAML
  to ytdrivarr projection. No auth, no scrape — validates emission + projection + the scheduling split.
- **M3 — Peloton plugin port (hardened).** Implement the `out_of_process` authenticated-scraper
  provider: port login/session/scrape/metadata + bearer/cookie minting + episode-numbering + the
  activity folder mapping (Q-03 §"port"), **hardened** — explicit `WebDriverWait`s, retries, the
  bearer-freshness SLA (D-07), the credential-age + selector-drift alarms (D-10). Cut the Peloton
  downloader to ytdrivarr projection; **remove the `ytdl-sub-peloton-config-manager` Kustomization**
  (the git-PR churn ends). Confirm-then-remove the vestigial `PELOTON_BEARER` (Q-05).
- **M4 — App Edit surfaces.** Ship `@hnet/ytdl` (read + confined write + the import-guard extension),
  flip the roles grid `toggle → tri`, wire the `edit`-gated mutation routes, and land the direct
  capped+audited add/remove with the over-cap ticket path (D-18).
- **M5 — Per-item Fix.** Implement C6 remediation end to end (D-09) and extend the Library walls' Fix
  action to YouTube/Peloton items. This is the Fix-everywhere parity payoff (PLAN-041).

Downloaders + read surfaces + poster guard are untouched until each phase's cutover; the old
config-manager runs until M3.

Cross-cutting: the **single API-key service auth (D-21) lands in M1**; the **operator console (D-20)
is Fable-built**, starting as a source/run/health shell in M1 and gaining provider config + `test()`
at M3 — it is a view over the same API, so it never gates a phase.

### D-20 — The operator/admin console (NOT headless; owner 2026-07-20)

ytdrivarr ships its **own operator/admin web console**, served by the service, the way Sonarr/Radarr
do — the correction to any earlier "headless" framing (owner 2026-07-20 "arrs are not headless").
Scoped **honestly as an operator surface, not a duplicate of the app's member UX**:

- **Sources** — the full source list across Libraries; add/edit/remove/enable at the operator grain
  (an admin managing the service directly, like editing series in Sonarr).
- **Providers** — the registered providers, their declared capabilities (D-04), per-provider
  settings, and a **`test()` button** (reachability/credential probe — the Sonarr "Test" idiom).
- **Runs** — discovery/emit + remediation run history with counts and log excerpts (D-02/D-19).
- **Health / telemetry** — the D-10 surfaces: per-source health, credential-age + selector-drift
  alarms, extractor-break signals, last-successful-discovery age.
- **Logs** — a structured log tail for operator debugging.

It is **LAN-reached** on the internal ingress (D-17); an Authentik front door is optional/later
(matching the estate *arrs, which carry none today). No member-facing browsing, no walls, no user
management — that UX is haynesnetwork's (D-18). **Division of labor (owner 2026-07-20):** this
operator console is **Fable-built**; Opus builds the service internals (core, providers, emission,
scheduling, remediation, the API). The console is a thin operator view over the same REST API the app
consumes — it adds no capability the API lacks.

### D-21 — Service AuthN: a single API key, no user management (the *arr idiom; owner 2026-07-20)

ytdrivarr has **no user management** — no accounts, no OIDC, no roles. Its REST API (and the operator
console behind it) is guarded by a **single API key** (`X-Api-Key`, the *arr idiom; comma-separated
`YTDRIVARR_API_KEYS` for rotation, ESO-friendly), exactly like every estate *arr. haynesnetwork holds
one key as its integration credential (via ESO) and calls ytdrivarr **server-side** at
`ytdrivarr.downloads.svc.cluster.local` (D-18); the browser never sees the key. This is a deliberate
SIMPLIFICATION over the Libretto/hnet auth stories: there is no second identity system to run. **ALL
per-user identity, grants, caps, and audit live app-side in haynesnetwork** (Q-05; D-08/D-18) — the
service authenticates the CALLER (the app, or an operator on LAN), never a member. Distinct from D-05,
which is a *provider's* own credential lifecycle (e.g. Peloton's login to onepeloton.com): D-21 is
ytdrivarr's own front-door auth.

## Alternatives considered

- **A pure config manager (not *arr-shaped)** — rejected by owner ruling (Q-01): a pure manager
  cannot do per-item Fix (PLAN-041), and gives the app no clean sync-in/confined-write integration.
- **Rework `ytdl-sub-config-manager` in place** — rejected by owner ruling (Q-06): the donor is
  Peloton-hardcoded (its generic seam is aspirational, Q-03 §TL;DR); re-shaping in place would fight
  a god-file/string-import-DI codebase. New repo, port behind a purpose-built seam.
- **A Python core (reuse the donor's stack wholesale)** — rejected (fork a): forfeits the TS `@hnet`
  integration idioms and the estate's TS gravity. Kept where it earns its place — the Peloton worker
  stays Python/Selenium/Chromium, but **out of process** behind the C2/C3/C6 transport, not in the
  core.
- **Stateless, Kometa-style (Libretto's choice)** — rejected for ytdrivarr (Q-04, owner-ruled
  service-owned state): unlike Libretto, ytdrivarr's whole value is owning cross-library source
  identity, dedup, run history, and a transactional audit trail — genuinely relational state a
  read-back model cannot carry.
- **Keep the git-PR config write-back** — rejected (Q-04 / fork b): it churns haynes-ops daily and
  forces members to wait on Flux for an edit. Service-owned projection to the downloader volume is
  instant and churn-free.
- **ytdrivarr vendors yt-dlp / downloads itself** — rejected (fork c): buys the weekly extractor-break
  treadmill and re-implements proven throttle/memory machinery. ytdl-sub stays the engine.
- **Fold the poster guard into ytdrivarr now (C8)** — deferred, not rejected (fork d / D-11): it works
  app-side today; moving it is net-new v1 risk with no payoff. Recorded as a later fork (Q-04 below).
- **Headless (Libretto's model), no operator console** — rejected by owner ruling (2026-07-20 "arrs
  are not headless"): ytdrivarr follows the *arr split — its own operator console (D-20) for admins,
  haynesnetwork for members. Not headless.
- **User management inside ytdrivarr (accounts / OIDC / roles)** — rejected by owner ruling
  (2026-07-20): a single API key guards the service (the *arr idiom, D-21); all per-user identity,
  caps, and audit live app-side. No second identity system.
- **A public ingress for the console** — rejected (owner 2026-07-20; DESIGN-041 D-11): LAN-only on
  `traefik-internal`, matching the estate *arrs.

## Test strategy

The hnet discipline travels (Q-03 §"test"): Vitest; the ytdrivarr service tested against a temp DB +
stub servers (a stub yt-dlp/ytdl-sub emit target, a stub Peloton for the worker). Highest-value
suites: **provider-contract conformance** (both a trivial and a full provider satisfy C1–C8 against
the same interface — the seam's compatibility promise); **capability negation** (a `[]`-capability
provider never triggers auth/scrape/asset paths); **YAML emission** (preset composition matches the
estate's live files byte-for-shape; cross-source dedup; **episode numbers immutable once published** —
the re-key regression guard); **projection atomicity** (write-temp-then-rename; a downloader never
reads a half file); **the Peloton port** (login/scrape/bearer with the hardened waits + retries;
credential-age + selector-drift alarms fire; a bearer-capture failure raises health, never a silent
stall — the donor's regression); **remediation** (URL stateless re-download; Peloton auth-gated
re-fetch dispatches a worker job); **audit-in-same-tx** (a Source mutation with no audit row is
impossible — the write is one transaction). App side: the **`arr-write-import-guard`** extension
(a `@hnet/ytdl/write` reference outside `packages/{domain,ytdl}` fails the test — the ADR-070
precedent); the roles-grid `tri` flip; the direct-add cap + over-cap-ticket path (the ADR-072 test
shapes); Fix-parity e2e on a YouTube/Peloton item.

## Open questions

Only genuinely-owner questions (the ruled ones — Q-01 shape, Q-04 service-owned state, Q-05 direct
capped+audited, Q-06 new repo + plugin seam — are NOT re-asked here).

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Repo **license** for `github.com/thaynes43/ytdrivarr` — MIT (ecosystem default) vs AGPL-3.0 (the self-hosted-tool protective choice Libretto took, DESIGN-037 Q-01)? Owner call; the repo already exists (public), so confirm what license it carries / should carry. | (open) |
| Q-02 | **Postgres placement** (D-01/D-17): its own Postgres 16 instance in `downloads` (isolation, standalone-shaped) vs a new database on the shared hnet cluster (one less StatefulSet)? The Libretto analog (Q-03) was ruled stateless so it did not arise; ytdrivarr IS stateful, so this is a live infra call. | (open) |
| Q-03 | **Music-vs-video classification at cutover** (D-12): v1 preserves the estate's current behavior (music artists filed as video TV-shows). Confirm that is acceptable for v1 and the music/video split is a later capability — or does the owner want the split introduced at the YouTube cutover (M2)? | (open) |
| Q-04 | **Poster guard fold-in (C8, D-11):** v1 leaves the app-side Peloton poster guard in place (ADR-074 C-10). Is folding poster durability into ytdrivarr a wanted follow-on, or does it stay app-side indefinitely? Records the fork; not decided. | (open) |
| Q-05 | **Vestigial `PELOTON_BEARER` (D-17):** the static 1Password `PELOTON_BEARER` on the `ytdl-sub-peloton` downloader appears unused (the real bearer is NFS `bearer.txt`). Confirm it is truly unreferenced before the M3 cleanup removes it. | (open — confirm-then-delete) |
| Q-06 | **Podcasts / RSS (D-12 Tier 3):** confirmed as an explicit v1 non-goal (no yt-dlp extractor; generic best-effort only)? Recording it as a non-goal rather than a silent gap; owner may want it on the roadmap. | (open) |
