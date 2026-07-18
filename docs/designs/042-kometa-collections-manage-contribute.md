# DESIGN-042: Kometa collections — manage & contribute (the provider contract instantiated for movies/TV)

- **Status:** Accepted <!-- revised 2026-07-18 to the direct-add + auto-merge model (ADR-072); was Draft under ADR-069 -->
- **Last updated:** 2026-07-18 evening (REVISED again — the estate's HAND-AUTHORED Kometa collections are
  now EDITABLE in place, superseding the #414 read-only stance. Owner ruling: *"the point of the
  collections config UI was to edit Kometa configs by add / update / editing collections."* See the D-01 /
  D-02 / D-04 revision notes below. Earlier: 2026-07-18 direct-add + auto-merge — ADR-072 supersedes
  ADR-069: the propose→approve suggestion pipeline is removed; a within-cap grouping-only add AUTO-COMMITS +
  AUTO-MERGES the haynes-ops config PR. Prior: 2026-07-17 owner directive.)
- **Satisfies:** PLAN-052 (collection-manager integration — the provider-agnostic surface, R1 KISS /
  R2 integration-parity); owner rulings 2026-07-18 (direct-add; Kometa auto-merge for within-cap
  adds; find-missing is a per-collection role grant); owner directive 2026-07-16: "apply the same
  concept to Kometa though it's more complex — keep it distilled to the types of collections /
  builders I am using now but let users hook in their own thing."
- **Governed by:** **ADR-072** (direct-add + cap-ticket-materialize + find-missing grant + Kometa
  auto-merge — supersedes ADR-069, whose git-PR managed-include / allowlisted-builder / validated-ref
  spine this design KEEPS, re-pointed at direct-add + auto-merge) on top of
  **ADR-064** (mirror-only doctrine: external software owns collections; the app authors a Kometa
  RECIPE, never a Plex collection directly), **ADR-062 / DESIGN-033** (the books-Fix suggest → audited
  row → role-gated action precedent this ports), **ADR-023 / ADR-059** (the `role_*_action_grants`
  machinery + `*ActionProcedure` gate), **hard rules 4** (the *arrs / external software are the source
  of truth; the only write-back is explicit), **6** (mutations write audit rows in the same tx),
  **8/9** (Modal for explanatory confirms; no reflow).
- **Companions:** **DESIGN-035** (the Movies/TV Plex-collections mirror this reads back through — the
  produced-collection surface + `provenance: kometa`), **DESIGN-037 / Libretto** (the sibling bound
  provider — the same recipe/apply/run contract, books-flavored), **DESIGN-038** (the books collections
  contribution surface this mirrors in shape).

## Overview

> **REVISED 2026-07-18 (ADR-072 — direct-add + auto-merge).** The propose→approve suggestion pipeline
> below is RETIRED. Any user now ADDS/EDITS a Kometa collection DIRECTLY, capped at
> `collection_size_cap` (PR3, default 25). A within-cap, grouping-only (find-missing OFF) add
> **auto-commits AND auto-merges** the haynes-ops config PR (bot-authored, app-owned managed file,
> `--validate-file` gated — D-10). Over-cap adds file a `collection_override` ticket (DESIGN-043 D-11)
> and enabling find-missing (the acquisition lever, the former `acquire`) are the ONLY two cases whose
> config PR is still **human-merged**. Read this design with D-02, D-07, and D-10 as revised; the
> allowlist (D-04), the composer (D-05), the safety contract (D-03), and validation (D-09) are
> unchanged. Where the text below says "suggest" / "approve" / "the acquire grant", read
> "add/edit directly" / "materialize" / "the find-missing grant" per ADR-072.

> **IMPLEMENTED 2026-07-18 (PR4b).** The write path below is built and merged: the pure recipe → managed-include
> compiler (`@hnet/domain` `kometa-compiler.ts` — D-04 allowlist as `@hnet/db` `KOMETA_BUILDER_TYPES`, D-05
> serializer, byte-stable + round-trippable via a `# hnet-recipes:` manifest); the confined haynes-ops
> git-write client (`@hnet/haynesops/write`, import-guarded to `packages/domain`); the orchestrator
> (`kometa-collections.ts` — overview reconcile, direct-add + auto-merge, materialize, delete); the router
> wiring (Movies/TV bind Kometa) and the live Movies/TV `/collections` tabs. D-10 auto-merge is a pure,
> exhaustively-tested policy. **Runtime prerequisite (FLAGGED):** the app has no cluster credential to write
> haynes-ops yet — `HAYNESOPS_WRITE_TOKEN` + the repo bootstrap (register the two managed files + the
> `--validate-file` CI gate) must be provisioned per **docs/ops/014-haynesops-collection-writes.md**. Until
> the CI gate exists the app leaves EVERY PR for a human (safe default — no green gate, no auto-merge).

