# DESIGN-037: Libretto — the books collection-manager app ("Kometa for books")

- **Status:** Draft (owner-review artifact — Libretto's own ADR train starts in the Libretto
  repo once the owner ratifies this shape; the hnet-side integration ADRs arrive with
  PLAN-051/052)
- **Last updated:** 2026-07-16
- **Satisfies:** the PLAN-043 saga phase "Books collection-manager app" (owner rulings
  2026-07-16, recorded in `.agents/plans/043-integration-tab-saga.md` and restated in
  PLAN-054); governed by **ADR-064** (mirrored-only doctrine — external software is always the
  collections source of truth; Libretto IS that external software for books) and the
  **provider-parity contract** (research §6 / PLAN-052 R2).
- **Foundation:** `.agents/context/2026-07-16-kometa-integration-research.md` — cited
  throughout as "research §N" rather than restated. UNVERIFIED flags from that doc carry
  forward here unchanged.
- **Companions:** DESIGN-035/PLAN-037 (the Plex collections mirror whose pattern PLAN-051
  reuses for books), DESIGN-036/ADR-065 (format pairing — the matching lesson + the mint-cap
  precedent), ADR-055 (confined LL write chain), ADR-054 + OPS-013 (MAM governor + Prowlarr
  owns LL provider config), PLAN-052 (the hnet UI that binds to this contract).

## Overview

Libretto is a **standalone, public-repo, headless Node/TS service** that does for
Kavita/Audiobookshelf what Kometa does for Plex: recipes describe collections built from
external list sources (Hardcover series positions, NYT bestseller lists, Wikidata awards,
static ID lists), a reconciler materializes them **into** Kavita and ABS (which stay the
sources of truth per ADR-064), and items a recipe wants but the library lacks become a
**missing report** that optionally drives LazyLibrarian wants — the acquisition leg. It is
valuable to anyone running Kavita/ABS/LazyLibrarian with no haynesnetwork at all;
haynesnetwork integrates ONLY through the provider-parity contract (research §6), and its
PLAN-051 mirror displays Libretto-written collections with zero site changes.

Kometa's idiom is kept as the **contract shape** (recipe ≈ collection definition + defaults +
template variables + schedule + sync_mode) but deliberately not its implementation: Libretto
is an APP — recipes are DB rows with a reconciler and a real API, not YAML files rewritten by
a batch job (research §5, "deltas to adopt deliberately"). KISS throughout: v1 is one small
builder set, two write targets, one acquisition path, and a minimal built-in UI for config
CRUD + run monitoring.

## Detailed design

### D-01 — Service shape: headless API-first app, recipes as DB rows

One Node/TS service (the hnet package idioms: zod, drizzle, Postgres 16) exposing a REST API
plus a minimal built-in web UI served from the same container. There is no YAML recipe file
and no config self-rewrite — the two Kometa pain points our own deployment documents
(research §4: the config.yml PVC seed/rewrite hybrid, git edits not reaching the pod) are
designed out:

- **Recipes, collections, runs, missing reports = DB rows** owned by Libretto's reconciler.
- **Connection config = environment/secrets only** (target URLs + API keys, source API keys,
  LL URL + key, `DATABASE_URL`, Libretto API keys). Nothing secret in the DB; nothing
  behavioral in env beyond caps/toggles.
- Schedules **trigger** runs (in-process cron, D-11) — a deliberate delta from Kometa, whose
  schedules only gate an already-running batch (research §1).

### D-02 — Domain model (the §6 contract verbatim)

Four aggregates. The Recipe field set is the provider-parity contract's noun, verbatim
(research §6.2), so the hnet form and any future provider render the same shape:

- **Recipe** `{ id, targetLibrary, name (namespaced), builder { type, ref }, variables
  { syncMode, ordered, acquisitionEnabled, tag, schedule }, enabled }`
  - `targetLibrary` — a configured target: `{ server: kavita|abs, libraryId }`.
  - `builder.type` — one of the v1 set (D-05); `builder.ref` — the source reference (a
    Hardcover series id, an NYT list slug, a Wikidata award QID, a static ID list).
  - `variables.syncMode` — `append | sync` (D-08); `variables.ordered` — whether the produced
    collection carries source order (drives target mapping, D-07);
  - `variables.acquisitionEnabled` — the `radarr_add_missing` analog (default **false**;
    D-09); `variables.tag` — provenance label written into target metadata where the target
    supports it; `variables.schedule` — cron expression or `manual`.
