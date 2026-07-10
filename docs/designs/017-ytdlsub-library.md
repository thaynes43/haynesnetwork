# DESIGN-017: ytdl-sub Library sub-tabs — direct Plex read, section-gated, Plex-thumb proxy

- **Status:** Accepted
- **Last updated:** 2026-07-10 (v2 — the owner's morning UX package: **D-07** poster streamlining per
  **ADR-041**, **D-08** Library tab order, **D-09** read-only series drill-in; R-131..R-132, T-120)
- **Satisfies:** PRD-001 **R-121..R-124** + **R-131..R-132**; governed by **ADR-038** (direct-Plex read
  model + `ytdlsub` section gate + Plex-thumb proxy) and **ADR-041** (poster transcode variants + LRU +
  ETag). Reuses ADR-017/DESIGN-007 (`@hnet/plex` read client + registry),
  ADR-019 (the authed poster **proxy** pattern), ADR-021/DESIGN-009 (Section Permissions), ADR-037/
  DESIGN-016 (the `disabled`-default rollout + the `?tab=` sub-tab shell), and the PLAN-004 `@hnet/ui`
  filter engine + the `MediaPoster` / `.poster-grid` Library idioms (DESIGN-008 D-11). Glossary
  **T-110..T-112**, **T-120**.

## Overview

Two new **Library** sub-tabs — **Peloton** and **YouTube** — surfacing the k8plex (HAYNESKUBE) ytdl-sub
libraries as poster grids, read **directly** from the Plex server via `@hnet/plex` (no ledger sync — this
content has no \*arr; ADR-038). The sub-tabs are gated by a new **`ytdlsub` Section Permission** with a
**`disabled` no-row default**, so they ship **Admin-only**; the owner opens them per role in the existing
role editor after his morning screenshot review. Posters stream through a new session- + section-gated
**Plex-thumb proxy** (extending ADR-019) with a graceful `MediaPoster` fallback tile when Plex art is
missing. The whole surface reuses the Library look — `.library-tabs`, `.poster-grid`, `MediaPoster`, the
`@hnet/ui` filter engine — with no new visual language and no new hex.

## Detailed design

### D-01 — Data model + migration 0032 (additive, ONE CHECK rebuild)

There is **no new content table** (ADR-038 C-01 — nothing is synced; Plex is read live). The only schema
change is admitting the new section id to the visibility CHECK.

`packages/db/migrations/0032_ytdlsub_section.sql` — one additive change (a CHECK rebuild copying the
current array verbatim + appending `'ytdlsub'`), plus the journal entry (`idx: 31`, `tag:
"0032_ytdlsub_section"`, `version: "7"`):

1. **`role_section_permissions` section CHECK** rebuilt to admit `'ytdlsub'` (visibility; ships Admin-only
   via the `SECTION_DEFAULT_LEVELS.ytdlsub = 'disabled'` no-row default). No new column, no new table, no
   new `permission_audit` action (the flip reuses the existing `setSectionPermission` single-writer + its
   `update_section_permission` audit row).

`packages/db/src/schema/enums.ts` is the single source of truth: `SECTION_IDS += 'ytdlsub'` and
`SECTION_DEFAULT_LEVELS.ytdlsub = 'disabled'`. No `no-direct-state-writes` guard edit (no new state table;
`role_section_permissions` is already covered). A **migration-parity test** asserts the CHECK admits
`'ytdlsub'` and rejects a bogus section.

### D-02 — `@hnet/plex` read extension (read-only, no import-confinement)

`packages/plex/src/schemas.ts` — a new section-contents shape mirroring `librarySectionsSchema`:

```ts
export const sectionItemSchema = z.object({
  ratingKey: z.union([z.string(), z.number()]).transform(String),
  key: z.string().optional(),
  type: z.string(),                                   // 'show' | 'season' | 'episode' | 'movie' | …
  title: z.string(),
  titleSort: z.string().optional(),
  summary: z.string().optional(),
  thumb: z.string().optional(),                       // Plex-relative thumb path (proxied, never hot-linked)
  art: z.string().optional(),
  year: z.union([z.string(), z.number()]).transform(Number).optional(),
  childCount: z.union([z.string(), z.number()]).transform(Number).optional(),   // seasons
  leafCount: z.union([z.string(), z.number()]).transform(Number).optional(),    // episodes
  addedAt: z.union([z.string(), z.number()]).transform(Number).optional(),
});
export type PlexSectionItem = z.infer<typeof sectionItemSchema>;

export const sectionContentsSchema = z.object({
  MediaContainer: z.object({
    size: z.union([z.string(), z.number()]).transform(Number).optional(),
    Metadata: z.array(sectionItemSchema).optional().default([]),   // absent when empty
  }),
});
```

