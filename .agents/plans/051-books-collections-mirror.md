# PLAN-051: Books collections mirror (Kavita + Audiobookshelf)

- **Status:** Queued (owner-ratified roadmap, 2026-07-16 — "collections for books is a big one").
  Phase 2 of the collections program; build after PLAN-037 ships (reuses its pattern + registry
  idiom end to end).
- **Depends on:** 037 (mirror pattern, group-by seam, gating discipline). Relates: 050 (format
  pairing feeds series/format coverage), 043 (the future books app WRITES the collections this
  plan displays).

## Scope

Mirror the collections that already exist in the book sources of truth, exactly the way
PLAN-037 mirrors Plex collections (the owner's mirrored-only doctrine — ADR-064):

1. **Kavita Collections** (and Reading Lists if the API shape cooperates — reading ORDER
   matters for series) → the Books + Comics walls.
2. **Audiobookshelf collections** → the Audiobooks wall.
3. Surface as the same "Collections" group-by view dimension the 037 registry rows added for
   Movies/TV — group cards with accessible counts, drill-in walls, no new nav.
4. Sync: a standalone mode in the 037 idiom (upsert + scoped reconcile; rebuildable derived
   cache; guard-listed; no audit rows).

**The quick win this unlocks:** a hand-curated collection in Kavita ("Harry Potter
Collection") appears on the site on the next sync — no waiting for the books app. When the
PLAN-043 books app later writes collections into Kavita/ABS programmatically, this mirror
displays them with ZERO site changes.

## Open questions

- Q-01: Kavita Reading Lists vs Collections — RESEARCH INPUT (2026-07-16): Kavita
  collections are UNORDERED; reading lists carry explicit positions (update-position API);
  ABS collections ARE ordered. Lean: mirror BOTH Kavita concepts, rendering reading lists
  as ordered collections (reading order is the series case).
- Q-02: cross-source collection identity — a series existing in BOTH Kavita and ABS (ebook +
  audio) shows as two collections or one merged card? (PLAN-050 pairing data could merge;
  lean: two honest source-scoped collections v1, merge later.)
