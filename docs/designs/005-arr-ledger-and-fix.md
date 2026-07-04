# DESIGN-005: *arr media ledger, Fix, and failsafe Restore — Phase 2

- **Status:** Accepted
- **Last updated:** 2026-07-03
- **Satisfies:** PRD-001 R-40..R-47 (ledger, history, wanted, Fix), R-50..R-52 (Restore),
  AC-07..AC-09, US-06, US-07; governed by ADR-007 (Fix semantics), ADR-008 (one-way sync,
  two write-backs), ADR-003 (Postgres/Drizzle + transactional audit), ADR-006 (single
  image), ADR-010 (test layers). Bounded context: DDD-002 **BC-03 Media Ledger** (ACL —
  external *arr/Seerr models never leak past `packages/arr` adapters).
- **Companions:** DESIGN-001 (conventions D-01, reserved names D-15, audit rules D-10/D-12),
  DESIGN-003 (procedure ladder, error taxonomy D-13, reserved router names).

## Overview

Phase 2 gives haynesnetwork its media brain: a **ledger** synced one-way from Sonarr,
Radarr, and Lidarr (they stay the source of truth — CLAUDE.md hard rule 4), request
attribution read from Jellyseerr, a user-facing **Fix** flow implementing ADR-007's
mark-failed + search semantics, and the admin-only **Restore** failsafe that can rebuild a
lost *arr database from recorded settings.

Everything in §D-01..§D-03 was verified **read-only against the live instances on
2026-07-03** (GET probes via the LAN ingresses) plus the published OpenAPI specs for the
`develop` branches those instances run. Write endpoints are listed for Phase 2 mutations
but were **never called**.

**Definition of success:** an implementation agent can build `packages/arr`, migration
`0003`, the domain writers, and the three routers from this doc alone, and AC-07..AC-09
are satisfiable against the live stack.

## Detailed design

### D-01 Live topology and API versions (verified 2026-07-03)

| Service | Version (live `system/status` / `status`) | API base | In-cluster DNS (verified `svc` + ports) | LAN ingress (dev only) |
|---|---|---|---|---|
| Sonarr | 4.0.18.2978 (develop) | `/api/v3` | `http://sonarr.media.svc.cluster.local:8989` | `https://sonarr.haynesops.com` |
| Radarr | 6.0.0.10217 (develop) | `/api/v3` | `http://radarr.media.svc.cluster.local:7878` | `https://radarr.haynesops.com` |
| Lidarr | 3.1.3.4968 (develop) | `/api/v1` | `http://lidarr.media.svc.cluster.local:8686` | `https://lidarr.haynesops.com` |
| Seerr | **Jellyseerr 3.3.0** (`applicationTitle: "Jellyseerr"`, media server type Plex) | `/api/v1` | `http://seerr.media.svc.cluster.local:5055` | `https://seerr.haynesops.com` |

Auth: header `X-Api-Key` on every call, all four services. Live scale at survey time:
1,018 series / 9,408 movies / 4,741 artists; wanted/missing totals 40,862 episodes
(Sonarr), 432 movies (Radarr), 640 albums (Lidarr). Quality profiles are identical
id-for-id on Sonarr/Radarr today (`1 Any … 9 FHD-UHD`); Lidarr has `1 Any, 2 Lossless,
3 Standard`. Root folders: `/data/haynestower/Media/TV Shows`, `…/Movies`,
`/data/media/music`. Live *arr tags: `mediarequests` (Sonarr+Radarr);
`spotifyalbums`/`spotifyartists`/`spotifyplaylist` (Lidarr — import-list provenance,
see Q-02).

> The instances do **not** serve their OpenAPI documents (`/api/v3/openapi.json` → 404);
> endpoint verification below used the specs published in the Sonarr/Radarr/Lidarr GitHub
> repos for the `develop` branches, cross-checked against live GETs.

### D-02 Fields consumed per entity (the sync contract)

Zod schemas in `packages/arr` parse **exactly these fields** and ignore the rest (ACL:
unknown fields never propagate). All field names below were confirmed present on live
responses.

| Ledger need | Sonarr `series` | Radarr `movie` | Lidarr `artist` |
|---|---|---|---|
| *arr item id | `id` | `id` | `id` |
| Title / year | `title`, `sortTitle`, `year` | `title`, `sortTitle`, `year` | `artistName`, `sortName` (no year) |
| External ids | `tvdbId` (always set), `imdbId?`, `tmdbId?` | `tmdbId` (always set), `imdbId?` | `foreignArtistId` (MusicBrainz artist id — **not** `mbId`) |
| Monitored | `monitored`, `monitorNewItems` | `monitored` | `monitored`, `monitorNewItems` |
| Quality profile | `qualityProfileId` (+ name via `GET qualityprofile`) | same | same, plus `metadataProfileId` |
| Root folder | `rootFolderPath`, `path` | `rootFolderPath`, `path` | `rootFolderPath`, `path` |
| Tags | `tags` (int ids → labels via `GET tag`) | same | same |
| On-disk stats | `statistics.{episodeFileCount, episodeCount, totalEpisodeCount, sizeOnDisk}` | `hasFile`, `movieFileId`, `sizeOnDisk`, `statistics.movieFileCount` | `statistics.{trackFileCount, trackCount, totalTrackCount, sizeOnDisk}` |
| Restore-fidelity extras | `seriesType`, `seasonFolder`, `status`, `ended`, `added` | `minimumAvailability`, `status`, `isAvailable`, `added` | `artistType`, `status`, `added` |

Fix-granularity child entities (fetched **live**, never synced — D-06):

- Sonarr `GET /episode?seriesId=` → `{id, seasonNumber, episodeNumber, title, airDateUtc,
  hasFile, monitored, episodeFileId}`.
- Lidarr `GET /album?artistId=` → `{id, artistId, foreignAlbumId (MB release-group id),
  title, albumType, monitored, anyReleaseOk, releaseDate, statistics}`.

History records (`GET /history?page=…`, paged, `sortKey=date&sortDirection=descending`):
`{id, eventType, date, sourceTitle, downloadId, quality, data{indexer, releaseGroup,
downloadClient, …}}` plus the per-kind target id — `episodeId`+`seriesId` (Sonarr),
`movieId` (Radarr), `albumId`+`artistId` (Lidarr).

**History eventTypes** — observed live (recent 50/instance): Sonarr `grabbed`,
`downloadFolderImported`, `episodeFileDeleted`; Radarr `grabbed`,
`downloadFolderImported`; Lidarr `trackFileImported`. Full enums from the OpenAPI specs:

| Instance | Full eventType enum |
|---|---|
| Sonarr (`EpisodeHistoryEventType`) | `unknown, grabbed, seriesFolderImported, downloadFolderImported, downloadFailed, episodeFileDeleted, episodeFileRenamed, downloadIgnored` |
| Radarr (`MovieHistoryEventType`) | `unknown, grabbed, downloadFolderImported, downloadFailed, movieFileDeleted, movieFolderImported, movieFileRenamed, downloadIgnored` |
| Lidarr (`EntityHistoryEventType`) | `unknown, grabbed, artistFolderImported, trackFileImported, downloadFailed, trackFileDeleted, trackFileRenamed, albumImportIncomplete, downloadImported, trackFileRetagged, downloadIgnored` |

