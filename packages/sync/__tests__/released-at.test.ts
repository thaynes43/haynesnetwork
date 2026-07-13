// ADR-051 C-05 / DESIGN-026 D-05 (PLAN-029 — the Date Released data layer). The released_at adapter
// mapping across the three engines: Radarr (digitalRelease ?? inCinemas ?? physicalRelease), Sonarr
// (firstAired), Lidarr (none → null), ABS (publishedDate). Pure fixture-driven unit tests (ADR-010).
import { describe, expect, it } from 'vitest';
import type { LidarrArtist, RadarrMovie, SonarrSeries } from '@hnet/arr';
import type { AbsItem } from '@hnet/books';
import {
  metadataFromLidarrArtist,
  metadataFromRadarrMovie,
  metadataFromSonarrSeries,
  radarrReleasedAt,
} from '../src/adapt-metadata';
import { absReleasedAt, normalizeAbsItem } from '../src/books';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

describe('radarrReleasedAt — digitalRelease ?? inCinemas ?? physicalRelease (DESIGN-026 D-05)', () => {
  it('prefers digitalRelease', () => {
    expect(
      iso(
        radarrReleasedAt({
          digitalRelease: '2020-05-01T00:00:00Z',
          inCinemas: '2020-01-01T00:00:00Z',
          physicalRelease: '2020-07-01T00:00:00Z',
        }),
      ),
    ).toBe('2020-05-01T00:00:00.000Z');
  });

  it('falls through to inCinemas, then physicalRelease', () => {
    expect(iso(radarrReleasedAt({ inCinemas: '2019-01-02T00:00:00Z' }))).toBe(
      '2019-01-02T00:00:00.000Z',
    );
    expect(iso(radarrReleasedAt({ physicalRelease: '2018-03-04T00:00:00Z' }))).toBe(
      '2018-03-04T00:00:00.000Z',
    );
  });

  it('skips an unparseable earlier date and takes the next valid one', () => {
    expect(iso(radarrReleasedAt({ digitalRelease: 'not-a-date', inCinemas: '2021-06-06T00:00:00Z' }))).toBe(
      '2021-06-06T00:00:00.000Z',
    );
  });

  it('is null when none present', () => {
    expect(radarrReleasedAt({})).toBeNull();
    expect(radarrReleasedAt({ digitalRelease: null, inCinemas: null, physicalRelease: null })).toBeNull();
  });
});

describe('metadataFrom* adapters carry released_at', () => {
  it('Radarr movie → digitalRelease', () => {
    const movie = {
      digitalRelease: '2022-02-02T00:00:00Z',
      inCinemas: '2021-12-25T00:00:00Z',
      added: '2023-01-01T00:00:00Z',
      genres: ['Drama'],
    } as unknown as RadarrMovie;
    expect(iso(metadataFromRadarrMovie(movie).releasedAt)).toBe('2022-02-02T00:00:00.000Z');
  });

  it('Sonarr series → firstAired', () => {
    const series = { firstAired: '2015-09-09T00:00:00Z', added: '2016-01-01T00:00:00Z' } as unknown as SonarrSeries;
    expect(iso(metadataFromSonarrSeries(series).releasedAt)).toBe('2015-09-09T00:00:00.000Z');
  });

  it('Sonarr series with no firstAired → null', () => {
    const series = { added: '2016-01-01T00:00:00Z' } as unknown as SonarrSeries;
    expect(metadataFromSonarrSeries(series).releasedAt).toBeNull();
  });

  it('Lidarr artist → no released_at (artists have no release date)', () => {
    const artist = { added: '2016-01-01T00:00:00Z', genres: ['Rock'] } as unknown as LidarrArtist;
    // The adapter leaves releasedAt unset (undefined) → the writer persists null.
    expect(metadataFromLidarrArtist(artist).releasedAt ?? null).toBeNull();
  });
});

describe('absReleasedAt + normalizeAbsItem (DESIGN-026 D-05 — ABS publishedDate)', () => {
  it('parses a publishedDate string', () => {
    expect(iso(absReleasedAt('2020-05-01'))).toBe('2020-05-01T00:00:00.000Z');
  });

  it('is null for blank / unparseable', () => {
    expect(absReleasedAt(null)).toBeNull();
    expect(absReleasedAt('')).toBeNull();
    expect(absReleasedAt('not-a-date')).toBeNull();
  });

  it('normalizeAbsItem carries released_at from media.metadata.publishedDate', () => {
    const item = {
      id: 'abs-1',
      media: { metadata: { title: 'The Book', publishedYear: '2020', publishedDate: '2020-05-01' } },
    } as unknown as AbsItem;
    const row = normalizeAbsItem(item, 'lib1', 'Audio Books', 'https://abs.example.com');
    expect(iso(row.releasedAt)).toBe('2020-05-01T00:00:00.000Z');
    expect(row.year).toBe(2020);
  });

  it('normalizeAbsItem released_at is null when publishedDate absent (year still present)', () => {
    const item = {
      id: 'abs-2',
      media: { metadata: { title: 'No Date', publishedYear: 1999 } },
    } as unknown as AbsItem;
    const row = normalizeAbsItem(item, 'lib1', 'Audio Books', 'https://abs.example.com');
    expect(row.releasedAt).toBeNull();
    expect(row.year).toBe(1999);
  });
});
