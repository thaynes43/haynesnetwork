import { describe, expect, it } from 'vitest';
import type { RadarrMovie, SonarrSeries } from '@hnet/arr';
import {
  mergeWatchContributions,
  metadataFromRadarrMovie,
  metadataFromSonarrSeries,
  parseTautulliGuids,
  posterFromArrImages,
  resolutionFromProfile,
  tautulliDate,
  tmdbPathFromRemote,
  type WatchContribution,
} from '../src/adapt-metadata';

describe('resolutionFromProfile (DESIGN-008 D-02 — approximate, profile-derived)', () => {
  it('maps single-tier profiles; ranges/any → unknown', () => {
    expect(resolutionFromProfile('HD-1080p')).toBe('1080p');
    expect(resolutionFromProfile('HD-720p')).toBe('720p');
    expect(resolutionFromProfile('Ultra-HD')).toBe('2160p');
    expect(resolutionFromProfile('SD')).toBe('sd');
    expect(resolutionFromProfile('Any')).toBe('unknown');
    expect(resolutionFromProfile('HD - 720p/1080p')).toBe('unknown'); // two tiers → ambiguous
    expect(resolutionFromProfile('FHD-UHD')).toBe('unknown');
    expect(resolutionFromProfile(null)).toBe('unknown');
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
  it('radarr movie → imdb/tmdb/RT split + poster + runtime + genres', () => {
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
    } as unknown as RadarrMovie;
    expect(metadataFromRadarrMovie(movie)).toMatchObject({
      imdbRating: 6.3,
      imdbVotes: 379,
      tmdbRating: 8.39,
      tmdbVotes: 41,
      rtTomatometer: 44,
      runtimeMinutes: 106,
      genres: ['Comedy'],
      posterSource: 'arr',
      posterRef: '/MediaCover/1/poster.jpg?lastWrite=1',
    });
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
