# PLAN-046: Kapowarr comics acquisition layer (owner-directed, 2026-07-14 ~01:15)

- **BUILT (Opus, 2026-07-14):** `@hnet/kapowarr` (read + confined `./write`), comic routing + reconcile +
  the dispatching force-search, migration 0046 (`comic_status`/`kapowarr_volume_id`/`comicvine_id`),
  `stub-kapowarr`, ADR-056 + DDD T-166 + PRD R-185..R-187 + DESIGN-028 amendment. Merge gate green (lint,
  lint:css, typecheck, test [domain 488 / api 387 / sync 75 / db 81 / kapowarr 9], build). ComicVine verified
  OPERABLE live. LIVE remediation done: both stray LL wants Skipped; both shelf comics monitored in Kapowarr
  (Scott Pilgrim cv 25478→vol 1; Legend-of-Batman cv 121720→vol 2); the two rows flipped to comic routing.
- **Status:** Completed — shipped #259 (confined @hnet/kapowarr, ComicVine routing live, comic force-search); OWNER RATIFIED 2026-07-15. Origin: owner ruling at the PLAN-045 question round ("Remove it and route
  comics to Kapowarr. I added them to my want so we have them there to rest comic acquisition on
  top of books. Dispatch Opus agents for this work tonight too but first they should at least
  show as Wanted in comics."). Opus build, same night.
- **Depends on:** PLAN-044 (v0.49.0 live). Coordinates with PLAN-045 (the UX layer): 046 owns
  the BACKEND comic-acquisition surface; 045 renders comics-Wanted tiles + wires its
  force-search button to 046's endpoint. Build order tonight: 046 backend may land before or
  parallel to 045 — the tRPC surface contract below is the interface.
- **Saga:** PLAN-043 — this is the comics-source leg the Books Automation Saga (PLAN-032) has
  carried as a mandate ("comics-source hunt"); F-08 comic re-grabs become this machinery's first
  backlog workload once routing exists.

## Scope

1. **Confined Kapowarr client — new `@hnet/kapowarr`** (the @hnet/lazylibrarian precedent):
   read (search volumes, wanted/monitored state, queue/status) + `./write` import-confined to
   `packages/domain` (add volume / monitor / trigger search). Kapowarr is the comics *arr
   (deployed by PLAN-023 on gasha01; check `docs/ops/013-mam-books-acquisition.md` + the
   PLAN-023 as-built for URL/API-key location — the key rides the downloads/media namespace
   secret estate; if the frontend ExternalSecret needs a `KAPOWARR_API_KEY` addition, note the
   1P item + property for the coordinator's haynes-ops commit, DON'T touch haynes-ops yourself).
2. **VERIFY KAPOWARR OPERABILITY FIRST (read-only):** PLAN-023 left "ComicVine key" as an owner
   TODO — if Kapowarr has no ComicVine API key wired, volume search/matching may be dead. Probe
   the live instance read-only; if ComicVine is missing, BUILD the layer anyway against the API
   contract + stubs, mark the live leg blocked, and surface "ComicVine key needed (1P + Kapowarr
   settings)" as the owner unblocker in your report.
3. **Comic request routing (domain):** comic-classified `book_requests` (state
   `unroutable_reason='comic'`) get a real path: match/add the volume in Kapowarr (ComicVine id
   via GB/classification signals where derivable, else Kapowarr's own search), monitor it, and
   reconcile Kapowarr state back into the request row (`comic` format status:
   requested|wanted|grabbed|landed|missing — extend `BOOK_REQUEST_FORMATS`/statuses as the ADR
   amendment dictates). The goodreads-sync mode routes comics through this instead of parking
   (parking remains the fallback when Kapowarr is unreachable/blocked).
4. **Force-search surface:** `integrations.search` (or a sibling procedure) gains the comic leg —
   fires Kapowarr's search for the volume, audited like `request_book_search`. THIS is the
   endpoint PLAN-045's Library force-search button calls for comics (books/audio legs already
   exist via LL).
5. **The stray want:** delete the ONE mis-routed comic book-want from LazyLibrarian live
   (owner-ruled; identify it from `book_requests` — the pushed comic from the first sync), set
   its request row back to comic routing. Log exactly what was removed.
6. **Docs:** ADR-055 amendment or next-free ADR (comic routing + the confined Kapowarr write),
   DDD/glossary + PRD rows per docs-first; e2e stub `stub-kapowarr.ts` in the harness (hard
   rule: every new external system gets a stub) + spec coverage of route/reconcile/force-search.

## Hard constraints

- Kapowarr acquisition uses ITS OWN sources (GetComics DDL primarily) — it must NOT be wired
  anywhere near MAM/qBittorrent/Prowlarr/the governor. LL provider config untouchable as always.
- Mirror purity stands (books_items/comics untouched by requests — composition per PLAN-045 A2).
- Single-writer + audit-in-same-tx; import-confined write; guard list for any new table/columns.
- Live actions in THIS plan: read-only probes + the ONE stray-want deletion + (if operable)
  routing the two real shelf comics. Nothing else mutates live systems.

## Acceptance

1. Stub-backed: comic-classified request → Kapowarr add/monitor → reconcile → force-search
   round-trip, all unit/e2e green.
2. Live (if ComicVine key present): the owner's two shelf comics (Scott Pilgrim vol 1, Batman
   Zero Year) are monitored WANTED in Kapowarr, their request rows show `comic: wanted`, and the
   stray LL want is gone. If the key is absent: everything staged, owner unblocker surfaced.
3. PLAN-045's Comics wall shows them as Wanted (rendering is 045's acceptance; the data must be
   right here).
