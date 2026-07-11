# ADR-048: TV season/episode art from the matched Plex title — a signed, item-scoped transcode-proxy reference

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Tom Haynes (owner request + PLAN-030 approval 2026-07-11) · ratified by Fable 5 (PLAN-030 build run)
- **Relates:** REUSES the [ADR-047](047-library-play-here-access-aware-deep-links.md) `media_plex_matches`
  *arr→Plex match (the ratingKey + library that just shipped) as the ART SOURCE, and its per-library access
  gate (`resolveLibraryAccessGate` / `isMediaItemAccessibleToUser`) VERBATIM (does NOT reinvent access);
  REFINES the [ADR-041](041-ytdlsub-poster-streamlining.md) photo-transcode proxy (fixed-size WebP variants +
  in-process LRU + strong ETag) to run on the MATCHED server, not just k8plex; adopts the [ADR-019](019-poster-proxy.md)
  "never store art" posture. Realized by [DESIGN-005](../designs/005-arr-ledger-and-fix.md) D-24 (TV) +
  [DESIGN-017](../designs/017-ytdlsub-library.md) D-09 amend (Peloton season poster). Implements PRD **R-158**;
  glossary **T-142**.

## Context and problem statement

The show-detail page's Seasons table is text-only: a season row shows a title + on-disk badge, and an
expanded season shows text-only episode rows. Meanwhile the Peloton/YouTube drill-in (ADR-038/041) already
paints episode STILLS. The owner wants parity: **(1)** a small season-poster icon in each season row (TV +
Peloton), and **(2)** TV episode thumbnails matching Peloton's.

The art must come from **Plex** — the exact poster/still a user sees in their Plex apps — with **no new
external API** (a TMDB re-fetch would duplicate what Plex already gives us now that ADR-047 links each
`media_item` to its Plex ratingKey). Two facts make it possible and one makes it delicate:

1. **ADR-047 just shipped `media_plex_matches`** — for a matched TV item we now have `{plex_library,
ratingKey}` on a specific server, so we can read the show's season children (season thumbs) and a season's
   episode children (episode stills) READ-ONLY from that server.
2. **ADR-041's transcode proxy already turns a 2.35 MB Plex JPEG into a ~3.5 KB WebP** and memoizes it — but
   it is hardwired to the single k8plex server and gated on the coarse `ytdlsub` section.
3. **THE INVARIANT (ADR-047):** a user must NEVER receive art for a title in a Plex library their role can't
   access. A TV show's season/episode art is a **parallel leak vector** (art by thumb path), exactly like the
   poster proxy ADR-047 closed. A naive proxy that trusts a client-supplied `thumb` path + gates only on a
   separate accessible item id would let a caller pass an accessible item but an INACCESSIBLE sibling title's
   thumb on the same server (a server hosts several libraries; a role may hold only one).

## Decision drivers

- **One art source (Plex), no new dependency.** Reuse the ADR-047 match; no TMDB harvest for stills.
- **Reuse the transcode/LRU/ETag machinery** (ADR-041) — don't build a second image path; just parameterize
  the server.
- **Uphold THE INVARIANT tightly** — "hard to guess a sibling thumb" is not "prevented." Art must be servable
  ONLY when bound to an item the caller can access.
- **Efficiency** — season posters + a season's episode stills should cost ONE Plex metadata read each (in the
  tRPC endpoint), not one read per art request.
- **Reflow-free (ADR-015), no new hex (hard rule 2), read-only (hard rule 4).**

## Considered options

- **A — Proxy trusts a client `thumb` + a separate item-access gate (the ytdl-sub shape).** Rejected for TV:
  the ytdl-sub proxy is safe because its two libraries gate as a unit, but TV art is per-library — a caller
  could fetch an inaccessible sibling library's thumb on the same server while presenting an accessible item.
- **B — Proxy derives the thumb itself from `(item, season[, episode])` by reading Plex per art request.**
  Fully safe (no client thumb) but read-heavy: a 20-episode season = ~40 Plex metadata reads per expand.
- **C — A SIGNED, item-scoped thumb reference (chosen).** The tRPC endpoint — which has ALREADY passed the
  per-item access gate to read the thumb from Plex — mints an HMAC over `(mediaItemId, serverSlug, thumb,
size)`. The proxy verifies the signature AND re-checks item access, then transcodes. One Plex read per
  season-list/episode-list in the endpoint; art requests are stateless verifies + transcodes.

## Decision outcome

Chosen option: **C** — TV season/episode art is sourced from the ADR-047 match and served through a
**signed, item-scoped** extension of the ADR-041 transcode proxy.

