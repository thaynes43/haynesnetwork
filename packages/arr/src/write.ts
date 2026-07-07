// @hnet/arr/write — the WRITE surface (DESIGN-005 D-03 write table, D-18 entrypoint
// split). ADR-008: the ONLY sanctioned *arr write-backs are Fix (mark-failed / delete /
// search) and Restore (add-item / create-tag). This entrypoint may be imported ONLY by
// the packages/domain fix/restore writers — enforced by the D-12 guard test that lands
// with those writers. Exercised exclusively via fetch stubs in tests; never in sync.
import { assertArrEnv, type ArrEnvConfig } from './config';
import { MaintainerrWriteFailedError } from './errors';
import { ArrHttp, type QueryParams } from './http';
import { maintainerrReturnStatusSchema } from './schemas/maintainerr';
import { commandResponseSchema, tagSchema, type ArrCommandResponse, type ArrTag } from './schemas/common';
import { sonarrSeriesSchema, type SonarrSeries } from './schemas/sonarr';
import { radarrMovieSchema, type RadarrMovie } from './schemas/radarr';
import { lidarrArtistSchema, type LidarrArtist } from './schemas/lidarr';
import type { ArrClientOptions } from './read';

// ---------- add-item payloads (D-16 step 2: Restore re-adds with searches OFF) ----------

export interface AddSeriesOptions {
  monitor?: string;
  searchForMissingEpisodes?: boolean;
}

/** `POST /series` payload (D-03/D-16): item resource subset + AddSeriesOptions. */
export interface AddSeriesPayload {
  tvdbId: number;
  title: string;
  qualityProfileId: number;
  rootFolderPath: string;
  monitored: boolean;
  seasonFolder?: boolean;
  seriesType?: string;
  monitorNewItems?: string;
  tags?: number[];
  addOptions?: AddSeriesOptions;
}

export interface AddMovieOptions {
  monitor?: string;
  searchForMovie?: boolean;
}

/** `POST /movie` payload (D-03/D-16). */
export interface AddMoviePayload {
  tmdbId: number;
  title: string;
  qualityProfileId: number;
  rootFolderPath: string;
  monitored: boolean;
  minimumAvailability?: string;
  tags?: number[];
  addOptions?: AddMovieOptions;
}

export interface AddArtistOptions {
  monitor?: string;
  monitored?: boolean;
  searchForMissingAlbums?: boolean;
}

/** `POST /artist` payload (D-03/D-16). */
export interface AddArtistPayload {
  foreignArtistId: string;
  artistName: string;
  qualityProfileId: number;
  metadataProfileId?: number;
  rootFolderPath: string;
  monitored: boolean;
  monitorNewItems?: string;
  tags?: number[];
  addOptions?: AddArtistOptions;
}

// ---------- write clients ----------

/** Writes shared verbatim by all three *arrs (D-03 write table). */
abstract class ArrWriteClientBase {
  protected readonly http: ArrHttp;

  constructor(options: ArrClientOptions, apiBasePath: string) {
    this.http = new ArrHttp({ ...options, apiBasePath });
  }

  /**
   * `POST /history/failed/{id}` — Fix primary path (ADR-007/AC-07): `{id}` is the
   * HISTORY RECORD id of the grab; no request body. The *arr blocklists the release.
   */
  markHistoryFailed(historyId: number): Promise<void> {
    return this.http.requestVoid('POST', `history/failed/${historyId}`);
  }

  /** `POST /tag {label}` — Restore prerequisite: recreate missing tags by label (D-03). */
  createTag(label: string): Promise<ArrTag> {
    return this.http.requestJson('POST', 'tag', tagSchema, { body: { label } });
  }

  protected runCommand(body: Record<string, unknown>): Promise<ArrCommandResponse> {
    return this.http.requestJson('POST', 'command', commandResponseSchema, { body });
  }
}

/** Sonarr v3 write client. */
export class SonarrWriteClient extends ArrWriteClientBase {
  constructor(options: ArrClientOptions) {
    super(options, '/api/v3');
  }

  /** `DELETE /episodefile/{id}` — Fix fallback path (AC-08). */
  deleteEpisodeFile(episodeFileId: number): Promise<void> {
    return this.http.requestVoid('DELETE', `episodefile/${episodeFileId}`);
  }