The estate already **mirrors** the 461 Plex collections (457 Kometa-managed) into the Movies/TV walls
(DESIGN-035, read-only). This design adds the WRITE half for the Kometa provider: **any user adds a
collection directly (within the cap), the app regenerates the app-owned managed include and opens a
haynes-ops git PR, the app auto-merges it (safe case), Flux applies it, the next Kometa run produces
the collection, and the existing `collections-sync` mirrors it back** with `provenance: kometa`. It is
the DESIGN-035 mirror's write loop, and it is the SAME provider contract Libretto proves live on the
books side (PLAN-052 R2) — one manager UI on the first-class `/collections` page (DESIGN-043), two
write adapters (Libretto direct, Kometa auto-merged git-PR).

Three constraints shape every decision:

1. **Mirror-only stays intact (ADR-064).** The app never writes a Plex collection. It writes a Kometa
   *recipe* (a collection definition in Kometa's YAML) into one app-owned file; Kometa is still the
   thing that builds the collection, and DESIGN-035 is still the only read path. The write surface is a
   config recipe, not a collection.
2. **Distilled to exactly the owner's builder types (R1).** Kometa's builder taxonomy is enormous and
   churns (the research doc's breaking-change history). The app allowlists EXACTLY the builder types
   the live config uses today (D-04) and nothing else. "Hook in your own thing" means a member picks an
   allowlisted builder type and supplies a *validated ref* (an IMDb list URL, a TMDb collection id) —
   **never raw YAML passthrough** (ADR-069).
3. **Role-gate the blast radius (owner directive).** A movie pulls gigabytes per title. An edit that
   flips `radarr_add_missing` on can fill Radarr with an entire IMDb list, a whole studio catalogue, or
   a chart that refreshes forever (the 2026-07-10 theatrical-window flood is the estate's own scar).
   So the write actions are gated `suggest` / `manage` / `acquire`, and `acquire` — the builders that
   RADARR/SONARR-request missing titles — is gated hardest (D-06).

## Detailed design

### D-01 — The provider contract, instantiated for Kometa

PLAN-052 §6 defines the provider-agnostic nouns (`recipe`, `validate`, `apply`, `run`, `produced
collections`). This is what each noun MEANS Kometa-side:

- **Recipe** = one Kometa **collection definition** — a single entry under `collections:` in a
  `collection_files` YAML file: a namespaced title + a builder + its ref + a bounded set of variables
  (`{ id, provider: 'kometa', targetLibrary, name, builder: { type, ref }, variables: { syncMode,
  collectionOrder, acquisitionEnabled, tag, schedule }, enabled }`). This is the SAME shape as a
  Libretto recipe (PLAN-052 §6.2) with a Kometa discriminator; the composer form and the tRPC router
  are shared, the builder allowlist (D-04) is provider-specific.
- **Read — what the app can safely see** (two layers, both already in the estate):
  - **Produced collections** — DESIGN-035's mirror. Already synced, already gated (ADR-047), already
    carrying `provenance: kometa` (T-194). This is the "what Kometa actually built" truth and needs no
    new read.
  - **The config's collection definitions** — the app-owned managed file is git (D-02), so the app
    reads back exactly what it wrote (its own recipes). Reading the app's own managed file back is the
    recipe-list source of truth, the Libretto `GET /api/recipes` analog.

> **REVISED 2026-07-18 evening (owner ruling — edit the estate's collections, not read-only).** The
> bullet above originally said the app does NOT parse the owner's hand-written sibling files. That is
> SUPERSEDED. The owner ruled: *"the point of the collections config UI was to edit Kometa configs by
> add / update / editing collections."* The app now READS EVERY hand-authored config file
> (`movies-*.yml` / `shows-*.yml`) and parses their collections into the Movies/TV list, and EDITS a
> hand collection in place by a **surgical text-level splice** of only that collection's builder ref (or
> its `<arr>_add_missing`/`_search` keys), preserving every untouched byte of the file (round-trip
> fidelity is the hard requirement — a YAML load→dump cannot preserve the estate's comments / anchors /
> flow-map layout, so the splice never re-serializes the file). Editing a hand file opens a haynes-ops PR
> against THAT file; it is ALWAYS human-merged (see D-10). Adds still flow to the app-owned managed
> include exactly as before. The editability boundary is D-04.
- **Write** = compile the enabled recipes into the ONE managed include file and open a haynes-ops PR
  (D-02). A write is a config change, applied by Flux, realized by the next Kometa run — never a live
  Plex mutation.

### D-02 — The write path: git-PR managed include (RECOMMENDED), not PVC

**Recommendation: git-PR writes to a single app-owned managed include file.** The research is
decisive on where the config lives (research §4, verbatim): the Kometa **collection/overlay files are a
git-managed ConfigMap** (`haynes-ops` `kubernetes/main/apps/media/kometa/app/config/*.yml` via
`configMapGenerator`), mounted read-only at `/config/git`, **hot on every run**. Only `config.yml`
itself lives on the PVC (an ExternalSecret seed that Kometa self-rewrites — the Defaults'
`template_variables` are there, and are a separate "PR + re-seed" story, deferred).

So the app owns exactly ONE new file in that ConfigMap — `hnet-managed-movies.yml` /
`hnet-managed-tv.yml` — appended to each library's `collection_files` list once, by hand, at
bootstrap. Every app write regenerates that file's `collections:` block and opens a PR against
haynes-ops. Consequences:

- **Audited + reversible + Flux-applied.** A git PR is the estate's native audit trail; a bad recipe is
  `git revert`; nothing touches the PVC or a live process.
- **No YAML the app didn't generate.** The app serializes from the validated recipe model (D-05); the
  file is machine-owned, header-stamped "generated by haynesnetwork — do not hand-edit."
- **Honest latency (the cost).** A member suggestion that a manager approves does NOT appear
  immediately. The pipeline is: PR merges → **Flux reconcile** (the ConfigMap redeploys, minutes) →
  the **next Kometa run** produces the Plex collection (the `collections` CronJob is `30 6 * * *`
  America/New_York daily; or a bounded run-now Job, D-08) → the **next `collections-sync`** mirrors it
  back (DESIGN-035 T-181). End to end, a suggestion is visible after a Flux cycle plus a Kometa run
  plus a mirror sync — a scheduled-batch cadence, not a request/response. The UI must say so plainly
  ("Approved. It will appear after the next collection run" — no time-grounding, owner tone). This is
  the deliberate tradeoff for the GitOps audit trail, and it is acceptable because collections are
  curation, not a live action.

**PVC writes are rejected** for the managed file: the collection files are not on the PVC (they are the
git ConfigMap), and the one thing that IS on the PVC — `config.yml` — is self-rewritten by Kometa every
run, so an app write there races the process and needs a re-seed to land. Git is both where the config
lives AND the estate's doctrine (research §4; PLAN-052 write-path verdict). See ADR-069 for the full
options table.

#### D-02 amend (2026-07-18) — the mirror's config collections list ~~as READ-ONLY rows~~ (SUPERSEDED)

> **SUPERSEDED 2026-07-18 evening (owner ruling).** The read-only treatment #414 shipped is replaced by
> edit-in-place. Read the section below for the reconcile shape (still accurate), but the estate's
> hand-file collections are now EDITABLE (D-01 revision / D-02 revision / D-04). The owner also critiqued
> the chip copy ("managed in the estate's Kometa config") as far too verbose; the Movies/TV rows now carry
> a short SOURCE badge — **"Added here"** (app-managed include) vs **"Kometa config"** (a hand file or a
> Defaults-produced mirror row) — and the books read-only chip is shortened to **"made in Kavita"** /
> "made in Audiobookshelf". The two-group split is dropped for Kometa: one source-badged list.

The managed include holds ONLY the recipes the app authored, but the estate's own Kometa config has
produced ~465 collections the mirror already carries (movies 441, TV 24 — confirmed on prod by
`plex_collections.created_by='kometa'`, `pl.media_type` in `movie`/`show`). The Movies/TV overview
therefore returns, beside the managed `recipes[]`, a `handCollections[]` array reconciled as follows:

- Every collection parsed from a hand-authored config file (`movies-*.yml` / `shows-*.yml`) →
  `{ name, file, source: 'hand', builderType, builderRef, editable, editableReason, findMissing, itemCount }`.
  `itemCount` joins the mirror by normalized title; `editable` is the D-04 boundary.
- Every mirror `created_by='kometa'` collection NOT joined by a managed recipe OR a hand file (the Kometa
  **Defaults** output — universe/seasonal/franchise/awards, authored in `config.yml`, no file to splice) →
  `{ name, source: 'default', editable: false, itemCount }`. Listed honestly, never editable.

Of the estate's **153 hand-authored collections** (parsed from the seven live config files), **43 are
editable** under the current D-04 allowlist (movies 26, TV 17); the other 110 are query/search/regex
engines, multi-builder blocks, or refs the app does not model (Edit disabled with the honest reason). The
remaining ~312 mirror collections are Defaults-produced and non-editable by construction. A recipe the app
DOES manage joins its mirror collection by title and is never duplicated into `handCollections`.

### D-03 — The managed include safety contract

The research §1 "single managed file is fully supported" contract, applied verbatim so the app file can
never disturb the owner's hand-written siblings:

- **Namespace every collection name.** Collections key by Plex title; a title collision with a sibling
  file silently merges (the estate exploits this deliberately for franchise dedup). The managed file
  MUST namespace its titles so it can never collide — a stable prefix the mirror can also recognize
  (proposal: the recipe carries the display title the owner wants, but the Kometa collection name is
  suffixed/marked so app-authored collections are unambiguous — Q-05 on the exact convention, weighing
  it against the DESIGN-035 provenance label which already distinguishes `kometa` but not
  app-authored-within-kometa).
- **`sync_mode: sync` per managed recipe** (the global is already `sync`) so a list-backed collection
  mirrors its ref exactly rather than append-growing.
- **Expect `minimum_items: 2` + `delete_below_minimum: true`** (global): a recipe whose ref resolves to
  0–1 matched titles auto-deletes. The composer must surface this (the Libretto "matched ≤1 ⇒ likely
  wrong ref" judgment gate, live-contract note) as a pre-save warning via ref preview (D-05).
- **Removal orphans, does not delete.** Removing a recipe from the managed file ORPHANS its Plex
  collection (research §1.4, exact orphan semantics UNVERIFIED — canary first). The delete flow must
  offer explicit target cleanup (the Libretto "delete does not cascade" live-contract lesson), and this
  is a `manage`-gated action, never automatic.
- **CI-gate every generated file with `--validate-file`** against the pinned image (v2.4.4; the
  validation framework landed v2.4.2) BEFORE the PR can merge (D-09). No `--dry-run` exists; nearest is
  `--validate-level full` (connects to Plex/APIs, mutates nothing).

### D-04 — Distillation: the builder allowlist IS the owner's current builder types

Enumerated from the LIVE config (`haynes-ops apps/media/kometa/app/config/*.yml`, read this session).
The allowlist is EXACTLY these types — a builder Kometa supports but the owner does not use is not
offered:

| Builder type | Where it lives now | Ref shape | Acquisition-capable? | Member-suggestible v1? |
|---|---|---|---|---|
| `imdb_list` | Christmas HNet, Roald Dahl, J-Horror, Addams Family, Monsterverse | an IMDb list URL (`imdb.com/list/ls\d+/`) | **Yes** (add_missing can pull the whole list) | **Yes** — validated URL + ref preview |
| `tmdb_collection_details` | movies-franchises (Addams, Goosebumps, Fantastic Four, …) | a TMDb collection id (int) | **Yes** | **Yes** — id resolves to a name + member count preview |
| `tvdb_list_details` | shows-franchises (Arrowverse, Band of Brothers, The Boys, …) | a TVDb list URL | **Yes** | **Yes** — validated URL + preview |
| `tmdb_movie` | Unbreakable, Addams augment | a list of TMDb movie ids | **Yes** | **Yes** — manual id curation |
| `tmdb_show` | Curated for Jackson/Kellie/Penelope, Kid Cartoons | a list of TMDb show ids | **Yes** | **Yes** — manual id curation |
| `tvdb_show` | Curated family lists, Earth & Space Wonders | a list of TVDb show ids | **Yes** | **Yes** — manual id curation |
| `tmdb_discover` | movies-charts (sort_by + `with_original_language` + `vote_count.gte`); movies-people (`with_crew`/`with_cast`) | a query OBJECT (many knobs) | **Yes** (charts pull; the 2023 flood source) | **No v1** — owner-only (it is the chart/people engine, not a ref) |
| `imdb_chart` | IMDB Popular, IMDB Top 250 | a named chart enum | **Yes** (continuous for "Popular") | **No v1** — owner-only |
| `imdb_search` | A24, Disney/DreamWorks Animation (company ids) | a search OBJECT (company/keyword) | **Yes** (whole catalogue) | **No v1** — owner-only |
| `plex_all` + `filters` | Spatial Surround, Dolby Atmos, DTS X | library-filter regexes | **No** — groups EXISTING media only | **No v1** — owner-only (regex, not a ref) but inherently acquisition-safe |
| Kometa Defaults (`- default:`) | config.yml: universe, seasonal, oscars, golden (acquire ON), franchise (OFF) | a default name + `template_variables` | Yes (per-default) | **No** — lives on the PVC config.yml (re-seed), deferred past v1 (PLAN-052) |

**The member-suggestible set (v1 proposal, Q-02):** `imdb_list`, `tmdb_collection_details`,
`tvdb_list_details`, `tmdb_movie`, `tmdb_show`, `tvdb_show` — the six that reduce to a **single
validated ref** (a URL or an id/id-list). Each is a "hook in your own thing" lever: a member proposes
"a collection built from THIS IMDb list / THIS TMDb collection". The four owner-only types
(`tmdb_discover`, `imdb_chart`, `imdb_search`, `plex_all`) are query/search/regex OBJECTS, not refs —
they are the estate's tuned acquisition engines and stay authored by the owner in the hand-written
files (or a later advanced surface). Defaults toggling is its own PVC story.

> **D-04 note (2026-07-18 evening) — the editability boundary for HAND-FILE collections.** When the app
> parses a hand-authored config collection (D-02 revision), it is **editable in place** ONLY when the block
> reduces to EXACTLY ONE builder in the six-type allowlist above with a ref `validateKometaRef`
> canonicalizes. A block with multiple builders (e.g. Addams Family's `collection` + `imdb_list`, Walking
> Dead's `tvdb_list_details` + `tvdb_show`), a query/search/regex engine (`tmdb_discover` charts + people,
> `imdb_search` studios, `plex_all` audio), a template-variable indirection the app does not model
> (`{name: Director, tmdb: 525}`), or a ref that fails validation renders its Edit **disabled** with a
> short honest tooltip ("Too custom to edit here. Edit the config directly."). The app NEVER does a lossy
> rewrite of config it does not fully model — an unrecognized block is listed, never silently rewritten.
> The builder type and name are the collection's identity (locked in the edit composer); only the ref (and
> the find-missing knob) is editable. The splice is text-level and byte-faithful (D-02 revision).

**Ref validation (no raw YAML — ADR-069).** The app never accepts a YAML fragment. It accepts a typed
ref, validates it structurally (URL matches the builder's host/path grammar; ids are integers), and —
the Libretto ref-preview lesson (live-contract note: a wrong slug silently matches 0) — RESOLVES it
before save to show the human what it will build: TMDb collection id → collection name + film count;
IMDb/TVDb list URL → list title + item count. A ref that resolves to 0–1 items is flagged (the
`minimum_items` auto-delete, D-03). The resolve calls ride existing/allowlisted egress (TMDb is already
a Kometa connector; IMDb/TVDb list resolution TBD — Q-06 on the preview data source and its egress
allowlist entry).

### D-05 — The recipe composer (the write model)

A recipe compiles deterministically to one `collections:` entry. Example — a member suggests an IMDb
list, grouping-only:

```yaml
# in hnet-managed-movies.yml (generated — do not hand-edit)
collections:
  "<namespaced title>":
    imdb_list: https://www.imdb.com/list/ls012345678/
    sync_mode: sync
    collection_order: custom
    radarr_add_missing: false        # acquisitionEnabled = false ⇒ grouping-only
    radarr_tag: "Kometa-Added,HNet-Suggested"
```

The composer enforces: builder in the allowlist (D-04), ref validated + previewed (D-04), `id` globally
unique (the Libretto "recipe id is global" lesson — filename + collection-name key; per-target variants
need distinct ids), title namespaced (D-03), and `acquisitionEnabled` defaulting **false** and gated by
the `acquire` grant (D-06). `variables` is a closed set — `syncMode`, `collectionOrder`, `tag`,
`schedule` (validated against the Kometa grammar; display-note only — the CronJob owns cadence, PLAN-052
§6.3), `acquisitionEnabled` — never free YAML.

### D-06 — Role gating: `role_collection_action_grants` — a single `find_missing` action (REVISED 2026-07-18)

> **REVISED (ADR-072).** The three-action triad below (`suggest` / `manage` / `acquire`) is retired.
> The grant table survives with a SINGLE action, **`find_missing`** (migration 0069 rebuilds the
> `COLLECTION_ACTIONS` CHECK, clears the old rows). Direct add/edit within the cap needs NO grant
> (everyone); DELETE + unbounded is admin-only; the acquisition lever (`radarr_add_missing`/
> `sonarr_add_missing`) is the `find_missing`-gated per-collection knob (DESIGN-043 D-14), enabling
> which opens a HUMAN-merged PR (D-10). Read the `acquire` discussion below as the `find_missing`
> rationale — the "movies pull gigabytes / the 2023-flood scar" argument is exactly why find-missing
> is gated and never auto-merged. Ships Admin-only, opened per role at the self-serve `/admin` grid
> (the DESIGN-033 FLIP idiom).

The retired triad, for historical context (superseded by the single `find_missing` action above):

Aligned with the books leg's action-grant model being built in parallel tonight (the
`role_books_action_grants` / `setRoleBookActions` / `bookActionProcedure` shape, DESIGN-033 D-03; the
shared `role_collection_action_grants` table is that agent's to define — this design CONSUMES it,
Kometa-side, and does not mint its own). Three actions, escalating:

- **`suggest`** — create a PENDING collection suggestion (an audited row; no config write, no PR). The
  low-trust entry point; safe to open to member roles because a suggestion is inert until approved.
- **`manage`** — approve/reject a suggestion and edit/remove managed recipes; approval is what opens
  the haynes-ops PR (D-07). Higher trust — a manager's approval writes config.
- **`acquire`** — the privileged flag: enable `radarr_add_missing`/`sonarr_add_missing` on a recipe
  (or approve a suggestion that requests acquisition). This is the "pull a ton of content" lever the
  owner called out.

**Why acquire is gated hardest — and why the rationale is stronger here than for books.** On the books
side a mistaken pull is an epub (megabytes). Here a single approved `imdb_list` with acquisition on can
enqueue an entire list into Radarr — the estate's own 2023 charts flooded Radarr with foreign titles,
and the 2026-07-10 theatrical-window incident (re-importing "Chum" the morning after a sweep deleted it)
is exactly this failure. **Movies pull gigabytes per title**; the blast radius of one wrong acquire
toggle is measured in the storage budget. So:

- The **grouping-capable** builders (`plex_all`) can NEVER acquire — structurally safe regardless of
  grant.
- The **acquisition-capable** builders (all six suggestible types) default `acquisitionEnabled: false`.
  Turning it on requires `acquire`. Approving a suggestion that ASKS for acquisition requires `acquire`
  (a `manage`-only approver can approve the grouping-only version but cannot grant its acquisition).
- Ships **Admin-only** (empty grant table — the DESIGN-033 default), then opened per the owner's ruling
  (Q-04). The natural rollout mirrors the books Fix: `suggest` to member roles early, `manage` to
  trusted roles, `acquire` held by the owner / admin for a long time (Q-04).

The API gate is `collectionActionProcedure('suggest'|'manage'|'acquire')` composed on the Movies/TV
surface, the `bookActionProcedure` idiom. Every grant mutation writes a `permission_audit` row in the
same transaction (hard rule 6). Every suggestion state transition writes an audit row (D-07).

### D-07 — The write flow (REVISED 2026-07-18 — direct-add + auto-merge, no suggestion)

> **REVISED (ADR-072).** The suggest→approve pipeline is retired. There is no `collection_suggestions`
> row and no manager review queue for a within-cap add. The direct-add flow, Kometa-shaped:

1. **Add/edit (any user, within the cap).** The user fills the composer (builder + validated +
   previewed ref); `assertWithinCollectionSizeCap` (PR3) gates on save. The domain single-writer
   recompiles the managed include (D-02) from all enabled recipes and opens a **bot-authored
   haynes-ops PR** via the dev-bot app token, writing an audit row in the SAME transaction as the
   local write intent (hard rule 6). No suggestion row — the recipe IS the write.
2. **Auto-merge (safe case).** For a within-cap, grouping-only (find-missing OFF) add, the app
   **auto-merges** the PR once the `--validate-file` CI gate is green (D-09/D-10) — no human. A red
   validation blocks the merge and surfaces the validator output honestly on the collection row
   (`apply_failed`, the DESIGN-033 `failed` idiom); the app never force-merges a red gate.
3. **Human-merge (the two gated cases).** An **over-cap** materialization (an admin-approved
   `collection_override` ticket, DESIGN-043 D-11) and any **find-missing enable** (the acquisition
   lever, D-06/D-14) open a PR that a HUMAN merges — the storage blast radius stays behind a person.
   The collection row shows "Pending merge" with the PR URL until merged.
4. **Kometa run.** On the next `collections` CronJob (or a bounded run-now Job, D-08) Kometa produces
   the Plex collection from the merged managed file.
5. **Mirror picks it up.** The next `collections-sync` (DESIGN-035 T-181) mirrors the new collection
   with `provenance: kometa` (T-194 — the `Kometa` Plex label). The collection row reconciles to
   `live` when its produced collection appears in the mirror (matched by the namespaced title / a
   recorded marker — Q-05). The user sees it on the Movies/TV Collections wall, provenance-badged,
   exactly like every other mirrored collection.

The collection row's state (drafting → PR opened (url) → validated → merged (auto|human) → run →
mirrored) is the durable audit spine across the async gap — the same trail the retired suggestion row
carried, now hung off the recipe/write audit rather than a suggestion aggregate.

### D-10 — Auto-merge policy (NEW 2026-07-18 — the ADR-072 ruling)

The app AUTO-MERGES a haynes-ops config PR only when ALL of these hold; otherwise the PR is
human-merged:

- the write is **within the cap** (`assertWithinCollectionSizeCap` passed, not an over-cap ticket
  materialization), AND
- the collection is **grouping-only** (find-missing OFF — no `radarr_add_missing`/`sonarr_add_missing`;
  the acquisition lever is never auto-merged), AND
- the PR touches ONLY the app-owned managed include (`hnet-managed-*.yml`, D-02) — a diff outside the
  managed file aborts the auto-merge (a safety assertion; the app never regenerates a sibling), AND
- the **`--validate-file` CI gate is green** against the pinned image (D-09).

> **D-10 note (2026-07-18 evening) — hand-file edits are ALWAYS human-merged.** An edit / find-missing /
> delete of a hand-authored collection touches a SIBLING config file, not the app-owned managed include,
> so the managed-file-only condition already forbids auto-merge — the write path never even attempts it.
> Every hand-file PR is left for a human. This keeps the estate's own config changes behind a person while
> preserving the auto-merge convenience for the app's own within-cap managed adds.

Mechanics: the write client opens the PR bot-authored (dev-bot app token, CLAUDE.md), waits for the
required check, and merges via the GitHub API (squash) — the same dance the release-train uses
(App-token events trigger CI; a GITHUB_TOKEN push does not — arm auto-merge or poll + merge). The
merged PR is the audit trail; a bad recipe is a `git revert`. This is the sole new automation ADR-072
introduces over the estate's human-merge GitOps norm, and it is bounded by the four conditions above
(ADR-072 C-06). A canary window (auto-merge behind a flag for the first runs) is a safe-rollout option
(DESIGN-043 Q-03).

### D-08 — The monitor story (what Kometa honestly exposes)

Kometa is a **batch process with NO inbound API/UI/daemon** (research §2). What the app can truthfully
show about a run:

- **Job status** — the three CronJobs are Kubernetes Jobs; `MediaAutomationJobFailed` already alerts on
  kometa job failure (research §4). The app can read last-run/last-success/status from Job state (the
  read-only kubectl SA covers get/list/watch). This is the honest "last collection run" surface.
- **`meta.log`** — `/config/logs/meta.log` on the PVC holds the run detail; a link/tail is the
  deepest honest signal (no per-collection results API exists).
- **Outbound webhook (optional upgrade)** — Kometa's `run_start`/`run_end`/`error`/`changes` webhooks
  are OUTBOUND-only; pointing `run_end`/`error` at an hnet endpoint would give the app a run-state
  readback without polling (research §3.7, §6.4). Deferred — Job status + meta.log is enough for v1.
- **Run-now** — a bounded `kubectl create job --from=cronjob/kometa-collections … -- --run --run-files
  "hnet-managed-movies.yml"` (the dev-env SA holds job-create per the pod capabilities memo) lets a
  `manage` user trigger an immediate scoped run of ONLY the managed file after an approval, shortening
  the latency (D-02) without waiting for 06:30. Scoped to the managed file so it can never re-run the
  owner's heavy overlay/operation passes.

**What Kometa CANNOT give** (say so in the UI): live progress, a per-collection result API, or any state
change without starting a process. The monitor is "last run + logs + did-it-fail", not a progress bar.

### D-09 — Validation strategy (a bad recipe can break the whole run)

A malformed managed file can fail the entire Kometa run (all collections), so validation is layered:

- **Compose-time** — the recipe model is a closed schema (D-05); ref structural validation + resolve
  preview (D-04) catches wrong ids/URLs before a row is even written.
- **CI gate (the hard gate)** — the haynes-ops PR runs `--validate-file hnet-managed-*.yml` against the
  PINNED image (v2.4.4). `--validate-file`/`--validate-dir` validate ONE generated file against its
  JSON schema, exit 0/1 (research §2). A red gate blocks merge — a bad recipe never reaches the pod.
  Alternatively (or additionally) the JSON schemas Kometa ships (`json-schema/`) can validate app-side
  before the PR (Q-06 on which, and on `--validate-file`'s connectivity needs at syntax/structure
  level — an UNVERIFIED from the research; canary first).
- **Blast-radius rules (never touch what the owner depends on):**
  - The app writes ONLY `hnet-managed-*.yml`; it never reads, edits, or regenerates a hand-written
    sibling file. The owner's charts/franchises/people/lists are out of the write surface entirely.
  - Namespaced titles (D-03) guarantee no collision-merge into a sibling collection.
  - `acquisitionEnabled` defaults false and is `acquire`-gated (D-06) — the storage blast radius is
    off by default.
  - Run-now is scoped to the managed file (D-08) — an app-triggered run can never re-run the heavy
    overlay/operation passes.
  - Orphan cleanup on delete is `manage`-gated and canary-verified (D-03), never automatic.

## Sequencing + risk (phases) — REVISED 2026-07-18 (maps to PLAN-052 PR4b/PR4c)

> **REVISED (ADR-072).** The old Phase 1 (inert suggestions) is deleted with the suggestion model.
> The Kometa write path builds as:

1. **Phase 0 — read-only monitor.** Surface Kometa's honest run-state (Job status + meta.log link,
   D-08) on the Movies/TV `/collections` sub-sections, beside the existing mirror. No write path.
2. **Phase 1 (PR4b) — direct-add + auto-merge (grouping-only).** The composer writes directly; a
   within-cap grouping-only add regenerates the managed include, opens a bot PR, and **auto-merges**
   after `--validate-file` green (D-07/D-10); the mirror reconciles the produced collection to `live`.
   Over-cap routes to a `collection_override` ticket (DESIGN-043 D-11) whose materialization is
   human-merged. Acquisition stays OFF — the storage blast radius is dark.
3. **Phase 2 (PR4c) — find-missing (gated + human-merged).** The `find_missing` grant + the
   per-collection knob (`radarr_add_missing`/`sonarr_add_missing`), enabled only by a granted role via
   the self-serve `/admin` grid (D-06/D-14). Enabling it opens a HUMAN-merged PR. This is the "ton of
   content" surface and lands last, behind the grant, after Phase 1 has proven the pipeline safe.

Risk register: the async latency (D-02) is a UX-honesty risk, not a safety one — say it plainly. The
orphan-on-remove and `--validate-file` connectivity items are UNVERIFIED (research §"Open") — canary
before relying. The **auto-merge** (D-10) is the sharpest new automation — bounded to within-cap,
grouping-only, managed-file-only, CI-green (ADR-072 C-06); a canary flag is the safe rollout.

## Alternatives considered

- **PVC writes to the managed file** — rejected: the collection files are the git ConfigMap, not the
  PVC; the only PVC file (`config.yml`) is self-rewritten by Kometa and races app writes (D-02, ADR-069).
- **Raw-YAML passthrough ("advanced mode")** — rejected (ADR-069): unbounded blast radius, exposes the
  full churning builder taxonomy, defeats validation. The allowlist + validated ref is the whole point
  of R1 (KISS).
- **App-native collection authoring (write Plex directly)** — rejected permanently by ADR-064 (the
  mirror-only doctrine): the app writes a Kometa recipe, Kometa owns the collection.
- **Exposing `tmdb_discover` / `imdb_search` to members** — rejected v1: they are query/search objects
  (the tuned acquisition engines behind the 2023 flood), not refs; owner-authored only (D-04).
- **Auto-applying Defaults `template_variables`** — deferred (PLAN-052): they live on the self-rewritten
  PVC `config.yml` and need a re-seed; a "PR + re-seed" owner operation, not a member lever.
- **A live Kometa progress UI** — impossible: Kometa has no inbound API/daemon (D-08). The monitor is
  last-run + logs, honestly.

## Test strategy

- **Domain (packages/domain)** — the recipe compiler is a pure function: allowlisted builder + validated
  ref → the expected `collections:` YAML entry; `acquisitionEnabled: false` emits `radarr_add_missing:
  false`; a non-allowlisted builder or an unvalidated ref REJECTS; global `id` uniqueness bites; title
  namespacing applied. Suggestion lifecycle: row + audit in ONE tx before any external call (the
  DESIGN-033 atomicity test); approve-with-acquisition without the `acquire` grant REJECTS.
- **Grant gate (packages/api)** — `collectionActionProcedure` matrix: no grant ⇒ FORBIDDEN;
  `suggest` can create but not approve; `manage` can approve grouping-only but not enable acquisition;
  `acquire` can; admin bypasses; every mutation writes `permission_audit`.
- **Validation** — a malformed generated file fails `--validate-file` (fixture against the pinned
  schema); a valid one passes; the CI gate blocks a red PR (the flow, mocked git).
- **Mirror reconcile (packages/sync)** — a produced managed collection appears in `collections-sync`
  with `provenance: kometa` and reconciles its suggestion to `live` (extends the DESIGN-035 battery).
- **e2e (advisory)** — suggest → (manager) approve grouping-only → PR opened (stub git) → mirrored →
  card appears on the Collections wall with the provenance badge; no-grant ⇒ no affordance
  (server-enforced); ADR-015 no-reflow across the suggestion state flips.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | **Write-path merge ruling:** does a config PR merge by a HUMAN or app-armed auto-merge after `--validate-file` green? | **RESOLVED 2026-07-18 (ADR-072, owner ruling): AUTO-MERGE the safe case** — within-cap, grouping-only (find-missing OFF), managed-file-only, `--validate-file` green (D-10). Over-cap materializations and find-missing enables stay HUMAN-merged. |
| Q-02 | **Which builder types are member-suggestible v1?** Proposed: the six single-ref types (`imdb_list`, `tmdb_collection_details`, `tvdb_list_details`, `tmdb_movie`, `tmdb_show`, `tvdb_show`); owner-only for `tmdb_discover`/`imdb_chart`/`imdb_search`/`plex_all`. | OPEN — owner ruling. The list is derived from the live config (D-04); owner confirms the cut. |
| Q-03 | **Approval SLA / notification:** how is a member told their suggestion was approved/rejected/went live? A Ticket? The `notification_outbox` email channel (T-173)? In-app only? | OPEN — owner ruling. The outbox email channel + notification-preference machinery already exists (T-173/T-174) and is the cheap reuse. |
| Q-04 | **Grant rollout:** which roles get `suggest` / `manage` / `acquire`, and when? | OPEN — owner ruling. Ships Admin-only (empty grants, DESIGN-033 default). Natural path: `suggest` to members early, `manage` to trusted roles, `acquire` owner-held long-term (the storage blast radius). |
| Q-05 | **Namespacing + live-reconcile marker:** the exact convention that (a) prevents title collision with sibling files and (b) lets `collections-sync` match a produced collection back to its suggestion. A title prefix? A recipe-id marker (the Libretto `[libretto:<id>]` idiom, but Kometa collections carry no app-writable description the sync reads today — the DESIGN-035 provenance is a Plex LABEL). | **RESOLVED-AT-BUILD 2026-07-18 (PR4b): the label option.** The compiler stamps every managed collection with a reserved `HNet Managed` Plex label (`HNET_MANAGED_LABEL`), added to `deriveCollectionCategory`'s reserved set so it never becomes a category chip and never uglifies the display title. Live-reconcile is BY NORMALIZED TITLE (the mirror row's `created_by: kometa` + a title match → `live`; else `pending_run`) — no `collections-sync` change. A finer label→recipe-id sync join stays deferred (a sync dependency; the title match is honest enough for v1). |
| Q-06 | **Ref-preview data source + egress:** resolving a TMDb collection id → name/count is a TMDb call (already a Kometa connector); resolving an IMDb/TVDb list URL → title/count needs a data source and an egress-allowlist entry (CiliumNetworkPolicy `dev-env`). Which source, and add the allowlist via a haynes-ops PR? | **RESOLVED-AT-BUILD 2026-07-18 (PR4b): canary-first, NO new egress.** `previewKometaRef` makes NO network call: an id-list builder (tmdb_movie/tmdb_show/tvdb_show) previews its exact count (the app knows it); a URL/collection-id builder renders an honest "preview unavailable for this ref type" note. Consequently the size cap can only be PROVEN for id-list builders — a non-admin URL/collection-id add is treated as over-cap (routes to the ticket, human-merged) rather than auto-merged. A TMDb/IMDb/TVDb resolve behind a new egress allowlist entry is a follow-up (Q-NN), not a proxy workaround. `--validate-file` connectivity remains UNVERIFIED — canary before relying on auto-merge. |
| Q-07 | **Do Kometa suggestions create Radarr/Sonarr wants at all in v1, or grouping-only first?** The "ton of content" risk. | OPEN — owner ruling. Design sequences acquisition to Phase 3 (grouping-only through Phase 2); the safe default is grouping-only until the pipeline is proven. |
| Q-08 | **TV `plex_all`/regex and Defaults toggling** — out of the member surface, but is an owner-only advanced managed surface wanted later, or do these stay hand-authored in haynes-ops? | DEFERRED. Hand-authored today; a later owner-only advanced surface is possible but out of this design's KISS scope (R1). |
