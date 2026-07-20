# PLAN-025: Generic ytdl config-manager platform (plugin architecture) + Library-extras editing

- **Status:** **SCOPED (owner rulings 2026-07-20 — the owner-present scoping session happened).**
  The four gating questions are RULED (below); the two researchable ones (Q-02 source sweep,
  Q-03 plugin interface) are Opus-dispatched, reports land as dated `.agents/context/` notes.
  Next: **ADR-074 (Proposed) + DESIGN-045 (Draft) + glossary T-214…T-224 are written** off the
  research (this PR) — the executable build saga (M1–M5, appended below) follows ADR-074
  Acceptance. The DO-NOT-DISPATCH gate is LIFTED for docs/research; code waits on the accepted
  design. **The repo EXISTS** (`github.com/thaynes43/ytdrivarr`, owner-created 2026-07-20, public;
  owner-named — the Libretto precedent).

  **AMENDED 2026-07-20 eve (three same-evening owner rulings — binding; fold into the ADR/design):**
  (1) **"arrs are not headless"** — the Libretto HEADLESS clause in the Q-01 bullet below is
  SUPERSEDED: ytdrivarr ships its OWN operator/admin console (like Sonarr) and haynesnetwork is the
  MEMBER-facing layer; members never touch ytdrivarr's UI (ADR-074 C-11, DESIGN-045 D-20).
  (2) **LAN-only + no user management** — internal `traefik-internal` ingress only (never public,
  matching the estate *arrs), a single `X-Api-Key` guards the API; no accounts/OIDC/roles
  (DESIGN-045 D-21). (3) **the app exposes SELECTED capabilities over its OWN tRPC API**, calling
  ytdrivarr server-side via `ytdrivarr.downloads.svc.cluster.local` — all per-user identity/caps/audit
  live app-side (DESIGN-045 D-18). The inline "HEADLESS … owns 100% of the UX" phrasing in the Q-01
  ruling is amended by the coordinator in parallel; this note records the correction so the plan is
  internally consistent.

## ▶ SCOPING RULINGS (owner, 2026-07-20 — all four on the recommended option)

- **Q-01 shape → *ARR-SHAPED SERVICE.** Own API/domain (sources, subscriptions, scheduling,
  media rules); haynesnetwork integrates it exactly like Sonarr/Radarr (one-way sync in,
  confined write client, hard-rule-4 source-of-truth pattern). The decisive driver stands:
  Fix-everywhere parity for YouTube/Peloton items requires per-item remediation only a service
  can do. Generic/reusable like the suite repos — but **NOT headless (owner correction, same
  evening: "arrs are not headless"; supersedes the Libretto-headless framing first recorded
  here):** ytdrivarr ships its OWN operator/admin web UI like Sonarr's console (sources,
  provider config + test, runs, health, logs), behind Authentik like every other *arr;
  **haynesnetwork remains the MEMBER-facing layer** (Edit-grant mutations, per-item Fix, the
  walls) via the confined client — members never touch ytdrivarr's UI, exactly the
  Sonarr/Radarr split today. Per the division-of-labor ruling, ytdrivarr's UI is FABLE-built;
  Opus builds the service internals/tests.
- **Q-06 codebase → NEW REPO; port the fragile-but-working Peloton logic behind the plugin
  seam.** The old manager keeps running untouched until cutover.
- **Q-04 state → SERVICE-OWNED.** Its own DB; it GENERATES ytdl-sub configs itself (no git-PR
  write path — member mutations want instant effect; the Kometa PR-per-change friction was
  live-measured the same day). haynes-ops just deploys the service; the hardcoded YouTube YAML
  gets taken over at cutover.
- **Q-05 member mutations → DIRECT with caps + audit.** Edit-granted roles add/remove channels
  directly (the collections direct-add doctrine: caps per role, over-cap → ticket, admins
  unbounded, audit rows same-tx). No suggest→approve.

**Addendum ruling (owner, same evening): the FULL *arr deployment pattern.** Near-verbatim:
"follow the arrs pattern where this service is LAN only, no need to manage users, and we
expose bits of its capabilities over an API on haynesnetwork." So: **LAN-ONLY** (internal
`*.haynesops.com` ingress only, never public; the admin console is reached on LAN like
Sonarr's; gate it the way the estate's *arrs are actually gated today) · **NO user
management** in ytdrivarr (no accounts/OIDC/roles — a single API key guards the API, the
X-Api-Key idiom; ALL per-user identity/grants/caps/audit live app-side) · **haynesnetwork
exposes selected capabilities over ITS OWN API** (tRPC → in-cluster service DNS + API key via
the confined `@hnet/ytdl` client; members consume the app, never the service).

