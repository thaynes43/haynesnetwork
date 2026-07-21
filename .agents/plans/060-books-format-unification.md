# PLAN-060: Books format unification — unified wall, multi-target collections, Authors program

Executes **ADR-075** (unified Books wall) + **ADR-076** (format-agnostic collections via
Libretto multi-target + Authors category). Rulings:
`.agents/context/2026-07-20-books-unification-rulings.md`. Two parallel streams after the
docs PR merges; each stream's brief is self-contained here + the amended designs.

## Choreography

1. **Docs PR merges first** (this branch): ADR-075/076, PRD/design/glossary amendments,
   this plan, the rulings note.
2. **Stream A (hnet)** and **Stream B (Libretto)** run in parallel, own worktrees/branches.
   They do not block each other: A's merge read is null-safe (no shared
   `libretto_recipe_id` across rows ⇒ cards render exactly as today), and B's multi-target
   output mirrors fine into the pre-merge app (two rows, merged only once A lands).
3. **After B releases + deploys** (helmrelease tag bump in haynes-ops — Libretto's own
   train): convert the 5 twin pairs to two-target recipes (Kavita recipe id survives —
   ADR-076 C-08), apply, verify markers; then land the 21 author recipes.
4. Owner reviews shipped UX (390px + desktop screenshots of the unified wall, seg, merged
   cards) per the standing rollout discipline.

## Stream A — haynesnetwork (branch `feat/unified-books-wall`)

1. **Registry** (`apps/web/lib/library-view-registry.ts`): collapse the `books` +
   `audiobooks` wall registrations into one `books` wall — facet union with data-gating
   (Author/Genre/Wanted universal; Narrator/Series/Language/Length/Read audio-gated;
   Pages/File ebook-gated; `fmt` relabels "File"), new three-state **format seg**
   (`?format=`, All · Ebook · Audiobook, availability semantics), view levels
   `books:wall|grouped-author|grouped-genre|grouped-collection|collection-items`, default
   grouped-by-Author. Comics rows untouched. Pin `Authors` in
   `CATEGORY_CHIP_HINT_ORDER` after `Sequels`.
2. **`books.search` work-grain collapse** (`packages/api` + query layer): live
   `book`/`audiobook` rows LEFT JOIN `books_format_pairs`; paired duo → one card anchored
   on the ebook row (ADR-075 C-02), partner metadata carried for facets/sorts; unpaired
   audio-only anchors on itself. Facet counts, pager, grouping all work-grain. Format
   predicate: Ebook ⇒ has ebook side; Audiobook ⇒ has audio side.
3. **Wanted composition** (ADR-075 C-05): top-level overlay keeps goodreads tiles; pairing
   wants STOP composing as standalone tiles — the anchor card's coverage badge carries
   wanted/in-flight for the missing format; detail-page pairing affordances unchanged.
4. **Collections merge** (`books.collectionGroups` + drill): group mirror rows by non-null
   `libretto_recipe_id` → one card; members union at work grain (same pair join);
   comic-partition wall mapping (majority comic ⇒ Comics wall, else Books, ties Books —
   ADR-076 C-04); drill want-tiles dedupe on `collection_member_ref` (C-05).
5. **Tabs + manager + URLs**: drop the Audiobooks tab from `BOOKS_TABS`
   (`library-client.tsx`); old audiobooks tab state redirects to Books with
   `format=audiobook`; `/collections` manager merges Books/Audiobooks sub-tabs (recipes
   listed once; `COLLECTION_MEDIA_TYPES` handling per ADR-076 C-01 — fold `audiobooks`
   into `books` at the router/UI seam, keep wire tolerance for old values).
6. **Migration** (next free number): drop orphaned `audiobooks`-wall preference rows
   (ADR-075 C-06). No mirror-table changes.
7. **Detail page**: anchor-linking only; both consume buttons already render (ADR-065).
8. **Tests**: registry parity suites (facet gating, seg states, default view), work-grain
   search battery (collapse, counts, format predicate, anchor rules incl. audio-only),
   merged-groups + partition rule, drill dedupe, pref migration, URL redirect. Stub
   harness already seeds both sources + collections — extend fixtures with a paired duo
   and a twin-recipe pair sharing a recipe id.
9. **UI copy** follows the owner tone rules (no em-dashes in user-facing copy, "cluster"
   never "k8s", no raw hex — tokens only). Layout: ADR-014/015 (two-step confirm widths,
   no reflow on interaction).

