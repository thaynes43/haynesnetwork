# ADR-041: ytdl-sub poster streamlining — Plex photo-transcode variants + in-process LRU + ETag revalidation

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes (owner UX review 2026-07-10 AM) · ratified by Fable 5 (ytdl-sub UX package run)
- **Relates:** [ADR-038](038-ytdlsub-library-direct-plex-read.md) (the direct-Plex read model + the
  Plex-thumb proxy this **refines** — specifically C-06's "stream the full thumb, no image storage"
  posture), [ADR-019](019-poster-proxy.md) (the authed poster-proxy pattern + its "never store posters"
  driver and ETag/304 mechanics, which this adopts for Plex thumbs), [DESIGN-017](../designs/017-ytdlsub-library.md)
  (amended with D-07..D-09 in the same change). Implements PRD **R-131**; glossary **T-120**.

## Context and problem statement

The PLAN-022 ytdl-sub walls (ADR-038) render far slower than the Movies|TV|Music walls. The owner's
morning review (2026-07-10): users "sit at a broken screen" waiting for icons on the YouTube (71 shows)
and Peloton (12 shows) tabs.

Root cause, measured live against k8plex from the deployed v0.33.0 pod:

- The **Movies|TV|Music** walls stream the owning \*arr's **pre-resized `poster-250.jpg` MediaCover
  variant** (or the TMDB `w342` CDN variant) with a **strong ETag** → repeat visits are 304s
  (ADR-019 / DESIGN-008).
- The **ytdl-sub** proxy (`/api/ytdlsub/poster`, ADR-038 C-06) streams the **original full-size Plex
  art** per request, with `Cache-Control` but **no ETag** and **no server-side reuse**. Peloton class
  art is **2.1–3.0 MB per JPEG** — the 12-tile Peloton wall moves **27.9 MiB**; the 71-tile YouTube
  wall moves **6.6 MiB**. Every page view re-pulls every byte through the Node proxy.

Two facts open a cheap exit:

1. **k8plex's photo transcoder works and is token-gated** (verified live 2026-07-10):
   `GET /photo/:/transcode?width=&height=&minSize=1&upscale=1&format=webp&url=<plex-path>` accepts the
   `X-Plex-Token` **header**, 401s without it, and turns the 2.35 MB Bike Bootcamp poster into a crisp
   **3.5 KB 300×450 WebP** (`format=webp` is the lever; the `quality` param is ignored — JPEG output
   stays 147 KB). Whole-wall totals: Peloton **27.9 MiB → 45 KiB (630×)**, YouTube **6.6 MiB → 836 KiB
   (8×)**.
2. **Plex thumb paths are self-versioning.** Every `thumb` is `/library/metadata/{id}/thumb/{lastWrite}`
   — the path **changes when the art changes**, so a `(thumb, variant)` pair is an immutable cache key
   and a perfect strong-ETag source (the same property ADR-019 exploits via `?lastWrite`).

The question: how to make the walls paint instantly **without** violating ADR-038's deliberate
decisions — no ledger sync (C-01), no image *storage* (C-06/option 9), not an open proxy (C-06) — and
without making the owner's deferred durable-poster work (C-09 / PRD Q-06) harder.

## Decision drivers

- **Wall paint must feel like Movies|TV|Music** — tiles at grid size, instant repeats, no megabyte tiles.
- **Don't invent a second store.** ADR-019/ADR-038 rejected PVC/`bytea` poster storage for backup +
  eviction weight; whatever caches here must be weightless and self-evicting.
- **Don't drag ytdl-sub content into the ledger.** Reusing the PLAN-004 poster machinery would require
  `media_items`/`media_metadata` rows for content ADR-038 C-01 deliberately keeps out of those tables.
- **Keep the security posture** — session + `ytdlsub`-section gate, token in a server-side header,
  `/library/…`-only path validation (not an open proxy). A resize parameter must not widen the surface.
- **Don't foreclose durable posters** (ADR-038 C-09): the future override store must be able to slot in
  ahead of the Plex read without reworking this layer.

## Considered options

### Shipping tiles at grid size

1. **Proxy the Plex photo-transcode endpoint** (chosen): the route asks k8plex for a fixed-size WebP
   variant (`/photo/:/transcode` with an allow-listed `width`/`height` per variant) instead of the
   original. Plex does the resizing it already does for its own clients; the app stores nothing.
2. **Resize in the app** (sharp/canvas in the Node route). Rejected: a native image dependency + CPU in
   the web pod to re-do work the Plex server already offers; more code, same result.
3. **Keep full-size and rely on browser caching alone.** Rejected: the first paint is still 28 MiB of
   Peloton tiles — the complaint IS the first paint.

### Making repeats instant

4. **In-process byte-capped LRU + strong ETag** (chosen): the route memoizes transcoded variants in an
   in-memory LRU (default 32 MiB cap, ~KB entries — both walls fit in well under 1 MiB) and serves a
   strong ETag derived from `(variant, thumb-path-with-lastWrite)`, so browsers revalidate to **304**s
   and other users hit the memory cache. Process restart = cold cache = one cheap re-transcode per tile
   (warm k8plex transcodes measured **3–4 ms**). This is memoization, not a store — nothing to back up,
   nothing to migrate, no eviction policy beyond LRU (the ADR-019 posture is intact).
