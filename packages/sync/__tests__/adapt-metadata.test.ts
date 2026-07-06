import { describe, expect, it } from 'vitest';
import type { RadarrMovie, SonarrSeries } from '@hnet/arr';
import {
  dominantResolution,
  mergeWatchContributions,
  metadataFromRadarrMovie,
  metadataFromSonarrSeries,
  parseTautulliGuids,
  posterFromArrImages,
  resolutionFromInt,
  tautulliDate,
  tmdbPathFromRemote,
  type WatchContribution,
} from '../src/adapt-metadata';

describe('resolutionFromInt (DESIGN-008 D-02 — real per-file tier from *arr quality int)', () => {
  it('maps the live *arr resolution ints to the RESOLUTIONS enum', () => {
    // live-observed Radarr movieFile.quality.quality.resolution values (2026-07-06)
    expect(resolutionFromInt(2160)).toBe('2160p');
    expect(resolutionFromInt(1080)).toBe('1080p');
    expect(resolutionFromInt(720)).toBe('720p');
    expect(resolutionFromInt(576)).toBe('576p');
    expect(resolutionFromInt(480)).toBe('480p');
  });

  it('treats 0 / absent (the *arr could not classify the release) as unknown', () => {
    expect(resolutionFromInt(0)).toBe('unknown');
    expect(resolutionFromInt(null)).toBe('unknown');
    expect(resolutionFromInt(undefined)).toBe('unknown');
    expect(resolutionFromInt(-1)).toBe('unknown');
  });

  it('buckets an unusual tier to the nearest lower standard; sub-480 → sd', () => {
    expect(resolutionFromInt(540)).toBe('480p'); // qHD → 480p bucket
    expect(resolutionFromInt(4320)).toBe('2160p'); // 8K clamps to top tier
    expect(resolutionFromInt(360)).toBe('sd');
    expect(resolutionFromInt(240)).toBe('sd');
  });
});

describe('dominantResolution (DESIGN-008 D-02 — Sonarr series mode across episode files)', () => {
  it('returns the modal tier; ties resolve to the higher tier', () => {
    expect(dominantResolution(['1080p', '1080p', '720p'])).toBe('1080p');
    expect(dominantResolution(['720p', '1080p'])).toBe('1080p'); // tie → higher tier
    expect(dominantResolution(['480p', '480p', '2160p'])).toBe('480p'); // mode beats a lone 4K
  });

  it('returns null for a series with no episode files', () => {
    expect(dominantResolution([])).toBeNull();
  });
});

describe('posterFromArrImages / tmdbPathFromRemote', () => {
  it('picks the poster image and records the arr proxy ref', () => {
    expect(
      posterFromArrImages([
        { coverType: 'fanart', url: '/MediaCover/1/fanart.jpg' },
        { coverType: 'poster', url: '/MediaCover/1/poster.jpg?lastWrite=99' },
      ]),
    ).toEqual({ posterSource: 'arr', posterRef: '/MediaCover/1/poster.jpg?lastWrite=99' });
    expect(posterFromArrImages([{ coverType: 'banner', url: '/x' }])).toBeNull();
    expect(posterFromArrImages(undefined)).toBeNull();
  });

  it('extracts a tmdb poster_path from a remote CDN url', () => {
    expect(tmdbPathFromRemote('https://image.tmdb.org/t/p/original/abc.jpg')).toBe('/abc.jpg');
    expect(tmdbPathFromRemote('/already/a/path.jpg')).toBe('/already/a/path.jpg');
    expect(tmdbPathFromRemote(null)).toBeNull();
  });
});

