# PLAN-043: The Integration Tab Saga (master)

- **Status:** SAGA MASTER — owner-specified 2026-07-13 (session 6, verbal spec + four MVP rulings
  the same night). This file is the umbrella; each phase ships as its own numbered plan. The MVP
  is **PLAN-044 (Goodreads → book/audiobook requests + Missing)**, dispatchable overnight.
- **Owner's big picture (5 points, near-verbatim):**
  1. **Integrations tab** — people link external accounts (Goodreads, Netflix, …) and we pull
     read / watched / wanted / watchlisted data out of the walled gardens into our FOSS ecosystem.
  2. **Predictions** — feed ALL linked sources (books read, shows watched, …) into a model that
     predicts "what to watch" / "what to read" across every media type.
  3. **Content syncing** — show each user what % of their integrations' watched/read content our
     estate holds ("can we be your source?"); sync watch/read states against the integrations;
     retain what they consumed that we DON'T have so we can update when we get it; sync their
     wanted lists so we hold what they want.
  4. **Missing for books/audiobooks** — wanted-but-not-found items become **Missing** (the *arr
     idiom) and support manual re-search.
  5. **Book ⇄ audiobook pairing** — attempt a copy of EACH format per title; the one we lack is a
     Missing entry. Library items with both show "Listen on Audiobookshelf" AND "Read in Kavita";
     otherwise one active button plus "Search for …" on the missing format.

## Phase map (each = a future numbered plan; numbers assigned at authoring)

| Phase | Scope | Status |
|---|---|---|
| **MVP — PLAN-044** | Goodreads linking (owner first) → shelf RSS sync → dedupe vs library → requests queued BOTH formats → **Missing** view + manual search + coverage % | **SHIPPED** (v0.49.0 + the #258 acceptance fixes) |
| Integration framework | Second provider generalization (provider registry, per-user link UX hardening, sister + member rollout, per-role visibility) | **Structure pulled forward by PLAN-045** (ADR-057/DESIGN-029): the hub + provider-sub-section shape is BUILT (future providers slot in as sibling cards); the second-provider registry + rollout remain |
| Content syncing (pt 3 full) | Read/watch-state reconciliation vs integrations; "we don't have it yet" retention + auto-clear on arrival; coverage across ALL providers | **First slice SHIPPED by PLAN-045** (all four shelves sync AND acquire — A1 overruled; per-shelf coverage + the composed Library-Wanted retention view); read/watch-state reconciliation + cross-provider coverage remain |
| Book ⇄ audiobook pairing (pt 5) | Format-pairing model over books_items; dual/single+search detail buttons; Missing entries per absent format | **IN BUILD — PLAN-050** (owner green-lit 2026-07-16; auto-mint estate-wide ruling, paced) |
| **Books collection-manager app** ("Kometa for books") | SEPARATE application, own repo/release train. Owner rulings 2026-07-16: it owns BOTH acquisition lists AND collections, "just like Kometa does"; modeled on the Kometa idiom (config YAML, list builders, defaults + template_variables, schedules); collections WRITE INTO Kavita/ABS (the mirrored-only doctrine, ADR-064 — hnet's PLAN-051 mirror displays them with zero site changes); missing list/series items become LL wants (the "drive content in" driver; series-completion is the flagship builder). Standalone-valuable to non-hnet users (modularity ruling). hnet integrates ONLY via the provider-agnostic collection-manager surface (PLAN-052 R2 parity contract, implemented from day one). Kometa deep research dispatched 2026-07-16 → `.agents/context/2026-07-16-kometa-integration-research.md`. | Research running; scope after PLAN-037/050/051 land |
| Streaming integrations | **Trakt is the realistic API** for watched/watchlist TV+movies; Netflix has NO API (CSV viewing-history import only). Feeds the same coverage/missing machinery | Research first |
| Predictions (pt 2) | Cross-media recommendation model over all integration + estate data (estate already runs Open WebUI/Ollama if we want local inference) | PARKED until data phases land |

## Hard facts the saga is built on (from `.agents/context/2026-07-11-books-list-sources-research.md`)

- **The Goodreads API is dead (retired 2020, no new keys).** The durable access path is
  **public per-shelf RSS** (one of only three low-fragility list sources found). Shelves must be
  PUBLIC; linking = profile/user-id, no OAuth, no secrets.
- **Goodreads is pull-only** (no write API) — saga point 3's "sync our states against them" is
  one-directional for Goodreads: we ingest; we never push.
- **LL-native wishlists exist but are ruled OUT as the integration path** (owner ruling
  2026-07-13): Prowlarr's fullSync **owns** LL provider config (OPS-013 discovery), so per-user
  RSS providers in LL risk clobber. Ruling: **app-side end-to-end** — our sync polls RSS, our DB
  stores shelf state, requests push via the proven LL API pattern.
- **The acquisition posture is unchanged:** SABnzbd/usenet rips immediately; MAM stays behind the
  PLAN-039 governor; Google-Books enrichment always retry/backoff; `queueBook` after `addBook`
  (addBook alone lands `Skipped`); `searchItem` ≠ title search.

## Relationship to existing plans

- **PLAN-033 (book requests + wanted view):** its request mechanism is SUBSUMED by PLAN-044
  (Goodreads want-to-read shelf = the request intake; the wanted/missing view ships in 044).
  Close 033 into 044's completion record when the MVP ships.
- **PLAN-032 (list-driven automation / Books Automation Saga):** REMAINS SEPARATE — charts/lists
  (NYT, awards, curation) are editorial sources, not personal integrations. It shares 044's
  confined LL write client and Missing primitives when it builds. The separate-app-vs-in-app
  question stays open THERE; the Integration Tab is in-app by owner spec ("new tab").
- **PLAN-041 (Library Fix for books):** 044's manual re-search on Missing IS the first confined
  acquisition-layer write it anticipated; 041 continues for the on-disk-but-defective Fix case.
- **PLAN-029 (shipped v0.47.0):** the per-user prefs + watch/read-state seam (ADR-052/053) is
  the substrate saga point 3 reconciles against.

## Open questions (saga-level, NOT blocking the MVP)

- **Q-01:** second book provider — Hardcover (native GraphQL API, low fragility per research) or
  StoryGraph (no API)? Hardcover leads on merit.
- **Q-02:** Trakt vs Plex-native watch history for streaming-side integration — Trakt adds
  out-of-estate (Netflix-watched) data, which is the point of the saga; scope a research spike.
- **Q-03:** predictions substrate — local (Ollama/estate) vs API model; parked until the data
  phases land.
- **Q-04:** per-role visibility of the Integrations tab once members link (privacy: a user's
  linked-account data visible to admins + self only?). MVP ships admin-only, mooting it until
  rollout.