- **The source.** `resolveArtMatchForItem(db, gate, mediaItemId)` returns the FIRST accessible match's
  `{serverSlug, ratingKey}` (the same accessibility filter + ordering as `resolvePlexPlayTargets`). Two new
  read-only ledger endpoints navigate the matched title on that server: `ledger.plexSeasons` (the show's
  season children → season thumbs, keyed by season number) and `ledger.plexEpisodeArt` (a season's episode
  children → episode stills, keyed by episode number, lazily per expanded season). Both re-gate the item
  (`itemAccessById` → NOT_FOUND for a hidden item) and degrade to `available:false` (no icons) on unmatched /
  inaccessible / Plex-unreachable — never a crash. **Peloton** season posters come the same way but simpler:
  the ytdl-sub drill-in already reads the season children live from k8plex, so `ytdlsub.detail`'s season shape
  just gains the existing `/api/ytdlsub/poster?...&size=grid` URL — no new proxy.
- **The proxy** (`/api/library/plex-art`). Session-gated, then: (1) **verify the HMAC** — the thumb was minted
  by our server for THIS item on THIS server at THIS size; (2) **re-check item access** — `isMediaItemAccessibleToUser`
  (defence in depth: a revoked grant stops art immediately); (3) resolve the matched server's config and
  stream the fixed-size WebP transcode variant (token header-only), original-art fallback, strong
  `(server, size, thumb)` ETag, shared in-process LRU (server-prefixed key). The size set is the SAME closed
  allow-list as ytdl-sub (`grid` season poster / `still` episode row) — single-sourced in `ytdlsub-poster.ts`.
- **Signing secret:** `BETTER_AUTH_SECRET` (the app already requires it in-cluster); mint (tRPC) + verify
  (proxy) run in the same Next.js process, so the signature never crosses a boundary. No new schema, no new
  external API, no image storage.
- **Fallbacks (PLAN-030 Q-01/Q-02):** an unmatched TV show (in the *arr, not yet in Plex) → no icon (no TMDB
  fallback — one source); a season/episode with no Plex art → the reserved tinted box / no icon.

### Consequences

| ID   | Consequence                                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | Good: TV finally shows the exact season/episode art users see in Plex, with ZERO new external API — reusing the ADR-047 match + the ADR-041 transcode/LRU/ETag path.                                                                                              |
| C-02 | Good: THE INVARIANT holds for art. The signature binds the thumb to an item the minting endpoint already access-gated; the proxy re-checks access. A caller cannot fetch an inaccessible sibling title's thumb (option A's hole), nor probe arbitrary ratingKeys. |
| C-03 | Good: one Plex read per season-list / per expanded season (not per tile); art requests are cheap verifies + transcodes, 304/LRU on repeats.                                                                                                                       |
| C-04 | Neutral: episode↔still correlation is by `(season, episode)` NUMBER (the *arr `episodeNumber` now rides `ledger.children`); a numbering divergence between Sonarr and Plex just yields no still for that row (tinted box) — never a wrong thumb, never a crash.   |
| C-05 | Bad/accepted: the art depends on the ADR-047 match being populated (the `plex-match` CronJob) and on Plex reachability; a miss degrades to the pre-030 no-icon layout, never an error.                                                                            |
| C-06 | Neutral: `BETTER_AUTH_SECRET` gains a second use (art-ref signing). It is already required in-cluster; the dev fallback keeps mint+verify consistent in dev:local.                                                                                                |

## More information

- Realized by **DESIGN-005 D-22** (TV season posters + episode thumbs) and **DESIGN-017 D-09** (amended — the
  Peloton season-row poster). No migration (all derived from `media_plex_matches` + live Plex reads).
- Enforcement / seam points: `packages/api/src/library-plex-art.ts` (sign/verify + the matched-server
  transcode resolver), `packages/api/src/library-access.ts` (`resolveArtMatchForItem`), `ledger.plexSeasons` /
  `ledger.plexEpisodeArt` (`packages/api/src/routers/ledger.ts`), `ytdlsub.detail` season `posterUrl`
  (`packages/api/src/routers/ytdlsub.ts`), the `apps/web/app/api/library/plex-art/route.ts` proxy.
- Proof: `packages/api/__tests__/library-plex-art.test.ts` (sign tamper-rejection + the matched-server
  transcode variant), `packages/api/__tests__/ledger-plex-art.test.ts` (season posters + episode stills
  end-to-end through the router + the withheld-item NOT_FOUND re-gate), `library-access.test.ts`
  (`resolveArtMatchForItem` respects the gate), plus the ytdl-sub season-poster assertion.
