# PLAN-053: Collection Type facet on the Collections group view

- **Status:** Queued (owner feedback at the v0.63.0 live review, 2026-07-16: "we should be
  able to filter by Collection Type... doesn't have to be broken too far down —
  'Trilogies, Franchise/Universe, Director, Actor, List, Other' something like that").
- **Depends on:** 037 (shipped v0.63.0). Relates: 052 (provenance data could later come from
  the managed-file recipes directly), 051 (books collections get the same facet when mirrored).

## Shape

1. **Classifier, not curation:** a `collection_type` annotation column on `plex_collections`
   (read-model metadata — the mirrored-only doctrine untouched; nothing written to Plex),
   assigned at sync time by a rule classifier seeded from OUR Kometa estate's known
   provenance (research doc 2026-07-16):
   - `trilogy` — title matches "… Trilogy" (and obvious n-ology variants).
   - `franchise_universe` — the franchise/universe default outputs + the curated franchise
     file's names ("… Collection" franchise idiom).
   - `director` / `actor` — the movies-people.yml name lists (director/producer/writer fold
     into Director unless the owner wants a separate bucket; actor separate).
   - `list` — charts (IMDb Top 250, Trending, Popular, seasonal) + award defaults
     (Oscars, Golden Globes, …).
   - `other` — everything unmatched (honest default; never guess).
2. **Facet chips** on the Collections group level via the existing registry facet seam
   (ViewLevelKey `movies:grouped-collection` / `tv:grouped-collection` gain a `type` facet) —
   the chip bar the walls already use; URL param `?ctype=` replace-in-place per D-19.
3. Rules live in ONE versioned classifier module with unit tests per bucket; re-classify is
   idempotent at sync (rebuildable annotation).

## Open questions

- Q-01: buckets final? (Owner listed six; producer/writer collections exist in the people
  file — fold into Director or add a "Crew" bucket?)
- Q-02: should `list`-type (charts) be down-ranked/hidden by default on the group wall, or
  equal citizens? (Owner earlier: "mirror everything, filter later" — this facet IS the
  "filter later"; default-all seems right.)