`packages/plex/src/read.ts` — a new read method on `PlexReadClient`:

```ts
/** List a library section's top-level items (shows for a TV-Show-by-Date library). Read-only;
 *  container-size bounded (ADR-038 C-08). Token stays in the X-Plex-Token header. */
async listSectionContents(sectionKey: string, opts?: { limit?: number }): Promise<PlexSectionItem[]> {
  const size = Math.min(Math.max(opts?.limit ?? 500, 1), 1000);
  const body = await this.http.requestJson(
    'GET',
    `${this.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all` +
      `?X-Plex-Container-Start=0&X-Plex-Container-Size=${size}`,
    sectionContentsSchema,
  );
  return body.MediaContainer.Metadata;
}
```

It lands in `read.ts` (`@hnet/plex/read`) — no `/write` surface, no import-confinement (ADR-038 C-02). A
unit test parses a `SECTION_CONTENTS_JSON` fixture and asserts the token rides the header, never the URL.

### D-03 — Session + gate (server-authoritative)

- **Enum/session:** `'ytdlsub'` joins `SECTION_IDS` (D-01). `@hnet/auth` session hydration already loops
  `SECTION_IDS`, so `SessionRole.sectionPermissions.ytdlsub` is populated with **no extra query and no
  code change**; `effectiveSectionLevel(role,'ytdlsub')` returns `edit` for admins (no rows) and
  `SECTION_DEFAULT_LEVELS.ytdlsub = 'disabled'` for everyone else until a role row opts them in.
- **`@hnet/api` `middleware/role.ts`:** `ytdlsubProcedure = sectionProcedure('ytdlsub','read_only')` — the
  visibility gate for the read procedures (mirrors `metricsProcedure`).

### D-04 — tRPC surface (`ytdlsubRouter`) + the Plex-thumb proxy

`ytdlsub` router registered in `routers/index.ts`. A Plex read client is resolved from the existing
`resolvePlexBundle(ctx).read['hayneskube']` (stub-injectable in tests). The two ytdl-sub section keys are
resolved by **title** from `listSections()` (ADR-038 C-03), cached per call:

| Procedure | Gate | Input | Returns |
| --------- | ---- | ----- | ------- |
| `ytdlsub.access` | `authedProcedure` | — | `{ canSee: boolean }` (the caller's own `ytdlsub` visibility) |
| `ytdlsub.libraries` | `ytdlsubProcedure` | — | `YtdlsubLibrary[]` — the resolved tabs `{ id: 'peloton'\|'youtube'; title; found: boolean }` |
| `ytdlsub.list` | `ytdlsubProcedure` | `{ library: 'peloton'\|'youtube' }` | `{ items: YtdlsubShow[]; found: boolean }` |

```ts
export interface YtdlsubShow {
  ratingKey: string;
  title: string;
  posterUrl: string | null;   // /api/ytdlsub/poster?thumb=… when a Plex thumb exists, else null → fallback tile
  seasonCount: number | null; // childCount (Peloton durations / YouTube sub-groups)
  episodeCount: number | null;// leafCount
  year: number | null;
  addedAt: number | null;     // epoch secs, for the "recently added" sort
}
```

`ytdlsub.list` maps `listSectionContents(sectionKey)` items to `YtdlsubShow`, building the proxied poster
URL: `thumb ? \`/api/ytdlsub/poster?thumb=${encodeURIComponent(thumb)}\` : null`. `found: false` when the
title resolver finds no matching section (⇒ the UI shows an empty-state, ADR-038 C-03). A k8plex read
failure is caught → `{ items: [], found: true, unavailable: true }` so the tab degrades to a muted note,
never a throw (ADR-038 C-08).

**The Plex-thumb proxy** — `apps/web/app/api/ytdlsub/poster/route.ts` (Node runtime), mirroring
`apps/web/app/api/posters/[mediaItemId]/route.ts`:

1. `getServerSession(req.headers)` → 401 if anonymous.
2. `effectiveSectionLevel(role,'ytdlsub') === 'disabled'` → **404** (section-gated; a denied caller can't
   probe thumbs).
3. Read `thumb` from the query; **validate** it starts with `/library/` and contains no scheme / no `..`
   (`resolveYtdlsubThumbUpstream` in `@hnet/api` — the arr/plex config coupling stays out of the route).
   Anything else → 404.
4. Stream `{hayneskube.baseUrl}{thumb}` with `{ 'X-Plex-Token': token, Accept: 'image/*' }` server-side
   (10s timeout), content-type passthrough, `Cache-Control: private, max-age=86400,
   stale-while-revalidate=604800`. Any upstream miss/timeout → **404** → the `MediaPoster` fallback tile.

The token/base URL come from `assertPlexEnv(process.env).hayneskube` — never serialized to the client.

### D-05 — UI: server-gated route + Library sub-tabs (ADR-015, no new hex)

The `/library` route becomes a thin **server component** (the ADR-037 `metrics/page.tsx` gate pattern),
because the current client page can't resolve the session:

- **`apps/web/app/(app)/library/page.tsx`** (NEW server component): `getServerSession` →
  `ytdlsubVisible = effectiveSectionLevel(role,'ytdlsub') !== 'disabled'` → renders
  `<LibraryClient ytdlsubVisible={ytdlsubVisible} />`. (Anonymous is already bounced by the app layout;
  a defensive `redirect('/login')` mirrors metrics.)
- **`apps/web/app/(app)/library/library-client.tsx`** (the former `page.tsx` client body, `git mv`d — all
  imports are `@/…`/`next`/`react`, so the move is import-safe): `LIBRARY_TABS` conditionally appends
  `{ key: 'peloton', label: 'Peloton' }` and `{ key: 'youtube', label: 'YouTube' }` when `ytdlsubVisible`.
  The existing `#library-panel` dispatch branches: an `arrKind` tab → `MediaBrowser` (unchanged); a
  `my-fixes` tab → `MyFixesPanel` (unchanged); a `peloton`/`youtube` tab → `<YtdlsubBrowser library={key}/>`.
  The tab strip, roving-tabindex, and `?tab=` URL state are the existing shared idiom — untouched.
- **`apps/web/app/(app)/library/ytdlsub-browser.tsx`** (NEW client component): `trpc.ytdlsub.list.useQuery({
  library })`, `placeholderData:(p)=>p` (dim-in-place). Renders the SAME `.media-list.poster-grid` of
  `.poster-card` tiles as `MediaBrowser`: a `<MediaPoster posterUrl={item.posterUrl} kind="show" alt={title}/>`
  head + a `.poster-card__body` caption (title + a muted "N seasons · M episodes" line). A **search box**
  (client filter over `title`) + a **sort control** (Title / Recently added) reuse `@hnet/ui`
  `FilterChip`-adjacent `nextSort`/`arrowFor` + `sortRowsClientSide` — client-side because the show counts
  are small (ADR-038 C-07/C-08). Loading → the existing skeleton poster boxes; `found: false` →
  a muted "This library isn't on the server yet" empty-state; `unavailable` → a muted "couldn't reach the
  library" note. No poll (one-shot load). ~~Tiles are action-free (no drill-in this round — season/episode
  counts are shown in the caption; deeper browse is a Phase-2 follow-up).~~ **Superseded by D-09
  (2026-07-10):** tiles are now click-through links to the read-only drill-in.
- **`apps/web/components/kind-icon.tsx`:** add `kind === 'show'` (reuses the sonarr TV-frame glyph,
  `currentColor` — no new asset, no hex) so a missing-poster tile falls back to a video frame, not the
  film frame.
- **Admin role editor** — `apps/web/app/(app)/admin/roles/page.tsx`: a **Library extras (ytdl-sub)** section
  column (Edit / Read-only / Disabled — the Ledger-style visibility cell; no fine-grained action grants)
  wired to `setSection.mutate({ sectionId: 'ytdlsub', level })`. `roles.list` already emits
  `sectionPermissions.ytdlsub` (it loops `SECTION_IDS`), so no router change is needed.

Because the sub-tabs are gated at the route (server) AND the data at the procedure (server), a non-admin
role sees neither tab nor data until the owner flips the role — the ship-Admin-only invariant.

### D-06 — dev/e2e stub

Extend the existing `apps/web/e2e/support/stub-plex.ts`:

- Add the two libraries to `LIBRARIES.hayneskube`: `{ key: '4', title: 'HOps Peloton', type: 'show',
  plexId: '300004' }` and `{ key: '5', title: 'HOps YT', type: 'show', plexId: '300005' }`.
- Add a `/library/sections/{key}/all` handler returning a canned `MediaContainer.Metadata` of shows (with
  `thumb` refs) per section, honoring `X-Plex-Container-Size`. Reuse the existing `/_stub/reset` +
  `/_stub/calls` control surface.
- Serve a tiny canned image for the stub `thumb` paths so the poster proxy round-trips in e2e.

The `@hnet/plex` client is the production reader; the stub speaks the same JSON wire shapes. `harness.ts` /
`env.ts` need **no** new stub — the existing stub-plex server stands in for k8plex. The
`packages/api/__tests__/plex-stubs.ts` fake `read` gains `listSectionContents` so router tests compile.

---

The following sections (D-07..D-09) are the **2026-07-10 owner UX package** — the morning-review
refinements to the shipped v0.31.0 feature. D-07 is governed by **ADR-041**; D-08/D-09 refine D-05
within the existing ADR-038 decisions (the "no drill-in this round" scope note in D-05 is superseded
by D-09).

### D-07 — Poster streamlining: transcode variants + in-process LRU + ETag (ADR-041; R-131)

The proxy route contract grows one **allow-listed** parameter and two caching layers; the URL shape the
router emits (`/api/ytdlsub/poster?thumb=…`) is unchanged (no `size` ⇒ `grid`).

- **Variants** (`@hnet/api` `ytdlsub-poster.ts`): `YTDLSUB_THUMB_SIZES = ['grid', 'still']` —
  `grid` = 300×450 (2:3; ≈2× the 132–160 px poster tile), `still` = 320×180 (16:9 episode rows).
  `resolveYtdlsubThumbUpstream(thumb, size, env)` validates the thumb exactly as before
  (`isValidPlexThumbPath`) and builds the k8plex **photo-transcode** upstream
  `{baseUrl}/photo/:/transcode?width=W&height=H&minSize=1&upscale=1&format=webp&url=<encodeURIComponent(thumb)>`
  (verified live on k8plex 2026-07-10: header token honored, 401 unauthenticated, `format=webp` turns a
  2.35 MB Peloton JPEG into a 3.5 KB 300×450 WebP), plus a `fallbackUrl` = the original `{baseUrl}{thumb}`
  and a strong `etag` = hash of `(size, thumb)` — self-versioning because the Plex thumb path embeds
  `lastWrite` (ADR-041 C-03).
- **LRU** (`ThumbLruCache`, module singleton in `@hnet/api`): byte-capped memoization (32 MiB total,
  1 MiB/entry) of `{body, contentType, etag}` per `(size, thumb)`; recency-refreshing get,
  evict-oldest set, over-cap bodies served-not-cached. Process-local — NOT a store (ADR-041 C-04).
- **Route** (`apps/web/app/api/ytdlsub/poster/route.ts`): after the unchanged session + section + path
  gates — `If-None-Match` match ⇒ **304** (no upstream); LRU hit ⇒ 200 from memory; miss ⇒ fetch the
  transcode upstream, buffer, memoize, 200 with `ETag` + the existing
  `Cache-Control: private, max-age=86400, stale-while-revalidate=604800`. A transcode failure retries
  the **original-art fallback** (ADR-041 C-02), which is served **without memoization or ETag** and a
  short `max-age=300` — a transient transcoder outage never makes megabyte originals sticky in the LRU
  or in browser caches. Unknown `size` ⇒ 404. Double miss ⇒ 404 ⇒ the `MediaPoster` fallback tile
  (unchanged).
- **Progressive reveal** (`MediaPoster`): the `<img>` inside the reserved 2:3 `.poster-box` starts
  transparent and fades in on load (`.poster-img.is-loaded`, opacity-only — ADR-015-safe by
  construction; the global reduced-motion rule kills the transition). Applies to every wall that uses
  `MediaPoster` (Movies|TV|Music included) — pure polish, no geometry change.
- **Measured (deployed pod → k8plex, 2026-07-10):** Peloton wall 12 thumbs **29,279,059 B → 46,460 B**;
  YouTube wall 70 thumbs **6,937,403 B → 856,008 B**; sequential upstream wall pull 159→27 ms /
  530→142 ms. The WAN transfer (the user-facing wait) shrinks proportionally.

### D-08 — Library tab order (owner ruling 2026-07-10)

`Movies | TV | Music | Peloton | YouTube | My Fixes` — the ytdl-sub tabs sit **after Music** (they are
media, browsed like media) and **My Fixes moves LAST** (it is a personal utility view, not a library).
`library-client.tsx` composes the strip as `MEDIA_TABS + (ytdlsubVisible ? YTDLSUB_TABS : []) +
MY_FIXES_TAB`; for a caller without the `ytdlsub` section the visible strip is `Movies | TV | Music |
My Fixes` (order preserved, nothing else changes). The `?tab=` contract, roving tabindex, and keyed
remounts are untouched.

### D-09 — Read-only series drill-in: show → seasons → episodes (R-132)

Clicking a Peloton/YouTube poster now opens a **read-only** detail view (the D-05 "action-free tiles /
no drill-in" scope note is superseded). Same visual language as `/library/[id]`; **no ledger, no
actions, no write surface**.

- **`@hnet/plex` reads** (read.ts; no import-confinement — reads only):
  `getMetadataItem(ratingKey)` → `GET /library/metadata/{key}` and
  `listMetadataChildren(ratingKey, {limit})` → `GET /library/metadata/{key}/children`
  (container-size bounded like `listSectionContents`), both parsed by a shared
  `metadataContainerSchema` whose items extend `sectionItemSchema` with `index`, `duration` (ms),
  `originallyAvailableAt`, and `librarySectionID` (item- and container-level, coerced to string).
- **tRPC** (`ytdlsubRouter`, both `ytdlsubProcedure`):

  | Procedure | Input | Returns |
  | --------- | ----- | ------- |
  | `ytdlsub.detail` | `{ library, ratingKey }` | `{ found, unavailable, show: {ratingKey,title,summary,posterUrl,seasonCount,episodeCount,year}, seasons: [{ratingKey,title,index,episodeCount}] }` |
  | `ytdlsub.episodes` | `{ library, seasonRatingKey }` | `{ found, unavailable, episodes: [{ratingKey,title,index,airDate,durationMs,stillUrl}] }` |

  **Section confinement:** both resolve the library's section key by title (ADR-038 C-03) and verify
  the metadata's `librarySectionID` matches — a ratingKey from any other k8plex section (Music, or a
  cross-library probe) is `found:false`, so the drill-in surface is exactly the two gated libraries.
  A Plex 404 ⇒ `found:false`; any other read failure ⇒ `unavailable:true` (the D-04 degrade grammar).
  Episode `stillUrl` rides the poster proxy with `size=still`.
- **Route** — `apps/web/app/(app)/library/ytdlsub/[library]/[ratingKey]/page.tsx` (server component,
  the D-05 gate pattern): anonymous → `/login`; `ytdlsub` `disabled`, a bad `library`, or a
  non-numeric ratingKey → `redirect('/library')`. Renders `<YtdlsubItemDetail/>` (client).
- **UI** (`ytdlsub-item-detail.tsx`): the `/library/[id]` idioms verbatim — `BackLink` (the fixed
  dictionary gains `peloton`/`youtube` keys → `/library?tab=…`), a `.card.detail-head` (2:3
  `MediaPoster` + title + a muted "N seasons · M episodes" badge row + the show summary when present),
  then one `.card.admin-section` of collapsible `.season` `<details>` blocks (the sonarr season
  grammar). Expanding a season lazily queries `ytdlsub.episodes` (enabled-on-open — a 261-episode
  Peloton season never loads up front) and renders read-only episode rows: a reserved 16:9 still box
  (`.epi-still`, token colors only) + title + muted `date · duration` (`formatDay` /
  `formatRuntime`). `<details>` expansion is the sanctioned ADR-015 in-place exception; loading states
  are muted text inside the expanded body (no reflow of neighbors).
- **Grid cards become links:** `ytdlsub-browser.tsx` tiles wrap in
  `<Link href={/library/ytdlsub/{library}/{ratingKey}}>` (the `MediaBrowser` card idiom; hover/focus
  affordances inherited).
- **Stubs:** `stub-plex.ts` gains `/library/metadata/{key}` + `/{key}/children` handlers over a canned
  show→season→episode hierarchy (with `librarySectionID`) and a `/photo/:/transcode` handler that
  serves the tiny image (webp-labeled) so the D-07 pipeline round-trips in e2e; the
  `plex-stubs.ts` fake read mirrors `getMetadataItem`/`listMetadataChildren`.

## Alternatives considered

- **Ledger sync of Peloton/YouTube** — rejected (ADR-038 option 2; this content has no \*arr of record).
- **A hardcoded admin-only flag** for visibility — rejected; the section mechanism gives audited per-role,
  owner-flippable visibility for free (ADR-038 option 5).
- **Hot-linking Plex thumbs / storing posters** — rejected (token leak / storage weight; ADR-019, ADR-038
  options 8-9).
- **A durable poster-override table + upload tonight** — rejected/deferred (guesses the sink before the
  owner answers PRD Q-06; ADR-038 option 11).
- **Server-side keyset + facets** like the ledger grid — rejected as overweight for the small show counts;
  client-side filter/sort over one bounded fetch is simpler and reflow-free.

## Test strategy

- **Hermetic (embedded PG16 + stubbed reader):** the `@hnet/plex` `listSectionContents` parse + header-only
  token (fixture); `ytdlsub.list` maps items + builds proxied poster URLs + returns `found:false` for an
  absent library + degrades to `unavailable` on a read throw (stub read); the section gate (a `disabled`
  caller gets `FORBIDDEN`, an admin gets items); `resolveYtdlsubThumbUpstream` accepts a `/library/…` thumb
  and rejects a scheme/`..`/non-library path; the migration-parity CHECK test (`ytdlsub` admitted).
- **e2e (advisory):** `ytdlsub-library.spec.ts` — an **admin** sees the Peloton + YouTube tabs, each renders
  the stub shows in the poster grid (posters resolve via the proxy), search/sort work in place (no reflow);
  a **member** (no `ytdlsub` row) sees **neither tab** and `ytdlsub.list` is `FORBIDDEN`; opening the member
  role's `ytdlsub` to `read_only` in the role editor makes the tabs appear.
- **v2 hermetic (D-07..D-09):** `resolveYtdlsubThumbUpstream` builds the allow-listed webp transcode
  variant per size (encoded thumb, token in the header, never the URL) + the original-art `fallbackUrl`,
  keeps rejecting scheme/`..`/non-library paths, and its ETag is stable per `(size, thumb)` and differs
  across sizes/thumbs; `ThumbLruCache` refreshes recency on get, evicts oldest at the byte cap, and
  never caches an over-cap body; `ytdlsub.detail`/`ytdlsub.episodes` map seasons/episodes (index-sorted,
  still URLs carry `size=still`), return `found:false` for a ratingKey **outside the resolved library
  section** (the confinement check) or a Plex 404, degrade to `unavailable` on a read throw, and stay
  `FORBIDDEN` for a `disabled` caller; `@hnet/plex` `getMetadataItem`/`listMetadataChildren` parse
  fixtures (coerced `librarySectionID`, duration, air date) with the container bound in the query.
- **v2 e2e (advisory):** the admin tab strip reads Movies | TV | Music | Peloton | YouTube | My Fixes
  (member: Movies | TV | Music | My Fixes); clicking a Peloton show opens the drill-in — the detail
  head renders, seasons list, expanding one loads its episodes (title/date/duration, stub still) —
  and the back link returns to the Peloton tab.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Where do the replacement poster files live + the durable home (repo / PVC / Kometa overlay), and does the app serve the durable poster or does Plex re-read it after the store re-applies? | Owner, morning (PRD Q-06). Resilient display ships now; the durable store is a Phase-2 follow-up. |
| Q-02 | Two sub-tabs (Peloton, YouTube) or one "ytdl-sub" tab with an internal switch? | Shipped as **two** tabs (matches the two libraries + the poster-grid idiom); trivially collapsible if the owner prefers one. |
| Q-03 | Which role(s) get the `ytdlsub` section after the screenshot review? | Owner, morning — one audited flip per role in the existing role editor (ships Admin-only). |