> **`eventType` is asymmetric — string in responses, INTEGER in the paged-`/history`
> filter.** History records RETURN the lowercase string (`"grabbed"`), but the paged
> `GET /history?…&eventType=` endpoint binds the query param to the INTEGER value of the
> enum above (0-based, in the order listed — `grabbed` = **1** for all three). Passing the
> string there returns HTTP 400 `{"errors":{"eventType":["The value 'grabbed' is not
> valid."]}}` (a prod bug — the *arr e2e stub was too lenient and accepted the string, so
> CI passed while Sonarr/Lidarr 400'd live). Verified read-only 2026-07-03: `?eventType=1`
> → 200 with `records[0].eventType === "grabbed"` on all three. The `@hnet/arr` schemas
> expose `SONARR_GRABBED_EVENT_TYPE` / `LIDARR_GRABBED_EVENT_TYPE` (= their enum index) for
> the filter; response-side zod keeps the string. Radarr's separate `GET /history/movie`
> path is tolerant and accepts the string (proven live 200) — left unchanged.

Jellyseerr request (`GET /request?take=&skip=&sort=added`): `{id, type ('movie'|'tv'),
status, createdAt, media{tmdbId, tvdbId, mediaType, status}, requestedBy{id, email,
plexUsername, plexId, displayName}}`. **Jellyseerr 3.3.0 has no music/Lidarr support**
(its published API spec contains zero `lidarr`/MusicBrainz references) — Lidarr items
have no Seerr attribution path (Q-02).

### D-03 Endpoint inventory

**Read (sync + fix resolution + restore diff)** — all verified live:

| Purpose | Sonarr (v3) | Radarr (v3) | Lidarr (v1) |
|---|---|---|---|
| Item list (full sync) | `GET /series` | `GET /movie` | `GET /artist` |
| Child list (fix target picker) | `GET /episode?seriesId=` | — (movie is the target) | `GET /album?artistId=` |
| Paged history | `GET /history?page=&pageSize=&sortKey=date&sortDirection=descending` | same | same |
| Incremental history | `GET /history/since?date=&eventType=` | same | same |
| Latest grab for a target | `GET /history?episodeId=&eventType=1` (integer enum; `grabbed`=1) | `GET /history/movie?movieId=&eventType=grabbed` (tolerant path — string OK) | `GET /history?albumId=&eventType=1` (integer enum; `grabbed`=1) |
| Profiles / folders / tags | `GET /qualityprofile`, `GET /rootfolder`, `GET /tag` | same | same (+ metadata profile via item fields) |
| Wanted (spot checks) | `GET /wanted/missing?page=` (episode-level) | `GET /wanted/missing?page=` (movie-level) | `GET /wanted/missing?page=` (album-level) |
| Queue (fix-in-flight display) | `GET /queue?page=` | same | same |

Seerr: `GET /request?take=&skip=&sort=added` (attribution), `GET /settings/main`
(identity probe), `GET /status` (version).

**Write (Phase 2 mutations — verified in the published OpenAPI specs, NEVER called
during this investigation):**

| Operation | Endpoint | Notes |
|---|---|---|
| Mark grab failed (blocklist) | `POST /api/v3/history/failed/{id}` (Sonarr, Radarr), `POST /api/v1/history/failed/{id}` (Lidarr) | `{id}` = the **history record id** of the grab; no request body. This is the modern endpoint on all three (the pre-v3 `POST /history/failed` with a body id is gone). |
| Delete file (fix fallback) | `DELETE /episodefile/{id}` · `DELETE /moviefile/{id}` · `DELETE /trackfile/{id}` (bulk variants exist) | Lidarr deletes at track-file granularity — an album fix deletes every track file of that album. |
| Trigger search | `POST /command` with `{name: 'EpisodeSearch', episodeIds: int[]}` · `{name: 'MoviesSearch', movieIds: int[]}` · `{name: 'AlbumSearch', albumIds: int[]}` (`SeriesSearch {seriesId}` exists but Fix targets episodes) | Command *names* are not enumerable read-only via REST; verified against the command class constants in each *arr's `develop` source (`EpisodeSearchCommand`, `MoviesSearchCommand`, `AlbumSearchCommand`). |
| Re-add item (Restore) | `POST /series` · `POST /movie` · `POST /artist` | Payloads take the item resource + `addOptions` (`AddSeriesOptions{monitor, searchForMissingEpisodes,…}`, `AddMovieOptions{monitor, searchForMovie,…}`, `AddArtistOptions{monitor, monitored, searchForMissingAlbums,…}`). |
| Create tag (Restore prerequisite) | `POST /tag` `{label}` | All three; restore recreates missing tags by **label** before re-adding items. |

### D-04 Granularity: one `media_items` row per series / movie / artist

The ledger row is the ***arr's top-level library entity**: Sonarr series, Radarr movie,
Lidarr artist. Justification:

1. **It is the unit Restore re-adds** (R-51): `POST /series|/movie|/artist` recreate whole
   series/artists — and it is the entity that carries the settings Restore must preserve
   (monitored, quality profile, root folder, tags).
2. **It is the unit the *arrs manage settings on** — profile/folder/tags live at this
   level; mirroring lower would denormalize without adding truth.
3. **Scale sanity:** ~15k rows total today vs. 100k+ if Sonarr episodes were mirrored
   (40,862 missing episodes alone). Episode/album detail is one live GET away when needed
   (D-06) and always fresher than a sync copy.

Fix targets finer grain (episode/album — ADR-007); D-06 covers how without a synced child
table.

### D-05 `media_items`

Follows every DESIGN-001 D-01 convention (uuid PKs, snake_case, `timestamptz`,
text + CHECK enums). New enum arrays land in `packages/db/src/schema/enums.ts`.

```ts
// packages/db/src/schema/media-items.ts
export const ARR_KINDS = ['sonarr', 'radarr', 'lidarr'] as const;           // DDD-001 T-22

export const mediaItems = pgTable(
  'media_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    arrKind: text('arr_kind').$type<ArrKind>().notNull(),
    arrInstanceId: text('arr_instance_id').notNull().default('main'),  // config slug, not FK — see below
    arrItemId: integer('arr_item_id').notNull(),        // series.id / movie.id / artist.id — NOT stable across an *arr rebuild
    // External ids — the durable identity that survives an *arr rebuild (R-50 diffing key)
    tvdbId: integer('tvdb_id'),                         // sonarr (required for kind)
    tmdbId: integer('tmdb_id'),                         // radarr (required for kind); sonarr optional extra
    imdbId: text('imdb_id'),
    musicbrainzArtistId: text('musicbrainz_artist_id'), // lidarr foreignArtistId (required for kind)
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    year: integer('year'),                              // null for artists
    monitored: boolean('monitored').notNull(),
    qualityProfileId: integer('quality_profile_id').notNull(),
    qualityProfileName: text('quality_profile_name').notNull(), // snapshot — ids differ on a fresh *arr; Restore maps BY NAME
    metadataProfileId: integer('metadata_profile_id'),  // lidarr only
    metadataProfileName: text('metadata_profile_name'), // lidarr only
    rootFolder: text('root_folder').notNull(),          // rootFolderPath
    arrTags: jsonb('arr_tags').notNull().default([]),   // LABEL snapshots, e.g. ["mediarequests"] — tag ids don't survive rebuilds
    // On-disk stats, normalized across kinds (sonarr episode files / radarr hasFile / lidarr track files)
    onDiskFileCount: integer('on_disk_file_count').notNull().default(0),
    expectedFileCount: integer('expected_file_count').notNull().default(0),
    sizeOnDisk: bigint('size_on_disk', { mode: 'number' }).notNull().default(0),
    // Kind-specific restore-fidelity extras (documented keys only — see D-02 row "Restore-fidelity extras"):
    //   sonarr: { seriesType, seasonFolder, monitorNewItems, status, ended }
    //   radarr: { minimumAvailability, status }
    //   lidarr: { monitorNewItems, artistType, status }
    arrAttrs: jsonb('arr_attrs').notNull().default({}),
    // Sync bookkeeping
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    deletedFromArrAt: timestamp('deleted_from_arr_at', { withTimezone: true }), // TOMBSTONE (DDD-001 T-41); null = live in the *arr
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('media_items_arr_kind_enum', sql`${t.arrKind} = ANY (ARRAY['sonarr','radarr','lidarr'])`),
    // Every row carries the external id its kind diffs/restores by (R-50/R-51):
    check('media_items_external_id_for_kind', sql`
      (${t.arrKind} = 'sonarr' AND ${t.tvdbId} IS NOT NULL) OR
      (${t.arrKind} = 'radarr' AND ${t.tmdbId} IS NOT NULL) OR
      (${t.arrKind} = 'lidarr' AND ${t.musicbrainzArtistId} IS NOT NULL)`),
    unique('media_items_arr_identity_unique').on(t.arrKind, t.arrInstanceId, t.arrItemId),
    index('media_items_kind_tvdb_idx').on(t.arrKind, t.tvdbId),
    index('media_items_kind_tmdb_idx').on(t.arrKind, t.tmdbId),
    index('media_items_kind_mbid_idx').on(t.arrKind, t.musicbrainzArtistId),
    index('media_items_sort_title_idx').on(t.sortTitle),
  ],
);
```

Decisions:

1. **`arr_instance_id` is a config slug (`'main'` today), not a FK.** Instance config is
   env-owned (D-18); a DB registry table would mirror env with drift risk and no reader.
   The column exists so a second instance (e.g. a future `sonarr-4k`) is a data change,
   not a migration.
2. **`arr_item_id` is bookkeeping, external ids are identity.** A rebuilt *arr assigns
   new internal ids; sync re-matches rows by `(arr_kind, arr_instance_id, external id)`
   and updates `arr_item_id` in place (D-14). The UNIQUE is on the *arr identity triple
   so the live mirror can never hold two rows for one *arr item.
3. **Snapshots by name** (`quality_profile_name`, `arr_tags` labels): numeric profile/tag
   ids are meaningless on a fresh instance; Restore resolves names/labels against the
   live target (D-16). This is exactly ADR-008's "enough to re-add" field set.
4. **Tombstone, never delete** (T-41): sync marks vanished rows `deleted_from_arr_at`
   and keeps them — R-41's "what was deleted when" and the DR value of the ledger both
   require it. Retention: keep forever at this scale (Q-03).

### D-06 No synced child table — fix targets resolve live

Fix targets an **episode** (Sonarr), the **movie itself** (Radarr), or an **album**
(Lidarr) per ADR-007. A synced `media_children` table was considered and rejected
(§Alternatives): it would add ~100k+ rows and a second staleness surface to serve a flow
that must consult the live *arr at execution time anyway (ADR-008 C-04 — Fix targets
*live* history). Instead:

- The fix UI's episode/album picker calls `ledger.children` (D-17), which proxies the
  live `GET /episode?seriesId=` / `GET /album?artistId=` through `packages/arr`.
- `fix_requests` records the chosen target denormalized (`target_arr_child_id` +
  `target_label`, D-09) — durable without a child FK.
- `ledger_events` carries child identifiers in `payload` (episode/album ids + labels from
  *arr history records); the FK lands on the parent `media_items` row.

Consequence: episode-level *wanted* browsing is also not mirrored (see D-08 + Q-05).

### D-07 `ledger_events`

```ts
export const LEDGER_EVENT_TYPES = [
  'grabbed', 'imported', 'deleted', 'download_failed',   // from *arr history (normalized)
  'requested',                                           // from Seerr
  'fix_requested', 'fix_actioned', 'fix_completed', 'fix_failed', // Fix lifecycle (D-09)
  'restored',                                            // Restore write-back (D-16)
  'search_requested',                                    // Force Search — search-only (D-17; migration 0004)
] as const;
export const LEDGER_EVENT_SOURCES = ['sonarr', 'radarr', 'lidarr', 'seerr', 'app'] as const;

export const ledgerEvents = pgTable(
  'ledger_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'cascade' }),
      // nullable: a Seerr request can precede the *arr add; sync backfills the FK when the
      // item appears (matched by tmdb/tvdb id kept in payload)
    eventType: text('event_type').$type<LedgerEventType>().notNull(),
    source: text('source').$type<LedgerEventSource>().notNull(),
    sourceEventId: text('source_event_id'),   // *arr history id / Seerr request id — dedupe key
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(), // source timestamp
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
      // resolved app user for 'requested' events (D-14 attribution); null = unattributed (ADR-008 C-05)
    payload: jsonb('payload').notNull(),      // sanitized source record + normalized bits: raw eventType,
                                              // sourceTitle, quality, indexer, releaseGroup, downloadId,
                                              // child target {episodeId|albumId, label}, external ids,
                                              // Seerr requestedBy {plexUsername, email}, fixRequestId, …
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ledger_events_event_type_enum', sql`${t.eventType} = ANY (ARRAY[
      'grabbed','imported','deleted','download_failed','requested',
      'fix_requested','fix_actioned','fix_completed','fix_failed','restored',
      'search_requested'])`),
    check('ledger_events_source_enum',
      sql`${t.source} = ANY (ARRAY['sonarr','radarr','lidarr','seerr','app'])`),
    uniqueIndex('ledger_events_source_event_unique')
      .on(t.source, t.sourceEventId).where(sql`${t.sourceEventId} IS NOT NULL`),
      // idempotent re-ingestion: overlapping history polls upsert-skip on conflict
    index('ledger_events_item_occurred_idx').on(t.mediaItemId, t.occurredAt.desc()),
    index('ledger_events_type_occurred_idx').on(t.eventType, t.occurredAt.desc()),
  ],
);
```

Normalization map (raw eventType always preserved in `payload.rawEventType`):

| Normalized | Sonarr | Radarr | Lidarr |
|---|---|---|---|
| `grabbed` | `grabbed` | `grabbed` | `grabbed` |
| `imported` | `downloadFolderImported`, `seriesFolderImported` | `downloadFolderImported`, `movieFolderImported` | `trackFileImported`, `downloadImported`, `artistFolderImported` |
| `deleted` | `episodeFileDeleted` | `movieFileDeleted` | `trackFileDeleted` |
| `download_failed` | `downloadFailed` | `downloadFailed` | `downloadFailed` |
| (dropped, payload-only) | `episodeFileRenamed`, `downloadIgnored`, `unknown` | renames/ignored/unknown | renames/retagged/`albumImportIncomplete`/ignored/unknown |

Item-level removals (a series/movie/artist vanishing from the *arr) are not history
events; the full-sync tombstone pass writes a `deleted` event with `source` = the *arr and
`payload.kind = 'item_removed'` (vs `'file_deleted'` for history-sourced deletions), so
R-41's "what was deleted when" covers both shapes.

### D-08 Wanted = a view, not a table

**Decision: `wanted_items` is a SQL view over `media_items`** (the DESIGN-001 D-15
reserved name is claimed by the view), mirroring the D-11 precedent (one canonical
definition, `psql`-queryable, typed wrapper in `packages/domain`):

```sql
CREATE VIEW wanted_items AS
  SELECT id AS media_item_id, arr_kind, title, sort_title, year,
         expected_file_count, on_disk_file_count, size_on_disk, last_seen_at
    FROM media_items
   WHERE monitored
     AND deleted_from_arr_at IS NULL
     AND on_disk_file_count = 0;
```

Justification: DDD-001 T-27 already defines Wanted Item as *derived* ("a Monitored Media
Item with nothing on disk"), and a table would have to mirror Sonarr's 40,862-row
episode-level `wanted/missing` feed — pure duplication of *arr state with no attribution
or DR value added (the two things the ledger exists for). Partially-missing series
(`0 < on_disk_file_count < expected_file_count`) are browsable via a `ledger.search`
filter rather than the view. Episode-level wanted browsing, if ever wanted, proxies the
live `wanted/missing` endpoint (Q-05).

### D-09 `fix_requests` and the Fix lifecycle

```ts
export const FIX_REASONS = [
  'wont_play_corrupt', 'wrong_language', 'wrong_version_quality',
  'missing_subtitles', 'wrong_content', 'other',
] as const;                                              // R-45; DDD-001 T-30
export const FIX_STATUSES = [
  'pending', 'actioned', 'search_triggered', 'failed', 'completed',
] as const;                                              // Fix Lifecycle, DDD-001 T-43
export const FIX_PATHS = ['blocklist_search', 'delete_search'] as const; // AC-07 vs AC-08

export const fixRequests = pgTable(
  'fix_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterId: uuid('requester_id').references(() => users.id, { onDelete: 'set null' }),
      // audit-grade row: outlives the user; requester email/displayName snapshotted in actionsTaken[0]
    mediaItemId: uuid('media_item_id').notNull()
      .references(() => mediaItems.id, { onDelete: 'restrict' }),
      // RESTRICT: fix history must not silently vanish; media_items rows tombstone, never delete (D-05)
    targetArrChildId: integer('target_arr_child_id'),    // episode id (sonarr) / album id (lidarr); NULL for radarr
    targetLabel: text('target_label'),                   // e.g. 'S06E02 · Rich' / album title — display-durable
    reason: text('reason').$type<FixReason>().notNull(),
    reasonText: text('reason_text'),
    status: text('status').$type<FixStatus>().notNull().default('pending'),
    pathTaken: text('path_taken').$type<FixPath>(),      // null until actioned
    actionsTaken: jsonb('actions_taken').notNull().default([]),
      // ordered steps incl. RAW *ARR RESPONSES (AC-07): [{step:'resolve_grab'|'mark_failed'|
      //  'delete_file'|'trigger_search', endpoint:'POST /api/v3/history/failed/123',
      //  ok:true, status:200, response:{…sanitized…}, at:'ISO'}]
    completedEventId: uuid('completed_event_id').references(() => ledgerEvents.id, { onDelete: 'set null' }),
      // the observed replacement-import event that closed the loop (ADR-007 C-06)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('fix_requests_reason_enum', sql`${t.reason} = ANY (ARRAY['wont_play_corrupt',
      'wrong_language','wrong_version_quality','missing_subtitles','wrong_content','other'])`),
    check('fix_requests_status_enum', sql`${t.status} = ANY (ARRAY['pending','actioned',
      'search_triggered','failed','completed'])`),
    check('fix_requests_path_enum',
      sql`${t.pathTaken} IS NULL OR ${t.pathTaken} = ANY (ARRAY['blocklist_search','delete_search'])`),
    // reason_text required IFF reason = 'other' (R-45): free text rides only on 'other'
    check('fix_requests_reason_text_iff_other', sql`
      (${t.reason} = 'other' AND ${t.reasonText} IS NOT NULL AND btrim(${t.reasonText}) <> '')
      OR (${t.reason} <> 'other' AND ${t.reasonText} IS NULL)`),
    index('fix_requests_requester_created_idx').on(t.requesterId, t.createdAt.desc()),
    index('fix_requests_item_idx').on(t.mediaItemId),
    index('fix_requests_status_idx').on(t.status),
  ],
);
```

**Lifecycle (T-43)** — transitions only via the `packages/domain` writers (D-12):

```
pending ──(blocklist or delete succeeded)──> actioned ──(search command accepted)──> search_triggered
   │                                            │                                        │
   └──(any *arr call failed)──> failed <────────┘            (sync observes replacement import)
                                                                                          v
                                                                                      completed
```

- `pending`: row + `fix_requested` ledger event written in one transaction **before** any
  *arr call — a crash mid-fix leaves an admin-visible pending row, never a silent
  half-action.
- `actioned`: the destructive step landed (`POST history/failed/{id}` per the primary
  path, or file DELETE(s) on the fallback); `path_taken` set; `fix_actioned` event.
- `search_triggered`: `POST /command` accepted (command id recorded in `actions_taken`).
- `completed`: a later sync ingests an `imported` event for the same target
  (`media_item_id` + child id match); the matcher writer flips status, links
  `completed_event_id`, writes `fix_completed` (asynchronous by design — ADR-007 C-06).
- `failed`: any step errored; response captured; surfaced to admins (R-46). Terminal
  alongside `completed`; users re-raise rather than retry in place.

**Rate guard (R-47, PRD Q-05 default):** constant `FIX_RATE_LIMIT_PER_HOUR = 5` in
`packages/domain` — `createFixRequest` counts the requester's rows with
`created_at > now() - interval '1 hour'` inside the insert transaction (under a
per-requester `pg_advisory_xact_lock` so parallel submissions can't slip past) and throws
`FixRateLimitError` at the limit. Admins bypass. Additionally, **one open fix per
target**: an existing `pending`/`actioned`/`search_triggered` row for the same
`(media_item_id, target_arr_child_id)` → `FixAlreadyOpenError` (CONFLICT).

### D-10 `restore_runs`

The durable record of every Restore execution (R-52's audit + AC-09's report):

```ts
export const RESTORE_RUN_STATUSES = ['running', 'completed', 'completed_with_errors', 'failed'] as const;

export const restoreRuns = pgTable(
  'restore_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    arrKind: text('arr_kind').$type<ArrKind>().notNull(),
    arrInstanceId: text('arr_instance_id').notNull(),
    initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }), // admin (snapshot in preview)
    status: text('status').$type<RestoreRunStatus>().notNull().default('running'),
    preview: jsonb('preview').notNull(),   // the exact diff the admin approved: [{mediaItemId, title, externalId, tombstoned}]
    results: jsonb('results').notNull().default([]), // per item: {mediaItemId, ok, newArrItemId?|error?, at}
    itemCount: integer('item_count').notNull(),
    successCount: integer('success_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('restore_runs_arr_kind_enum', sql`${t.arrKind} = ANY (ARRAY['sonarr','radarr','lidarr'])`),
    check('restore_runs_status_enum', sql`${t.status} = ANY (ARRAY['running','completed','completed_with_errors','failed'])`),
    index('restore_runs_started_idx').on(t.startedAt.desc()),
  ],
);
```

### D-11 Sync bookkeeping: `sync_runs` + `sync_state`

Two small tables, one job each (DDD-001 T-37 prescribes `sync_runs`):

```ts
export const SYNC_SOURCES = ['sonarr', 'radarr', 'lidarr', 'seerr'] as const;
export const SYNC_RUN_KINDS = ['full', 'incremental'] as const;
export const SYNC_RUN_STATUSES = ['running', 'succeeded', 'failed', 'aborted'] as const;

// Observability: one append-only row per run (never updated after finish)
export const syncRuns = pgTable('sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').$type<SyncSource>().notNull(),          // CHECK: SYNC_SOURCES
  runKind: text('run_kind').$type<SyncRunKind>().notNull(),      // CHECK: SYNC_RUN_KINDS
  status: text('status').$type<SyncRunStatus>().notNull().default('running'), // CHECK: SYNC_RUN_STATUSES
  stats: jsonb('stats').notNull().default({}),  // {itemsSeen, upserted, tombstoned, eventsIngested, requestsMatched, …}
  error: text('error'),                          // incl. the mass-tombstone abort reason
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

// Cursor of record: one row per source (T-42 Sync Cursor), advanced in the SAME
// transaction as each committed ingestion batch — a crash never re-processes committed
// events (and re-delivery is harmless anyway via the D-07 dedupe unique index).
export const syncState = pgTable('sync_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').$type<SyncSource>().notNull().unique(), // CHECK: SYNC_SOURCES
  historyCursor: timestamp('history_cursor', { withTimezone: true }), // max ingested history `date` / Seerr `createdAt`
  lastFullSyncAt: timestamp('last_full_sync_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### D-12 Audit decision + new single-writers (DESIGN-001 D-15's open item)

**Decision: sibling audit tables, not `permission_audit` extension.** `permission_audit`
belongs to BC-02 Entitlements; Fix/Restore/Sync are BC-03 aggregates whose rows *are* the
audit record (`fix_requests`, `restore_runs`, `sync_runs` carry actor, actions, raw
responses, and timestamps — richer than a generic audit row could). The
`permission_audit` action CHECK is untouched by Phase 2.

The D-12 single-writer rule extends to every Phase 2 table. New writers in
`packages/domain` (the no-direct-writes guard test adds `media_items`, `ledger_events`,
`fix_requests`, `restore_runs`, `sync_runs`, `sync_state` to its watched list):

| Writer | Mutates | Transactionality |
|---|---|---|
| `startSyncRun` / `finishSyncRun` | `sync_runs` | run row brackets the batch writers |
| `upsertMediaItemsBatch` | `media_items`, `sync_state.last_full_sync_at` | per-batch tx; external-id re-match (D-14) |
| `tombstoneMissingItems` | `media_items.deleted_from_arr_at` + `ledger_events('deleted')` | one tx; enforces the mass-tombstone guard (D-14) |
| `ingestLedgerEvents` | `ledger_events` + `sync_state.history_cursor` | events + cursor advance in one tx; ON CONFLICT DO NOTHING on the dedupe index |
| `backfillEventAttribution` | `ledger_events.media_item_id` / `requested_by_user_id` | resolves formerly-unmatched Seerr events after items/users appear |
| `createFixRequest` | `fix_requests` + `ledger_events('fix_requested')` | one tx; rate limit + open-fix dedupe inside (D-09) |
| `recordFixAction` | `fix_requests.{status,path_taken,actions_taken}` + `ledger_events('fix_actioned'\|'fix_failed')` | one tx per lifecycle step |
| `completeFixRequests` | `fix_requests.{status,completed_event_id}` + `ledger_events('fix_completed')` | invoked by sync after import ingestion |
| `startRestoreRun` / `recordRestoreResult` / `finishRestoreRun` | `restore_runs` (+ `ledger_events('restored')` per success) | run row first; per-item results appended as each *arr POST returns |

Write-backs to the *arrs themselves are additionally confined by construction:
`packages/arr` exports its write surface from a separate entrypoint (D-18) that only
`recordFixAction`/restore writers may import — enforced by an ADR-010-style guard test.

### D-13 Migration numbering

Continues DESIGN-001 D-13:

| Migration | Contents | How produced |
|---|---|---|
| `0003_media_ledger.sql` | All D-05..D-11 tables, CHECKs, partial unique + indexes, and the `wanted_items` view | `drizzle-kit generate`; view appended by hand if drizzle-kit still doesn't emit `pgView` (DESIGN-001 Q-04's resolution applies here too) |
| `0004_search_requested_event.sql` | Relaxes (drop + re-add) the `ledger_events_event_type_enum` CHECK to admit `'search_requested'` — the Force Search audit event (D-17). Existing rows unaffected | hand-written ALTER TABLE; `LEDGER_EVENT_TYPES` extended in `packages/db/src/schema/enums.ts` in the same change |

No seed data — every row arrives via sync.

### D-14 Sync architecture (ADR-008: strictly *arr → app)

#### Runner: Kubernetes CronJobs reusing the app image — recommended

| | **CronJob (chosen)** | In-process interval (rejected) |
|---|---|---|
| Single-writer guarantee | `concurrencyPolicy: Forbid` — by construction | needs advisory locks the moment `apps/web` scales past 1 replica |
| Failure isolation | a wedged sync can't degrade request serving; OOM/timeouts kill the Job, not the app | full sync of ~15k items + history bursts contend with user requests |
| Observability | Job history, per-run logs, k8s-native alerting | buried in app logs |
| Restart semantics | each run starts clean; cursor in `sync_state` resumes | `setInterval` state lost on every deploy/restart mid-run |
| ADR-006 single image | preserved — command override, same pattern as the migrator init container | trivially preserved |

The Dockerfile already proves the mechanism: the migrator runs `tsx` against a
`pnpm deploy`-flattened subtree of the same image. Phase 2 adds one more flattened
subtree (`pnpm --filter @hnet/sync deploy --legacy --prod /sync-deploy` → `/sync`;
the runner lives in its own `@hnet/sync` package so the CLI and orchestration stay
out of the ACL package — workspace-dep chain flattening verified, Q-07). **Command:**

```
tsx /sync/src/scripts/sync.ts --mode=incremental        # every 15 min
tsx /sync/src/scripts/sync.ts --mode=full               # nightly 03:30
```

Two CronJobs in the haynesnetwork HelmRelease (haynes-ops), both `concurrencyPolicy:
Forbid`, `backoffLimit: 0` (the next tick retries; cursors make missed ticks harmless),
sharing the app's ExternalSecret-fed env (D-18). Fix/Restore are *not* CronJob work —
they run in-request in `apps/web` (user-facing latency, and they must report *arr
responses synchronously).

#### Full sync (per *arr instance): upsert + tombstone

1. `GET /qualityprofile` + `GET /tag` → id→name/label lookup maps.
2. `GET /series|/movie|/artist` (single unpaged call — verified fine at live scale).
3. For each item, adapt to the D-05 shape and **match an existing row**:
   a. by `(arr_kind, arr_instance_id, arr_item_id)`;
   b. else by `(arr_kind, arr_instance_id, external id)` — the rebuilt-*arr case:
      update `arr_item_id`, clear `deleted_from_arr_at` (un-tombstone), keep history.
   c. else insert (`first_seen_at = now()`).
   Batched upserts (`upsertMediaItemsBatch`, 500/tx); `last_seen_at = now()` on every
   matched row.
4. **Tombstone pass** (`tombstoneMissingItems`): live rows of that instance not seen in
   step 3 get `deleted_from_arr_at = now()` + a `deleted` ledger event
   (`payload.kind = 'item_removed'`).
5. **Mass-tombstone guard:** if the pass would tombstone more than
   `SYNC_TOMBSTONE_GUARD_PCT = 20%` of the instance's live rows (and more than 10 rows),
   the run **aborts** (`sync_runs.status = 'aborted'`, error recorded, tombstones NOT
   written). Rationale: a wiped/fresh *arr looks exactly like a mass deletion; blindly
   tombstoning would corrupt the very ledger Restore needs (R-50). An admin re-runs with
   `--force-tombstones` after confirming reality (threshold + override UX: Q-03).

#### Incremental history polling (per *arr): cursor + dedupe

- `GET /history/since?date=<sync_state.history_cursor>` (endpoint verified on all three;
  first run and large gaps fall back to paged
  `GET /history?page=…&sortKey=date&sortDirection=descending` walked until the cursor).
- Normalize per the D-07 map; resolve `media_item_id` via `seriesId`/`movieId`/`artistId`
  → `(arr_kind, arr_item_id)`; child ids and release metadata into `payload`.
- `ingestLedgerEvents` advances `sync_state.history_cursor = max(date)` in the same
  transaction; the partial unique index makes overlap re-delivery a no-op.
- After ingestion, `completeFixRequests` matches new `imported` events against open
  `search_triggered` fixes (D-09).

#### Seerr request attribution (Jellyseerr 3.3.0)

- Poll `GET /request?take=100&skip=…&sort=added`, newest-first until `createdAt` ≤ the
  `seerr` cursor.
- Map request → item: `type='movie'` → `media.tmdbId` → radarr `media_items.tmdb_id`;
  `type='tv'` → `media.tvdbId` (fallback `tmdbId`) → sonarr row. No match yet (request
  precedes the *arr add) → event stored with `media_item_id = NULL` + external ids in
  payload; `backfillEventAttribution` re-resolves after later item syncs. **Music: no
  Seerr path exists** (D-02) — Lidarr items simply have no `requested` events (Q-02).
- Map `requestedBy` → app user: case-insensitive `requestedBy.email` vs `users.email`
  (both derive from the same Plex account via Authentik-with-Plex, so email is the
  expected join); fallback `plexUsername` vs `users.display_name` is recorded as a
  *suggestion* in payload but not auto-linked. Unresolved → `requested_by_user_id NULL`,
  rendered "unattributed" (ADR-008 C-05). Confidence unproven against real accounts —
  Q-01.

### D-15 Fix flow (ADR-007, AC-07/AC-08)

```mermaid
sequenceDiagram
    actor U as User (Member)
    participant W as apps/web (fix router)
    participant D as packages/domain
    participant A as owning *arr (via packages/arr)

    U->>W: ledger.detail → picks item (+ episode/album via ledger.children, live)
    U->>W: fix.create { mediaItemId, targetChildId?, reason, reasonText? }
    W->>D: createFixRequest (rate limit 5/h, open-fix dedupe)
    D-->>W: fix_requests row (pending) + fix_requested event  [one tx]
    W->>A: GET latest grab — paged /history?episodeId|albumId=&eventType=1 (INTEGER enum; grabbed=1); Radarr /history/movie?movieId=&eventType=grabbed (tolerant)
    alt grab history exists (primary — AC-07)
        W->>A: POST history/failed/{grabHistoryId}   ← blocklists the release
        A-->>W: 200
        W->>D: recordFixAction → actioned, path=blocklist_search (+responses)
    else no grab history (fallback — AC-08)
        W->>A: DELETE episodefile/{id} | moviefile/{id} | trackfile/{id}…
        A-->>W: 200 (cannot blocklist — limitation recorded on the row)
        W->>D: recordFixAction → actioned, path=delete_search (+responses)
    end
    W->>A: POST command { EpisodeSearch|MoviesSearch|AlbumSearch, ids }
    A-->>W: 201 (command id)
    W->>D: recordFixAction → search_triggered
    W-->>U: fix status + path taken
    Note over D,A: later: incremental sync ingests the replacement 'imported' event →<br/>completeFixRequests flips search_triggered → completed (ADR-007 C-06)
```

Rules already fixed above: mandatory reason taxonomy with `reason_text` iff `other`
(D-09 CHECK), per-user rate limit `FIX_RATE_LIMIT_PER_HOUR = 5` (constant per PRD Q-05;
admin-configurable later), every step's raw *arr response persisted in `actions_taken`,
any step failure → `failed` + `fix_failed` event. Target validation lives in
`createFixRequest`: sonarr requires an episode target, lidarr an album target, radarr
requires none (`FixTargetRequiredError` otherwise). Admin visibility = `fix.adminList`
(all rows, filterable); users see exactly their own via `fix.myFixes` (R-46).

**Fix targets a single child, never the whole show (owner feedback).** The detail page
renders the live per-episode (sonarr) / per-album (lidarr) list from `ledger.children`
with each child's on-disk state, and the Fix action lives on that row — the dialog
carries that specific episode/album, so a user repairs one broken thing rather than the
whole series. Radarr stays movie-level (the movie *is* the child). The old show-level
Fix button is gone for sonarr/lidarr.

**Force Search — the search-only sibling for MISSING content (D-17).** Content that is
Monitored but has nothing on disk is missing, not broken: it gets a **Force Search**
action, not Fix. Force Search triggers ONLY the owning *arr's search command (episode /
album / movie / whole-series `SeriesSearch`), with **no** `history/failed` (Blocklist),
**no** file delete, and no Fix Reason — a single confirm. It records an audited
`search_requested` `ledger_events` row (source `app`, attributed to the requester) via
the `recordSearchRequest` single-writer, and the `runForceSearch` orchestrator fires the
command after that audit row commits (search-only surface of `@hnet/arr/write`). Force
Search **shares the Fix hourly budget** (`countRecentFixBudget` counts a requester's
`fix_requests` + `search_requested` events against `FIX_RATE_LIMIT_PER_HOUR`; admins
bypass) so the two actions can't be alternated to dodge R-47. UI rule everywhere
(library list, wanted rows, detail item + each episode/album): **on disk → Fix; not on
disk → Force Search.**

### D-16 Restore flow (R-50..R-52, AC-09)

Explicitly **not automatic** — no code path triggers Restore but the two admin
procedures; sync never writes to a *arr.

1. **Diff (`restore.diff`, admin, read-only):** fetch the live item list from the target
   instance; index by external id; candidates = ledger rows of that
   `(arr_kind, arr_instance_id)` with `monitored = true` whose external id is absent from
   the live set. Tombstoned rows are *included* (the disaster that lost the *arr DB is
   exactly what tombstoned them — possibly behind the D-14 guard) and badged. Returns the
   preview list `{mediaItemId, title, year, externalId, qualityProfileName, rootFolder,
   arrTags, tombstonedAt?}` — never persisted; R-52's preview is the admin seeing this
   before step 2.
2. **Execute (`restore.execute`, admin):** input is the **explicit `mediaItemIds` list
   the admin approved** (re-validated against a fresh live diff; vanished/now-present
   items are skipped into the report — no TOCTOU re-adds). `startRestoreRun` persists the
   approved preview, then per item:
   - resolve `quality_profile_name` → live profile id (`GET qualityprofile`; no match →
     per-item failure, never a silent default), `root_folder` verified against
     `GET rootfolder`, `arr_tags` labels → live tag ids (`POST /tag` for missing labels —
     the one auxiliary write, part of the sanctioned Restore surface);
   - `POST /series` `{tvdbId, title, qualityProfileId, rootFolderPath, monitored: true,
     seasonFolder, seriesType, tags, addOptions: {monitor: 'all',
     searchForMissingEpisodes: false}}` — or the `/movie` (`tmdbId`,
     `minimumAvailability`, `searchForMovie: false`) / `/artist` (`foreignArtistId`,
     `metadataProfileId`, `searchForMissingAlbums: false`) analogue, kind-specific attrs
     from `arr_attrs`;
   - `recordRestoreResult` appends `{ok, newArrItemId | error}`; success also writes a
     `restored` ledger event and clears the row's tombstone + updates `arr_item_id`.
   Searches are deliberately **off** at add time — a 400-item restore must not carpet-bomb
   the indexers; the *arr's own RSS/missing loop backfills, and the admin can trigger
   searches selectively afterwards (default flagged for owner sign-off: Q-04).
3. **Report:** `finishRestoreRun` closes the run (`completed` /
   `completed_with_errors`); `restore.run` returns preview + per-item results — AC-09's
   success/failure report, durable in `restore_runs` (R-52 audit).

### D-17 tRPC surface additions

Three new routers in `packages/api` (DESIGN-003 reserved `ledger` and `fix`; `restore` is
claimed here as the third Phase 2 name — recorded so DESIGN-003's reservation comment can
be updated when next touched). Conventions carried over: zod v4 inputs, ISO-string
timestamps, `mapDomainErrors`, every mutation through a D-12 writer.

**Deviation from DESIGN-003 D-03 (no pagination):** `ledger.*` lists and `fix.adminList`
are cursor-paginated (`{cursor?, limit ≤ 100}`) — the ledger is 15k+ rows today, not
household-scale. Phase 1 routers are unchanged.

```ts
// ---------- ledger (authed: browse/search is a Member feature, R-43) ----------
export const ledgerRouter = router({
  search: authedProcedure.input(z.object({
    query: z.string().trim().max(200).optional(),          // title ILIKE / sort_title prefix
    arrKind: z.enum(ARR_KINDS).optional(),
    onDisk: z.enum(['any', 'complete', 'partial', 'none']).default('any'),
    wanted: z.boolean().optional(),                        // shortcut to the D-08 view semantics
    includeTombstoned: z.boolean().default(false),
    cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50),
  })).query(/* projected rows {id, arrKind, title, year, monitored, onDiskFileCount,
               expectedFileCount, sizeOnDisk, qualityProfileName, tombstoned} + nextCursor */),

  detail: authedProcedure.input(z.object({ id: z.uuid() }))
    .query(/* full media_item + latest ledger_events page (incl. requested-by displayName
              when attributed) + open/recent fix_requests for the item */),

  events: authedProcedure.input(z.object({ mediaItemId: z.uuid(),
      cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(/* event page for the detail view's "history" tab */),

  children: authedProcedure.input(z.object({ mediaItemId: z.uuid() }))
    .query(/* LIVE proxy (D-06): sonarr episodes / lidarr albums / [] for radarr;
              {arrChildId, label, hasFile, monitored} — fix target picker */),

  wanted: authedProcedure.input(z.object({ arrKind: z.enum(ARR_KINDS).optional(),
      cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(/* wanted_items view (D-08), ordered by sort_title */),
});

// ---------- fix ----------
export const fixRouter = router({
  create: authedProcedure.input(z.object({
    mediaItemId: z.uuid(),
    targetChildId: z.number().int().positive().optional(), // required iff sonarr/lidarr (domain-validated)
    reason: z.enum(FIX_REASONS),
    reasonText: z.string().trim().min(1).max(500).optional(), // required iff reason === 'other' (zod .refine + D-09 CHECK)
  }).refine(v => (v.reason === 'other') === (v.reasonText !== undefined),
    { error: 'reasonText is required exactly when reason is "other"' }))
    .mutation(/* createFixRequest → D-15 orchestration → returns
                 {id, status, pathTaken, targetLabel} */),

  // Force Search (D-15/D-17): search-only for MISSING content — no reason, no
  // blocklist, no delete. targetChildId optional (sonarr episode or whole-series;
  // required for lidarr album; forbidden for radarr). Shares the Fix hourly budget.
  forceSearch: authedProcedure.input(z.object({
    mediaItemId: z.uuid(),
    targetChildId: z.number().int().positive().optional(),
  })).mutation(/* runForceSearch → recordSearchRequest ('search_requested') + the
                  *arr search command → returns {eventId, targetLabel, commandName} */),

  myFixes: authedProcedure.query(/* caller's fix_requests, newest first:
    {id, item {title, arrKind}, targetLabel, reason, status, pathTaken, createdAt, updatedAt} */),

  adminList: adminProcedure.input(z.object({
    status: z.enum(FIX_STATUSES).optional(), requesterId: z.uuid().optional(),
    cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50),
  })).query(/* all rows + requester {id, displayName} + actionsTaken (raw responses — R-46) */),
});

// ---------- restore (admin-only, R-52) ----------
export const restoreRouter = router({
  diff: adminProcedure.input(z.object({ arrKind: z.enum(ARR_KINDS),
      arrInstanceId: z.string().default('main') }))
    .query(/* D-16 step 1 preview list — live call, not persisted */),

  execute: adminProcedure.input(z.object({ arrKind: z.enum(ARR_KINDS),
      arrInstanceId: z.string().default('main'),
      mediaItemIds: z.array(z.uuid()).min(1).max(10_000) }))
    .mutation(/* startRestoreRun → per-item POSTs (D-16 step 2) → returns {runId};
                 execution is awaited for small sets, chunk-reported via restore.run for large */),

  run: adminProcedure.input(z.object({ id: z.uuid() }))
    .query(/* restore_runs row: status, counts, preview, per-item results (AC-09 report) */),

  runs: adminProcedure.query(/* recent runs, newest first */),
});
```

**Error taxonomy additions** (extends DESIGN-003 D-13's table in place, as it planned):

| Domain error | `appCode` | TRPC code | Thrown by |
|---|---|---|---|
| `FixRateLimitError` | `FIX_RATE_LIMIT_EXCEEDED` | `TOO_MANY_REQUESTS` | `createFixRequest` (R-47) |
| `FixAlreadyOpenError` | `FIX_ALREADY_OPEN` | `CONFLICT` | `createFixRequest` dedupe |
| `FixTargetRequiredError` | `FIX_TARGET_REQUIRED` | `UNPROCESSABLE_CONTENT` | sonarr/lidarr fix without child target |
| `ArrUpstreamError` | `ARR_UPSTREAM_UNAVAILABLE` | `BAD_GATEWAY` | any *arr/Seerr call failure surfaced to the client |
| `RestoreProfileUnmappedError` | `RESTORE_PROFILE_UNMAPPED` | `UNPROCESSABLE_CONTENT` | per-item in execute (also recorded in `results`) |
| `LedgerItemTombstonedError` | `LEDGER_ITEM_TOMBSTONED` | `PRECONDITION_FAILED` | `fix.create` on a tombstoned item (nothing to fix in the *arr) |

### D-18 `packages/arr` — clients, config, secrets

```
packages/arr/                        @hnet/arr (raw-TS workspace package, like siblings)
  src/
    config.ts          arrEnv / assertArrEnv — the env contract below
    http.ts            fetch wrapper: X-Api-Key header, timeouts, retry(2, idempotent GETs only)
    schemas/           zod parsers for exactly the D-02 field sets (sonarr.ts radarr.ts lidarr.ts seerr.ts)
    read.ts            ArrReadClient + SeerrReadClient (everything in D-03's read table)   ← sync, ledger.children, restore.diff
    write.ts           ArrWriteClient (history/failed, file deletes, command, add-item, tag) ← ONLY importable by packages/domain fix/restore writers (guard test, D-12)
    scripts/sync.ts    the CronJob CLI entry (D-14): --mode=full|incremental [--source=…] [--force-tombstones]
  __fixtures__/        sanitized recorded GET responses (test strategy)
```

Read and write surfaces are **separate entrypoints** (`@hnet/arr/read`, `@hnet/arr/write`)
per ADR-008's enforceability requirement. Zod parsing is `strip`-mode with required
fields only — unknown *arr fields never enter the app (BC-03 ACL).

**Env contract** (per-instance; URLs are non-secret config, keys are secrets):

| Variable | Cluster value (HelmRelease env / ExternalSecret) | Local dev (`.env.local`) |
|---|---|---|
| `SONARR_URL` | `http://sonarr.media.svc.cluster.local:8989` | `https://sonarr.haynesops.com` |
| `RADARR_URL` | `http://radarr.media.svc.cluster.local:7878` | `https://radarr.haynesops.com` |
| `LIDARR_URL` | `http://lidarr.media.svc.cluster.local:8686` | `https://lidarr.haynesops.com` |
| `SEERR_URL` | `http://seerr.media.svc.cluster.local:5055` | `https://seerr.haynesops.com` |
| `SONARR_API_KEY` / `RADARR_API_KEY` / `LIDARR_API_KEY` / `SEERR_API_KEY` | ExternalSecret (below) | copied from the same 1Password fields |

These are server/CronJob-only values — they never reach client bundles, and the
`*.haynesops.com` dev URLs are backend config, not user-facing links (R-14 untouched; the
catalog CHECK still guards everything user-visible).

**ExternalSecret additions (haynes-ops, `kubernetes/main/apps/frontend/haynesnetwork/app/externalsecret.yaml`)** —
sources verified against the live cluster's existing ExternalSecrets in ns `media`:

| Secret key | 1Password item → field (`HaynesKube` vault) |
|---|---|
| `SONARR_API_KEY` | `media-stack` → `SONARR_API_KEY` (property already consumed by the media-ns `sonarr` ExternalSecret) |
| `RADARR_API_KEY` | `media-stack` → `RADARR_API_KEY` (same pattern) |
| `LIDARR_API_KEY` | `lidarr` → `LIDARR__AUTH__APIKEY` (the `lidarr` item is whole-item-extracted in ns `media`; we map the field to the clean name) |
| `SEERR_API_KEY` | today only exists as `HOMEPAGE_VAR_SEERR_API_KEY` (whole-item extract feeding `homepage-secret`, ns `frontend`); recommend the owner add a canonical `SEERR_API_KEY` field to `media-stack` — Q-06 |

## Alternatives considered

- **Synced child table for episodes/albums** — rejected (D-06): ~100k+ rows mirroring
  state the fix flow must re-check live anyway; live proxy + denormalized target columns
  cover fix, events, and display. Revisit only if episode-level wanted browsing becomes a
  requirement (Q-05).
- **`wanted_items` as a synced table** from `wanted/missing` — rejected (D-08): duplicates
  40k+ *arr rows with zero attribution/DR value; the T-27 definition is derivable from
  `media_items` fields we already sync.
- **In-process sync interval** — rejected (D-14 table): multi-replica duplication,
  restart-mid-run loss, request-path contention; CronJob reuses the proven
  migrator-subtree image pattern.
- **`arr_instances` registry table** — rejected (D-05): env is the config authority
  (12-factor, matches DESIGN-002's env contract style); a table would drift from env.
- **Hard-deleting vanished items** — rejected (D-05): destroys R-41 deletion history and
  the R-50 restore source; tombstones + the D-14 guard keep both.
- **Extending `permission_audit` for fix/restore** — rejected (D-12): cross-context
  leakage; BC-03's own tables are richer audit records. DESIGN-001 D-10 explicitly
  deferred this choice here.
- **Deriving sync cursors from `max(ledger_events.occurred_at)`** — rejected (D-11):
  couples cursor progress to event retention/normalization choices; a dedicated
  `sync_state` row advances atomically with each batch.
- **Search-on-add during Restore** — rejected as default (D-16, Q-04): indexer
  carpet-bombing on bulk restores; the *arr's own missing-search loop backfills.
- **Storing Seerr requester only as text** — rejected: `requested_by_user_id` FK enables
  "my requests" queries later; unresolved attributions still keep the raw payload.

## Test strategy

Per ADR-010 (embedded PG16, no Docker, no live-API tests in CI):

- **Recorded fixtures** (`packages/arr/__fixtures__/`): sanitized JSON captured from the
  2026-07-03 GET probes — `system/status`, one page each of series/movie/artist,
  history pages showing each observed eventType, `qualityprofile`/`rootfolder`/`tag`,
  `wanted/missing` pages, Seerr `request` page (emails/usernames/plexIds replaced with
  `*.example.test` values; no API keys appear in any response body). Unit tests: every
  fixture parses through its zod schema; unknown-field stripping; D-07 normalization map;
  cursor math; env contract (`assertArrEnv`) failure modes.
- **Integration (embedded PG16):**
  - *Full sync:* fixture-driven upsert twice → idempotent; item vanishes → tombstone +
    `deleted(item_removed)` event; rebuilt-*arr simulation (same external ids, new
    `arr_item_id`s) → rows re-matched, ids updated, no duplicates, tombstones cleared;
    mass-tombstone guard aborts at >20% and writes `sync_runs.status='aborted'`.
  - *Incremental:* overlapping history batches → dedupe index holds (event count stable);
    cursor advances transactionally with the batch; Seerr request before item exists →
    NULL FK, then backfill resolves it after the item syncs.
  - *Fix lifecycle:* every legal transition via the D-12 writers; illegal transitions
    throw; `reason_text` iff-other CHECK (SQLSTATE 23514 both directions); rate limit at
    5/h incl. the advisory-lock race test; open-fix dedupe; `completeFixRequests` closes
    the loop from an ingested import event; failure path records responses and lands
    `failed`.
  - *Restore:* profile-name → id remapping (incl. unmapped failure), tag label
    recreation plan, run report counts, tombstone cleared + `arr_item_id` updated on
    success; `restore_runs` row survives requester deletion (SET NULL).
  - *Routers:* ladder checks (member blocked from `fix.adminList`/`restore.*`), appCode
    wire shapes for the six new errors, pagination cursors.
- **Guards (CI `test` job):** no-direct-writes extended to the six Phase 2 tables;
  new guard — `@hnet/arr/write` importable only from `packages/domain` (keeps ADR-008's
  "no other code path may call a mutating *arr endpoint" executable).
- **e2e (later, advisory):** a stub *arr HTTP server in `apps/web/e2e/support/`
  (mirroring the stub-OIDC pattern) serving the fixtures + accepting the write endpoints
  in-memory, so US-06's full journey (browse → fix → blocklist + search recorded) runs in
  Playwright without touching real instances. **No CI job ever calls the live APIs.**

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Seerr↔app user mapping confidence: both emails should be the same Plex account's, but Jellyseerr local users, alias emails, or Plex Home users may not match `users.email`. Accept email-only auto-link with `plexUsername` as a recorded suggestion, or add an admin "link Seerr user" override UI? | Coordinator 2026-07-03: email-only auto-link for Phase 2, store plexUsername as suggestion, unmatched stays unattributed; admin link-override UI deferred until real mismatches appear. |
| Q-02 | Jellyseerr 3.3.0 has no music/Lidarr requests (verified: zero `lidarr` refs in its API spec), and the live Lidarr tags (`spotify*`) indicate import-list-driven adds. Is "Lidarr items are always unattributed" acceptable long-term, or should the spotify import-list provenance be surfaced as a pseudo-attribution? | Coordinator 2026-07-03: acceptable — surface import-list provenance as pseudo-attribution ('via Spotify import list') where tags allow; revisit if Jellyseerr adds music. |
| Q-03 | Tombstone retention (forever vs. prune after N years) and the mass-tombstone guard: is 20% / 10-row minimum the right threshold, and is a CLI `--force-tombstones` override enough, or does the admin UI need a confirmation flow? | Coordinator 2026-07-03: retain forever (it is a ledger); 20%/10-row guard + CLI --force-tombstones for Phase 2; admin-UI confirm flow deferred. |
| Q-04 | Restore defaults `searchFor* = false` (D-16) to protect indexers on bulk re-adds. Owner sign-off, or should small restores (< N items) search on add? | Coordinator 2026-07-03: searchFor*=false always for Phase 2 — indexer safety beats convenience; per-item manual search exists in the *arr UI. |
| Q-05 | Episode-level wanted browsing: R-42 is satisfied at item granularity per DDD-001 T-27, but Sonarr tracks 40,862 missing episodes. If per-episode wanted views are ever wanted, they proxy `wanted/missing` live rather than sync. Confirm item granularity is the accepted reading. | Coordinator 2026-07-03: item granularity confirmed; per-episode wanted views proxy live if ever needed. |
| Q-06 | `SEERR_API_KEY` sourcing: reuse the `HOMEPAGE_VAR_SEERR_API_KEY` field from the homepage-consumed items, or have the owner add a canonical `SEERR_API_KEY` field to `media-stack` for the haynesnetwork ExternalSecret? | Resolved 2026-07-03: SEERR_API_KEY already exists as a field in the media-stack item (the homepage ExternalSecret extracts it via dataFrom media-stack) — consume it directly; no owner action. |
| Q-07 | Does `pnpm --filter @hnet/arr deploy --legacy --prod` flatten the `@hnet/arr → @hnet/domain → @hnet/db` workspace chain into a runnable `/sync` subtree like the migrator's single-package case? | Resolved 2026-07-03 (sync-runner implementation): yes — the runner landed as its own package `@hnet/sync` (depending on `@hnet/arr` + `@hnet/domain` → `@hnet/db`), and `pnpm --filter @hnet/sync deploy --legacy --prod /sync-deploy` packs the whole workspace chain as real copies inside the deploy dir's own `.pnpm` store (no symlinks back into /repo); `tsx /sync/src/scripts/sync.ts` runs from the flattened subtree. No fallback needed. |
| Q-08 | Lidarr album-fix semantics: `POST /history/failed/{id}` verified to exist, but albums have multiple releases (`anyReleaseOk`) and multi-file grabs — does blocklisting one grab reliably dislodge a whole bad album, or does the Lidarr path need delete+search more often than Sonarr/Radarr? Recent live history showed only `trackFileImported` (import-list era), so grab coverage may be thin. | (open — needs a real broken album against the live instance) Partial finding, fix-flow implementation 2026-07-03 (stubbed only, no live write probes per the rule): the thin-grab-coverage case is handled by construction — a grab-less album falls to the AC-08 path, which enumerates `GET /trackfile?albumId=` and deletes EVERY track file before `AlbumSearch`, so multi-file albums are fully dislodged without relying on blocklist reach; whether one blocklisted grab suffices when grab history DOES exist remains unverified. |