**Addendum ruling (owner, same evening — binding on the design): the plugin architecture is
*arr-STYLE EXTENSION POINTS, not a port shim.** Near-verbatim: "It's important to remember how
complex Peloton is vs YouTube so we need to 'plugin' like modularity like how *arrs let you
plug in download clients etc." The complexity SPREAD is the design driver: a simple source
(YouTube ≈ pure config generation over yt-dlp's native extractor) and a maximally complex one
(Peloton: auth/session lifecycle, scraping cadence, bespoke season/duration mapping) must
implement the SAME stable contract, the way Sonarr treats download clients/indexers/import
lists as swappable modules behind defined interfaces. The design doc must specify those
interface contracts (capability declaration, auth/secret hooks, scheduling hooks, config
emission, per-item remediation for Fix parity, health/telemetry) BEFORE the Peloton port —
the port validates the seam, it doesn't define it.
- **Relates:** PLAN-022 (ytdl-sub Library surfaces + its phase-2 "config-manager cleanup" TODO —
  SUPERSEDED by this vision), PLAN-024 (poster guard — the "smallest Kometa-for-ytdl-sub"; likely
  folds in as a core or plugin concern), ADR-038/041 (read surfaces this would add write flows to),
  the `ytdlsub` section's currently-meaningless Edit level (becomes the user-facing write grant).
- **Repos:** `/home/thaynes/workspace/ytdl-sub-config-manager` (the donor/rework target),
  `haynes-ops` (currently hardcodes the YouTube YAML under kubernetes/main/apps/downloads/ytdl-sub/),
  this app (integration client + UI).

---

## Owner vision (2026-07-10)

ytdl-sub-config-manager is old, hard to work with without major refactoring; the Peloton logic is
fragile and buggy **but works**. Rework it into a **generic config manager with a plugin
architecture**:

1. **Core = generic ytdl-sub/yt-dlp config management.** Supports many ytdlp source types out of
   the box — requires a **sweep of what ytdl-sub/yt-dlp natively handle** to define the built-in
   source matrix. Takes over managing the **YouTube YAML currently hardcoded in haynes-ops**.
2. **Plugins for special sources.** Peloton is the first plugin — a **rebrand/port of the existing
   fragile-but-working logic** into the plugin interface. Most other plugin-requiring sources are
   skipped at the start (Peloton only).
3. **User-facing editing from haynesnetwork.com:** users add/remove YouTube channels (and later,
   other sources) through the app UI. This is what the Library-extras **Edit** permission level was
   reserved for — Edit = may mutate sources/subscriptions; Read-only = browse only.
4. **Media-management hooks** tied into the new app — open question whether it stays a *pure
   config manager* or grows into **"an *arr for ytdl content"**: a service with its own API/domain
   (sources, subscriptions, scheduling, media rules) that haynesnetwork.com integrates with the
   same way it integrates Sonarr/Radarr (one-way sync in, confined write client, source-of-truth
   stays with the service — the CLAUDE.md hard-rule-4 pattern extends naturally).

## Open questions for the scoping session (Q-NN when ratified)

- **Q-01 — pure manager vs *arr-shaped service:** where on that spectrum? (API-first service is
  what makes the app integration + RBAC story clean; also enables the poster-guard/media hooks to
  live there instead of in @hnet/sync long-term.) **New driver (owner 2026-07-11, PLAN-041):**
  the Library **Fix-everywhere parity goal** — YouTube/Peloton items can only get the TV/Movies-
  style "Fix" (re-download/replace a bad copy) if this becomes the *arr-shaped service; a pure
  config manager cannot remediate a single item. Weigh that leg of the parity table in the Q-01
  decision.
- **Q-02 — the ytdlp source sweep:** which source types are first-class out of the box; what does
  "supported" mean (subscribe/download/organize/present)?
- **Q-03 — plugin interface:** what does the Peloton port need from it (auth/session handling,
  scraping cadence, season/duration mapping — the exact fragile parts); language/runtime for
  plugins.
- **Q-04 — migration path:** haynes-ops YouTube YAML → managed state (GitOps-compatible? does the
  manager write PRs, own a CRD/ConfigMap, or hold state in its own DB with haynes-ops just
  deploying it?).
- **Q-05 — app integration surface:** which mutations members get (add/remove channel at Edit
  level), quota/approval gates (does a member request a channel and an admin approve — the
  requested-items pattern?), audit trail requirements.
- **Q-06 — what of ytdl-sub-config-manager survives:** rework in place vs new repo with the old
  Peloton logic ported behind the plugin seam.

## Out of scope until the owner green-lights scoping — SUPERSEDED (scoping happened 2026-07-20)

~~Everything. No dispatches, no ADRs, no refactors of ytdl-sub-config-manager.~~ The scoping session
ran; ADR-074 + DESIGN-045 are written; the executable build plan is below. PLAN-024's poster guard
keeps running as-is (folding it into ytdrivarr is a recorded-not-decided later fork, ADR-074 C-10 /
DESIGN-045 Q-04); PLAN-022 phase-2 cleanup TODOs are absorbed here.

---

## Executable build plan (M1–M5) — governed by ADR-074, realized by DESIGN-045

Phased so nothing user-visible breaks: both ytdl-sub downloader CronJobs, the app read surfaces
(`ytdlsubRouter`, poster proxy), and the app-side Peloton poster guard stay UNTOUCHED until each
phase's cutover; the old `ytdl-sub-config-manager` runs until M3. Cross-cutting: the single API-key
service auth (D-21) lands in M1; the **operator console (D-20) is Fable-built** (owner
division-of-labor ruling — Opus builds the service internals), starting as a source/run/health shell
in M1 and gaining provider config + `test()` at M3. **Gate: M1 starts on ADR-074 Acceptance.**

Three codebases move (all suite-autonomous per rule 10; ytdrivarr drives its own release train):

- **`ytdrivarr` repo** (new, `github.com/thaynes43/ytdrivarr`) — the TS core + providers + Python
  worker + operator console.
- **`haynes-ops`** — `kubernetes/main/apps/downloads/ytdrivarr/` (deploy) + the downloader cutovers.
- **`haynesnetwork`** (this repo) — `@hnet/ytdl` + the domain orchestrator + the tRPC surface + the
  member UX (Edit, Fix, roles grid).

### M1 — Walking skeleton + the C1–C8 contracts (ytdrivarr repo)

- **Core scaffold:** TS service — REST API (zod + generated OpenAPI), Postgres 16 + Drizzle
  migrations (Q-02 placement TBD), the **typed provider registry** (D-04 — NOT string-import DI), the
  **job dispatcher** (D-03 in_core vs out_of_process), the in-process **scheduler** (D-07), the
  **emitter + NFS projection** writer (D-13/D-14, atomic write-temp-then-rename).
  - Files (ytdrivarr): `src/core/{api,db,registry,dispatcher,scheduler,emitter,projection}/`,
    `src/contracts/` (the C1–C8 provider interfaces + zod schemas, D-04…D-11).
- **Service auth (D-21):** single `X-Api-Key` middleware; `YTDRIVARR_API_KEYS` env. No user mgmt.
- **A trivial `in_core` provider end to end** (exercises C1/C3/C5, no auth) to validate the seam.
- **Operator console shell (Fable-built, D-20):** sources / runs / health, served by the service on
  the internal ingress.
- No estate cutover — the old config-manager still runs. **Proves:** the contracts + emission +
  projection round-trip.

### M2 — YouTube YAML takeover (the clean first cut; ytdrivarr + haynes-ops)

- **`in_core` URL-list provider** (D-12 Tier 1): import the ~80 YouTube channels (from the
  hand-edited git YAML) as **Sources**; emit `Plex TV Show by Date` + `= Genre` chips + the throttle
  policy by **preset composition** (D-13); project `subscriptions.yaml` to the YouTube downloader's
  NFS volume (D-14).
  - Files (ytdrivarr): `src/providers/youtube/`. Files (haynes-ops):
    `kubernetes/main/apps/downloads/ytdrivarr/` (HelmRelease, ESO, Kustomization, the projection
    volume); cut `ytdl-sub-youtube` from git YAML → ytdrivarr projection.
- No auth, no scrape. **Proves:** emission + projection + the scheduling split (D-15) on real content.

### M3 — Peloton plugin port, hardened (ytdrivarr + haynes-ops)

- **`out_of_process` authenticated-scraper provider** (D-03): PORT login/session/scrape/metadata +
  bearer/cookie minting + episode-numbering + activity-folder mapping (Q-03 port list), **hardened** —
  explicit `WebDriverWait`s (replacing fixed sleeps), retries, the **bearer-freshness SLA** (D-07),
  **credential-age + selector-drift alarms** (D-10). DISCARD the git-PR write-back, the Peloton
  `Config` dataclass, string-import DI, most of the 896-line disk-repair layer, the text-summary
  metrics (Q-03 discard list).
  - Files (ytdrivarr): `src/providers/peloton/` (core-side registration) + the **Python/Selenium
    worker** image (`worker/`, `ghcr.io/thaynes43/ytdrivarr-peloton-worker`). Operator console gains
    provider config + `test()`.
  - Files (haynes-ops): the Peloton worker Deployment/Job + 6Gi; cut `ytdl-sub-peloton` to ytdrivarr
    projection; **remove the `ytdl-sub-peloton-config-manager` Kustomization** (git churn ends);
    **confirm-then-remove the vestigial static `PELOTON_BEARER`** (DESIGN-045 Q-05).
- **Proves:** the seam holds for the maximally complex source; the silent-stall failure mode is now
  an alarm.

### M4 — App Edit surfaces (haynesnetwork)

- **`@hnet/ytdl`** (the `@hnet/libretto` template): `packages/ytdl/src/{index,read,write,http,schemas,
  errors,config}.ts` + `package.json` (barrel + `./read` + `./write` exports). Extend
  `packages/domain/__tests__/arr-write-import-guard.test.ts` — add `packages${sep}ytdl${sep}` to
  `ALLOWED_DIR_PREFIXES` and `ytdl` to `IMPORT_PATTERN`.
- **Domain orchestrator** (`packages/domain/`): the only importer of `@hnet/ytdl/write`; owns the
  add/remove/edit-Source flow + the **cap check** (the `assertWithinCollectionSizeCap` analog) +
  **over-cap → ticket** (new `TICKET_CATEGORIES += 'ytdl_source_override'`; ADR-050 payload carries
  the Source definition) + the **user-attributed audit row same-tx** (hard rule 6, D-08/D-18).
- **tRPC surface** (`packages/api/`): extend `ytdlsubRouter` with `edit`-gated mutation procedures
  (`ytdlsubEditProcedure = sectionProcedure('ytdlsub','edit')`) exposing SELECTED ytdrivarr
  capabilities; the app calls ytdrivarr server-side via `@hnet/ytdl` + `svc.cluster.local`.
- **Roles grid:** `apps/web/lib/role-sections.ts` — `SECTION_CONTROL.ytdlsub: 'toggle' → 'tri'`
  (the `edit` rung finally has a consumer; the in-code note already anticipates this).
- **Member UI** (`apps/web/app/(app)/library/…`): the channel add/remove/edit surface, the over-cap
  ticket state under the existing tickets surface, direct-add per ADR-072.
- **Proves:** members self-serve YouTube channels, capped + audited, no git round-trip.

### M5 — Per-item Fix (ytdrivarr + haynesnetwork)

- **C6 remediation end to end** (D-09): `RemediationJob` in ytdrivarr (URL stateless re-download;
  Peloton auth-gated re-fetch via the worker + a fresh bearer); a role-gated tRPC Fix route →
  domain orchestrator → `@hnet/ytdl/write`; poll status via `@hnet/ytdl/read`.
- Extend the Library walls' TV/Movies-style **Fix** action to YouTube/Peloton items (the unified
  media-action doctrine). **Proves:** Fix-everywhere parity (PLAN-041) — the whole reason for the
  *arr shape.

**Untouched until each cutover:** the two ytdl-sub downloader CronJobs, the app read surfaces, and
the app-side poster guard (C8 fold-in is the recorded-not-decided later fork, DESIGN-045 Q-04).

## Open owner questions carried into the build (DESIGN-045 Q-01…Q-06)

Genuinely-owner, NOT the ruled ones: repo **license** (Q-01), **Postgres placement** (own instance
vs shared cluster, Q-02), **music-vs-video** classification at cutover (Q-03), **poster-guard fold-in**
(Q-04), the **vestigial `PELOTON_BEARER`** confirm-then-delete (Q-05), **podcasts/RSS** non-goal
confirmation (Q-06). These block no docs work; Q-05 gates the M3 cleanup step.
