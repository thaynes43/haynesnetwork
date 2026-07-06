// @hnet/arr/write — the WRITE surface (DESIGN-005 D-03 write table, D-18 entrypoint
// split). ADR-008: the ONLY sanctioned *arr write-backs are Fix (mark-failed / delete /
// search) and Restore (add-item / create-tag). This entrypoint may be imported ONLY by
// the packages/domain fix/restore writers — enforced by the D-12 guard test that lands
// with those writers. Exercised exclusively via fetch stubs in tests; never in sync.
import { assertArrEnv, type ArrEnvConfig } from './config';
import { ArrHttp } from './http';
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