  /** `POST /command {name: 'EpisodeSearch', episodeIds}` (D-03 payload keys). */
  searchEpisodes(episodeIds: number[]): Promise<ArrCommandResponse> {
    return this.runCommand({ name: 'EpisodeSearch', episodeIds });
  }

  /** `POST /command {name: 'SeriesSearch', seriesId}` — whole-show Force Search (roll-up). */
  searchSeries(seriesId: number): Promise<ArrCommandResponse> {
    return this.runCommand({ name: 'SeriesSearch', seriesId });
  }

  /**
   * `PUT /series/editor {seriesIds, monitored}` — the bulk-editor patch (ADR-022 D-02).
   * Ledger Add-&-search flips a present-but-unmonitored series to monitored WITHOUT
   * round-tripping the full resource (the ACL schema is a read subset, not a valid PUT body).
   * The editor echoes the updated resources; we drain them.
   */
  setSeriesMonitored(seriesIds: number[], monitored: boolean): Promise<void> {
    return this.http.requestVoid('PUT', 'series/editor', { body: { seriesIds, monitored } });
  }

  /**
   * `POST /command {name: 'SeasonSearch', seriesId, seasonNumber}` — season roll-up
   * search (verified against Sonarr's `SeasonSearchCommand` fields `SeriesId` +
   * `SeasonNumber` in the develop source; D-03 command-name convention).
   */
  searchSeason(seriesId: number, seasonNumber: number): Promise<ArrCommandResponse> {
    return this.runCommand({ name: 'SeasonSearch', seriesId, seasonNumber });
  }

  /** `POST /series` — Restore re-add (D-16). */
  addSeries(payload: AddSeriesPayload): Promise<SonarrSeries> {
    return this.http.requestJson('POST', 'series', sonarrSeriesSchema, { body: payload });
  }
}

/** Radarr v3 write client. */
export class RadarrWriteClient extends ArrWriteClientBase {
  constructor(options: ArrClientOptions) {
    super(options, '/api/v3');
  }

  /** `DELETE /moviefile/{id}` — Fix fallback path (AC-08). */
  deleteMovieFile(movieFileId: number): Promise<void> {
    return this.http.requestVoid('DELETE', `moviefile/${movieFileId}`);
  }

  /** `POST /command {name: 'MoviesSearch', movieIds}` (D-03 payload keys). */
  searchMovies(movieIds: number[]): Promise<ArrCommandResponse> {
    return this.runCommand({ name: 'MoviesSearch', movieIds });
  }

  /**
   * `PUT /movie/editor {movieIds, monitored}` — bulk-editor patch (ADR-022 D-02). Flips a
   * present-but-unmonitored movie to monitored without round-tripping the full resource.
   */
  setMoviesMonitored(movieIds: number[], monitored: boolean): Promise<void> {
    return this.http.requestVoid('PUT', 'movie/editor', { body: { movieIds, monitored } });
  }

  /** `POST /movie` — Restore re-add (D-16). */
  addMovie(payload: AddMoviePayload): Promise<RadarrMovie> {
    return this.http.requestJson('POST', 'movie', radarrMovieSchema, { body: payload });
  }
}

/** Lidarr v1 write client. */
export class LidarrWriteClient extends ArrWriteClientBase {
  constructor(options: ArrClientOptions) {
    super(options, '/api/v1');
  }

  /** `DELETE /trackfile/{id}` — Fix fallback; an album fix deletes every track file (D-03). */
  deleteTrackFile(trackFileId: number): Promise<void> {
    return this.http.requestVoid('DELETE', `trackfile/${trackFileId}`);
  }

  /** `POST /command {name: 'AlbumSearch', albumIds}` (D-03 payload keys). */
  searchAlbums(albumIds: number[]): Promise<ArrCommandResponse> {
    return this.runCommand({ name: 'AlbumSearch', albumIds });
  }

  /**
   * `POST /command {name: 'ArtistSearch', artistId}` — whole-discography Force Search
   * (roll-up above album; verified against Lidarr's `ArtistSearchCommand` field
   * `ArtistId` in the develop source; D-03 command-name convention).
   */
  searchArtist(artistId: number): Promise<ArrCommandResponse> {
    return this.runCommand({ name: 'ArtistSearch', artistId });
  }

