# Collection label classification — labeling PASS (movies/TV + books)

- **Date:** 2026-07-17
- **Type:** Reviewable classification + draft artifacts for **OWNER SPOT-CHECK**. NOTHING APPLIED — no Kometa run, no PR, no writes to Plex/Libretto.
- **Design:** `.agents/context/2026-07-17-label-driven-collections-spike.md` (the `blank_collection: true` + `label:` companion mechanism, the dynamic/open category model).
- **Draft companion files:** haynes-ops branch `agent/label-driven-collections-draft` → `kubernetes/main/apps/media/kometa/app/config/{movies-default-labels.yml, shows-default-labels.yml}` (+ `DRAFT-labels-README.md`). NOT wired into kustomization/externalsecret, NOT PR'd.

## ⚠ DRY-RUN RESULT (2026-07-17) — the companion `blank_collection` mechanism DOES NOT WORK

The owed one-collection safety gate was run against prod (franchise-Default collection **Back to the
Future**, rk 93441, via a temporary one-entry change on haynes-ops main #2098, a full `kometa-collections`
run, then reverted #2099). **Outcome: the label was NOT appended.** Kometa logged
`Config Warning: Skipping duplicate collection: "Back to the Future"` — a same-name `blank_collection`
entry in a later file is **skipped as a duplicate** because the `franchise` Default already builds that
collection in the same run (the Default's build showed `... | 3 | 0 | Unchanged`). The collection was
left completely intact (childCount 3→3, `Kometa` + `TMDb Collections` labels preserved — **no harm**), but
**no `Sequels` label was written.** This falsifies the design's "same-name compose / last file wins"
assumption for this Kometa build — duplicates are dropped, the FIRST (Default) definition wins.

**Implication:** the 326-entry `movies-default-labels.yml` companion would be **entirely skipped as
duplicates → zero labels applied.** DO NOT roll it out as designed. The inline-label edits for
UNIQUELY-named hand-authored collections (people/studio/audio/charts/TV) are unaffected and still valid;
only the Default-produced collections are blocked. **Recommended pivot** (design §1b fallback, needs NO
Kometa change): derive the app category from the section labels Kometa ALREADY applies — `TMDb Collections`
→ Sequels, `Universe Collections` → Universe, awards groupings → List — plus inline labels for the
uniquely-named hand-authored set. Held for owner checkpoint. The classification below is unaffected — only
the *delivery mechanism* for Default collections changed.

## PIVOT ANALYSIS (2026-07-17, read-only) — does the section-label derive reproduce the ratified classification?

Quantified for the owner checkpoint. Method: read-only re-pull of the ACTUAL label set on all 459
Kometa-created collections (DB ratingKeys → Plex `includeLabels=1` reads; Job `label-pivot-pull`,
frontend ns, deleted after) joined against the ratified table below. No prod changes, no Kometa runs.

### The live section-label inventory (what Kometa actually put there)

| section label | count | produced by | → derived category |
|---|---|---|---|
| `TMDb Collections` | 297 (movies) | `franchise` Default (in-run) | **Sequels** |
| `Universe Collections` | 15 (movies) | `universe` Default (in-run) | **Universe** |
| `Oscars Winners Awards` | 5 (movies) | oscars Default's `dynamic_collections` (yearly) | **List** |
| `Golden Globes Awards` | 5 (movies) | golden Default's `dynamic_collections` (yearly) | **List** |
| `Show Franchise Collections` | 8 (TV) | LEGACY (no TV Default runs today) | **Universe** (fallback) |
| bare `Kometa` only | 114 movies + 15 TV | hand-authored + static-keyed Defaults + orphans | null (owner/inline label expected) |

Derive precedence: an OWNER category label (from inline edits), if present, ALWAYS wins; the section-label
map is only the fallback for Default-produced collections. (`Kometa` stays on the reserved IGNORE list.)
This precedence matters for exactly 5 collections that carry both kinds: hand-authored *Fantastic Four*
(TMDb Collections twin) and 4 hand-authored TV shows with the legacy `Show Franchise Collections` label —
notably **Game of Thrones**, where the inline `Sequels` must beat the fallback's Universe.

### Result over the 330 Default-produced collections

**320 exact matches (97%), 1 mismatch, 9 no-derive.** The breakdown:

| collection | issue | resolution |
|---|---|---|
| Halloween (6) | derive Sequels vs ratified List | **The data resolves the earlier flag:** it carries `TMDb Collections` and appears in the franchise-Default run summary — it IS the TMDb "Halloween Collection" (Michael Myers franchise), NOT a seasonal list. **Recommend ratifying Sequels → mismatch count 0.** If the owner insists List: franchise-Default `exclude:` its TMDb id + re-author custom with inline label (the exclude var is already live in config.yml for 1704738/11716). |
| Oscars Best Picture Winners (95), Oscars Best Director Winners (94), Golden Globes Best Picture Winners (254), Golden Globes Best Director Winners (80) | no-derive (bare `Kometa`) — these are the Defaults' STATIC keyed collections (`key: best_picture`/`best_director`); only the yearly `dynamic_collections` get the awards section label; all four ARE built in-run (run-summary-verified), so `blank_collection` is duplicate-skipped | **Fix (verified mechanism):** `use_best_picture: false` + `use_best_director: false` template variables on the oscars/golden Defaults — `use_<<key>>` is the documented "Turns off individual Collections in a Defaults File" shared variable (docs/templates/defaults/base/collection/shared.md) — then re-author the four as custom defs (copy the `imdb_award` builders from `defaults/award/oscars.yml`/`golden.yml`) with inline `label: List`. Alternative zero-Kometa fix: a bounded 4-exact-title fallback map in the app derive. |
| Star Wars — movies (9) | no-derive (bare `Kometa`), ratified Universe | **ORPHAN** — absent from the run summary (only *Star Wars Universe* and *Star Wars: Skywalker Saga* build in-run). The duplicate-skip does NOT apply to orphans, so a one-entry `blank_collection` + `label: Universe` companion works for it. |
| Doctor Who (2), Law & Order (2), NCIS (2), Star Trek (12) — TV | no-derive under a naive map | All four carry the legacy `Show Franchise Collections` label and are ORPHANS (absent from the TV run summary). The **`Show Franchise Collections` → Universe** fallback map fixes all four with ZERO Kometa changes (all are ratified Universe); the existing 4-entry `shows-default-labels.yml` companion also remains viable (orphans) as belt-and-braces. |

So the per-collection fix count is a handful: **2 Default toggles + 4 re-authored custom defs (or one
4-title app map), 1 orphan companion entry, and 0 changes for the TV four (the map covers them)** — plus
the recommended Halloween ratification flip.

### TV wall derive map (question 3)

No TV Defaults run in the current config, so the TV wall needs only: `Show Franchise Collections` →
Universe (legacy label, 8 collections — the 4 orphans resolve by it; the 4 hand-authored ones are
overridden by their inline owner labels, which is what puts Game of Thrones under Sequels).

### Final delivery plan (pending owner sign-off)

1. **App-side derive (no Kometa change) covers all in-run Default collections:** owner-label-first, then
   the section-label fallback map above → 320/330 Default-produced correct immediately, including every
   future franchise-Default auto-discovery (born labeled `TMDb Collections`).
2. **Inline `label:` edits** for the 36 hand-authored defs (people templates, Studio/Audio/charts/TV) —
   unchanged, proven mechanism (unique names never hit the duplicate-skip).
3. **Mismatch fixes:** oscars/golden `use_<key>: false` + 4 custom re-authored defs with `label: List`
   (or the app-side 4-title map — owner's call), + the movie *Star Wars* orphan companion entry
   (+ optionally the TV 4-entry companion).
4. **Ratify:** Halloween → Sequels (data-resolved).

## Source of truth for this classification

LIVE data, not fabricated: a read-only Job in `frontend` (`collection-label-inventory`, postgres-init image, `envFrom haynesnetwork-secret` → `DATABASE_URL`) queried the app's `plex_collections` (joined to `plex_libraries`/`plex_servers`) and `books_collections` mirrors. The Job read only; it is gone (ttl). The `collection_type` column shown is the app's CURRENT title-based classifier output (the thing this program REPLACES) — used only as a sanity hint, not the answer.

## Taxonomy applied (owner-authoritative, revised 2026-07-17 after spot-check)

- **Universe** — order-agnostic shared world umbrella-ing MULTIPLE sub-series (MCU, Wizarding World, Middle Earth, DCEU/DC, Monsterverse, X-Men, Alien/Predator, Conjuring, …).
- **Sequels** — a SINGLE ORDERED film/show line (Toy Story, John Wick, Mission: Impossible, Game of Thrones; and a single sub-series like *Harry Potter* or *Fantastic Beasts* on its own). Trilogies fold in here.
- **Director / Actor** — person collections (the `movies-people.yml` templates).
- **List** — charts, awards, seasonal lists, author/genre curated lists (IMDb Top 250, Oscars, Golden Globes, Roald Dahl, J-Horror).
- **Studio** *(new — owner split from List)* — studio showcases (A24, Disney Animation, DreamWorks).
- **Audio** *(new — owner split from List)* — audio-quality collections (Dolby Atmos, DTS X, Spatial Surround).
- **Series / Event** *(books)* — Series = a single book series (Dune, Outlander); Event = comic crossover events (Fall of X, Shattered Grid).
- One category label per collection. Membership overlap (an Alien film in both the *Alien* Sequels line and the *Alien / Predator* Universe) is expected and fine; labels do not overlap.
- OPEN set: a new label is a new chip. No **Other** bucket — an unlabeled collection just shows under All.

## Counts per category (revised)

| wall | Universe | Sequels | Director | Actor | List | Studio | Audio | (exclude) | total |
|---|---|---|---|---|---|---|---|---|---|
| Movies | 17 | 298 | 20 | 72 | 22 | 3 | 3 | 4 | 439 |
| TV | 14 | 3 | 0 | 0 | 6 | 0 | 0 | 1 | 24 |
| **Movies+TV** | 31 | 301 | 20 | 72 | 28 | 3 | 3 | 5 | 463 |

Books: Event 7, List 3, Series 16 (total 26).
`(exclude)` = Plex/Maintainerr operational collections + the Kometa `Universe Collections` section hub — not owner-category chips, cannot carry a Kometa label. Listed but not labeled.

## How the labels get applied (mechanism split)

- **Movies — Default-produced/orphan (326):** companion file `movies-default-labels.yml` (`blank_collection: true` + `label:` by exact title).
- **TV — orphan (4):** companion file `shows-default-labels.yml` (Star Trek, Doctor Who, Law & Order, NCIS).
- **Hand-authored (128 — 109 movie + 19 TV):** INLINE `label:` on their existing defs/templates (enumerated below), NOT in the companion files.

## FLAGGED — owner judgement calls (30)

Every non-obvious call. `conf` low = please confirm; med = reasonable but worth a glance; `(exclude)` = confirm these should carry no chip.

| conf | wall | title | size | my call | why / the alternative |
|---|---|---|---|---|---|
| low | Movies | A Christmas Story | 2 | Sequels | A Christmas Story + sequel = ordered line = Sequels; seasonal flavour could argue List. |
| low | Movies | Fast & Furious | 10 | Universe | Mostly a single ordered line + Hobbs & Shaw spinoff. Universe Default owns it, but it is borderline Sequels. Flag. |
| low | Movies | Halloween | 6 | List | AMBIGUOUS: could be the Michael Myers HORROR FRANCHISE (Sequels) OR the seasonal Default 'Halloween' list. DB tagged list on the season keyword. size 6. |
| low | Movies | In Association With Marvel | 41 | Universe | Broad 'all Marvel-associated films' umbrella (Sony/Fox/etc). Unusual grouping - Universe by umbrella logic. Flag. |
| low | Movies | Independence Day | 2 | Sequels | 2-film franchise (ID + Resurgence) = Sequels; DB mis-tagged 'list' on the July-4 keyword. Could be seasonal List if that is the intent. |
| low | Movies | Kendrick Brothers Movies - Saga | 2 | Sequels | Creator/faith-film set by the Kendrick Brothers - not a shared narrative universe. Could be a List (creator showcase) or a coined 'Creator' category. DB had franchise_universe. |
| low | Movies | The Christmas Chronicles | 2 | Sequels | 2-film Netflix line = Sequels; seasonal flavour could argue List. |
| low | Movies | X-Men | 11 | Sequels | Main X-Men film line = Sequels; 'X-Men Universe' (20) is the Universe. Owner listed X-Men as a Universe example, so could flip. TWO X-Men collections exist. |
| low | TV | Avatar The Last Airbender | 2 | Universe | ATLA + Korra (+more) shared world = Universe; could be Sequels if just the ordered pair. Flag. |
| low | TV | Band of Brothers | 3 | Sequels | WWII miniseries trilogy (Band of Brothers/The Pacific/Masters of the Air) = ordered anthology. Sequels vs Universe - flag. |
| low | TV | Breaking Bad | 2 | Universe | Breaking Bad + Better Call Saul + El Camino shared world = Universe. Flag. |
| low | TV | Doctor Who | 2 | Universe | Classic + revived era + spinoffs = Universe. Not in Kometa config (orphan/unmanaged-but-labeled). Flag. |
| low | TV | Law & Order | 2 | Universe | L&O + SVU + CI multi-series = Universe. Orphan (not in config). Flag. |
| low | TV | NCIS | 2 | Universe | NCIS + LA + Hawaii multi-series = Universe. Orphan (not in config). Flag. |
| low | TV | Sons of Anarchy | 2 | Universe | SoA + Mayans M.C. shared world = Universe. Flag. |
| low | TV | The Boys | 3 | Universe | The Boys + Gen V + Diabolical shared world = Universe. Flag vs Sequels. |
| low | TV | Walking Dead | 5 | Universe | TWD + spinoffs shared world = Universe. Flag. |
| low | TV | Yellowstone | 6 | Universe | Yellowstone + 1883 + 1923 shared world = Universe. Flag. |
| med | Movies | Batman: The Long Halloween | 2 | Sequels | 2-part animated film = ordered Sequels line; DB mis-tagged 'list' on 'Halloween'. |
| med | Movies | Harry Potter | 8 | Sequels | OWNER-DEF override: HP alone is a single ordered line = Sequels; the Wizarding World collection is the Universe. DB had franchise_universe. |
| hi | Movies | hnet — unwatched low-value movies | 639 | (exclude) | Plex/Maintainerr operational collection (not Kometa-managed) - cannot carry a Kometa label; not an owner category chip. Handle app-side or exclude. |
| hi | Movies | Leaving Soon — Movies | 25 | (exclude) | Plex/Maintainerr operational collection (not Kometa-managed) - cannot carry a Kometa label; not an owner category chip. Handle app-side or exclude. |
| hi | Movies | Leaving Soon — Movies | 0 | (exclude) | Plex/Maintainerr operational collection (not Kometa-managed) - cannot carry a Kometa label; not an owner category chip. Handle app-side or exclude. |
| med | Movies | Rocky / Creed | 9 | Universe | Two sub-lines (Rocky + Creed) under one world = Universe per the universe Default. Borderline. |
| med | Movies | Star Wars: Skywalker Saga | 9 | Sequels | Single ordered 9-film saga = Sequels; 'Star Wars' / 'Star Wars Universe' are the Universe. DB had franchise_universe. |
| hi | Movies | Universe Collections | 0 | (exclude) | Kometa 'Universe Collections' SECTION HUB (size 0) - a reserved system/parent label, on the derive IGNORE list. No owner category. |
| med | TV | Gilmore Girls | 2 | Sequels | Show + revival = single ordered line. |
| hi | TV | hnet — unwatched low-value TV | 8 | (exclude) | Plex/Maintainerr operational collection (not Kometa-managed) - cannot carry a Kometa label; not an owner category chip. Handle app-side or exclude. |
| med | TV | One Chicago | 4 | Universe | Fire + PD + Med + Justice crossover world = Universe. |
| med | TV | Star Trek | 12 | Universe | Multi-series/timeline = Universe. Orphan (not in config). |

**Cross-cutting flags for the owner:**
- **Harry Potter / Wizarding World / Fantastic Beasts:** per owner def, *Harry Potter* (8) and *Fantastic Beasts* (3) are **Sequels** (single ordered lines); only *Wizarding World* (11) is the **Universe**. The old classifier had *Harry Potter* as franchise_universe — corrected here.
- **Star Wars:** three movie collections — *Star Wars* (9) and *Star Wars Universe* (11) = **Universe**; *Star Wars: Skywalker Saga* (9) = **Sequels** (the single ordered saga). Confirm.
- **X-Men:** *X-Men Universe* (20) = **Universe**; *X-Men* (11) = **Sequels** (main line). Owner listed 'X-Men' as a Universe example, so *X-Men* could flip to Universe — please rule.
- **Seasonal keyword false-positives:** the old classifier tagged *Halloween*, *Independence Day*, *Batman: The Long Halloween*, the *Christmas* franchises as `list` on the season word. Several are really franchise **Sequels** lines (see rows). *Halloween* especially — horror franchise vs seasonal list.
- **Studio / Audio now their own chips (owner):** A24, Disney Animation, DreamWorks → **Studio**; Dolby Atmos, DTS X, Spatial Surround → **Audio**. Roald Dahl + J-Horror stay **List**.
- **Game of Thrones → Sequels (owner):** the shared world is **A Song of Ice and Fire** (Universe). See the ASOIAF finding below — that Universe collection does NOT exist in the estate yet.
- **TV franchises lean Universe:** most other TV 'franchise' collections group multiple series in one world (The Boys+Gen V, Breaking Bad+Better Call Saul, Yellowstone+1883/1923, TWD+spinoffs) → **Universe**. If a collection is really just one show's ordered continuation, flip it to Sequels.
- **Books comic events → Event (owner):** the 7 Kavita-native reading lists (Fall of X, Shattered Grid, …) are crossover **Event**s. They are Kavita-native (no Libretto recipe) so they can only be categorized app-side (L2).

## Finding — 'A Song of Ice and Fire' Universe (owner correction #3)

**Does NOT exist** in the live inventory — no *A Song of Ice and Fire*, *ASOIAF*, or *House of the Dragon* collection was found on the Movies wall, the TV wall, or in books (checked all 463 movie/TV rows + 26 book rows). The only related collection is TV **Game of Thrones** (size 3), now labeled **Sequels**.

**FLAGGED for owner:** if you want an ASOIAF **Universe** chip, that umbrella collection must be CREATED first (it would umbrella *Game of Thrones* + *House of the Dragon* + any future spinoffs). I did NOT fabricate one. *House of the Dragon* has no standalone collection either (no relabel needed); when one exists it would be **Sequels** under the ASOIAF Universe.

## Inline-label edits (hand-authored defs) — DRAFT, not applied

Add `label:` to these existing defs in the haynes-ops kometa config. Where a whole template shares a category, set it once on the template.

**`movies-people.yml`** — set on the templates (covers all 20 Director + 72 Actor collections):
```yaml
templates:
  Director:
    label: Director   # append
  Actor:
    label: Actor      # append
```
**`movies-lists.yml`** — per collection (the Studio template no longer maps to one label): A24, Disney Animation, DreamWorks Pictures → `label: Studio`; Roald Dahl, J-Horror → `label: List`.
**`movies-charts.yml`** — Chart template → `label: List` (Popular Now, Top Rated, Top Grossing, IMDB Popular, IMDB Top 250).
**`movies-collections.yml`** — per collection: Christmas HNet → `List`; Spatial Surround / Dolby Atmos / DTS X → `label: Audio`.
**`movies-franchises.yml`** — surviving customs that materialized: Monsterverse → `Universe`; The Addams Family, Fantastic Four, Unbreakable → `Sequels` (set per collection; the `Movies` template has no single category).
**`shows-franchises.yml`** — per collection: Arrowverse, MCU, Star Wars, The Boys, Breaking Bad, Walking Dead, Yellowstone, One Chicago, Sons of Anarchy, Avatar The Last Airbender → `Universe`; **Game of Thrones → `Sequels`** (owner), Band of Brothers, Gilmore Girls → `Sequels`.
**`shows-collections.yml`** — Curated for Jackson/Kellie/Penelope, Big Kid Cartoons, Kid Cartoons, Earth & Space Wonders → `List` (curated hand-picked show lists).

## Books — draft category assignments (Libretto/Kavita/ABS)

Books are mirrored from Libretto recipes (provenance `libretto`) or hand-made in Kavita (provenance `kavita`) — NOT via Plex labels. Per design: **L1** = Libretto writes a free-form `cat=` into its `[libretto:<recipeId>]` description marker (recommended for the recipe-backed rows); **L2** = app-side `books_collections.category` for the Kavita-native rows (no recipe to carry a cat). Libretto is not in the current haynes-ops tree (feature branches only), so these are drafts keyed to the live mirror rows.

| source | kind | title | size | prov | category | conf | placement / note |
|---|---|---|---|---|---|---|---|
| audiobookshelf | collection | Dune | 6 | libretto | Series | hi | L1 recipe cat=Series (hardcover_series default). |
| audiobookshelf | collection | Percy Jackson and the Olympians | 6 | libretto | Series | hi | L1 recipe cat=Series. |
| audiobookshelf | collection | Sookie Stackhouse | 14 | libretto | Series | hi | L1 recipe cat=Series. |
| audiobookshelf | collection | The Hunger Games | 3 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | A Court of Thorns and Roses | 5 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | Bridgerton | 12 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | Discworld | 19 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | Dune | 4 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | Harry Potter | 6 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | Mistborn | 2 | libretto | Series | hi | L1 recipe cat=Series (part of the Cosmere; standalone series here). |
| kavita | reading_list | NYT Combined Print and E-Book Fiction | 2 | libretto | List | hi | L1 recipe cat=List (nyt_list default). |
| kavita | reading_list | NYT Hardcover Fiction | 1 | libretto | List | hi | L1 recipe cat=List (nyt_list). |
| kavita | reading_list | NYT Series Books | 2 | libretto | List | hi | L1 recipe cat=List (nyt_list). |
| kavita | reading_list | Outlander | 13 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | Percy Jackson and the Olympians | 5 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | Sookie Stackhouse | 12 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | The Stormlight Archive | 3 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | The Wheel of Time | 11 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | Throne of Glass | 10 | libretto | Series | hi | L1 recipe cat=Series. |
| kavita | reading_list | "Spider-Man" Kraven's Last Hunt [43327] | 1 | kavita | Event | hi | OWNER: comic-crossover Event chip. Kavita-NATIVE (no Libretto recipe) -> L2 app-side category only. |
| kavita | reading_list | "Web of Spider-Man" Cult of Love [56949] | 4 | kavita | Event | hi | Comic Event. Kavita-native -> L2 app-side. |
| kavita | reading_list | Beyond the Grid [60067] | 2 | kavita | Event | hi | Power Rangers comic Event. Kavita-native -> L2. |
| kavita | reading_list | Fall of X [61126] | 13 | kavita | Event | hi | X-Men crossover Event. Kavita-native -> L2. |
| kavita | reading_list | Fall of the House of X [61178] | 7 | kavita | Event | hi | X-Men Event. Kavita-native -> L2. |
| kavita | reading_list | Necessary Evil [60294] | 2 | kavita | Event | hi | Comic Event. Kavita-native -> L2. |
| kavita | reading_list | Shattered Grid [59796] | 2 | kavita | Event | hi | Power Rangers Event. Kavita-native -> L2. |

## Full classification table (all 463 movie/TV collections)

`prov` = provenance (kometa/plex mirror). `source` = default (Default-produced/orphan → companion file) vs custom (hand-authored → inline label) vs plex (operational). Sorted by wall then category.

| # | title | wall | size | prov | source | CATEGORY | conf | note |
|---|---|---|---|---|---|---|---|---|
| 1 | hnet — unwatched low-value movies | Movies | 639 | plex | plex | (exclude) | hi | Plex/Maintainerr operational collection (not Kometa-managed) - cannot carry a Kometa label; not an owner category chip. Handle app-side or exclude. |
| 2 | Leaving Soon — Movies | Movies | 25 | plex | plex | (exclude) | hi | Plex/Maintainerr operational collection (not Kometa-managed) - cannot carry a Kometa label; not an owner category chip. Handle app-side or exclude. |
| 3 | Leaving Soon — Movies | Movies | 0 | plex | plex | (exclude) | hi | Plex/Maintainerr operational collection (not Kometa-managed) - cannot carry a Kometa label; not an owner category chip. Handle app-side or exclude. |
| 4 | Universe Collections | Movies | 0 | kometa | default | (exclude) | hi | Kometa 'Universe Collections' SECTION HUB (size 0) - a reserved system/parent label, on the derive IGNORE list. No owner category. |
| 5 | Adam Sandler | Movies | 43 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 6 | Ben Affleck | Movies | 39 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 7 | Bruce Willis | Movies | 36 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 8 | Chris Evans | Movies | 27 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 9 | Chris Hemsworth | Movies | 23 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 10 | Chris Pratt | Movies | 25 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 11 | Chris Rock | Movies | 21 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 12 | Christian Bale | Movies | 25 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 13 | Christopher Walken | Movies | 21 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 14 | Chuck Norris | Movies | 2 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 15 | Clint Eastwood | Movies | 19 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 16 | Daniel Craig | Movies | 19 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 17 | Denzel Washington | Movies | 29 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 18 | Dwayne Johnson | Movies | 28 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 19 | Eddie Murphy | Movies | 22 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 20 | Emma Stone | Movies | 20 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 21 | Emma Watson | Movies | 12 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 22 | Gene Wilder | Movies | 10 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 23 | George Clooney | Movies | 30 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 24 | Gerard Butler | Movies | 25 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 25 | Harrison Ford | Movies | 34 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 26 | Hugh Jackman | Movies | 28 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 27 | Jack Black | Movies | 29 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 28 | Jack Nicholson | Movies | 20 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 29 | Jackie Chan | Movies | 13 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 30 | Jenna Ortega | Movies | 8 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 31 | Jennifer Lawrence | Movies | 23 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 32 | Jim Carrey | Movies | 25 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 33 | John Candy | Movies | 11 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 34 | John Travolta | Movies | 13 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 35 | Johnny Depp | Movies | 34 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 36 | Julia Roberts | Movies | 26 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 37 | Kevin Bacon | Movies | 23 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 38 | Leonardo DiCaprio | Movies | 19 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 39 | Liam Neeson | Movies | 39 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 40 | Lucy Liu | Movies | 17 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 41 | Mark Wahlberg | Movies | 25 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 42 | Martin Short | Movies | 15 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 43 | Matt Damon | Movies | 47 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 44 | Mel Brooks | Movies | 18 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 45 | Mel Gibson | Movies | 20 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 46 | Melissa McCarthy | Movies | 10 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 47 | Meryl Streep | Movies | 34 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 48 | Michael Keaton | Movies | 24 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 49 | Mike Myers | Movies | 12 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 50 | Mila Kunis | Movies | 10 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 51 | Morgan Freeman | Movies | 33 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 52 | Natalie Portman | Movies | 26 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 53 | Nicolas Cage | Movies | 34 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 54 | Reese Witherspoon | Movies | 18 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 55 | Robert De Niro | Movies | 38 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 56 | Robert Downey Jr. | Movies | 27 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 57 | Robin Williams | Movies | 22 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 58 | Ryan Reynolds | Movies | 32 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 59 | Sacha Baron Cohen | Movies | 18 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 60 | Samuel L. Jackson | Movies | 61 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 61 | Sandra Bullock | Movies | 19 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 62 | Scarlett Johansson | Movies | 39 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 63 | Sean Connery | Movies | 19 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 64 | Steve Carell | Movies | 25 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 65 | Steve Martin | Movies | 19 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 66 | Sylvester Stallone | Movies | 27 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 67 | Taika Waititi | Movies | 9 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 68 | Timothée Chalamet | Movies | 15 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 69 | Tom Cruise | Movies | 35 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 70 | Tom Hanks | Movies | 42 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 71 | Tom Holland | Movies | 16 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 72 | Vin Diesel | Movies | 26 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 73 | Will Ferrell | Movies | 29 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 74 | Will Smith | Movies | 30 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 75 | Woody Harrelson | Movies | 35 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 76 | Zendaya | Movies | 10 | kometa | custom | Actor | hi | people file (movies-people.yml Actor template). |
| 77 | Dolby Atmos | Movies | 1274 | kometa | custom | Audio | hi | Audio-quality collection (OWNER: own 'Audio' chip; movies-collections.yml). |
| 78 | DTS X | Movies | 93 | kometa | custom | Audio | hi | Audio-quality collection (OWNER: own 'Audio' chip; movies-collections.yml). |
| 79 | Spatial Surround | Movies | 1367 | kometa | custom | Audio | hi | Audio-quality collection (OWNER: own 'Audio' chip; movies-collections.yml). |
| 80 | Alfred Hitchcock | Movies | 10 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 81 | Ari Aster | Movies | 11 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 82 | Christopher Nolan | Movies | 18 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 83 | Coen Brothers | Movies | 17 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 84 | David Lynch | Movies | 10 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 85 | Edgar Wright | Movies | 11 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 86 | James Cameron | Movies | 24 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 87 | James Gunn | Movies | 15 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 88 | Jon Favreau | Movies | 16 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 89 | Jordan Peele | Movies | 8 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 90 | M. Night Shyamalan | Movies | 13 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 91 | Martin Scorsese | Movies | 32 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 92 | Michael Bay | Movies | 31 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 93 | Quentin Tarantino | Movies | 19 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 94 | Ridley Scott | Movies | 31 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 95 | Stanley Kubrick | Movies | 10 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 96 | Steven Spielberg | Movies | 85 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 97 | Tim Burton | Movies | 25 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 98 | Wes Anderson | Movies | 14 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 99 | Zack Snyder | Movies | 16 | kometa | custom | Director | hi | people file (movies-people.yml Director template). |
| 100 | Golden Globe 2022 | Movies | 10 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 101 | Golden Globe 2023 | Movies | 10 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 102 | Golden Globe 2024 | Movies | 7 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 103 | Golden Globe 2025 | Movies | 10 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 104 | Golden Globe 2026 | Movies | 7 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 105 | Golden Globes Best Director Winners | Movies | 80 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 106 | Golden Globes Best Picture Winners | Movies | 254 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 107 | Halloween | Movies | 6 | kometa | default | List | low | AMBIGUOUS: could be the Michael Myers HORROR FRANCHISE (Sequels) OR the seasonal Default 'Halloween' list. DB tagged list on the season keyword. size 6. |
| 108 | IMDB Popular | Movies | 69 | kometa | custom | List | hi | Chart (movies-charts.yml). |
| 109 | IMDB Top 250 | Movies | 248 | kometa | custom | List | hi | Chart (movies-charts.yml). |
| 110 | J-Horror | Movies | 20 | kometa | custom | List | hi | Author/genre curated list (movies-lists.yml). |
| 111 | Oscars Best Director Winners | Movies | 94 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 112 | Oscars Best Picture Winners | Movies | 95 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 113 | Oscars Winners 2022 | Movies | 13 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 114 | Oscars Winners 2023 | Movies | 13 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 115 | Oscars Winners 2024 | Movies | 12 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 116 | Oscars Winners 2025 | Movies | 12 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 117 | Oscars Winners 2026 | Movies | 14 | kometa | default | List | hi | Awards list (oscars/golden Default). |
| 118 | Popular Now | Movies | 52 | kometa | custom | List | hi | Chart (movies-charts.yml). |
| 119 | Roald Dahl | Movies | 18 | kometa | custom | List | hi | Author/genre curated list (movies-lists.yml). |
| 120 | Top Grossing | Movies | 99 | kometa | custom | List | hi | Chart (movies-charts.yml). |
| 121 | Top Rated | Movies | 99 | kometa | custom | List | hi | Chart (movies-charts.yml). |
| 122 | 101 Dalmatians (Animated) | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 123 | 28 Days/Weeks/Years Later | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 124 | 300 | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 125 | A Better Tomorrow | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 126 | A Christmas Prince | Movies | 2 | kometa | default | Sequels | hi | OWNER: Netflix film series (3 films) = Sequels, not a seasonal List. |
| 127 | A Christmas Story | Movies | 2 | kometa | default | Sequels | low | A Christmas Story + sequel = ordered line = Sequels; seasonal flavour could argue List. |
| 128 | A Goofy Movie | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 129 | A Nightmare on Elm Street | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 130 | A Quiet Place | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 131 | A Simple Favor | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 132 | Ace Ventura | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 133 | Airplane | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 134 | Aladdin | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 135 | Alex Cross | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 136 | Alice in Wonderland | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 137 | Alien | Movies | 6 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 138 | American Civil War | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 139 | American Pie | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 140 | An Inconvenient | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 141 | Anchorman | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 142 | Annabelle | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 143 | Ant-Man | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 144 | Aquaman | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 145 | Army of the Dead | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 146 | Austin Powers | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 147 | Avatar | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 148 | AVP | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 149 | Back to the Future | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 150 | Bad Boys | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 151 | Bambi | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 152 | Batman | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 153 | Batman (Adam West) Animation | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 154 | Batman (DC Universe Animated) | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 155 | Batman: The Dark Knight Returns | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 156 | Batman: The Long Halloween | Movies | 2 | kometa | default | Sequels | med | 2-part animated film = ordered Sequels line; DB mis-tagged 'list' on 'Halloween'. |
| 157 | Beetlejuice | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 158 | Before... | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 159 | Beverly Hills Cop | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 160 | Black Panther | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 161 | Blade | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 162 | Blade Runner | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 163 | Book Club | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 164 | Boys / Girls State | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 165 | Bridget Jones | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 166 | Captain America | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 167 | Captain Marvel | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 168 | Cars | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 169 | Chicken Run | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 170 | Clerks | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 171 | Clint Eastwood's Iwo Jima | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 172 | Cloverfield | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 173 | Code 8 | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 174 | Concrete Utopia | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 175 | Creed | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 176 | Daddy's Home | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 177 | Deadpool | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 178 | Den of Thieves | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 179 | Descendants | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 180 | Despicable Me | Movies | 6 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 181 | Dhurandhar | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 182 | Die Hard | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 183 | Divergent | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 184 | Doctor Strange | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 185 | Dora's Adventures | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 186 | Downton Abbey (Films) | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 187 | Dracula (Universal) | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 188 | Drishyam | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 189 | Dumb and Dumber | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 190 | Dune | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 191 | Elite Squad | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 192 | Enola Holmes | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 193 | Evil Dead | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 194 | Evil Dead Standalone | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 195 | Extraction | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 196 | Fantasia | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 197 | Fantastic Beasts | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 198 | Fantastic Four | Movies | 2 | kometa | custom | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 199 | Father of the Bride (Spencer Tracy) | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 200 | Father of the Bride (Steve Martin) | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 201 | Fault: London | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 202 | Fifty Shades | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 203 | Final Destination | Movies | 6 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 204 | Finding Nemo | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 205 | Firefly | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 206 | Fisherman's Friends | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 207 | Freaky Friday | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 208 | Frozen | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 209 | G.I. Joe (Live-Action) | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 210 | Gendernauts | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 211 | Ghost in the Shell | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 212 | Ghost Rider | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 213 | Ghostbusters | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 214 | Gladiator | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 215 | Godzilla (MonsterVerse) | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 216 | Grown Ups | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 217 | Guardians of the Galaxy | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 218 | Happy Gilmore | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 219 | Harold & Kumar | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 220 | Harry Potter | Movies | 8 | kometa | default | Sequels | med | OWNER-DEF override: HP alone is a single ordered line = Sequels; the Wizarding World collection is the Universe. DB had franchise_universe. |
| 221 | Has Fallen | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 222 | Hellboy | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 223 | Hercule Poirot (Kenneth Branagh) | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 224 | Hocus Pocus | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 225 | Home Alone | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 226 | Horrible Bosses | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 227 | Hotel Transylvania | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 228 | How to Train Your Dragon | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 229 | Ice Age | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 230 | Independence Day | Movies | 2 | kometa | default | Sequels | low | 2-film franchise (ID + Resurgence) = Sequels; DB mis-tagged 'list' on the July-4 keyword. Could be seasonal List if that is the intent. |
| 231 | Indiana Jones | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 232 | Influencer | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 233 | Inside Out | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 234 | Insidious | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 235 | Ip Man | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 236 | Iron Man | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 237 | It | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 238 | Jack Reacher | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 239 | Jackass | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 240 | James Bond | Movies | 25 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 241 | Jay and Silent Bob | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 242 | John Wick | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 243 | Joker | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 244 | Ju-on | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 245 | Jumanji | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 246 | Jurassic Park | Movies | 7 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 247 | Justice League (DCAMU) | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 248 | Justice League (Tomorrowverse) | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 249 | Justice League Dark | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 250 | Kendrick Brothers Movies - Saga | Movies | 2 | kometa | default | Sequels | low | Creator/faith-film set by the Kendrick Brothers - not a shared narrative universe. Could be a List (creator showcase) or a coined 'Creator' category. DB had franchise_universe. |
| 251 | Kick-Ass | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 252 | Kill Bill | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 253 | Kingsman | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 254 | Knives Out | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 255 | Knocked Up | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 256 | Kung Fu Panda | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 257 | Legally Blonde | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 258 | Lilo & Stitch (Animated) | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 259 | M3GAN | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 260 | Mad Max | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 261 | Madagascar | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 262 | Madea | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 263 | Maleficent | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 264 | Mamma Mia! | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 265 | Man of Steel | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 266 | Mary Poppins | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 267 | Meet the Parents | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 268 | Men in Black | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 269 | Mexico | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 270 | Mission: Impossible | Movies | 8 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 271 | Moana | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 272 | Monsters, Inc. | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 273 | Mortal Kombat | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 274 | Muppet Films | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 275 | Murder Mystery | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 276 | Naked Gun | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 277 | National Treasure | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 278 | Navarone | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 279 | Ne Zha | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 280 | Night of the Demons | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 281 | Nobody | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 282 | Now You See Me | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 283 | Ocean's | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 284 | One Mile | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 285 | One Shot | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 286 | Pacific Rim | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 287 | Paddington | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 288 | Paranormal Activity | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 289 | PAW Patrol (Theatrical) | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 290 | Peanuts | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 291 | Pet Sematary | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 292 | Pirates of the Caribbean | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 293 | Pitch Perfect | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 294 | Planet of the Apes (Original) | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 295 | Planet of the Apes (Reboot) | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 296 | Pokémon (Alternate Continuity) | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 297 | Predator | Movies | 6 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 298 | Puss in Boots | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 299 | Rambo | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 300 | Ready or Not | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 301 | Resident Evil | Movies | 6 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 302 | Rio | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 303 | Robert Langdon | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 304 | Rocky | Movies | 6 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 305 | Rosemary's Baby | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 306 | Rush Hour | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 307 | Saw | Movies | 9 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 308 | Scary Movie | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 309 | Scream | Movies | 7 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 310 | Shaft | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 311 | Shazam! | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 312 | Short Circuit | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 313 | Shrek | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 314 | Silent Hill | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 315 | Sing | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 316 | Sisu | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 317 | Smile | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 318 | Son of Batman | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 319 | Sonic the Hedgehog | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 320 | Spider-Man | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 321 | Spider-Man (MCU) | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 322 | Spider-Man: Spider-Verse | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 323 | SpongeBob | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 324 | Star Trek: Alternate Reality | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 325 | Star Trek: The Original Series | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 326 | Star Wars: Skywalker Saga | Movies | 9 | kometa | default | Sequels | med | Single ordered 9-film saga = Sequels; 'Star Wars' / 'Star Wars Universe' are the Universe. DB had franchise_universe. |
| 327 | Suicide Club | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 328 | Suicide Squad | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 329 | Superman | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 330 | Taare Zameen Par | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 331 | Taken | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 332 | Ted | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 333 | Teen Titans | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 334 | Teen Titans Go! | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 335 | Teenage Mutant Ninja Turtles | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 336 | Terrifier | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 337 | The Accountant | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 338 | The Addams Family | Movies | 3 | kometa | custom | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 339 | The Amazing Spider-Man | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 340 | The Angry Birds | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 341 | The Avengers | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 342 | The Barrytown Trilogy | Movies | 2 | kometa | default | Sequels | hi | Trilogy folds into Sequels (owner def). |
| 343 | The Best Man | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 344 | The Black Phone | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 345 | The Boss Baby | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 346 | The Bourne | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 347 | The Christmas Chronicles | Movies | 2 | kometa | default | Sequels | low | 2-film Netflix line = Sequels; seasonal flavour could argue List. |
| 348 | The Chronicles of Narnia | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 349 | The Chronicles of Riddick | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 350 | The Conjuring | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 351 | The Dark Knight | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 352 | The Devil Wears Prada | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 353 | The Emigrants | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 354 | The Equalizer | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 355 | The Expendables | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 356 | The Fast and the Furious | Movies | 10 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 357 | The Godfather | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 358 | The Hangover | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 359 | The Hannibal Lecter | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 360 | The Hitman's Bodyguard | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 361 | The Hobbit | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 362 | The Hood | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 363 | The Hunger Games | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 364 | The Incredibles | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 365 | The Jack Ryan | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 366 | The Karate Kid | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 367 | The Land Before Time | Movies | 13 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 368 | The Lego Movie | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 369 | The Lion King | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 370 | The Lion King (Reboot) | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 371 | The Lord of the Rings | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 372 | The Matrix | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 373 | The Maze Runner | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 374 | The Meg | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 375 | The Mummy | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 376 | The Muppets | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 377 | The Omen | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 378 | The Princess Switch | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 379 | The Purge | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 380 | The Raid | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 381 | The Rescuers | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 382 | The Ring | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 383 | The Rocky Horror Picture Show | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 384 | The Roundup | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 385 | The Santa Clause | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 386 | The Secret Life of Pets | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 387 | The Shining | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 388 | The Souvenir | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 389 | The Space Odyssey Series | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 390 | The Super Mario | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 391 | The Terminator | Movies | 6 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 392 | The Three Flavours Cornetto | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 393 | The Toxic Avenger | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 394 | The Transporter | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 395 | The Trolls | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 396 | The Twilight | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 397 | Thor | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 398 | Tinker Bell | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 399 | To All the Boys | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 400 | Top Gun | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 401 | Toy Story | Movies | 4 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 402 | Trainspotting | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 403 | Transformers | Movies | 5 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 404 | TRON | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 405 | Twister | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 406 | Unbreakable | Movies | 3 | kometa | custom | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 407 | V/H/S | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 408 | Venom | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 409 | Wall Street | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 410 | Wicked | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 411 | Wonder | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 412 | Wonder Woman | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 413 | Wreck-It Ralph | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 414 | X | Movies | 3 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 415 | X-Men | Movies | 11 | kometa | default | Sequels | low | Main X-Men film line = Sequels; 'X-Men Universe' (20) is the Universe. Owner listed X-Men as a Universe example, so could flip. TWO X-Men collections exist. |
| 416 | Yossi | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 417 | Zombieland | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 418 | Zootopia | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 419 | Zorro | Movies | 2 | kometa | default | Sequels | hi | Single ordered franchise line (franchise Default / curated). Members may also sit in a Universe collection. |
| 420 | A24 | Movies | 158 | kometa | custom | Studio | hi | Studio showcase (OWNER: own 'Studio' chip; movies-lists.yml). |
| 421 | Disney Animation | Movies | 76 | kometa | custom | Studio | hi | Studio showcase (OWNER: own 'Studio' chip; movies-lists.yml). |
| 422 | DreamWorks Pictures | Movies | 100 | kometa | custom | Studio | hi | Studio showcase (OWNER: own 'Studio' chip; movies-lists.yml). |
| 423 | Alien / Predator | Movies | 16 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 424 | Conjuring Universe | Movies | 8 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 425 | DC Animated Universe | Movies | 27 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 426 | DC Universe | Movies | 25 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 427 | Fast & Furious | Movies | 10 | kometa | default | Universe | low | Mostly a single ordered line + Hobbs & Shaw spinoff. Universe Default owns it, but it is borderline Sequels. Flag. |
| 428 | In Association With Marvel | Movies | 41 | kometa | default | Universe | low | Broad 'all Marvel-associated films' umbrella (Sony/Fox/etc). Unusual grouping - Universe by umbrella logic. Flag. |
| 429 | Marvel Cinematic Universe | Movies | 42 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 430 | Middle Earth | Movies | 6 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 431 | Monsterverse | Movies | 4 | kometa | custom | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 432 | Mummy Universe | Movies | 5 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 433 | Rocky / Creed | Movies | 9 | kometa | default | Universe | med | Two sub-lines (Rocky + Creed) under one world = Universe per the universe Default. Borderline. |
| 434 | Star Trek | Movies | 9 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 435 | Star Wars | Movies | 9 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 436 | Star Wars Universe | Movies | 11 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 437 | View Askewniverse | Movies | 9 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 438 | Wizarding World | Movies | 11 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 439 | X-Men Universe | Movies | 20 | kometa | default | Universe | hi | Order-agnostic shared world umbrella-ing multiple sub-series. |
| 440 | hnet — unwatched low-value TV | TV | 8 | plex | plex | (exclude) | hi | Plex/Maintainerr operational collection (not Kometa-managed) - cannot carry a Kometa label; not an owner category chip. Handle app-side or exclude. |
| 441 | Big Kid Cartoons | TV | 9 | kometa | custom | List | hi | Curated hand-picked show list (shows-collections.yml). |
| 442 | Curated for Jackson | TV | 25 | kometa | custom | List | hi | Curated hand-picked show list (shows-collections.yml). |
| 443 | Curated for Kellie | TV | 19 | kometa | custom | List | hi | Curated hand-picked show list (shows-collections.yml). |
| 444 | Curated for Penelope | TV | 16 | kometa | custom | List | hi | Curated hand-picked show list (shows-collections.yml). |
| 445 | Earth & Space Wonders | TV | 6 | kometa | custom | List | hi | Curated hand-picked show list (shows-collections.yml). |
| 446 | Kid Cartoons | TV | 36 | kometa | custom | List | hi | Curated hand-picked show list (shows-collections.yml). |
| 447 | Band of Brothers | TV | 3 | kometa | custom | Sequels | low | WWII miniseries trilogy (Band of Brothers/The Pacific/Masters of the Air) = ordered anthology. Sequels vs Universe - flag. |
| 448 | Game of Thrones | TV | 3 | kometa | custom | Sequels | hi | OWNER: GoT is a single ordered line = Sequels. The shared world is 'A Song of Ice and Fire' (Universe) - see ASOIAF finding. House of the Dragon, if present, is Sequels under ASOIAF. |
| 449 | Gilmore Girls | TV | 2 | kometa | custom | Sequels | med | Show + revival = single ordered line. |
| 450 | Arrowverse | TV | 7 | kometa | custom | Universe | hi | Multi-series shared world. |
| 451 | Avatar The Last Airbender | TV | 2 | kometa | custom | Universe | low | ATLA + Korra (+more) shared world = Universe; could be Sequels if just the ordered pair. Flag. |
| 452 | Breaking Bad | TV | 2 | kometa | custom | Universe | low | Breaking Bad + Better Call Saul + El Camino shared world = Universe. Flag. |
| 453 | Doctor Who | TV | 2 | kometa | default | Universe | low | Classic + revived era + spinoffs = Universe. Not in Kometa config (orphan/unmanaged-but-labeled). Flag. |
| 454 | Law & Order | TV | 2 | kometa | default | Universe | low | L&O + SVU + CI multi-series = Universe. Orphan (not in config). Flag. |
| 455 | Marvel Cinematic Universe | TV | 27 | kometa | custom | Universe | hi | Multi-series shared world. |
| 456 | NCIS | TV | 2 | kometa | default | Universe | low | NCIS + LA + Hawaii multi-series = Universe. Orphan (not in config). Flag. |
| 457 | One Chicago | TV | 4 | kometa | custom | Universe | med | Fire + PD + Med + Justice crossover world = Universe. |
| 458 | Sons of Anarchy | TV | 2 | kometa | custom | Universe | low | SoA + Mayans M.C. shared world = Universe. Flag. |
| 459 | Star Trek | TV | 12 | kometa | default | Universe | med | Multi-series/timeline = Universe. Orphan (not in config). |
| 460 | Star Wars | TV | 15 | kometa | custom | Universe | hi | Multi-series shared world. |
| 461 | The Boys | TV | 3 | kometa | custom | Universe | low | The Boys + Gen V + Diabolical shared world = Universe. Flag vs Sequels. |
| 462 | Walking Dead | TV | 5 | kometa | custom | Universe | low | TWD + spinoffs shared world = Universe. Flag. |
| 463 | Yellowstone | TV | 6 | kometa | custom | Universe | low | Yellowstone + 1883 + 1923 shared world = Universe. Flag. |

## Confirmation

NOTHING WAS APPLIED. No Kometa run was triggered, no config was wired in or merged, no PR was opened, and no writes were made to Plex, Libretto, or the app database (the only DB touch was one read-only SELECT Job, now expired). The two companion YAMLs sit UNWIRED on a haynes-ops branch for spot-check. Next steps after owner review: ratify the flagged calls, then the implementing PR runs the one-collection `blank_collection` dry-run (design D-B) before the 418-entry file lands.