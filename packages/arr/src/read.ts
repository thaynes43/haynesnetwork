// @hnet/arr/read — the READ surface (DESIGN-005 D-03 read table, D-18 entrypoint split).
// Consumers: sync, ledger.children, restore.diff. Nothing here can mutate an *arr;
// the write surface lives in `@hnet/arr/write` and is import-guarded to packages/domain.
import { z } from 'zod';
import { ARR_CLUSTER_URL_DEFAULTS, assertArrEnv, type ArrEnvConfig } from './config';
import { ArrHttp, type QueryParams } from './http';
import {
  pagedSchema,
  qualityProfileSchema,
  rootFolderSchema,
  systemStatusSchema,
  tagSchema,
  type ArrPage,
  type ArrQualityProfile,
  type ArrRootFolder,
  type ArrSystemStatus,
  type ArrTag,
} from './schemas/common';
import {
  SONARR_GRABBED_EVENT_TYPE,
  sonarrEpisodeSchema,
  sonarrHistoryRecordSchema,
  sonarrSeriesSchema,
  type SonarrEpisode,
  type SonarrHistoryRecord,
  type SonarrSeries,
} from './schemas/sonarr';
import {
  radarrHistoryRecordSchema,
  radarrMovieSchema,
  type RadarrHistoryRecord,
  type RadarrMovie,
} from './schemas/radarr';
import {
  LIDARR_GRABBED_EVENT_TYPE,
  lidarrAlbumSchema,
  lidarrArtistSchema,
  lidarrHistoryRecordSchema,
  lidarrMetadataProfileSchema,
  lidarrTrackFileSchema,
  type LidarrAlbum,
  type LidarrArtist,
  type LidarrHistoryRecord,
  type LidarrMetadataProfile,
  type LidarrTrackFile,
} from './schemas/lidarr';
import {
  seerrMainSettingsSchema,
  seerrRequestPageSchema,
  seerrStatusSchema,
  type SeerrMainSettings,
  type SeerrRequestPage,
  type SeerrStatus,
} from './schemas/seerr';

export interface ArrClientOptions {
  /** Service origin WITHOUT the API path, e.g. `http://sonarr.media.svc.cluster.local:8989`. */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Injectable fetch for fixture-driven tests (ADR-010: no live-API tests in CI). */
  fetchImpl?: typeof fetch;
}

export interface HistoryPageParams {
  page?: number;
  pageSize?: number;
  sortKey?: string;
  sortDirection?: 'ascending' | 'descending';
}

export interface WantedMissingParams {
  page?: number;
  pageSize?: number;
}

const toIso = (value: string | Date) =>
  value instanceof Date ? value.toISOString() : value;

/** Read endpoints shared verbatim by Sonarr/Radarr/Lidarr (D-03). */
abstract class ArrReadClientBase {
  protected readonly http: ArrHttp;

  constructor(options: ArrClientOptions, apiBasePath: string) {
    this.http = new ArrHttp({ ...options, apiBasePath });
  }

  getSystemStatus(): Promise<ArrSystemStatus> {
    return this.http.requestJson('GET', 'system/status', systemStatusSchema);
  }

  listQualityProfiles(): Promise<ArrQualityProfile[]> {
    return this.http.requestJson('GET', 'qualityprofile', z.array(qualityProfileSchema));
  }

  listRootFolders(): Promise<ArrRootFolder[]> {
    return this.http.requestJson('GET', 'rootfolder', z.array(rootFolderSchema));
  }

  listTags(): Promise<ArrTag[]> {
    return this.http.requestJson('GET', 'tag', z.array(tagSchema));
  }

  protected historyQuery(params: HistoryPageParams): QueryParams {
    return {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 100,
      sortKey: params.sortKey ?? 'date',
      sortDirection: params.sortDirection ?? 'descending',
    };
  }
}

/** Sonarr v3 read client (D-01: live 4.0.x, `/api/v3`). */
export class SonarrClient extends ArrReadClientBase {
  constructor(options: ArrClientOptions) {
    super(options, '/api/v3');
  }

  listSeries(): Promise<SonarrSeries[]> {
    return this.http.requestJson('GET', 'series', z.array(sonarrSeriesSchema));
  }

  getSeriesById(id: number): Promise<SonarrSeries> {
    return this.http.requestJson('GET', `series/${id}`, sonarrSeriesSchema);
  }