5. **Reuse the PLAN-004 poster-cache mechanism** (`media_metadata.poster_source/poster_ref`). Rejected:
   it is keyed on `media_items` UUIDs — using it would fabricate ledger rows for non-\*arr content,
   exactly what ADR-038 option 2 ruled out.
6. **A PVC/disk cache.** Rejected: the ADR-019 weight argument (storage + backup + eviction for a cache
   Plex already maintains) — and unnecessary at these sizes.

### Perceived loading

7. **Progressive image reveal in the reserved tile** (chosen): `MediaPoster` already reserves a fixed
   2:3 box (ADR-015); the `<img>` now fades in on load over the tinted skeleton box, so a loading wall
   reads as "tiles filling in", never a broken grid. No geometry changes — reflow-free by construction.
8. **Blur-hash / LQIP placeholders.** Rejected: needs pre-computation (a store) for marginal polish at
   3–15 KB tiles.

## Decision outcome

Chosen options **1 + 4 + 7**: the ytdl-sub poster proxy requests **fixed-size WebP variants from the
Plex photo-transcode endpoint** (an allow-listed `size=grid|still` parameter; original-art fallback if a
transcode misses), memoizes them in an **in-process byte-capped LRU**, and serves **strong ETags** keyed
on the self-versioning thumb path so repeat visits are 304/instant; the reserved poster tile gains a
**fade-in reveal**. No new table, no storage, no change to the read-only / no-ledger posture.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Tiles ship at grid size.** `resolveYtdlsubThumbUpstream(thumb, size)` builds `{k8plex}/photo/:/transcode?width=W&height=H&minSize=1&upscale=1&format=webp&url=<encoded thumb>` with the token still in the `X-Plex-Token` header. Variants are a **closed allow-list** — `grid` (300×450, ≈2× the 132–160 px poster tile) and `still` (320×180, the 16:9 episode row) — the client can never request arbitrary dimensions, so the resize parameter adds no proxy surface. Measured: Peloton wall 27.9 MiB → **45 KiB**, YouTube 6.6 MiB → **836 KiB**. |
| C-02 | **Transcode misses fall back to the original.** If the transcode upstream errors/404s for a specific image, the route streams the original `{baseUrl}{thumb}` (the pre-ADR-041 behavior) before giving up; only a double miss 404s to the `MediaPoster` fallback tile. A Plex build without a photo transcoder degrades to exactly the old behavior — never a broken wall. |
| C-03 | **Strong ETag + 304 revalidation.** The ETag hashes `(size, thumb)`; because the thumb path embeds Plex's `lastWrite`, replaced art rotates the URL **and** the ETag while unchanged art revalidates as an empty 304 (`If-None-Match` is answered before any upstream/cache work). `Cache-Control: private, max-age=86400, stale-while-revalidate=604800` is unchanged from ADR-038 C-06. |
| C-04 | **In-process LRU, not a store.** A byte-capped (32 MiB, 1 MiB/entry) `Map`-based LRU in `@hnet/api` memoizes `{body, contentType, etag}` per `(size, thumb)`. It is process-local and evaporates on restart — **no PVC, no table, no backup surface** (ADR-019/ADR-038 storage rejections stand). Entries above the per-entry cap (e.g. a full-size fallback body) are served but not cached. |
| C-05 | **Security posture unchanged.** The route stays session- **and** `ytdlsub`-section-gated; `isValidPlexThumbPath` still restricts to `/library/…` on the single k8plex server; the token never reaches the browser; an invalid `size` is a 404. The transcode URL's `url=` parameter carries the **already-validated** Plex-relative path, URL-encoded. |
| C-06 | **Read-only invariants intact.** `/photo/:/transcode` is a GET against the PMS — no write to Plex or ytdl-sub, no ledger involvement, no `@hnet/plex` surface change (the proxy resolver stays in `@hnet/api`). |
| C-07 | **Durable posters (ADR-038 C-09 / PRD Q-06) are not foreclosed** — they get easier. The future override store slots in as a resolve step ahead of the Plex upstream (`resolveYtdlsubThumbUpstream` is the single seam), and the LRU/ETag layer works identically over an override body. Nothing here assumes Plex is the only art source. |
| C-08 | (Cost/risk) **First paint after a pod restart re-transcodes each visible tile once** (~3–4 ms warm, ~50–90 ms cold per image on k8plex) — imperceptible at wall scale. The Plex transcoder also keeps its own variant cache, so even "cold" app misses are usually warm on the server. |

## More information

- **Measured before/after (2026-07-10, from the deployed pod against k8plex):** Peloton wall (12 thumbs)
  **29,279,059 B → 46,460 B**; YouTube wall (70 thumbs) **6,937,403 B → 856,008 B**; sequential
  whole-wall upstream pull 530 ms → 142 ms (YouTube), 159 ms → 27 ms (Peloton) — and the dominant
  user-facing win is WAN transfer (28 MiB at phone bandwidth is tens of seconds; 45 KiB is instant).
- Realized by DESIGN-017 **D-07** (pipeline + route contract) and **D-08/D-09** (the same UX package's
  tab-order + drill-in changes); the drill-in's episode stills ride the `still` variant.
- ADR-038 is **not superseded** — its read model, gating, and proxy validation all stand; this ADR
  refines only the *what streams* (C-06's full-size body → sized variants + memoization), the same way
  ADR-039 refined ADR-037.
