// DESIGN-005 D-14 full-sync step 3: adapt the @hnet/arr D-02 shapes to the D-05
// media_items field set consumed by the @hnet/domain single-writer
// (upsertMediaItemsBatch). Profile/tag ids are resolved to NAME/LABEL snapshots here
// (D-05 decision 3 — numeric ids are meaningless on a fresh *arr; Restore maps by name).
import type {
  ArrQualityProfile,
  ArrTag,
  LidarrArtist,
  RadarrMovie,
  SonarrSeries,
} from '@hnet/arr';
import type { MediaItemSyncFields } from '@hnet/domain';

export interface ArrLookupMaps {
  /** quality profile id → name (from `GET /qualityprofile`). */
  profileNameById: Map<number, string>;
  /** tag id → label (from `GET /tag`). */
  tagLabelById: Map<number, string>;
}

export function buildLookupMaps(
  profiles: ArrQualityProfile[],
  tags: ArrTag[],
): ArrLookupMaps {
  return {
    profileNameById: new Map(profiles.map((p) => [p.id, p.name])),
    tagLabelById: new Map(tags.map((t) => [t.id, t.label])),
  };
}

/**
 * Snapshot the profile name; an id the profile list doesn't know (should never happen —
 * both are fetched in the same pass) degrades to a sentinel that can never silently
 * match a real profile during Restore's map-by-name step (D-16).
 */
function profileName(maps: ArrLookupMaps, id: number): string {
  return maps.profileNameById.get(id) ?? `unknown-profile-${id}`;
}

/** Tag LABEL snapshots; ids without a label are dropped rather than invented (D-05). */
function tagLabels(maps: ArrLookupMaps, ids: number[]): string[] {
  return ids.flatMap((id) => {
    const label = maps.tagLabelById.get(id);
    return label === undefined ? [] : [label];
  });
}

/** Sonarr series → media_items fields (D-02 column ↔ field table, sonarr column). */
export function adaptSonarrSeries(
  series: SonarrSeries,
  maps: ArrLookupMaps,
): MediaItemSyncFields {
  return {
    arrItemId: series.id,
    tvdbId: series.tvdbId,
    tmdbId: series.tmdbId ?? null,
    imdbId: series.imdbId ?? null,
    title: series.title,
    sortTitle: series.sortTitle,
    year: series.year,
    monitored: series.monitored,
    qualityProfileId: series.qualityProfileId,
    qualityProfileName: profileName(maps, series.qualityProfileId),
    rootFolder: series.rootFolderPath,
    arrTags: tagLabels(maps, series.tags),
    onDiskFileCount: series.statistics.episodeFileCount,
    expectedFileCount: series.statistics.episodeCount,
    sizeOnDisk: series.statistics.sizeOnDisk,
    // Restore-fidelity extras — documented D-05 keys only.
    arrAttrs: {
      seriesType: series.seriesType,
      seasonFolder: series.seasonFolder,
      monitorNewItems: series.monitorNewItems,
      status: series.status,
      ended: series.ended,
    },
  };
}

/** Radarr movie → media_items fields. */
export function adaptRadarrMovie(movie: RadarrMovie, maps: ArrLookupMaps): MediaItemSyncFields {
  return {
    arrItemId: movie.id,
    tmdbId: movie.tmdbId,
    imdbId: movie.imdbId ?? null,
    title: movie.title,
    sortTitle: movie.sortTitle,
    year: movie.year,
    monitored: movie.monitored,
    qualityProfileId: movie.qualityProfileId,
    qualityProfileName: profileName(maps, movie.qualityProfileId),
    // rootFolderPath is always present on the full `GET /movie` list; `path` is the
    // schema-level fallback for the wanted/missing shape that omits it (D-02 note).
    rootFolder: movie.rootFolderPath ?? movie.path,
    arrTags: tagLabels(maps, movie.tags),
    onDiskFileCount: movie.statistics.movieFileCount,
    expectedFileCount: 1, // the movie itself (D-05 normalization across kinds)
    sizeOnDisk: movie.sizeOnDisk,
    arrAttrs: {
      minimumAvailability: movie.minimumAvailability,
      status: movie.status,
    },
  };
}

/** Lidarr artist → media_items fields (no year; MusicBrainz id is the identity). */
export function adaptLidarrArtist(
  artist: LidarrArtist,
  maps: ArrLookupMaps,
): MediaItemSyncFields {
  return {
    arrItemId: artist.id,
    musicbrainzArtistId: artist.foreignArtistId,
    title: artist.artistName,
    sortTitle: artist.sortName,
    year: null,
    monitored: artist.monitored,
    qualityProfileId: artist.qualityProfileId,
    qualityProfileName: profileName(maps, artist.qualityProfileId),
    // Lidarr's metadata profile is only visible as an id on the artist resource
    // (D-03: "+ metadata profile via item fields") — there is no name lookup endpoint
    // in the read surface, so the name snapshot stays null.
    metadataProfileId: artist.metadataProfileId,
    rootFolder: artist.rootFolderPath,
    arrTags: tagLabels(maps, artist.tags),
    onDiskFileCount: artist.statistics.trackFileCount,
    expectedFileCount: artist.statistics.trackCount,
    sizeOnDisk: artist.statistics.sizeOnDisk,
    arrAttrs: {
      monitorNewItems: artist.monitorNewItems,
      artistType: artist.artistType ?? null,
      status: artist.status,
    },
  };
}