  getHistory(params: HistoryPageParams = {}): Promise<ArrPage<SonarrHistoryRecord>> {
    return this.http.requestJson('GET', 'history', pagedSchema(sonarrHistoryRecordSchema), {
      query: this.historyQuery(params),
    });
  }

  getHistorySince(date: string | Date, eventType?: string): Promise<SonarrHistoryRecord[]> {
    return this.http.requestJson('GET', 'history/since', z.array(sonarrHistoryRecordSchema), {
      query: { date: toIso(date), eventType },
    });
  }

  /** `GET /episode?seriesId=` — fix-target picker, resolved LIVE, never synced (D-06). */
  listEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
    return this.http.requestJson('GET', 'episode', z.array(sonarrEpisodeSchema), {
      query: { seriesId },
    });
  }

  /**
   * `GET /history?episodeId=&eventType=1` — latest grab for a fix target (D-03/D-15).
   * Newest first (the *arr default sort is honored explicitly). The paged `/history`
   * endpoint binds `eventType` to the INTEGER enum; the string `grabbed` yields HTTP 400.
   */
  getEpisodeGrabHistory(episodeId: number): Promise<ArrPage<SonarrHistoryRecord>> {
    return this.http.requestJson('GET', 'history', pagedSchema(sonarrHistoryRecordSchema), {
      query: {
        ...this.historyQuery({ pageSize: 20 }),
        episodeId,
        eventType: SONARR_GRABBED_EVENT_TYPE,
      },
    });
  }

  /** Episode-level wanted feed (paged) — spot checks only, never mirrored (D-08). */
  getWantedMissing(params: WantedMissingParams = {}): Promise<ArrPage<SonarrEpisode>> {
    return this.http.requestJson('GET', 'wanted/missing', pagedSchema(sonarrEpisodeSchema), {
      query: { page: params.page ?? 1, pageSize: params.pageSize ?? 50 },
    });
  }
}

/** Radarr v3 read client (D-01: live 6.0.x, `/api/v3`). */
export class RadarrClient extends ArrReadClientBase {
  constructor(options: ArrClientOptions) {
    super(options, '/api/v3');
  }

  listMovies(): Promise<RadarrMovie[]> {
    return this.http.requestJson('GET', 'movie', z.array(radarrMovieSchema));
  }

  getMovieById(id: number): Promise<RadarrMovie> {
    return this.http.requestJson('GET', `movie/${id}`, radarrMovieSchema);
  }

  getHistory(params: HistoryPageParams = {}): Promise<ArrPage<RadarrHistoryRecord>> {
    return this.http.requestJson('GET', 'history', pagedSchema(radarrHistoryRecordSchema), {
      query: this.historyQuery(params),
    });
  }

  getHistorySince(date: string | Date, eventType?: string): Promise<RadarrHistoryRecord[]> {
    return this.http.requestJson('GET', 'history/since', z.array(radarrHistoryRecordSchema), {
      query: { date: toIso(date), eventType },
    });
  }

  /**
   * `GET /history/movie?movieId=&eventType=grabbed` — latest grab for a fix target
   * (D-03/D-15). Radarr's per-movie history endpoint returns a plain array.
   */
  getMovieGrabHistory(movieId: number): Promise<RadarrHistoryRecord[]> {
    return this.http.requestJson('GET', 'history/movie', z.array(radarrHistoryRecordSchema), {
      query: { movieId, eventType: 'grabbed' },
    });
  }

  /** Movie-level wanted feed (paged). */
  getWantedMissing(params: WantedMissingParams = {}): Promise<ArrPage<RadarrMovie>> {
    return this.http.requestJson('GET', 'wanted/missing', pagedSchema(radarrMovieSchema), {
      query: { page: params.page ?? 1, pageSize: params.pageSize ?? 50 },
    });
  }
}

/** Lidarr v1 read client (D-01: live 3.1.x, `/api/v1`). */
export class LidarrClient extends ArrReadClientBase {
  constructor(options: ArrClientOptions) {
    super(options, '/api/v1');
  }

  listArtists(): Promise<LidarrArtist[]> {
    return this.http.requestJson('GET', 'artist', z.array(lidarrArtistSchema));
  }

  getArtistById(id: number): Promise<LidarrArtist> {
    return this.http.requestJson('GET', `artist/${id}`, lidarrArtistSchema);
  }

