# PLAN-053: Collection Type facet — six-bucket annotation + Type chips on the Collections walls

- **Status:** Completed (v0.65.0, 2026-07-16 eve — feat #323, release #321, haynes-ops #2074; LIVE: all 461 collections classified on the post-deploy sync, Type chips live on Movies/TV Collections views). Was: BUILT (2026-07-16 — docs + code on `feat/plan-053-collection-type`, committed
  locally, awaiting coordinator review/PR). Docs: DESIGN-035 **D-10/D-11 amendment** (NO new
  ADR — this is an annotation + facet on ADR-064's read-model, the ADR-039-refines-ADR-037
  precedent) + PRD **R-214** + glossary **T-186**.
- **Owner rulings (2026-07-16, FINAL):**
  - **Six buckets** — Trilogies, Franchise/Universe, Director, Actor, List, Other;
    **producer/writer fold into Director**.
  - **The wall shows ALL types by default**; the chip FILTERS — it is never hidden
    (a 0-count chip still renders).
- **Relates:** PLAN-037 (the mirrored-collections read-model this annotates — ADR-064 /
  DESIGN-035, shipped v0.63.0), ADR-047 (THE INVARIANT — chip counts are gated exactly like
  cards), ADR-051 C-01 (registry-row seam), DESIGN-026 D-19 (replace-in-place refinement),
  `.agents/context/2026-07-16-kometa-integration-research.md` §4 (the estate whose outputs
  seed the classifier's name lists: `movies-people.yml` director/actor sections; the
  universe/seasonal/oscars/golden Defaults; the charts/franchises/lists git files).

## Executed shape (2026-07-16 build — the docs are normative, this is the file map)

- **Docs (docs-first, same branch):** DESIGN-035 gains **D-10** (the `collection_type`
  annotation + versioned classifier) and **D-11** (the `?ctype=` Type chip row — server-side
  card filtering + UNFILTERED gated `typeCounts`); D-03/D-09 amended in place; PRD R-214;
  glossary T-186 + changelog.
- **DB:** migration `0055_collection_type.sql` — `plex_collections.collection_type text NOT
  NULL DEFAULT 'other'` + CHECK over the six values; `COLLECTION_TYPES`/`CollectionType` in
  `@hnet/db` enums; schema column on `plex-collections.ts`; migration-test 0055 block
  (default bites, CHECK rejects).
- **Domain:** `packages/domain/src/collection-type.ts` — ONE versioned pure classifier
  (`classifyCollectionType`, `COLLECTION_CLASSIFIER_VERSION = 1`), rule order
  trilogy → franchise/universe → director/actor (estate-seeded known-name lists) → list
  (charts + awards + decade/seasonal) → honest `other`. Applied in `syncPlexCollections` at
  upsert (insert AND conflict-update — recomputed every sync, rebuildable). Unit suite per
  bucket with REAL estate names + ambiguous-cases-stay-`other`; sync test proves persistence
  + recompute-on-retitle.
- **API:** `ledger.collectionGroups` input gains optional `ctype`; wire gains per-card
  `type` + `typeCounts` (accessible-collection counts computed BEFORE the `ctype` narrowing);
  filtering is server-side. Invariant tests extended (gated counts, all-withheld collections
  count for nobody restricted).
- **Web (registry rows + one chip row):** the `movies:grouped-collection` /
  `tv:grouped-collection` levels declare exactly ONE facet
  `{ key:'collectionType', label:'Type', kind:'select', param:'ctype' }`;
  `COLLECTION_TYPE_OPTIONS` label map (Trilogies · Franchise & Universe · Director · Actor ·
  Lists · Other). `MediaBrowser` renders the always-visible single-select chip row (All
  default) from the registry declaration, `?ctype=` replace-in-place (D-19); chips recolor
  (`is-active`), never reflow (ADR-015); zero new CSS (the `.library-chipbar`/`.seg` skins).
  Registry asymmetry test updated to pin the new declared truth.

## Verification

