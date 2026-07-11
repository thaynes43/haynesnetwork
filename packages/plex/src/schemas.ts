// ADR-017 / DESIGN-007 D-03 — the BC-04 anti-corruption boundary. External Plex models
// (PMS `/library/sections` JSON + the plex.tv v1 XML sharing responses) never leak past this
// package: the read client extracts only the fields below and zod-validates them, so upstream
// schema drift surfaces as a typed PlexParseError rather than an undefined-shaped object.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// PMS reads (JSON) — Accept: application/json returns `{ MediaContainer: { ... } }`.
// ---------------------------------------------------------------------------

/** `GET /identity` — the server GUID + version (registry machine_identifier source). */
export const identitySchema = z.object({
  MediaContainer: z.object({
    machineIdentifier: z.string(),
    version: z.string().optional(),
  }),
});
export type PlexIdentity = z.infer<typeof identitySchema>;

/**
 * `GET /library/sections` element. `key` is the per-server section id (our registry identity,
 * kept as a string). `type` is left as a plain string here — the PLEX_MEDIA_TYPES CHECK on
 * `plex_libraries.media_type` is the authoritative gate, so the ACL stays decoupled from the
 * @hnet/db enum (a new upstream type fails loudly at insert, not silently here).
 */
export const librarySectionSchema = z.object({
  key: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  type: z.string(),
  agent: z.string().optional(),
});
export type PlexLibrarySection = z.infer<typeof librarySectionSchema>;

export const librarySectionsSchema = z.object({
  MediaContainer: z.object({
    // Absent when the server has zero libraries.
    Directory: z.array(librarySectionSchema).optional().default([]),
  }),
});
export type PlexLibrarySections = z.infer<typeof librarySectionsSchema>;

/**
 * ADR-038 / DESIGN-017 (PLAN-022) — `GET /library/sections/{key}/all` element. A top-level item of a
 * library section (a "show" for a TV-Show-by-Date ytdl-sub library). `type` is a plain string (the UI
 * decides how to render — same decoupling as librarySectionSchema). Numeric-ish fields arrive as strings
 * in Plex JSON, so they are coerced. `thumb` is the Plex-RELATIVE poster path — it is never hot-linked;
 * the ytdl-sub poster proxy (ADR-038 C-06) streams it server-side with the token.
 */
export const sectionItemSchema = z.object({
  ratingKey: z.union([z.string(), z.number()]).transform(String),
  key: z.string().optional(),
  type: z.string(),
  title: z.string(),
  titleSort: z.string().optional(),
  summary: z.string().optional(),
  thumb: z.string().optional(),
  art: z.string().optional(),
  year: z.union([z.string(), z.number()]).transform(Number).optional(),
  childCount: z.union([z.string(), z.number()]).transform(Number).optional(), // seasons
  leafCount: z.union([z.string(), z.number()]).transform(Number).optional(), // episodes
  addedAt: z.union([z.string(), z.number()]).transform(Number).optional(), // epoch secs
  // DESIGN-017 D-09 (drill-in) — hierarchy fields present on /library/metadata/{key}[/children]
  // items: a season's/episode's ordinal, an episode's runtime + air date, and the owning library
  // section (the drill-in's section-confinement check — coerced, Plex serves it as a number).
  index: z.union([z.string(), z.number()]).transform(Number).optional(),
  duration: z.union([z.string(), z.number()]).transform(Number).optional(), // episode runtime, ms
  originallyAvailableAt: z.string().optional(), // 'YYYY-MM-DD'
  librarySectionID: z.union([z.string(), z.number()]).transform(String).optional(),
  // ADR-047 / DESIGN-025 (PLAN-028 — Library deep links) — the external-agent GUIDs Plex carries on a
  // library title: `Guid` is the array of secondary agent ids (`[{ id: 'tmdb://12345' }, { id:
  // 'imdb://tt...' }, { id: 'tvdb://...' }]` for movies/shows; `mbid://...` for music artists). The
  // plex-match sync parses these against the *arr ledger's tmdb/tvdb/imdb/musicbrainz ids to resolve the
  // exact ratingKey + owning library. The scalar `guid` (e.g. `plex://movie/5d...`) is the Plex-internal
  // agent id — kept for completeness, not used for matching.
  guid: z.string().optional(),
  Guid: z.array(z.object({ id: z.string() })).optional().default([]),
});
export type PlexSectionItem = z.infer<typeof sectionItemSchema>;