  /**
   * `PUT /artist/editor {artistIds, monitored}` — bulk-editor patch (ADR-022 D-02). Flips a
   * present-but-unmonitored artist to monitored without round-tripping the full resource.
   */
  setArtistsMonitored(artistIds: number[], monitored: boolean): Promise<void> {
    return this.http.requestVoid('PUT', 'artist/editor', { body: { artistIds, monitored } });
  }

  /** `POST /artist` — Restore re-add (D-16). */
  addArtist(payload: AddArtistPayload): Promise<LidarrArtist> {
    return this.http.requestJson('POST', 'artist', lidarrArtistSchema, { body: payload });
  }
}

/**
 * ADR-016 / DESIGN-005 D-19 — Bazarr write client (the subtitle-search trigger for the
 * missing_subtitles Fix). Base path `/api`, auth header `X-API-KEY` (exact casing). Both
 * endpoints are Bazarr's async `search-missing` action (verified live 2026-07-06: HTTP 204
 * in ~18ms, queued internally — fire-and-forget). Lives under @hnet/arr/write so it stays
 * import-confined to packages/domain (D-12 guard) like the other write clients.
 */
export class BazarrWriteClient {
  private readonly http: ArrHttp;

  constructor(options: ArrClientOptions) {
    this.http = new ArrHttp({ ...options, apiBasePath: '/api', apiKeyHeader: 'X-API-KEY' });
  }

  /** `PATCH /api/movies?radarrid=&action=search-missing` — search missing subtitles for a movie. */
  searchMovieSubtitles(radarrMovieId: number): Promise<void> {
    return this.http.requestVoid('PATCH', 'movies', {
      query: { radarrid: radarrMovieId, action: 'search-missing' },
    });
  }

  /**
   * `PATCH /api/series?seriesid=&action=search-missing` — search missing subtitles for a
   * whole series. Bazarr 1.5.6 has no async per-episode action, so an episode- OR
   * season-scoped subtitle Fix both trigger this series-level search (only *missing* subs
   * are searched — a safe superset covering the target; ADR-016 option C rejected).
   */
  searchSeriesSubtitles(sonarrSeriesId: number): Promise<void> {
    return this.http.requestVoid('PATCH', 'series', {
      query: { seriesid: sonarrSeriesId, action: 'search-missing' },
    });
  }
}

/**
 * ADR-023 / DESIGN-010 D-02 — Maintainerr WRITE client (the confined deletion-control surface).
 * Base path `/api`, auth header `x-api-key` (writes REQUIRE the key, unlike the keyless reads).
 * Lives under @hnet/arr/write so every Maintainerr mutation stays import-confined to
 * packages/domain (the ADR-008 guard test) exactly like the *arr write clients. Endpoints derived
 * from the Maintainerr v3.17.0 source (route decorators + DTO/Zod bodies — no live call):
 *   - POST   /api/rules/exclusion            (add: { mediaId, collectionId?, action:0 })
 *   - DELETE /api/rules/exclusions/:mediaId  (remove ALL exclusions for an item)
 *   - POST   /api/collections/handle         (expedite ALL — no body; 409 if already running)
 *   - POST   /api/collections/media/handle   ({ collectionId, mediaId } — expedite one item)
 *   - POST   /api/rules  |  PUT /api/rules  |  DELETE /api/rules/:id   (rule-group CRUD)
 *   - PATCH  /api/settings                   (enable radarr/sonarr tag exclusions + `dnd` tag)
 *
 * P1a — these endpoints return a `ReturnStatus`/`BasicResponseDto` at HTTP 201/200 **even on logical
 * failure** (`code:0`, e.g. `setExclusion` → `{code:0, message:'Failed - no metadata'}`). So the
 * write methods do NOT use HTTP-status-only `requestVoid` (which would read `code:0` as success →
 * phantom protection); they parse the body through `maintainerrReturnStatusSchema` and throw
 * `MaintainerrWriteFailedError` (an ArrError → BAD_GATEWAY via the domain guard) when `code === 0`,
 * failing closed exactly like a non-2xx. The two collection **handle** endpoints
 * (`/collections/handle`, `/collections/media/handle`) return VOID (no ReturnStatus — verified in the
 * v3.17.0 controllers) and keep `requestVoid` semantics.
 */
