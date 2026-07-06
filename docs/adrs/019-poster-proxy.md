# ADR-019: Poster serving — an authed server-side PROXY, no image storage

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (autonomous run, KICKOFF mandate)

## Context and problem statement

Library shows ~17,700 media items. Each wants a small poster. The posters must NOT be
hot-linked from the browser to TMDB / the *arrs (CLAUDE.md privacy intent — the backend URLs and
API keys must never reach the client), and they must render without reflowing the grid (ADR-015).
The question is where the bytes come from and whether we store them.

The *arrs already maintain **pre-resized MediaCover variants** (verified live 2026-07-06:
`GET /api/v3/mediacover/{id}/poster-250.jpg` on Radarr/Sonarr and
`GET /api/v1/mediacover/artist/{id}/poster-250.jpg` on Lidarr both return `200 image/jpeg`), and
tombstoned / lookup-sourced items carry a TMDB `poster_path` we can serve off the TMDB CDN
(`https://image.tmdb.org/t/p/w342{path}`).

## Decision drivers

- **Privacy / key safety.** The *arr API keys and internal URLs must stay server-side.
- **No new infra weight.** A PVC of thumbnails means RWX storage, backup bloat, an eviction/orphan
  policy, and image-processing deps in the standalone image + CronJob.
- **No reflow (ADR-015).** A poster's box must reserve its space so a late load never shifts the
  grid; a miss must fall back to the KindIcon, never a broken `<img>`.
- **The *arrs already do the resizing.** We would be duplicating a cache they maintain.

## Considered options

1. **Authed proxy route, no storage** — a Next.js route streams the poster server-side from the
   owning *arr's pre-resized MediaCover variant (API key in a header) or the TMDB CDN.
2. **PVC of resized WebP thumbnails** (fetch → `sharp` resize → store → serve from the volume).
3. **Postgres `bytea`** column holding the image bytes.

## Decision outcome

Chosen option: **the authed proxy route, no storage** — because the *arrs already keep resized
covers, so storing our own is redundant; it keeps keys/URLs server-side; it adds zero storage,
backup, or image-processing surface; and it degrades cleanly (a 404 → KindIcon). Options 2 and 3
were rejected: the PVC adds RWX storage + backup bloat + an orphan/eviction policy + `sharp` in
the image and the CronJob for a cache the *arrs already maintain; `bytea` bloats the DB and its
backups with ~17.7k binary blobs and couples image bytes to row reads. The privacy/offline-DR
intent is met by the proxy (browser never sees an upstream URL) without paying storage costs.

### The route (DESIGN-008 D-11)

`apps/web/app/api/posters/[mediaItemId]/route.ts` (Node runtime): **session-checked** (mirrors the
tRPC mount — `getServerSession`; unauthenticated → 401, NOT a public endpoint). It resolves the
poster upstream via `@hnet/api resolvePosterUpstream` (which does the DB lookup + `@hnet/arr`
config, keeping drizzle/arr coupling out of the app route), then streams:

- `poster_source = 'arr'` → `{*arr baseUrl}/api/v{3|1}/mediacover/{arrItemId}/poster-250.jpg`
  with the `X-Api-Key` header server-side. `arrItemId` is read fresh from `media_items` so an
  *arr rebuild (new internal id) self-corrects.
- `poster_source = 'tmdb'` → `https://image.tmdb.org/t/p/w342{poster_ref}`.

Response: content-type passthrough, `Cache-Control: private, max-age=86400,
stale-while-revalidate=604800`, and an `ETag` derived from `poster_source:poster_ref` (the *arr
url carries `?lastWrite`, so the ETag changes when the poster changes; a matching
`If-None-Match` returns 304). Any miss (no metadata, unresolved ref, unreachable upstream,
*arr env absent) → **404**, and the UI shows the KindIcon fallback.

`poster_ref` stores the *arr relative MediaCover url (carries `?lastWrite` for the ETag) for the
`arr` tier, or the TMDB `poster_path` for the `tmdb` tier; `poster_source` picks the branch.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: zero image storage — no PVC, no backup bloat, no `sharp`, no eviction policy; the *arrs' resized cache is reused. |
| C-02 | Good: *arr keys + internal URLs never reach the browser; the endpoint is session-gated. |
| C-03 | Good: a miss is a clean 404 → KindIcon; an un-primed cache never breaks Library. |
| C-04 | Neutral: each poster is a proxied request per view; `private, max-age=86400` + ETag/304 keep it cheap, but there is no CDN edge cache (private). |
| C-05 | Bad: a slow/unreachable *arr adds latency to the miss path (10s timeout → 404); acceptable for a thumbnail. |

## More information

ADR-018 (metadata modeling — `poster_source`/`poster_ref` live on `media_metadata`);
DESIGN-008 D-11; ADR-015 (no reorientation — the fixed 2:3 poster box); PRD-001 R-69.
