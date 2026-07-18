# Design Spike — Label-driven collection classifier (Movies/TV + Books)

- **Date:** 2026-07-17
- **Type:** Research + design spike (NO production changes made — no Kometa config edits, no
  Kometa run, no PR merges). Owner-ready plan.
- **Supersedes (proposed):** DESIGN-035 **D-10/D-11** (the title-only `classifyCollectionType`
  annotation + Type chip). Touches glossary **T-186**, PRD **R-214**, enum `COLLECTION_TYPES`.
- **Author of prior groundwork:** `2026-07-16-kometa-integration-research.md` (this builds on it).

## The ask (owner directive)

Replace the title-only movie/TV collection classifier with a **label-driven** one. The owner labels
every collection deliberately; those labels become the actual filter chips on the Collections view
for BOTH Movies and TV walls. Mirror the same idea for BOOK collections (Libretto/Kavita/ABS). The
app should just mirror labels we own — no title guessing.

Owner taxonomy (authoritative):

- **Universe** = a broad shared world, ORDER-AGNOSTIC, umbrella-ing MULTIPLE sub-series
  (Wizarding World = Harry Potter + Fantastic Beasts; MCU; Middle Earth; Monsterverse; DCEU; X-Men;
  Alien/Predator; …).
- **Sequels** = a SINGLE ORDERED film line (Harry Potter's 8 films; Fantastic Beasts; Toy Story;
  Back to the Future; Ocean's; John Wick; Mission: Impossible). A trilogy is just a short Sequels
  line — **the old `trilogy` bucket folds into Sequels.**
- A collection carries **EXACTLY ONE** label. A film may sit in a Universe collection AND a Sequels
  collection (HP films are in both "Harry Potter" Sequels and "Wizarding World" Universe). Universe
  and Sequels overlap in membership, never in labeling.
- Non-franchise categories: Director, Actor, List, and any others the labeling agent coins.
  (REVISION 2, owner review: categories are DYNAMIC/open, NOT a fixed enum, and there is NO "Other"
  catch-all — see §2. Everything is deliberately labeled, so the chip set = whatever labels exist.)

---

## 1. The Kometa labeling mechanism (the load-bearing unknown — RESOLVED)

Kometa's public wiki host (`kometa.wiki` / `metamanager.wiki`) is **DNS-blocked** by the dev-env
egress allowlist (`getaddrinfo EREFUSED`). The docs were confirmed instead from the **wiki source
markdown on GitHub** (`raw.githubusercontent.com/Kometa-Team/Kometa/...`, which IS reachable) plus
the live config in `haynes-ops` (`kubernetes/main/apps/media/kometa/app/`). If a future task needs
the rendered wiki, propose adding `kometa.wiki` to the CiliumNetworkPolicy `dev-env` allowlist via a
haynes-ops PR — do not look for a workaround.

### 1a. Custom label on a HAND-AUTHORED collection definition — CONFIRMED, exact YAML

The collection-object metadata edit attribute is **`label`** (documented in
`docs/files/updates.md`, "Collection/Playlist Metadata Updates"):

| attribute | behaviour |
|---|---|
| `label` | **Appends** new labels. Value: comma-separated string (or YAML list) of labels. |
| `label.sync` | **Replaces ALL** labels on the collection with exactly the provided set (blank = strip all). |
| `label.remove` | Removes only the named labels. |

This attribute writes to the **COLLECTION object's own labels** — exactly what the app reads today
via `readCollectionLabels(collection.ratingKey)` = `GET /library/metadata/{ratingKey}?includeLabels=1`
(`packages/plex/src/read.ts:266`). So a label we append here lands in precisely the field the app
already fetches. Exact YAML (any of the hand-authored `config/git/*.yml` definitions):

```yaml
collections:
  Harry Potter:
    tmdb_collection_details: 1241
    label: Sequels            # APPEND — lands alongside Kometa's managed "Kometa" label
  Wizarding World:
    imdb_list: https://www.imdb.com/list/...
    label: Universe
```

Because each hand-authored file already routes definitions through a `templates:` block
(`Movies`, `Director`, `Actor`, `Studio`, `Shows`), the label can be set **per template** for the
bulk and overridden per collection where needed, e.g. in `movies-people.yml`:

```yaml
templates:
  Director:
    # ...existing...
    label: Director
  Actor:
    # ...existing...
    label: Actor
```

### 1b. Custom label on a DEFAULT-produced collection — the hard constraint (OWNER DECISION)

**There is NO shared template variable to blanket-label a Default's collections.** Verified against
the canonical shared-collection-variables snippet
(`docs/templates/defaults/base/collection/shared.md` — 74 variables: `collection_mode`,
`collection_section`, `file_poster`, `hub_priority`, `item_radarr_tag`, `minimum_items`, `name`,
`order`, `radarr_*`, `schedule`, `sonarr_*`, `sort_title`, `visible_*` … **and no `label`**). The
`franchise` Default is even more restricted — its doc explicitly includes
`no_shared_variables.md` ("Shared Template Variables are NOT available to this Defaults File"); it
accepts only `franchise|arr|addons|addons-extra|exclude|sync_mode|collection_mode|collection_order`.
`universe` DOES take the shared set, but that set still has no `label`.

So the estate's Default-produced collections **cannot be labeled from config via template variables**:

- `universe` Default (config.yml) — a small, fixed, named set (MCU, DCEU, Wizarding World, Middle
  Earth, Fast & Furious, Rocky/Creed, …). All are **Universe**.
- `franchise` Default (~168 auto-discovered TMDb Collections — Dune, Mission: Impossible, The
  Bourne, …). Each is an ordered film line ⇒ all are **Sequels**.
- `seasonal` / `oscars` / `golden` Defaults — all are **List**.

…BUT a **companion metadata file that appends a `label:` to an existing Default collection BY NAME —
without re-authoring its builder — IS supported. This is the confirmed linchpin.** Verified from the
Kometa SOURCE (`modules/builder.py`, since the wiki host is egress-blocked):

- The "no builders" error is: `if not self.server_preroll and not self.smart_url and not
  self.blank_collection and len(self.builders) == 0: raise BuilderValidationError("No builders were
  found")`. So a definition with **`blank_collection: true`** and NO builder is a VALID config
  (`blank_collection` is one of the three escapes; it is also mutually exclusive with builders —
  `if self.blank_collection and len(self.builders) > 0: raise`).
- Kometa looks up the existing collection by name BEFORE any build:
  `self.obj = self.library.get_collection(self.name, force_search=True)` — so a companion definition
  keyed by the Default collection's exact name resolves onto the SAME Plex collection object, and
  `update_details` (which applies the `label` **append** edit from `updates.md`) runs on it.
- Kometa **forces append, never remove, in edit-only mode**: the source warns "sync Mode can only be
  append when using build_collection: false" — i.e. these no-build edit definitions do not strip
  members. `blank_collection` carries no builder output, so there is nothing to reconcile-remove.
- **The estate already relies on the same-name compose pattern:** `movies-franchises.yml`'s header
  documents that a curated file and the franchise Default sharing an EXACT name "resolve to ONE Plex
  collection with the curated file (loaded last) winning" — proof that a later file editing a
  Default-built collection by name composes cleanly on this deployment.

**So the mechanism to hit the owner's "label everything ourselves" goal is a GENERATED companion file**
an Opus agent produces — one entry per Default collection, title → our category label:

```yaml
# movies-default-labels.yml  (generated: collection title -> our category label)
collections:
  The Bourne Collection:
    blank_collection: true      # no builder; only edits the existing collection
    label: Sequels              # APPEND — lands beside Kometa's managed "Kometa" label
  Mission: Impossible Collection:
    blank_collection: true
    label: Sequels
  Wizarding World:
    blank_collection: true
    label: Universe
  # …one line-triple per Default-produced collection the agent labels
```

Load it LAST in each library's `collection_files` (after the Default + curated files) so the target
collections already exist when it runs. `label:` is append + idempotent, so re-runs are no-ops and
Kometa's `Kometa` provenance label survives.

> **ONE residual to confirm in a Kometa DRY-RUN before the 168-collection rollout** (design-only now,
> so not executed): that `blank_collection: true` on an ALREADY-POPULATED collection appends the label
> WITHOUT emptying it. The source (edit-mode forces append; blank_collection has no builder to
> reconcile) and the estate's proven same-name compose pattern both indicate it is safe, but verify on
> ONE test collection (`--collection "The Bourne Collection"` against a scratch label) first. If the
> dry-run surprises us, fall back to the app-side derive below.

**Fallback if the companion append disappoints (NOT preferred, but zero-Kometa-change):** the estate's
Default collections ALREADY carry Kometa's own auto-applied CATEGORY labels — the provenance research
(`collection-provenance.ts:11-13`) records that the mirror sees secondary labels like
`Universe Collections`, `TMDb Collections`, and awards groupings on these collections. The app's
`deriveCollectionCategory` (see §3) can map those directly (`Universe Collections` → `Universe`,
`TMDb Collections` → `Sequels`, awards → `List`). This needs no Kometa edit at all, but it leans on
Kometa's naming rather than a label WE chose — hence the companion file is strongly preferred for the
"deliberate, owned label" goal.

### 1c. Label SYNC semantics / provenance safety

- Use **`label:` (append) ONLY. NEVER `label.sync`** in a definition — `label.sync` replaces the
  full label set and would **strip the `Kometa` managed label** the app's provenance derivation
  relies on (`derivePlexCollectionProvenance`, `collection-provenance.ts:52`). `label:` (append) adds
  our category alongside `Kometa`; both coexist. This is codified in the CLAUDE.md rule (§5).
- Kometa auto-applies the `Kometa` managed label to every collection it builds (that is how
  `show_unmanaged` distinguishes managed vs hand-made — confirmed in the wiki). Appending our label
  does not disturb it.
- `label:` is **idempotent** — re-appending an already-present label each run is a no-op. No conflict.
- Kometa's `settings.sync_mode: sync` (live in config.yml) governs **collection MEMBERSHIP**, not the
  collection's own labels — it does not remove our appended label.

### 1d. Trigger a Kometa run on demand + surface the labels

- The Kometa `collections` cronjob runs `--run --collections-only` daily at **06:30
  America/New_York** (`helmrelease.yaml`, `concurrencyPolicy: Forbid`). Collection files mount live
  from the git ConfigMap `kometa-config-files` (`/config/git`, `configMapGenerator` in
  `kustomization.yaml`) — a merged config change is live on the next run with no image rebuild.
- **On-demand:** `kubectl create job kometa-labels-$(date +%s) --from=cronjob/kometa-collections`
  (the dev-env kubectl SA has scoped `job create` per the pod-capabilities memo). A **collections-only**
  run is the bounded cadence the 3-way split was designed around (the day-long monolith was the
  overlay/operations passes) — expect **minutes to low tens of minutes**, not hours.
- **Then surface in the app:** run the app's **`collections-sync`** mode
  (`packages/sync` → `syncPlexCollections`). NOTE: `collections-sync` is a **standalone mode NOT
  currently on a scheduled CronJob** in the haynes-ops snapshot (DESIGN-035 D-02 said "the CronJob
  lands in haynes-ops later"; the deployed `haynesnetwork` helmrelease has no `--mode=collections-sync`
  entry, and `full` does not orchestrate it — `orchestrator.ts:349`). Today it is run on demand
  (`--mode=collections-sync`). **Add a CronJob for it** as part of this work (see §6) so labels
  refresh automatically after each 06:30 Kometa run — e.g. daily at 07:00.

---

## 2. The category model — DYNAMIC, open, no enum, no "Other"

**Owner correction (2026-07-17): chips are DYNAMIC, derived from the labels actually present — NOT a
fixed CHECK-enum, and there is NO "Other" bucket.** Because an Opus labeling agent labels EVERY
collection deliberately (per the Universe/Sequels definitions plus whatever categories fit — Director,
Actor, List, and any new one the agent coins), there is no unlabeled residue, so no catch-all.

- **Storage becomes a free-form `category` string** on the collection row (rename the
  `collection_type` column → `category`, drop its CHECK). It is still a rebuildable derived annotation
  recomputed every sync — so **NO enum, NO CHECK, NO migration churn**: a brand-new label the agent
  invents simply appears as a new stored category on the next sync, and a new chip appears with it.
- **`deriveCollectionCategory(labels)`** picks OUR category off the present labels. Since a collection
  carries exactly one owner-category label (Universe | Sequels | Director | Actor | List | …) plus
  Kometa's provenance/section labels, the derive returns the first label that is NOT a reserved
  system label (the `Kometa` provenance label + Kometa's section labels like `Universe Collections` /
  `TMDb Collections` are on a small IGNORE list; everything else is treated as an owner category).
  `labels === null` (read failed) → `null` (preserve prior). If — against the everything-is-labeled
  promise — a collection has no owner label, it derives `null` and simply contributes NO chip and
  shows under "All" (no fake "Other").
- **The chip row = the DISTINCT set of categories actually present** (per wall). A new label yields a
  new chip automatically, zero migration. **Display ordering:** a small ordered HINT list pins the
  familiar ones first — `['Universe','Sequels','Director','Actor','List']` — and any category present
  but not in the hint list is appended **alphabetically** after them. So known categories stay in a
  stable, sensible order and novel ones are deterministic, never random.

The definitions the labeling agent uses (Universe = order-agnostic shared world umbrella-ing multiple
sub-series; Sequels = a single ordered line; a title may be in both a Universe collection and a
Sequels collection) are the owner-confirmed INPUT to labeling — they are guidance for the agent, not a
CHECK-enum in the database. This is the one thing the owner still ratifies (see decisions).

---

## 3. App rewire design (SUPERSEDES DESIGN-035 D-10/D-11) — docs-first

Everything below keeps the classifier a **pure, rebuildable derived annotation recomputed each
sync** (no new mutable state, no per-row backfill) — the D-10 idiom, just driven by labels.

### D-10′ — derive an OPEN category string from LABELS, not title

- **New pure fn** in `packages/domain/src/collection-type.ts` (rename file → `collection-category.ts`):
  `deriveCollectionCategory(labels: readonly string[] | null): string | null`
  — normalize each label (trim; keep display case for storage, match the ignore-list
  case-insensitively); return the FIRST label not on the reserved IGNORE list
  (`Kometa` + Kometa's section labels `Universe Collections` / `TMDb Collections` / awards groupings);
  no owner label → `null`; **`labels === null` (read failed) → `null`** (preserve prior — symmetric
  with `derivePlexCollectionProvenance`). No vocabulary map, no `'other'` — the returned string IS the
  category (free-form).
- **Retire** `classifyCollectionType(title)` and its entire title-idiom apparatus: `TRILOGY_RE`,
  `FRANCHISE_COLLECTION_RE`, `SAGA_RE`, `UNIVERSE_RE`, `UNIVERSE_NAMES`, `DIRECTOR_NAMES`,
  `ACTOR_NAMES`, `CHART_RES`, `SEASONAL_RES`, `AWARD_RES`. Bump `COLLECTION_CLASSIFIER_VERSION` → 2.
- The empty "Trilogies" matcher and the TV trilogy-hide special-case are deleted.

### Column rename — open text, NO enum, NO CHECK migration

- `plex_collections.collection_type` (text + CHECK, migration 0055) → **`category text` (nullable, NO
  CHECK)**. A one-shot migration renames the column and DROPS the CHECK constraint — no value backfill
  (it re-derives on the next sync). `COLLECTION_TYPES` enum + `CollectionType` type are **removed**
  from `@hnet/db`; downstream references become `string | null`. (Same treatment as `created_by`,
  which is already open text for exactly this "vocabulary we don't fully own up front" reason — here
  it's a vocabulary that GROWS.)

### Thread labels through the sync (symmetry with provenance)

- The fetcher `packages/sync/src/plex-collections.ts` **already reads every label** (line ~117-119,
  `readCollectionLabels`) then derives only `createdBy` and **discards the raw labels**. Change: also
  compute `category = deriveCollectionCategory(labels)` and pass it on `PlexCollectionSyncInput`
  (beside `createdBy`). One-line addition; the per-collection label read already happens — **zero new
  Plex I/O.**
- The domain writer `packages/domain/src/plex-collections.ts` **line 92** currently does
  `collectionType: classifyCollectionType(collection.title)` → change to `category:
  collection.category`, and in `onConflictDoUpdate.set` (**line 105**) use
  `COALESCE(excluded.category, ${plexCollections.category})` so a `null` (failed read) PRESERVES the
  prior category — exactly the `createdBy` pattern (line 108).
- `PlexCollectionSyncInput` gains `category: string | null`.

### Chips (DYNAMIC, both walls, identical)

- **The chip vocabulary is no longer a static registry constant.** Delete `COLLECTION_TYPE_OPTIONS`
  and `collectionTypeOptionsForWall` from `library-view-registry.ts`. The Type facet
  (`COLLECTION_TYPE_FACET` on `movies:grouped-collection` / `tv:grouped-collection`) stays, but its
  OPTIONS are supplied at request time from data.
- `ledger.collectionGroups` (`@hnet/api`) already returns per-card `type` + `typeCounts`; rename to
  `category` + `categoryCounts` where `categoryCounts` is the DISTINCT set of categories present
  (with counts) among the accessible collections of the wall. The client renders one chip per key,
  ordered by the hint list `['Universe','Sequels','Director','Actor','List']` then alphabetical for
  anything else (§2). No 0-count phantom chips — only present categories show.
- Applies to BOTH walls identically (no trilogy special-case).

### Docs-first companions

- Update glossary **T-186** (label-driven, OPEN dynamic category — no closed bucket list),
  **PRD R-214**, and rewrite **DESIGN-035 D-10/D-11** as D-10′/D-11′. Per house rules DESIGN-035 is
  amended in the same change; a cleaner break is a new **DESIGN-0NN "Label-driven dynamic collection
  categories"** superseding D-10/D-11, cited from T-186/R-214. (No new ADR — refines ADR-064's
  read-model annotation, the ADR-039-refines-ADR-037 precedent DESIGN-035 already invokes.)

---

## 4. Libretto / books mirror design

Book collections are built by **Libretto** (the "Kometa for books") and mirrored into
`books_collections` (`packages/db/src/schema/books-collections.ts`) by `books-collections-sync` —
**NOT via Plex/Kometa**. Kavita/ABS collections carry no Plex labels, so the movie label pathway does
not apply. The parallel is the existing **provenance marker** idiom: Libretto plants
`[libretto:<recipeId>]` in the collection description (`collection-provenance.ts:36`,
`deriveBooksCollectionProvenance`), and the app parses it. Two clean placements (owner picks):

The books category is **DYNAMIC too** — the labeling agent sets a free-form `category` on each
Libretto recipe (same open model as movies/TV; whatever categories fit — Series, Award, List, or a
new one), and the books filter shows **whatever categories exist**, dynamically. Two placements:

- **Option L1 (Libretto-side, mirror-pure — matches doctrine R1):** the Libretto **recipe** gains a
  free-form `category` string; Libretto writes it into the SAME description marker, e.g.
  `[libretto:<recipeId>|cat=Series]`. The app extends `LIBRETTO_MARKER_RE` to capture the category and
  stores it on `books_collections.category` (open text) at sync. The mirror stays a mirror — nothing
  invented app-side. Requires a small Libretto change (recipe schema + description writer).
- **Option L2 (app-side):** add a `category text` column to `books_collections`, set by the app's own
  `/integrations/collections` composer
  (`apps/web/app/(app)/integrations/collections/collections-client.tsx`) when a recipe is authored.
  The composer already owns `COLLECTION_BUILDER_TYPES`
  (`static_ids | hardcover_series | nyt_list | wikidata_award`, `enums.ts:814`), so a SUGGESTED
  default (`hardcover_series → Series`, `wikidata_award → Award`, `nyt_list/static_ids → List`) can
  pre-fill a **free-text** category field the agent/owner overrides. Faster (no Libretto change) but
  the category is app-state, not in the source.

The suggested builder→category defaults are a convenience only — the field is **free-form**, so the
agent can coin any category and it becomes a chip. There is no fixed enum and no "Other".

**Split of responsibility:** Libretto-side = writing the category (L1) or nothing (L2); app-side =
the `books_collections.category` open column, the DYNAMIC chip row (distinct categories present),
and wiring the Type facet onto the books Collections grouped levels (`books:grouped-collection`,
`audiobooks:grouped-collection`, `comics:grouped-collection` — today they carry **no facets**, the
documented "honest gap"). The `books.groups` read returns `categoryCounts` exactly like
`ledger.collectionGroups`, and the same hint-list-then-alphabetical ordering applies.

> **Recommendation:** L1 if Libretto is easy to change (mirror-pure, symmetric with the provenance
> marker); otherwise L2 (the composer is already app-owned). Either way the chips are dynamic and
> app-rendered.

---

## 5. CLAUDE.md rule for the Kometa app (haynes-ops) — draft

Add to `kubernetes/main/apps/media/kometa/app/` guidance (or the repo's Kometa section):

```markdown
## Collection labels are the app's chip source of truth (haynesnetwork)

Every collection (hand-authored AND Default-produced) MUST carry exactly ONE deliberate
owner-category label via the `label:` (append) attribute. Categories are OPEN (the app derives the
chip from whatever label is present — no fixed enum), but use these CORE definitions:

  Universe | Sequels | Director | Actor | List | (coin a new one only when none fits)

- Universe = an order-agnostic shared world umbrella-ing multiple sub-series (Wizarding World, MCU,
  Middle Earth, Monsterverse, DCEU, X-Men, Alien/Predator).
- Sequels = a single ordered film/show line (Harry Potter, Toy Story, Mission: Impossible, a trilogy).
- Director / Actor = the people-file collections.
- List = charts, awards, seasonal, studio, curated lists.
- A collection carries EXACTLY ONE owner-category label. A title may live in both a Universe
  collection and a Sequels collection — that is membership overlap, never a second label on one
  collection.

Rules:
1. Use `label:` (APPEND). NEVER `label.sync` or `label.remove` — `label.sync` strips the `Kometa`
   managed label the haynesnetwork app reads for provenance.
2. Set the label per-`templates:` block where a file's collections share a category (people →
   Director/Actor), else per collection.
3. Hand-authored definitions set `label:` inline. Default-produced collections
   (`default: franchise|universe|seasonal|oscars|golden`) — which CANNOT take a `label` template
   variable — are labeled by the GENERATED companion file `movies-default-labels.yml`
   (title → `blank_collection: true` + `label:`), loaded LAST. Every Default collection MUST have a
   companion entry. Adding a new Default REQUIRES adding its collections to the companion file.
4. Categories are OPEN — a new `label:` string becomes a new filter chip automatically. There is NO
   "Other" bucket: because everything is labeled, there is no unlabeled residue. An unlabeled
   collection (a slip) simply shows under "All" and contributes no chip — fix it by labeling it.
```

---

## 6. Phased plan + open questions

> **NOTE (revision 2):** the owner corrections made the closed-vocabulary framing below OBSOLETE.
> The authoritative decisions + phases are **"Updated owner decisions" + "Updated phased plan"** at
> the END of this doc. This §6 is kept for the labeling-pass sizing only; where it says "enum" /
> "ratify vocabulary" / "re-author universe file", read the dynamic-category + companion-file model
> from §1b/§2/§3 instead.

### Labeling-pass sizing (still accurate)
- **Hand-authored definitions** get `label:` inline — count is small and known: ~24 franchise/universe
  entries in `movies-franchises.yml`, ~20 directors + ~65 actors (many commented) in
  `movies-people.yml`, a handful of studio/genre in `movies-lists.yml`, ~16 in `shows-franchises.yml`,
  a few charts/audio in the collections/charts files. Realistically **~60–90 hand-authored
  definitions**, most via 5–6 `templates:`-block edits.
- **The ~168 Default-produced collections** get labeled by the GENERATED `movies-default-labels.yml`
  companion (title → `blank_collection` + `label:`) — the Opus agent produces it; no per-definition
  hand-editing (§1b). This is the labeling "pass" the owner asked about: one generated file.
- Merge → next 06:30 collections run applies labels (or trigger on demand per §1d), then the
  `collections-sync` mode surfaces them (add its CronJob — §1d).

### Risks / notes
- **Provenance safety:** the `label:`-append discipline (CLAUDE rule #1) is the guardrail — a stray
  `label.sync` anywhere would strip `Kometa` and misfile every affected collection as hand-made.
- **No "Other" — everything is labeled:** curated/audio/tech collections (Spatial Surround, DTS X)
  get a deliberate category from the labeling agent (e.g. `Audio`, or `List`), same as any other. An
  UNLABELED collection is a labeling slip (fix by labeling it), not a permanent bucket; until fixed it
  shows under "All" and adds no chip.
- **Franchise-Default coverage:** new franchises Kometa auto-discovers must get a companion-file
  entry (the generated `movies-default-labels.yml` is regenerated when the Default set changes — a
  small maintenance step the CLAUDE rule mandates). Until re-generated, a new Default collection is
  unlabeled (shows under "All", no chip) — visible-but-harmless, not misfiled.
- **CronJob gap:** `collections-sync` (and `books-collections-sync`) have no scheduled CronJob in the
  current haynes-ops snapshot; confirm they're wired before relying on automatic label refresh.
- **No blocker hit:** the Kometa per-title append mechanism was confirmed viable from the source (one
  dry-run owed); the remaining items are owner CHOICES (see "Updated owner decisions").

### Files that change (citations — revised for the dynamic model)
- Kometa (haynes-ops): `kubernetes/main/apps/media/kometa/app/config/*.yml` (add `label:` inline),
  NEW generated `config/movies-default-labels.yml` (companion `blank_collection` + `label:` for the
  ~168 Default collections) + `kustomization.yaml` configMap entry + its `collection_files` slot in
  `externalsecret.yaml` (loaded LAST), CLAUDE.md rule.
- App classifier: `packages/domain/src/collection-type.ts` → `collection-category.ts`
  (`deriveCollectionCategory`), `packages/domain/src/index.ts` (`PlexCollectionSyncInput.category`),
  `packages/domain/src/plex-collections.ts:92,105` (use `collection.category`, COALESCE-preserve),
  `packages/sync/src/plex-collections.ts:117-160` (pass labels/category through).
- Column: `packages/db/src/schema/plex-collections.ts` (`collection_type` → `category`, nullable, NO
  CHECK) + a rename/drop-CHECK migration; REMOVE `COLLECTION_TYPES`/`CollectionType` from `enums.ts`.
- Chips (dynamic): `apps/web/lib/library-view-registry.ts` (delete `COLLECTION_TYPE_OPTIONS` +
  `collectionTypeOptionsForWall`; keep the facet, options supplied at request time); `ledger.collectionGroups`
  (`@hnet/api`) returns `category` + `categoryCounts`; client renders one chip per present category,
  hint-list-then-alphabetical.
- Books: `packages/db/src/schema/books-collections.ts` (L2 open `category` col) or
  `packages/domain/src/collection-provenance.ts` (L1 marker parse),
  `apps/web/app/(app)/integrations/collections/collections-client.tsx`, registry books
  grouped-collection rows + `books.groups` `categoryCounts`.
- Deploy: `kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml` (add `collections-sync`
  CronJob).

---

# SCOPE EXTENSION (2026-07-17, owner) — Wanted-tile collections + acquisition, as ONE system

The owner added a major requirement that must ship **as one system** with the label classification
above. It is **additive** — nothing in §1–§6 changes; the classification is the chip layer, this is
the membership + acquisition layer underneath the same Collections view. Still design-only.

The good news from the codebase: **most of the machinery already exists** and this is largely a
WIRING job, not a new engine:

- **Movies/TV wanted model:** `wanted_items` is a VIEW = "a monitored *arr item with nothing on disk"
  (`packages/db/src/schema/wanted-items.ts`; `monitored AND on_disk_file_count = 0`). Kometa's
  acquisition-ON Defaults already run `radarr_add_missing: true` + `radarr_search: true` (config.yml)
  — so the *arr ALREADY monitors + searches the full membership of those collections.
- **Books wanted model:** `book_requests` ledger + the shipped **"Wanted in the Library"** tiles
  (DESIGN-029: unmet `book_requests` render as Wanted tiles on the Books/Audiobooks/Comics walls,
  with the shared `RequestSearchButton` force-search). Libretto recipes already emit **held + a
  `missing[]` split** (DESIGN-037 D-05) and drive acquisition via LazyLibrarian, **paced at
  `ACQUISITION_CAP_PER_RUN` (default 25)**.
- **Role model:** `role_collection_action_grants` with `COLLECTION_ACTIONS = ['suggest','manage',
  'acquire']` (DESIGN-043); `acquire` is a DISTINCT content-pull grant a `manage` role does not
  imply; ships Admin-only. Libretto recipes carry a per-recipe `acquisitionEnabled` toggle (the
  `radarr_add_missing` analog, default OFF) exposed only to `acquire`-granted roles.

So the extension = (7) surface FULL membership incl. not-held as Wanted tiles, (8) route un-held
members into the EXISTING search pipelines, (9) gate creation by the existing grants + add an
admin-only size cap.

## 7. "Wanted-tile" collection display — full membership incl. not-held

Today the collection mirror only knows **on-disk** members: `plex_collection_members` is populated
from the Plex collection's CHILDREN (things actually in Plex), and `books_collection_members` from
the resolved library items. A 3-of-18 franchise therefore shows 3 tiles. The new requirement: show
all 18 — 3 on-disk tiles + 15 **Wanted** tiles. The **new data need is the not-held members**, and
its SOURCE differs per medium:

### Movies/TV — full membership source (OWNER DECISION)

The un-held members are not in Plex, so they are not in `plex_collection_members`. Three ways to get
the full membership (the *arrs are the media source of truth — hard rule 4 — so prefer an *arr/TMDb
source over Plex):

- **Option M-a (recommended — *arr-native collections):** Radarr 4+ natively models **TMDb
  Collections** and can monitor/track ALL their members (held or not). Mirror the *arr collection
  membership: for each mirrored collection, resolve its full member set from Radarr/Sonarr (or from
  the TMDb collection id) and match to `media_items` by external id. Held = `on_disk_file_count > 0`;
  **Wanted = the `wanted_items` view** (monitored, nothing on disk). This reuses the existing wanted
  model verbatim and honors "the *arrs are the source of truth."
- **Option M-b (GitOps lever — per-collection tag):** make Kometa tag every added item with a
  **per-collection** `radarr_tag`/`item_radarr_tag` (today it is the CATEGORY tag
  `"Kometa-Added,FranchiseCollection"`). Then the app joins Radarr monitored items by that tag to get
  full membership. Simple join, but 168 collections = tag sprawl.
- **Option M-c (source-list membership):** store each collection's SOURCE list identity (TMDb
  collection id / imdb_list / chart) on `plex_collections`, resolve full membership from that source,
  match to `media_items`. Most source-accurate; needs a per-collection id captured from Kometa config
  or the Plex collection, plus a TMDb read.

**Data-model shape (any option):** a `held` boolean (or a second `wanted` member class) on the
collection membership so a member row can exist WITHOUT a Plex ratingKey. Concretely: add a nullable
`media_item_id` (the *arr ledger row) alongside the existing Plex `rating_key` on
`plex_collection_members`, and a `held boolean`. The `ledger.collectionGroups` count + the
`?group=` drill predicate (DESIGN-035 D-03/D-04) then union held tiles (via `media_plex_matches`) with
wanted tiles (via `wanted_items`), all still under the ADR-047 access gate. **THE INVARIANT
softens:** a collection with 0 held but N wanted accessible members is NO LONGER dropped (it renders
N Wanted tiles) — this is a deliberate change to DESIGN-035 D-03's "drop empty" rule and needs owner
sign-off (it changes what titles are visible).

### Books — full membership source (already exists, just surface it)

Libretto recipes already produce **held + `missing[]`** (DESIGN-037 D-05, series-completion
semantics). `books-collections-sync` mirrors the collection; extend it to also mirror the `missing[]`
members. Two clean ways to represent the wanted members:

- **Reuse `book_requests` with a new `origin` (recommended):** add `'collection'` to
  `BOOK_REQUEST_ORIGINS` (today `['goodreads','pairing']`). A recipe's `missing[]` member mints a
  `book_requests` row (origin `collection`, linking the recipe/collection). The shipped
  **"Wanted in the Library" tiles + force-search** (DESIGN-029) then light up on the collection drill
  for FREE — same tiles, same button, same lifecycle. This is the tightest reuse.
- **Or a `held`/`wanted` flag on `books_collection_members`:** mirror missing members as rows with
  `books_item_id = null` + a `wanted` marker; the drill renders them as Wanted tiles. Keeps
  membership self-contained but doesn't reuse the request lifecycle.

> **Recommendation:** Movies/TV → **M-a** (*arr-native, reuses `wanted_items`); Books → **reuse
> `book_requests` origin `collection`** (reuses the DESIGN-029 Wanted tiles + force-search). Both keep
> the app a mirror + reuse the existing wanted model — no parallel acquisition ledger.

## 8. Missing member → Wanted → searched via EXISTING configs

No new acquisition engine — ride what is already deployed:

- **Movies/TV:** the acquisition-ON Kometa Defaults already carry `radarr_add_missing: true` +
  `radarr_search: true` (universe/seasonal/oscars/golden) — so a missing collection member is ALREADY
  added to Radarr as monitored and searched, under the theatrical-window guard
  (`radarr_availability: released`). The franchise Default is currently `radarr_add_missing: false`
  (tag-only, to avoid a 168-collection runaway). **Flow:** collection membership (via §7 M-a) →
  un-held members = `wanted_items` → Radarr's own monitored search (automatic) + the app's existing
  **force-search** on a Wanted tile (the *arr search-only action). Turning acquisition ON for a
  hand-authored collection is just its Kometa `radarr_add_missing`/`sonarr_add_missing` knob — the
  role/cap fence in §9 governs WHO may flip it and HOW BIG.
- **Books:** Libretto's `acquisitionEnabled` (per recipe) already pushes `missing[]` to LazyLibrarian,
  paced at `ACQUISITION_CAP_PER_RUN` (25), oldest-first. **Flow:** recipe `missing[]` → `book_requests`
  (origin `collection`) → the existing LazyLibrarian push + the `RequestSearchButton` manual
  force-search. Unchanged pipeline.

The only NEW thing is that the app now DISPLAYS these wanted members on the collection view and
offers the existing force-search from there — the acquisition itself is the deployed pipeline.

## 9. Role-controlled creation + admin-only size cap

### Creation / add — reuse the DESIGN-043 grant model (no new model)

- `suggest` = propose a collection / member (member contribution; writes `collection_suggestions`,
  audited). `manage` = create/edit/delete recipes + apply. `acquire` = flip the content-pull toggle
  (a DISTINCT grant). Ships Admin-only; owner opens per role after review (the books-Fix precedent).
- These already gate the Libretto (books) leg via `collectionActionProcedure('manage'|'acquire')`
  (DESIGN-043). The **Movies/TV (Kometa) leg** joins the SAME router as a second provider
  (`COLLECTION_PROVIDERS` gains `'kometa'`; ADR-070 C-06 — no schema change) — so movies/TV collection
  creation inherits the identical grant gating when that adapter lands. **No new role plumbing.**

### Size cap — owner's exact spec (default 25; lists are admin territory)

Acquisition is now ON, so an unbounded collection could dump hundreds of monitored+searched items.
The fence (owner-specified):

- **Default cap = `25`** on what a **NON-ADMIN** role can create/add (membership count). Rationale:
  covers essentially every franchise/universe/series line; the exception is LISTS.
- **LISTS are the exception** — the owner keeps an IMDb ~top-200 list; those are legitimately larger
  and are **admin territory** (only admins create/enlarge a list-category collection beyond 25).
- **Where stored:** a new **`app_settings`** key `collection_size_cap` (int, default 25), mutated ONLY
  through the audited `setAppSetting` single-writer (`update_app_setting` permission_audit row) —
  **admin-only by construction** (the `space_targets`/`notify_window` precedent). Admins set/override
  it; non-admins can never change it.
- **Where enforced — the creation/add path AND the Wanted-expansion:**
  - **Books (Libretto):** at recipe create/apply (`collectionActionProcedure`) the builder's resolved
    membership size is checked against the cap for non-admins; the per-run `ACQUISITION_CAP_PER_RUN`
    (25) remains the pacing fence on top.
  - **Movies/TV (Kometa manager leg, when the `kometa` provider lands):** the same check at create/add;
    hand-authored config additionally honors the CLAUDE rule (§5 addendum) that an acquisition-ON
    definition sets `limit:` ≤ cap.
  - The check runs where §7's full membership is resolved (so a collection that would EXPAND to > cap
    Wanted tiles is caught at creation, not after it floods Radarr/LazyLibrarian).
- **Admin override:** admins (is_admin ⇒ all `COLLECTION_ACTIONS`) bypass the cap outright.

### Over-cap flow — Modal + auto-ticket (hard rule 8)

When a NON-ADMIN tries to create/add a collection whose membership **exceeds `collection_size_cap`**,
the UI does NOT silently truncate or use `window.confirm`/`ConfirmButton` — it opens a **`@hnet/ui`
`Modal`** (this is an explanatory, multi-field confirm — exactly the hard-rule-8 case that mandates a
Modal, like failsafe restore / Fix). The Modal:

- Explains "This collection is too large ({size} items; the limit is {cap})."
- Offers a primary button **"Request admin override"** that **auto-creates a TICKET** (reuse the
  ADR-050 helpdesk ticket system + its single-writer `createTicket`) so an admin can approve raising
  the cap for this collection.
- **Ticket payload:** `authorUserId` = the requesting user; `title` = "Collection override request:
  {collection/recipe name}"; `category` = a new `'collection_override'` value on `TICKET_CATEGORIES`
  (small CHECK add) — or reuse `'other'` if the owner prefers no schema change; `body` = structured
  fields: requesting user, provider (`kometa`/`libretto`), collection/recipe name, resolved
  membership size, current cap, requested action (raise cap for this collection / grant a one-off).
  The ticket rides the existing `open → in_progress → complete|rejected` state machine; an admin
  completing it performs the override (raise the per-collection limit / bump the global cap via
  `setAppSetting`). No new approval subsystem — it's a ticket.

### CLAUDE.md rule addendum (append to §5)

```markdown
5. Acquisition + size fence (default cap 25, admin-only to change): a definition whose file sets
   `radarr_add_missing`/`sonarr_add_missing` true (acquisition ON) MUST keep resolved membership
   at or below `collection_size_cap` (default 25) unless an admin has signed off a higher bound in
   the PR. LISTS (e.g. an IMDb top-200) are the sanctioned larger exception and are admin-created.
   People collections (Director/Actor) stay `add_missing: false` (tag-only) — never acquire a full
   filmography.
```

## Updated owner decisions (holistic — REPLACES the §6 Q-list)

The vocabulary questions are now **MOOT** — categories are dynamic/open, so there is nothing to
ratify as an enum. What remains:

- **D-A — The labeling-agent definitions.** Confirm the Universe/Sequels (+ Director/Actor/List)
  DEFINITIONS the Opus labeling agent uses (§2). These are guidance, not a schema; the agent may coin
  a new category when none fits. This is the only "vocabulary" input, and it's advisory.
- **D-B — Kometa per-title append mechanism: CONFIRMED viable** (companion `movies-default-labels.yml`
  with `blank_collection: true` + `label:` append). ONE dry-run check owed before the 168-collection
  rollout: `blank_collection` on a populated collection appends without emptying it (§1b). Owner
  action: none — flagged for the implementing PR's dry-run.
- **D-C — Books category placement** — L1 (Libretto writes `cat=` into the marker) vs L2 (app-side
  `books_collections.category` column). Recommended L1 if Libretto is easy to change, else L2.
- **D-D — Movies/TV full-membership source** — **M-a** (*arr-native collections, reuses `wanted_items`)
  vs M-b (per-collection tag) vs M-c (source-list id). Recommended M-a.
- **D-E — "drop-empty" softening** — confirm a 0-held / N-wanted collection SHOULD now render (N Wanted
  tiles) instead of being dropped (DESIGN-035 D-03 change; affects title visibility under the ADR-047
  gate).
- **D-F — Books wanted representation** — reuse `book_requests` origin `'collection'` (recommended) vs
  a `wanted` flag on `books_collection_members`.
- **D-G — Over-cap ticket category** — add a `'collection_override'` `TICKET_CATEGORIES` value (small
  CHECK add) vs reuse `'other'`. Recommended: the dedicated value (clean board filtering).
- **D-H — Acquisition default posture** — NEW collections default acquisition OFF (owner opts in per
  collection via the `acquire` grant + Kometa knob), matching Libretto's `acquisitionEnabled: false`.
  Recommended YES (safe default; acquisition is explicit, granted, capped).

(The cap number is NOT an open question — the owner fixed it: **25**, lists are the admin-only
exception.)

## Updated phased plan (holistic)

- **Phase 1 (haynes-ops Kometa PR):** add `label:` to every hand-authored definition + the GENERATED
  `movies-default-labels.yml` companion (Opus-agent-produced title→label for the ~168 Default
  collections, `blank_collection` append) + the CLAUDE label/size rules. Includes the one-collection
  dry-run (D-B) before the full companion file lands. Decide per-collection `radarr_tag` only if
  D-D = M-b.
- **Phase 2 (app classification PR):** open `category` column (rename, drop CHECK, no backfill),
  `deriveCollectionCategory`, retire the title classifier, DYNAMIC chips (`categoryCounts` +
  hint-list ordering), add the `collections-sync` CronJob.
- **Phase 3 (app membership + wanted-tile PR):** the §7 full-membership data-model change, the §8
  wanted-tile rendering on the collection drill (reusing `wanted_items` / `book_requests` Wanted
  tiles + force-search), the DESIGN-035 D-03 drop-empty softening. Docs: amend DESIGN-035 D-03/D-04
  + DESIGN-037 (books missing surfacing).
- **Phase 4 (acquisition + fence PR):** the `collection_size_cap` app_setting (default 25) +
  enforcement at create/add + Wanted-expansion, the over-cap **Modal + auto-ticket** flow (reuse
  `createTicket`), wiring the `acquire` grant to the acquisition toggle, and (when the `kometa`
  provider adapter lands) the movies/TV creation path through the same `collectionActionProcedure`.

### Risks / notes (extension)
- **Blast radius:** acquisition-ON collections + no cap = a chart could flood Radarr. The
  `collection_size_cap` + `acquire`-grant + `ACQUISITION_CAP_PER_RUN` pacing are the three fences —
  ship all three before any non-admin gets `acquire`.
- **Wanted membership is the real new data:** everything else reuses shipped models. Getting the
  full (not-held) membership right (D-D) is the load-bearing new build; M-a keeps it inside the *arr
  source-of-truth doctrine.
- **Visibility change:** the drop-empty softening (D-E) surfaces titles the household doesn't hold —
  intended (the whole point of Wanted tiles) but confirm against the ADR-047 gate expectations.

### Additional files that change (extension)
- Membership: `packages/db/src/schema/plex-collections.ts` (`+ media_item_id`, `+ held`) and its
  migration; `packages/sync/src/plex-collections.ts` + a full-membership fetch (D-D source);
  `packages/domain/src/plex-collections.ts` (writer unions held + wanted members).
- Books: `packages/db/src/schema/enums.ts` (`BOOK_REQUEST_ORIGINS += 'collection'`),
  `packages/sync/src/books-collections.ts` (mirror `missing[]`), `packages/domain` book-requests
  writer (mint origin `collection`).
- Wanted tiles: `ledger.collectionGroups` + the `?group=` drill (`@hnet/api`) union held +
  `wanted_items`; the books drill unions the DESIGN-029 Wanted tiles; reuse `RequestSearchButton` /
  the *arr force-search.
- Cap + grants: `packages/db/src/schema/enums.ts` (`APP_SETTING_KEYS += 'collection_size_cap'`, default
  25; optionally `TICKET_CATEGORIES += 'collection_override'`), the `setAppSetting` path,
  `collectionActionProcedure` size clamp; CLAUDE.md rule addendum in haynes-ops.
- Over-cap flow: the `@hnet/ui` `Modal` (hard rule 8) + a "Request admin override" action calling the
  ADR-050 `createTicket` single-writer (`packages/domain` tickets) with the structured payload (§9).
- Role UI: the collection composer/monitor already exists (DESIGN-043) — extend it with the cap field
  (admin-only) + the acquisition toggle wiring + the over-cap Modal.