export interface MaintainerrWriteClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export class MaintainerrWriteClient {
  private readonly http: ArrHttp;

  constructor(options: MaintainerrWriteClientOptions) {
    this.http = new ArrHttp({
      baseUrl: options.baseUrl,
      apiBasePath: '/api',
      apiKey: options.apiKey,
      apiKeyHeader: 'x-api-key',
      timeoutMs: options.timeoutMs,
      retryDelayMs: options.retryDelayMs,
      fetchImpl: options.fetchImpl,
    });
  }

  /**
   * P1a — a write whose body is a `ReturnStatus`/`BasicResponseDto`: a non-2xx already throws
   * (ArrHttpError), and here a 2xx body with `code === 0` (logical failure) throws
   * `MaintainerrWriteFailedError`. Both fail closed. A missing `code` is upstream drift → ArrParseError
   * (also fail closed). `code === 1` ⇒ success (void).
   */
  private async requestReturnStatus(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown } = {},
  ): Promise<void> {
    const status = await this.http.requestJson(method, path, maintainerrReturnStatusSchema, options);
    if (status.code === 0) {
      throw new MaintainerrWriteFailedError(
        method,
        this.http.buildUrl(path, options.query),
        status.message ?? status.result ?? undefined,
      );
    }
  }

  /** `POST /api/rules/exclusion` — Save/whitelist: exclude an item so Maintainerr never deletes it.
   *  `mediaServerId` is the item's Plex ratingKey; omit `collectionId` for a GLOBAL exclusion.
   *  Returns a ReturnStatus — `code:0` (e.g. 'Failed - no metadata') throws, never a phantom success. */
  addExclusion(mediaServerId: string, collectionId?: number): Promise<void> {
    return this.requestReturnStatus('POST', 'rules/exclusion', {
      body: {
        mediaId: mediaServerId,
        action: 0, // 0 = ADD
        ...(collectionId !== undefined ? { collectionId } : {}),
      },
    });
  }

  /** `DELETE /api/rules/exclusions/:mediaServerId` — un-save: remove ALL exclusions for an item.
   *  Returns a ReturnStatus — `code:0` fails closed (a phantom un-save would leave the item exposed). */
  removeExclusion(mediaServerId: string): Promise<void> {
    return this.requestReturnStatus(
      'DELETE',
      `rules/exclusions/${encodeURIComponent(mediaServerId)}`,
    );
  }

  /**
   * `POST /api/collections/handle` — trigger Maintainerr's ESTATE-WIDE handler (every active
   * collection, all media kinds, incl. items outside our ledger; NOT scopeable; no ReturnStatus).
   * DELIBERATELY NEVER CALLED by the Trash expedite path (ADR-023 C-07 / DESIGN-010 D-05, dated
   * ruling 2026-07-06, Fable): expedite loops per-item over `handleCollectionMedia` so deletion is
   * scoped to exactly what the user saw and every deleted item passed the guardian. Retained only for
   * client-surface completeness; wiring it into a user action would bypass the guardian — do not.
   */
  handleAllCollections(): Promise<void> {
    return this.http.requestVoid('POST', 'collections/handle');
  }

  /** `POST /api/collections/media/handle` — expedite ONE item's deletion now (void — no ReturnStatus
   *  in the v3.17.0 controller; a non-2xx still throws ArrHttpError → fail closed). */
  handleCollectionMedia(collectionId: number, mediaServerId: string): Promise<void> {
    return this.http.requestVoid('POST', 'collections/media/handle', {
      body: { collectionId, mediaId: mediaServerId },
    });
  }

  /** `POST /api/rules` — create a rule group (RulesDto). Returns a ReturnStatus (`code:0` fails closed). */
  createRuleGroup(payload: Record<string, unknown>): Promise<void> {
    return this.requestReturnStatus('POST', 'rules', { body: payload });
  }

  /** `PUT /api/rules` — update a rule group (RulesDto with id). Returns a ReturnStatus (`code:0` throws). */
  updateRuleGroup(payload: Record<string, unknown>): Promise<void> {
    return this.requestReturnStatus('PUT', 'rules', { body: payload });
  }

  /** `DELETE /api/rules/:id` — delete a rule group. Returns a ReturnStatus (`code:0` = 'Delete Failed'). */
  deleteRuleGroup(id: number): Promise<void> {
    return this.requestReturnStatus('DELETE', `rules/${id}`);
  }

  /** `PATCH /api/settings` — enable Radarr/Sonarr tag exclusions + set the `dnd` exclusion tag
   *  (a documented deploy-time step; the code path exists so ops can flip it via our surface).
   *  Returns a BasicResponseDto — `code:0` (e.g. invalid CRON) fails closed, never a phantom apply. */
  patchSettings(payload: Record<string, unknown>): Promise<void> {
    return this.requestReturnStatus('PATCH', 'settings', { body: payload });
  }

  // ADR-025 / DESIGN-011 — the Leaving-Soon manual-collection surface (Q-05). Endpoints + body shapes
  // re-verified against the Maintainerr v3.17.0 source 2026-07-07 (Maintainerr/Maintainerr@v3.17.0
  // apps/server/src/modules/collections/collections.controller.ts — `@Controller('api/collections')`,
  // `createCollectionBodySchema` / `collectionBaseShape`):
  //   POST /api/collections            createCollection  { collection, media?: [{ mediaServerId }] }
  //   POST /api/collections/add        addToCollection    { collectionId, media: [{ mediaServerId }], manual? }
  //   POST /api/collections/remove     removeFromCollection { collectionId, media: [{ mediaServerId }] }
  //   POST /api/collections/removeCollection removeCollection { collectionId }
  // The `collection` body is validated by `collectionBaseShape`: `type` is `z.enum(MediaItemTypes)`
  // (the STRING 'movie'|'show'|… — a numeric code is rejected 400), `arrAction` is a REQUIRED
  // `z.nativeEnum(ServarrAction)`, and `deleteAfterDays` is `z.coerce.number().int().optional()` — so
  // `null` COERCES to `0` (Number(null)); it does NOT disable aging. `visibleOnHome`/`visibleOnRecommended`
  // are pushed to Plex by collections.service.ts (`updateCollectionVisibility`) so the collection
  // surfaces on Plex Home + Recommended.

  /** `POST /api/collections` — create a standalone, Plex-visible collection seeded with `media`.
   *  v3.17.0's `createCollection` handler returns NO body (void, HTTP 201) — so this is a tolerant
   *  void write (parsing an empty body as JSON would throw ArrParseError). The caller re-reads the new
   *  collection's id via `GET /api/collections`, matching the exact title. A non-2xx still throws
   *  ArrHttpError (fail closed). */
  createCollection(body: {
    collection: Record<string, unknown>;
    media?: Array<{ mediaServerId: string }>;
  }): Promise<void> {
    return this.http.requestVoid('POST', 'collections', { body });
  }

  /** `POST /api/collections/add` — add specific Plex items (by ratingKey) to a collection. */
  addToCollection(collectionId: number, mediaServerIds: string[]): Promise<void> {
    return this.http.requestVoid('POST', 'collections/add', {
      body: {
        collectionId,
        media: mediaServerIds.map((mediaServerId) => ({ mediaServerId })),
        manual: true,
      },
    });
  }

  /** `POST /api/collections/remove` — remove specific Plex items from a collection (e.g. a rescued item). */
  removeFromCollection(collectionId: number, mediaServerIds: string[]): Promise<void> {
    return this.http.requestVoid('POST', 'collections/remove', {
      body: {
        collectionId,
        media: mediaServerIds.map((mediaServerId) => ({ mediaServerId })),
      },
    });
  }

  /** `POST /api/collections/removeCollection` — tear the whole collection down (cancel/complete). */
  removeCollection(collectionId: number): Promise<void> {
    return this.http.requestVoid('POST', 'collections/removeCollection', {
      body: { collectionId },
    });
  }
}

export interface ArrWriteClients {
  sonarr: SonarrWriteClient;
  radarr: RadarrWriteClient;
  lidarr: LidarrWriteClient;
}

/** D-18 env factory for the write surface (Seerr has no write client — read-only source). */
export function arrWriteClientsFromEnv(
  env: Record<string, string | undefined> = process.env,
): ArrWriteClients {
  const config: ArrEnvConfig = assertArrEnv(env);
  return {
    sonarr: new SonarrWriteClient(config.sonarr),
    radarr: new RadarrWriteClient(config.radarr),
    lidarr: new LidarrWriteClient(config.lidarr),
  };
}