- **Collection** — a collection Libretto **produced**: `{ id, recipeId, targetLibrary,
  targetCollectionId, targetKind (kavita_collection | kavita_reading_list | abs_collection),
  name, lastWrittenAt }` with **ordered membership** in `collection_items` carrying
  `position` from day one (research §5: ordering is first-class).
- **Run** — first-class run records: `{ id, scope (all | recipeId), trigger (cron | api |
  ui), startedAt, finishedAt, status (running | ok | warn | error), counts (per-recipe:
  matched, written, added, removed, missing, acquired), log excerpt }`.
- **MissingReport** — per-recipe `missing[]`: works the builder demanded that no library item
  matched. Rows are `{ recipeId, work identity (title, author, identifiers jsonb),
  firstSeenAt, lastSeenAt, resolution (open | pushed | landed | unmintable), llBookId? }` —
  the acquisition leg's input (D-09) and the contract's `missing[]` read (D-10).

### D-03 — Persistence: Postgres 16 + drizzle

Tables: `recipes`, `collections`, `collection_items` (FK collection, `position` int, target
member id, matched work identity), `runs`, `missing_items`, `identifier_cache` (D-04's
resolved external-id lookups, TTL'd), `settings` (few, typed). Drizzle schema + generated
migrations; embedded-Postgres test harness exactly as hnet's `@hnet/test-utils` does it
(PG16 only — the hard-rule discipline travels with the idiom). Collections/collection_items
are a **rebuildable derived cache** of what Libretto wrote (the media_plex_matches class);
recipes/runs/missing_items are durable state. Whether the production DB is a new database in
hnet's Postgres cluster or Libretto's own instance is **Q-03**.

### D-04 — Identifier resolution: IDs first, never title/author fuzz alone

The PLAN-050 lesson is normative (ADR-065 C-c: conservative title+author matching honestly
misses edition variants; identifier-backed matching is the upgrade path — Libretto starts
there). Every builder emits **works keyed by identifiers**, and matching walks a chain:

1. **Source-side identity:** builders return whatever IDs the source carries — NYT gives
   ISBN10/13; Hardcover gives its book id + ISBNs; Wikidata gives QIDs with OLID/ISBN claims;
   static lists are entered AS identifiers. **Open Library is the glue backbone** (no-key
   reads; OLID/ISBN/LCCN crosswalk) and **Wikidata** fills gaps (research §5). Resolved
   edges land in `identifier_cache`.
2. **Library-side identity:** match target items by identifier where the target exposes one —
   ABS item metadata carries `isbn`/`asin` fields; Kavita's identifier exposure per
   series/chapter is **UNVERIFIED** and must be probed in the MVP spike.
3. **Fallback, flagged:** where a library item carries no identifier, apply the ADR-065
   conservative matcher (full-title pairing key + author agreement, full token equality) —
   never looser fuzz — and record `matchedVia: title_author` on the membership row so the
   honesty survives into reads. No match ⇒ the work goes to the MissingReport; nothing is
   fabricated.

### D-05 — Builders v1 (small, source-viability-ranked per research §5)

| type | ref | emits | notes |
|---|---|---|---|
| `static_ids` | inline identifier list | ordered works | the tracer builder + the manual-curation idiom (Kometa's ID-builder analog); no external dependency |
| `hardcover_series` | Hardcover series id | works ordered by series **position** | **the flagship: "complete the series I started"** — Hardcover GraphQL, Bearer, 60/min; token expiry UNVERIFIED (Q-02) |
| `nyt_list` | NYT list slug | ranked works with ISBNs | official NYT Books API; rate limit UNVERIFIED (~500/day vs 1000) |
| `wikidata_award` | award QID | works (year-ordered) | SPARQL P166; Hugo/Nebula/Booker home |

Series-completion semantics (the flagship): for each series the recipe references (v1:
explicit series refs; a later builder can auto-discover "series I own part of" from the
target libraries), emit ALL positions in order; positions the library holds become ordered
membership, positions it lacks become missing[] — acquisition then "drives content in"
(the saga phrase). Format coverage awareness leans on the shipped PLAN-050 pairing idea:
holding EITHER format counts as held v1; per-format completion is a later variable.
**Goodreads shelf RSS is seed-only** (research §5: API dead, RSS last-100 cap): an import
command that materializes a `static_ids` recipe, never a live builder. Deferred builder
ideas (Open Library lists, `wikidata_series`) stay out of v1 — KISS.

### D-06 — Write targets and per-recipe target mapping

Verified API surfaces (research §5, from source):

- **Kavita** (Plugin auth, apiKey→JWT): Collections = `POST /api/Collection/update`,
  `/update-for-series`, `/update-series`, `DELETE` — **UNORDERED**. Reading lists =
  `/api/ReadingList/create`, `update-by-*`, **`update-position`** (explicit arbitrary order)
  + CBL import/export. Membership unit: series.
- **ABS** (Bearer): `/api/collections` CRUD + `/book` + `/batch/add|remove` — **ORDERED**
  (`collectionBook.order`; PATCH takes a `books[]` array; exact batch body fields
  UNVERIFIED). Membership unit: library item. Playlists are user-personal — out of scope v1.

**D-07 — Target-mapping rule (per recipe, derived not asked):** `variables.ordered` picks the
target kind — on a Kavita library, `ordered: true` ⇒ **reading list** (positions via
update-position), `ordered: false` ⇒ **collection**; on ABS, both map to an ABS collection
(natively ordered; unordered recipes just write source order without maintaining it). One
recipe targets one library; "the same series in both Kavita and ABS" is two recipes v1
(matching PLAN-051 Q-02's two-honest-collections lean).

### D-08 — Ownership, sync_mode, and deletion (the Kometa safety contract, made structural)

- **Ownership is by stored target-side ID, not by name.** Libretto only ever mutates
  collections whose `targetCollectionId` it created and recorded (the `collections` row).
  Name namespacing (a configurable display prefix, default `"Libretto: "`, plus
  `variables.tag` where the target supports labels) is for human clarity — collision cannot
  cause cross-writes as it can in Kometa, where collections key by title (research §1.1).
- **`sync_mode: sync`** — the run reconciles the produced collection's full membership and
  order to the builder output (adds, removes, repositions). **`append`** — adds only, never
  removes, positions appended at the end. Per-API: ABS sync is one PATCH of the full ordered
  `books[]` array; Kavita reading-list sync is create/delete of items + `update-position`
  passes; Kavita collection sync is the update-series membership calls.
- **Recipe deletion orphans by default, deletes only explicitly.** Kometa's orphan semantics
  on managed-entry removal are UNVERIFIED (research §1.4) — Libretto makes the choice
  explicit: `DELETE /recipes/:id` detaches (the produced collection survives in the target,
  now unmanaged); `?deleteCollection=true` also deletes it in the target. No
  `minimum_items` auto-delete magic: a 0-match run flags the run `warn` and leaves the
  collection alone (honesty over magic).

### D-09 — The acquisition leg: missing[] → LazyLibrarian, confined and paced

The `radarr_add_missing` analog, per-recipe via `variables.acquisitionEnabled` (default
**false**; the 2026-07-10 theatrical-window flood is the standing cautionary tale, research
§3):

- **A confined LL write module** — the ADR-055 discipline transplanted as a Libretto-side
  module: the only LL writes anywhere in the codebase are `addBook → queueBook →
  searchBook` behind one module boundary (lint-enforced import confinement, as
  `@hnet/lazylibrarian/write` is), with the proven 250ms pacer. `queueBook` after `addBook`
  (addBook alone lands `Skipped`) — the shipped hnet lesson rides along.
- **NEVER LL provider config.** Prowlarr fullSync **owns** LL provider configuration
  (OPS-013) — Libretto has no code path that touches it, pinned by a test asserting the
  acquisition path calls nothing beyond the three writes (the ADR-065 C-08 pattern).
- **The MAM governor is structurally untouched:** it sits at the Prowlarr seam (ADR-054);
  Libretto's wants enter LL like any other want and drain usenet-first by LL `dlpriority`.
- **Paced, capped, honest:** per run, at most `ACQUISITION_CAP_PER_RUN` (default **25**,
  env-tunable — the PLAN-050 mint-cap precedent, ADR-065 C-06) missing items are pushed,
  oldest-first, retries least-recently-attempted first. Unresolvable identities persist as
  `unmintable` and retry with backoff-by-recency; nothing is fabricated (the DESIGN-036 D-05
  discipline). Items that later appear in the library reconcile `landed` on the next run.

### D-10 — API surface: the five contract nouns as REST

REST + zod-validated JSON (OpenAPI generated from the zod schemas) rather than tRPC: the
consumers include non-TS standalone users, and hnet's tRPC router (PLAN-052) wraps this API
behind its provider discriminator anyway. Base `/api/v1`, all under D-12 auth:

| Contract noun (research §6) | Endpoints |
|---|---|
| listRecipes / upsertRecipe / deleteRecipe | `GET/POST /recipes`, `GET/PUT/DELETE /recipes/:id` (`?deleteCollection=true` per D-08) |
| validate(recipe \| set) → issues[] | `POST /validate` (body: recipe draft or `{all: true}`) — schema + ref resolution + target reachability, mutating nothing |
| apply(scope) → runId; getRun | `POST /apply` `{ scope: all \| recipeId }` → `{ runId }`; `GET /runs/:id`, `GET /runs` |
| listProducedCollections | `GET /collections` (+ `GET /collections/:id/items` — ordered membership) |
| per-recipe missing[] | `GET /recipes/:id/missing` |

Plus discovery + liveness: `GET /builders` (types + zod param schemas — drives both UIs'
forms), `GET /targets` (configured libraries + reachability), `GET /health` (unauthenticated
liveness; D-14).

### D-11 — Scheduler: in-process cron

One in-process cron loop (croner-class library): each enabled recipe's
`variables.schedule` (cron expression | `manual`) enqueues an apply; runs serialize through
a single worker queue (no concurrent writes to one target — Kometa's `concurrencyPolicy:
Forbid` instinct, in-process). Missed ticks on restart are skipped, not replayed (next tick
catches up — recipes are reconcilers, not event logs). No external job system v1.

### D-12 — AuthN: API keys first, OIDC later

`Authorization: Bearer <key>` checked against `LIBRETTO_API_KEYS` (env, comma-separated —
ESO-friendly; hashed-in-DB key management is a later feature). hnet holds one key as its
provider credential; the built-in UI prompts for a key once and keeps it client-side. OIDC
(Authentik for us, generic OIDC for standalone users) is explicitly later — the contract
surface doesn't change, only the authenticator.

### D-13 — Built-in UI: config CRUD + run monitor, nothing more

A minimal SPA served by the service itself (no separate deployment): **Recipes** (list +
form generated from `GET /builders` param schemas + validate-before-save), **Runs** (history
+ polling detail with per-recipe counts and the missing report), **Status** (targets/sources
reachability). No walls, no browsing, no user management, no theming ambitions — the rich UX
lives in hnet (PLAN-052) and in the targets themselves. This bound is the KISS ruling made
structural.

### D-14 — Deployment + observability

- **Single container** (`ghcr.io/thaynes43/libretto`) + Postgres 16. Same release train
  idiom as hnet: conventional commits, release-please, image on `v*` tags.
- **haynes-ops HelmRelease sketch** (`kubernetes/main/apps/media/libretto/`): bjw-s
  app-template, one Deployment (the scheduler is in-process — no CronJobs, unlike Kometa's
  three, research §4), ExternalSecrets from the 1Password `HaynesKube` vault (Kavita/ABS/LL
  keys exist there today; Hardcover/NYT keys are Q-02), internal ingress
  `libretto.haynesops.com`, egress allowlist for `api.hardcover.app`,
  `api.nytimes.com`, `openlibrary.org`, `query.wikidata.org`. DB per Q-03.
- **Observability v1:** structured logs (pino), `GET /health` (liveness + DB ping), run
  history in the DB as the primary run-state surface (the contract's noun 4). Prometheus
  `/metrics` is explicitly later; alerting rides "no successful run in N hours" via the
  existing log/uptime stack until then.

### D-15 — Non-goals v1 (explicit)

- **No Goodreads scraping** — RSS import is seed-only (D-05); no Listopia, no page scraping.
- **No recommendations / predictions** — that is saga pt 2, parked, and it is hnet-side.
- **No multi-user personalization** — recipes are estate-level; ABS playlists (user-personal)
  and per-user anything are out.
- **No writing to LL provider config** (D-09 — structural, not aspirational).
- **No overlays / poster art / metadata operations** — Kometa's other half is out of scope
  entirely.
- **No comics v1** — Kavita comics libraries are not targeted until a viable comics list
  source exists (the PLAN-032 comics-mandate hunt; ADR-065 C-08 kept comics out of pairing
  for the same honesty).

## Alternatives considered

- **In-app (an hnet package) instead of a standalone service** — rejected by owner ruling
  (2026-07-11 escalation of PLAN-032, reaffirmed 2026-07-16): standalone-valuable to
  non-hnet users, own repo/release train; hnet stays a mirror + contract consumer (ADR-064).
- **YAML recipe files, Kometa-style** — rejected (research §5.4): the config-hybrid pain in
  our own Kometa deployment (§4) is the counterexample; DB rows + reconciler + API is the
  app shape the owner asked for.
- **tRPC as the public API** — rejected for the public surface (TS-only consumers); kept as
  hnet's client-side idiom wrapping this REST contract.
- **Title/author matching as the primary matcher** — rejected; ADR-065 C-c is the recorded
  lesson. Identifiers first; the conservative matcher only as a flagged fallback (D-04).
- **External job runner / CronJobs for scheduling** — rejected v1 (KISS): in-process cron +
  a serialized worker queue suffices for one estate; the run model doesn't preclude moving
  later.

## Test strategy

The hnet discipline travels: Vitest + embedded Postgres 16 (no substitutes), stub servers
for Kavita/ABS/LL/Hardcover/NYT/Open Library/Wikidata in the `@hnet/test-utils` idiom.
Highest-value suites: identifier-chain resolution (cache hits, glue fallbacks, honest
no-match ⇒ missing), the flagship series builder (positions → ordered membership + missing
split), sync_mode reconcile per target kind (add/remove/reposition; append never removes),
ownership (never mutates a collection without a `collections` row; delete-vs-orphan),
acquisition pacing (cap honored, oldest-first, unmintable retry ordering, three-writes-only
confinement pin), and contract-surface schema tests (the five nouns' zod schemas are the
compatibility promise hnet binds to).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Repo license for the public repo — MIT (ecosystem default) vs AGPL (self-hosted-tool protective)? Owner call before the repo is created. | (open) |
| Q-02 | Source API key provisioning: owner creates the Hardcover account + token (expiry behavior UNVERIFIED) and the NYT Books API key (rate limit UNVERIFIED); both land in 1Password `HaynesKube`. | (open) |
| Q-03 | Does Libretto share hnet's Postgres cluster (new database, one less StatefulSet) or get its own instance in its namespace (isolation, standalone-shaped)? | (open — lean: own CNPG instance, matching the standalone story) |
| Q-04 | Public repo home + name check: `github.com/thaynes43/libretto` (name availability on GHCR/npm unchecked). | (open) |

## Appendix A — the hnet binding sequence (the doctrine payoff)

How the two queued hnet plans consume Libretto with no bespoke coupling:

1. **PLAN-052 (provider registry).** hnet's collection-manager surface registers provider
   `libretto` next to `kometa`: base URL (`libretto.haynesops.com` internal ingress) + API
   key from ESO. The provider adapter maps the R2 nouns 1:1 onto D-10's endpoints —
   recipes CRUD, validate, apply/run-state, produced collections, missing[] — with **no
   translation layer**, because Libretto implements the contract natively from day one
   (owner ruling). The recipe form renders from `GET /builders` param schemas; Kometa stays
   the constrained git-PR provider beside it (PLAN-052's own write path). Acquisition
   toggling (`variables.acquisitionEnabled`) is role-gated in hnet exactly like the
   `radarr_add_missing` knob class.
2. **PLAN-051 (books collections mirror) — zero changes.** Libretto writes real collections
   and reading lists INTO Kavita/ABS (D-06). PLAN-051's mirror syncs whatever exists in
   those servers, exactly as PLAN-037 mirrors Plex — so every Libretto-produced collection
   appears on the hnet Books/Audiobooks walls **without any Libretto-aware code in the
   mirror**. That is ADR-064's doctrine paying off: the site never needed to know who
   authored a collection.
3. **Managed vs unmanaged flagging (contract noun 6).** Where the hnet UI wants to
   distinguish "Libretto-managed" from hand-curated collections (badges, PLAN-052's
   read-only context), it joins the mirror's target-side collection IDs against
   `GET /collections` — read-only, hnet-side, still zero mirror-schema changes.
4. **Sequence:** Libretto MVP live against the estate (PLAN-054 M6) → PLAN-051 mirror ships
   independently (its quick win is hand-curated collections; Libretto's arrivals are free) →
   PLAN-052 registry binds Kometa + Libretto behind one UI. 051 and Libretto have no
   ordering dependency on each other — that independence is the design working.