Five-green gate on the branch: `pnpm lint` + `pnpm lint:css` + `pnpm typecheck` +
`pnpm test` + `pnpm build`.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Should the classifier consult Kometa metadata (radarr_tag DirectorCollection/ActorCollection, sort_title prefixes) instead of titles? | Deferred — the mirror stores titles only (ADR-064 wire); tags/sort_titles don't survive the Plex `/collections` read we mirror. The versioned classifier + estate-seeded lists cover today's estate; revisit if the estate grows names the patterns miss (they land honestly in Other). |
| Q-02 | Per-collection manual type override? | Deferred by the same R3 posture as PLAN-037 Q-01 (display knobs designed after the owner sees it live). The annotation column is recomputed each sync, so an override would need its own column — do not overload `collection_type`. |

## Amendment — owner mobile review (2026-07-17, feat/collection-chips-mobile)

The owner reviewed the live Type chips on his phone and directed four polish changes. All are
DISPLAY-only; the `collection_type` stored keys, the classifier, and the DB are untouched (stable
IDs — CLAUDE.md doctrine). Shipped on `feat/collection-chips-mobile`:

1. **Per-chip counts removed.** The `(N)` suffix bloated the row on mobile. A global total (ONE
   number, not per-category) is backlogged (`.agents/plans/TODO.md`) — the owner's call: "if we
   were going to do totals we'd do it globally." The gated `typeCounts` still ride the wire
   (`ledger.collectionGroups`) — the ADR-047 gated-count invariant test stays; the number is just
   no longer painted per chip. Seed for the backlogged global count.
2. **"Franchise & Universe" → "Franchise"** (label map only, `COLLECTION_TYPE_OPTIONS`) so the row
   fits a 320px phone. The `franchise_universe` key is unchanged.
3. **Trilogies hidden on TV.** New `collectionTypeOptionsForWall(wall)` drops the `trilogy` chip on
   the TV wall (movies keep all six). `?ctype=trilogy` URL validation still accepts the key (deep
   links are honest — the TV server filter just returns an empty grid).
4. **Mobile fit.** After 1–3 the row is short; `.library-chipbar > .seg { flex: none }` +
   `white-space: nowrap` on its buttons keep the pill content-sized and one-line, and the existing
   `.library-chipbar` horizontal pan (ADR-015: fixed-height, never reflows the grid) is the
   overflow fallback — matches the Tickets `.twall-bar .seg` idiom.

### Trilogies diagnosis (owner flagged "doesn't seem to work") — data-backed

Queried the live estate (461 collections, frontend-ns Job against `plex_collections`). The movie
`trilogy` bucket holds exactly **1** collection: **"The Barrytown Trilogy"** — and it has
`child_count = 2`, so it isn't even a full trilogy; it matched purely on the literal word
"Trilogy" in its title. It is the ONLY collection in the whole estate whose title contains a
`…logy` word.

Root cause: **this estate names its collections BARE** — just the franchise name, no "Trilogy" and
no "Collection" suffix. (The "titles ending in `collection`" query returned ZERO movie rows — the
`franchise_universe` bucket's 21 movies matched via `…verse` / `Saga` / the universe name-list, not
the `Collection$` tail.) So the classifier's title-only `TRILOGY_RE` can never find the real
trilogies — they're named "Back to the Future", "Men in Black", "Ocean's", "Paddington", etc.

Is there a safe fix? **No.** 70 movie collections have exactly 3 mirrored members, but member-count
= 3 is NOT a trilogy signal: that same set includes "Iron Man", "Guardians of the Galaxy",
"Batman (DC Universe Animated)", "Avatar" — franchise entries and coincidences, not owner-sense
trilogies. Per the plan's own guardrail (member-count-3 + franchise-shaped name ≠ trilogy — do not
overreach), and because the mirror carries titles only (no Kometa tags/sort_titles — Q-01), there
is no conservative title rule that separates trilogies from franchises. **Verdict:** trilogies
genuinely barely exist as such in the mirrored data; the classifier is left UNCHANGED and the
bucket stays honest for movies (hidden on TV). Revisit only if Q-01 (consult Kometa metadata)
is ever taken up.
