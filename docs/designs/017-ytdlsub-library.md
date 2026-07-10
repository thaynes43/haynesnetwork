# DESIGN-017: ytdl-sub Library sub-tabs — direct Plex read, section-gated, Plex-thumb proxy

- **Status:** Accepted
- **Last updated:** 2026-07-10
- **Satisfies:** PRD-001 **R-121..R-124**; governed by **ADR-038** (direct-Plex read model + `ytdlsub`
  section gate + Plex-thumb proxy). Reuses ADR-017/DESIGN-007 (`@hnet/plex` read client + registry),
  ADR-019 (the authed poster **proxy** pattern), ADR-021/DESIGN-009 (Section Permissions), ADR-037/
  DESIGN-016 (the `disabled`-default rollout + the `?tab=` sub-tab shell), and the PLAN-004 `@hnet/ui`
  filter engine + the `MediaPoster` / `.poster-grid` Library idioms (DESIGN-008 D-11). Glossary **T-110..T-112**.

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
  library" note. No poll (one-shot load). Tiles are action-free (no drill-in this round — season/episode
  counts are shown in the caption; deeper browse is a Phase-2 follow-up).
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

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Where do the replacement poster files live + the durable home (repo / PVC / Kometa overlay), and does the app serve the durable poster or does Plex re-read it after the store re-applies? | Owner, morning (PRD Q-06). Resilient display ships now; the durable store is a Phase-2 follow-up. |
| Q-02 | Two sub-tabs (Peloton, YouTube) or one "ytdl-sub" tab with an internal switch? | Shipped as **two** tabs (matches the two libraries + the poster-grid idiom); trivially collapsible if the owner prefers one. |
| Q-03 | Which role(s) get the `ytdlsub` section after the screenshot review? | Owner, morning — one audited flip per role in the existing role editor (ships Admin-only). |