  getHistory(params: HistoryPageParams = {}): Promise<ArrPage<LidarrHistoryRecord>> {
    return this.http.requestJson('GET', 'history', pagedSchema(lidarrHistoryRecordSchema), {
      query: this.historyQuery(params),
    });
  }

  getHistorySince(date: string | Date, eventType?: string): Promise<LidarrHistoryRecord[]> {
    return this.http.requestJson('GET', 'history/since', z.array(lidarrHistoryRecordSchema), {
      query: { date: toIso(date), eventType },
    });
  }

  /** `GET /album?artistId=` — fix-target picker, resolved LIVE, never synced (D-06). */
  listAlbums(artistId: number): Promise<LidarrAlbum[]> {
    return this.http.requestJson('GET', 'album', z.array(lidarrAlbumSchema), {
      query: { artistId },
    });
  }

  /**
   * `GET /history?albumId=&eventType=1` — latest grab for a fix target (D-03/D-15).
   * The paged `/history` endpoint binds `eventType` to the INTEGER enum; the string
   * `grabbed` yields HTTP 400.
   */
  getAlbumGrabHistory(albumId: number): Promise<ArrPage<LidarrHistoryRecord>> {
    return this.http.requestJson('GET', 'history', pagedSchema(lidarrHistoryRecordSchema), {
      query: {
        ...this.historyQuery({ pageSize: 20 }),
        albumId,
        eventType: LIDARR_GRABBED_EVENT_TYPE,
      },
    });
  }

  /** `GET /trackfile?albumId=` — the Fix fallback's delete targets (D-03). */
  listTrackFiles(albumId: number): Promise<LidarrTrackFile[]> {
    return this.http.requestJson('GET', 'trackfile', z.array(lidarrTrackFileSchema), {
      query: { albumId },
    });
  }

  /** `GET /metadataprofile` — Restore maps Lidarr metadata profiles BY NAME (D-16). */
  listMetadataProfiles(): Promise<LidarrMetadataProfile[]> {
    return this.http.requestJson('GET', 'metadataprofile', z.array(lidarrMetadataProfileSchema));
  }

  /** Album-level wanted feed (paged). */
  getWantedMissing(params: WantedMissingParams = {}): Promise<ArrPage<LidarrAlbum>> {
    return this.http.requestJson('GET', 'wanted/missing', pagedSchema(lidarrAlbumSchema), {
      query: { page: params.page ?? 1, pageSize: params.pageSize ?? 50 },
    });
  }
}

export interface SeerrRequestParams {
  take?: number;
  skip?: number;
  sort?: string;
}

/** Jellyseerr 3.3 v1 read client — request attribution + identity probe (D-03). */
export class SeerrClient {
  private readonly http: ArrHttp;

  constructor(options: ArrClientOptions) {
    this.http = new ArrHttp({ ...options, apiBasePath: '/api/v1' });
  }

  getStatus(): Promise<SeerrStatus> {
    return this.http.requestJson('GET', 'status', seerrStatusSchema);
  }

  getMainSettings(): Promise<SeerrMainSettings> {
    return this.http.requestJson('GET', 'settings/main', seerrMainSettingsSchema);
  }

  getRequests(params: SeerrRequestParams = {}): Promise<SeerrRequestPage> {
    return this.http.requestJson('GET', 'request', seerrRequestPageSchema, {
      query: {
        take: params.take ?? 100,
        skip: params.skip ?? 0,
        sort: params.sort ?? 'added',
      },
    });
  }
}

export interface ArrReadClients {
  sonarr: SonarrClient;
  radarr: RadarrClient;
  lidarr: LidarrClient;
  seerr: SeerrClient;
}

/**
 * D-18 env factory: build all four read clients from `SONARR_URL`/`SONARR_API_KEY`
 * (+ RADARR_/LIDARR_/SEERR_). URLs default to the in-cluster service DNS
 * (ARR_CLUSTER_URL_DEFAULTS); missing keys throw ArrConfigError.
 */
export function arrReadClientsFromEnv(
  env: Record<string, string | undefined> = process.env,
): ArrReadClients {
  const config: ArrEnvConfig = assertArrEnv(env);
  return {
    sonarr: new SonarrClient(config.sonarr),
    radarr: new RadarrClient(config.radarr),
    lidarr: new LidarrClient(config.lidarr),
    seerr: new SeerrClient(config.seerr),
  };
}

export { ARR_CLUSTER_URL_DEFAULTS, assertArrEnv };
export type { ArrEnvConfig };
