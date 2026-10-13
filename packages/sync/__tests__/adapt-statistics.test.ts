// PR #951 review — a movie Radarr has not refreshed yet carries no `statistics`; its own `hasFile` then says whether one
// file is on disk, so an on-disk movie never reads as fileless (and never lands in Wanted).
import { describe, expect, it } from 'vitest';
import type { RadarrMovie } from '@hnet/arr';
import { adaptRadarrMovie, buildLookupMaps } from '../src/adapt';

const movie = (over: Partial<RadarrMovie>): RadarrMovie =>
  ({
    id: 7,
    title: 'Fresh Movie',
    sortTitle: 'fresh movie',
    year: 2026,
    tmdbId: 7007,
    monitored: true,
    qualityProfileId: 1,
    path: '/movies/Fresh Movie (2026)',
    tags: [],
    hasFile: false,
    movieFileId: 0,
    sizeOnDisk: 0,
    minimumAvailability: 'released',
    status: 'released',
    isAvailable: true,
    added: '2026-10-13T00:00:00Z',
    ...over,
  }) as RadarrMovie;

describe('adaptRadarrMovie without statistics', () => {
  const maps = buildLookupMaps([], []);
  it('falls back to hasFile', () => {
    expect(adaptRadarrMovie(movie({ hasFile: true, movieFileId: 9 }), maps).onDiskFileCount).toBe(1);
    expect(adaptRadarrMovie(movie({ hasFile: false }), maps).onDiskFileCount).toBe(0);
  });
  it('uses the statistics when Radarr sends them', () => {
    expect(adaptRadarrMovie(movie({ hasFile: true, statistics: { movieFileCount: 2 } }), maps).onDiskFileCount).toBe(2);
  });
});