**Verify:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; `pnpm dev:local`
drive of: unified wall renders both formats, seg filters correctly, paired duo = one card
with coverage badge, audio-only anchor works, merged collection card + deduped drill,
Audiobooks URL redirect, Comics untouched. Playwright resize matrix on the wall
(advisory). Screenshots 390px + desktop for the owner.

## Stream B — Libretto (repo `thaynes43/libretto`, branch `feat/multi-target-recipes`)

1. **Recipe schema**: `targets: [{server, libraryId}]` (1..N, distinct servers enforced);
   back-compat: `targetLibrary` accepted + normalized to one-entry `targets` (45 live
   YAMLs stay valid); API emits `targets`. New optional `category` field.
2. **Marker**: produced collections carry `[libretto:<recipeId>|cat=<Category>]` when
   `category` is set (existing marker grammar — the hnet parse already reads `cat=`).
3. **Reconciler**: apply loop per target (kind mapping per D-07 unchanged); run counts per
   (recipe, target); `missing[]` entries gain the target they are missing FROM;
   `GET /collections` read-back tags each produced collection's target. Additive wire
   changes only.
4. **Acquisition leg**: unchanged confinement (three LL writes, cap 25/run, no provider
   config — structurally pinned). Per-format: a work missing from the ABS target but held
   in Kavita still wants ONLY per LL semantics (LL grabs both formats anyway — hnet R-180);
   no new LL surface.
5. **Tests** (temp-config idiom): two-target reconcile (add/remove/reposition per target),
   back-compat normalize, marker + cat emission, per-target missing split, orphan/delete
   semantics per target, statelessness (volume wipe converges).
6. **Release + deploy**: conventional commits → release-please → image tag; haynes-ops PR
   bumping `kubernetes/main/apps/media/libretto/` helmrelease tag (GitOps, never kubectl).
7. **Twin migration + author recipes** (after deploy): collapse the 5 twins (Kavita id
   survives; ABS twin deleted via `?deleteCollection=true`); land the 21 author recipes
   from Appendix A (`static_ids`, both targets, `category: Authors`, `ordered: false`,
   `acquisitionEnabled: true`). Resolve every canon title to identifiers at authoring time
   (Hardcover id / ISBN — the D-04 chain; a title that resolves to nothing stays listed
   with a `# unresolved` comment and rides the flagged fallback, never dropped silently).
8. **PR hygiene**: short PR; NO bare haynesnetwork doc IDs — full URLs or nothing
   (standing owner rule).

**Verify:** vitest green; staging: convert ONE twin first, apply, confirm marker + both
server collections + hnet mirror rows sharing the recipe id (and, once Stream A lands,
one merged card); then the rest + authors. Watch LL want volume stays cap-paced.

## Edge cases (both streams must hold these)

- **E-1 — one active want per (work, format) across origins.** Collection wants vs pairing
  wants for the same missing format must not double-mint: reuse-before-resolve on
  llBookId/normalized identity + the ref keys; assert in tests (Stream A domain, Stream B
  missing split).
- **E-2 — anchor rule totality:** paired ⇒ ebook row; unpaired ⇒ the sole row (audio-only
  anchors on the audiobook row). No card ever vanishes because it lacks an ebook.
- **E-3 — divergent pair metadata** (authors/genres differing across the duo): facets match
  on the UNION, display uses the anchor's values.
- **E-4 — twin migration continuity:** Kavita recipe id survives ⇒ mirror rows keep their
  `libretto_recipe_id`; the deleted ABS twin's row reconciles away next sync; the merged
  card never flickers to empty.
- **E-5 — comics isolation:** no format seg, no pairing, no multi-target acquisition;
  comic-majority collections keep their wall.
- **E-6 — markerless collections:** never merged, never categorized L1; L2 agent-set
  categories preserved by the shipped COALESCE.

## Appendix A — the Authors program seed (curated canon, owner-prunable)

One `static_ids` recipe per author, `category: Authors`, both targets. Canon = signature
works, not bibliographies (ruling R2). Franchise overlap with existing Universe/Sequels
collections is fine — membership is many-to-many; the chip row separates them.

1. **Isaac Asimov** — I, Robot; The Caves of Steel; The Naked Sun; The Robots of Dawn;
   Robots and Empire; Foundation; Foundation and Empire; Second Foundation; Foundation's
   Edge; Foundation and Earth; Prelude to Foundation; Forward the Foundation; The Gods
   Themselves; The End of Eternity; Nightfall; Pebble in the Sky.
2. **Arthur C. Clarke** — 2001: A Space Odyssey; 2010: Odyssey Two; 2061: Odyssey Three;
   3001: The Final Odyssey; Rendezvous with Rama; Childhood's End; The City and the Stars;
   The Fountains of Paradise; A Fall of Moondust; The Songs of Distant Earth.