describe('metadata mappers (D-02)', () => {
  it('radarr movie → imdb/tmdb/RT split + poster + runtime + genres + inline-file resolution', () => {
    const movie = {
      id: 1,
      added: '2025-01-01T00:00:00Z',
      runtime: 106,
      genres: ['Comedy'],
      ratings: {
        imdb: { value: 6.3, votes: 379 },
        tmdb: { value: 8.39, votes: 41 },
        rottenTomatoes: { value: 44 },
      },
      images: [{ coverType: 'poster', url: '/MediaCover/1/poster.jpg?lastWrite=1' }],
      // live shape: the on-disk file is embedded inline in GET /movie (D-02 resolution fix)
      movieFile: {
        quality: { quality: { id: 30, name: 'Remux-1080p', resolution: 1080 } },
      },
    } as unknown as RadarrMovie;
    expect(metadataFromRadarrMovie(movie)).toMatchObject({
      imdbRating: 6.3,
      imdbVotes: 379,
      tmdbRating: 8.39,
      tmdbVotes: 41,
      rtTomatometer: 44,
      runtimeMinutes: 106,
      genres: ['Comedy'],
      resolution: '1080p',
      posterSource: 'arr',
      posterRef: '/MediaCover/1/poster.jpg?lastWrite=1',
    });
  });

  it('radarr movie with no file on disk → resolution null (not unknown)', () => {
    const movie = {
      id: 2,
      added: '2025-01-01T00:00:00Z',
      runtime: 90,
      genres: [],
      images: [],
    } as unknown as RadarrMovie;
    expect(metadataFromRadarrMovie(movie).resolution).toBeNull();
  });

  it('sonarr series single rating → tmdb slot', () => {
    const series = {
      id: 1,
      added: '2024-01-01T00:00:00Z',
      runtime: 44,
      genres: ['Action'],
      ratings: { value: 6.0, votes: 1364 },
      images: [],
    } as unknown as SonarrSeries;
    const patch = metadataFromSonarrSeries(series);
    expect(patch.tmdbRating).toBe(6.0);
    expect(patch.tmdbVotes).toBe(1364);
    expect(patch.imdbRating).toBeUndefined();
    expect(patch.genres).toEqual(['Action']);
  });
});

describe('parseTautulliGuids', () => {
  it('parses imdb/tmdb/tvdb scheme uris', () => {
    expect(parseTautulliGuids(['imdb://tt42998751', 'tmdb://7045602', 'tvdb://11759792'])).toEqual({
      imdbId: 'tt42998751',
      tmdbId: 7045602,
      tvdbId: 11759792,
    });
    expect(parseTautulliGuids(null)).toEqual({});
  });
});

describe('mergeWatchContributions (D-04 cross-server — SUM playcount, MAX last-viewed)', () => {
  it('sums play counts and takes the latest last-viewed across instances', () => {
    const contributions: WatchContribution[] = [
      { instanceSlug: 'haynesops', playCount: 2, lastViewedAt: new Date('2026-01-01T00:00:00Z') },
      { instanceSlug: 'haynestower', playCount: 3, lastViewedAt: new Date('2026-06-01T00:00:00Z') },
    ];
    const merged = mergeWatchContributions(contributions);
    expect(merged.playCount).toBe(5);
    expect(merged.lastViewedAt?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(merged.perInstance.haynesops).toEqual({
      playCount: 2,
      lastViewedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(merged.perInstance.haynestower!.playCount).toBe(3);
  });

  it('handles a null last-viewed and a single instance', () => {
    const merged = mergeWatchContributions([
      { instanceSlug: 'haynesops', playCount: 1, lastViewedAt: null },
    ]);
    expect(merged.playCount).toBe(1);
    expect(merged.lastViewedAt).toBeNull();
  });
});

describe('tautulliDate', () => {
  it('converts unix seconds to a Date; guards junk', () => {
    expect(tautulliDate(1_700_000_000)?.getTime()).toBe(1_700_000_000_000);
    expect(tautulliDate('1700000000')?.getTime()).toBe(1_700_000_000_000);
    expect(tautulliDate(null)).toBeNull();
    expect(tautulliDate(0)).toBeNull();
  });
});