export const sectionContentsSchema = z.object({
  MediaContainer: z.object({
    size: z.union([z.string(), z.number()]).transform(Number).optional(),
    // The library's full item count (paged reads compare `start` against it — ADR-047 plex-match sweep).
    totalSize: z.union([z.string(), z.number()]).transform(Number).optional(),
    // Absent when the section is empty.
    Metadata: z.array(sectionItemSchema).optional().default([]),
  }),
});
export type PlexSectionContents = z.infer<typeof sectionContentsSchema>;

/**
 * DESIGN-017 D-09 (drill-in) — `GET /library/metadata/{key}` and `GET /library/metadata/{key}/children`.
 * Same item shape as a section listing; the container additionally carries the owning
 * `librarySectionID` (the drill-in verifies it against the resolved ytdl-sub section so a ratingKey
 * can never browse outside the gated libraries) and `totalSize` when the children read is paged.
 */
export const metadataContainerSchema = z.object({
  MediaContainer: z.object({
    size: z.union([z.string(), z.number()]).transform(Number).optional(),
    totalSize: z.union([z.string(), z.number()]).transform(Number).optional(),
    librarySectionID: z.union([z.string(), z.number()]).transform(String).optional(),
    Metadata: z.array(sectionItemSchema).optional().default([]),
  }),
});
export type PlexMetadataContainer = z.infer<typeof metadataContainerSchema>;

// ---------------------------------------------------------------------------
// plex.tv v1 sharing API (XML) — the read client extracts attributes into these plain
// objects (all XML attrs are strings) and validates them here. Verified live 2026-07-06.
// ---------------------------------------------------------------------------

/**
 * `GET /api/v2/user` (JSON) — the account the owner token authenticates as, i.e. the server
 * OWNER. Consumed to detect when the logged-in user IS the owner: owners are never in their own
 * `/api/users` friend list, so friend-matching structurally cannot match them (ADR-029). Only
 * the identity subset is read; every other field plex.tv returns is ignored (non-strict object).
 */
export const plexAccountSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  email: z.string().nullable().default(null),
  username: z.string().nullable().default(null),
});
export type PlexAccount = z.infer<typeof plexAccountSchema>;

/** `<User>` from `GET /api/users` — the friend list. Maps app user (OIDC email) → Plex id. */
export const plexFriendSchema = z.object({
  id: z.string(),
  email: z.string().nullable().default(null),
  username: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
});
export type PlexFriend = z.infer<typeof plexFriendSchema>;

/**
 * `<Section>` from `GET /api/servers/{machineId}` — maps a server section `key` to the
 * plex.tv-scoped section `id` that the share body's `library_section_ids` uses.
 */
export const plexServerSectionSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  type: z.string(),
});
export type PlexServerSection = z.infer<typeof plexServerSectionSchema>;

/** `<Section>` nested in a `<SharedServer>` — `shared="1"` marks a currently-shared section. */
export const sharedSectionSchema = z.object({
  id: z.string(),
  key: z.string(),
  shared: z.boolean(),
});
export type PlexSharedSection = z.infer<typeof sharedSectionSchema>;

/**
 * `<SharedServer>` from `GET /api/servers/{machineId}/shared_servers` — one per friend the
 * server is shared with. `id` is the sharedServerId (PUT/DELETE key); `sharedSectionIds` are
 * the plex.tv section ids the user currently has (the read-merge-write base set, ADR-017 D-02).
 */
export const sharedServerSchema = z.object({
  id: z.string(),
  userID: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  username: z.string().nullable().default(null),
  allLibraries: z.boolean(),
  sections: z.array(sharedSectionSchema),
});
export type PlexSharedServer = z.infer<typeof sharedServerSchema>;