3. **Frank Herbert** — Dune; Dune Messiah; Children of Dune; God Emperor of Dune; Heretics
   of Dune; Chapterhouse: Dune; The Dosadi Experiment.
4. **Robert A. Heinlein** — Starship Troopers; Stranger in a Strange Land; The Moon Is a
   Harsh Mistress; Double Star; The Door into Summer; Citizen of the Galaxy; Have Space
   Suit—Will Travel; Time Enough for Love; The Puppet Masters; Friday.
5. **Philip K. Dick** — Do Androids Dream of Electric Sheep?; The Man in the High Castle;
   Ubik; A Scanner Darkly; VALIS; Flow My Tears, the Policeman Said; The Three Stigmata of
   Palmer Eldritch; Martian Time-Slip; The Minority Report and Other Classic Stories.
6. **Ray Bradbury** — Fahrenheit 451; The Martian Chronicles; Something Wicked This Way
   Comes; The Illustrated Man; Dandelion Wine; The October Country.
7. **Ursula K. Le Guin** — A Wizard of Earthsea; The Tombs of Atuan; The Farthest Shore;
   Tehanu; Tales from Earthsea; The Other Wind; The Left Hand of Darkness; The
   Dispossessed; The Lathe of Heaven; The Word for World Is Forest.
8. **J.R.R. Tolkien** — The Hobbit; The Fellowship of the Ring; The Two Towers; The Return
   of the King; The Silmarillion; Unfinished Tales; The Children of Húrin.
9. **Brandon Sanderson** — Elantris; Warbreaker; Mistborn: The Final Empire; The Well of
   Ascension; The Hero of Ages; The Alloy of Law; Shadows of Self; The Bands of Mourning;
   The Lost Metal; The Way of Kings; Words of Radiance; Oathbringer; Rhythm of War; Wind
   and Truth; Tress of the Emerald Sea.
10. **Terry Pratchett** — The Colour of Magic; Mort; Wyrd Sisters; Guards! Guards!; Reaper
    Man; Small Gods; Men at Arms; Feet of Clay; Hogfather; Night Watch; Going Postal;
    Thief of Time; Good Omens.
11. **Neil Gaiman** — American Gods; Neverwhere; Stardust; Coraline; The Graveyard Book;
    Anansi Boys; The Ocean at the End of the Lane; Norse Mythology; Good Omens.
12. **Douglas Adams** — The Hitchhiker's Guide to the Galaxy; The Restaurant at the End of
    the Universe; Life, the Universe and Everything; So Long, and Thanks for All the Fish;
    Mostly Harmless; Dirk Gently's Holistic Detective Agency; The Long Dark Tea-Time of
    the Soul.
13. **Stephen King** — Carrie; 'Salem's Lot; The Shining; The Stand; The Dead Zone; Pet
    Sematary; It; Misery; The Green Mile; 11/22/63; Doctor Sleep; The Gunslinger; The
    Drawing of the Three; The Waste Lands.
14. **Agatha Christie** — The Mysterious Affair at Styles; The Murder of Roger Ackroyd;
    Murder on the Orient Express; The A.B.C. Murders; Death on the Nile; And Then There
    Were None; Evil Under the Sun; Five Little Pigs; Crooked House; Curtain: Poirot's
    Last Case.
15. **Michael Crichton** — The Andromeda Strain; The Terminal Man; Congo; Sphere; Jurassic
    Park; The Lost World; Airframe; Timeline; Prey; State of Fear.
16. **Andy Weir** — The Martian; Artemis; Project Hail Mary.
17. **John Scalzi** — Old Man's War; The Ghost Brigades; The Last Colony; Redshirts; Lock
    In; The Collapsing Empire; The Kaiju Preservation Society; Starter Villain.
18. **James S.A. Corey** — Leviathan Wakes; Caliban's War; Abaddon's Gate; Cibola Burn;
    Nemesis Games; Babylon's Ashes; Persepolis Rising; Tiamat's Wrath; Leviathan Falls.
19. **Martha Wells** — All Systems Red; Artificial Condition; Rogue Protocol; Exit
    Strategy; Network Effect; Fugitive Telemetry; System Collapse; Witch King.
20. **Dennis E. Taylor** — We Are Legion (We Are Bob); For We Are Many; All These Worlds;
    Heaven's River; Not Till We Are Lost; The Singularity Trap.
21. **Kurt Vonnegut** — Slaughterhouse-Five; Cat's Cradle; The Sirens of Titan; Breakfast
    of Champions; Mother Night; Galápagos.
