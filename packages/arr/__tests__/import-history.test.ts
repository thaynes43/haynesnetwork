// ADR-110 C-03 / DESIGN-055 D-05 (PLAN-077 P4) — the Title Check's history reads, offline against fetch stubs (ADR-010):
// the paged `downloadFolderImported` read (integer eventType 3, oldest first) and the `history/since` read (eventType
// by name), each keeping only the import's named `data` keys (file id, dropped path, imported path, release group).
// The fixture is the live record shape from Sonarr 4.0.20.3012 (`GET /history?eventType=3`, 2026-10-13).
import { describe, expect, it } from 'vitest';
import { SonarrClient } from '../src/read';
import {
  SONARR_DOWNLOAD_FOLDER_IMPORTED_EVENT_TYPE,
  sonarrEpisodeFileReleaseSchema,
  sonarrImportHistoryRecordSchema,
} from '../src/schemas';
import { fixture, stubFetch, TEST_OPTS } from './helpers';

const SONARR = { ...TEST_OPTS, baseUrl: 'http://sonarr.test:8989' };

const EXPECTED = {
  id: 1504212,
  eventType: 'downloadFolderImported',
  date: '2026-10-13T00:44:15Z',
  seriesId: 402,
  episodeId: 34301,
  sourceTitle: 'Love.on.the.Spectrum.US.S04E07.Episode.7.1080p.NF.WEB-DL.DDP5.1.H.264-Kitsune',
  downloadId: 'ae18d2b8-0000-0000-0000-000000000000',
  fileId: 79099,
  droppedPath:
    '/data/haynestower/usenet/complete-k8s/tv/Love.on.the.Spectrum.US.S04.1080p.NF.WEB-DL.DDP5.1.H.264-Kitsune/Love.on.the.Spectrum.US.S04E07.Episode.7.1080p.NF.WEB-DL.DDP5.1.H.264-Kitsune.mkv',
  importedPath:
    '/data/haynestower/Media/TV Shows/Love on the Spectrum U.S/Season 4/Love on the Spectrum (US) (2022) - S04E07 - Episode 7 [NF WEBDL-1080p][EAC3 5.1][x264]-Kitsune.mkv',
  releaseGroup: 'Kitsune',
};

describe('Sonarr import history (Title Check reads)', () => {
  it('pages downloadFolderImported history with the integer event type, oldest first, keeping only the named keys', async () => {
    const { fetchImpl, calls } = stubFetch([{ path: '/api/v3/history', body: fixture('sonarr.history-imported') }]);
    const page = await new SonarrClient({ ...SONARR, fetchImpl }).getImportHistoryPage({ page: 2 });
    expect(SONARR_DOWNLOAD_FOLDER_IMPORTED_EVENT_TYPE).toBe(3);
    const q = calls[0]!.url.searchParams;
    expect(q.get('eventType')).toBe('3');
    expect(q.get('page')).toBe('2');
    expect(q.get('pageSize')).toBe('1000');
    expect(q.get('sortKey')).toBe('date');
    expect(q.get('sortDirection')).toBe('ascending');
    expect(page.totalRecords).toBe(1);
    expect(page.records).toEqual([EXPECTED]);
  });

  it('reads history since a date by event name, and never carries any other data key', async () => {
    const live = fixture<{ records: Array<Record<string, unknown>> }>('sonarr.history-imported').records[0]!;
    const withUrl = {
      ...live,
      id: 1504213,
      data: { ...(live.data as object), downloadUrl: 'https://indexer.test/api?apikey=SECRET', nzbInfoUrl: 'https://x' },
    };
    const grab = { ...live, id: 1504214, eventType: 'grabbed' };
    const { fetchImpl, calls } = stubFetch([{ path: '/api/v3/history/since', body: [live, withUrl, grab] }]);
    const records = await new SonarrClient({ ...SONARR, fetchImpl }).getImportHistorySince(
      new Date('2026-10-12T22:00:00Z'),
    );
    const q = calls[0]!.url.searchParams;
    expect(q.get('date')).toBe('2026-10-12T22:00:00.000Z');
    expect(q.get('eventType')).toBe('downloadFolderImported');
    // A record of another event type is dropped; the URL-bearing keys never make it through.
    expect(records.map((r) => r.id)).toEqual([1504212, 1504213]);
    expect(JSON.stringify(records)).not.toMatch(/apikey|SECRET|nzbInfoUrl|downloadUrl/);
    expect(Object.keys(records[1]!).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('reads a malformed or missing file id and path as null', () => {
    const live = fixture<{ records: Array<Record<string, unknown>> }>('sonarr.history-imported').records[0]!;
    expect(sonarrImportHistoryRecordSchema.parse({ ...live, data: { fileId: 'abc' } })).toMatchObject({
      fileId: null,
      droppedPath: null,
    });
    expect(sonarrImportHistoryRecordSchema.parse({ ...live, data: null, sourceTitle: ' ' })).toMatchObject({
      fileId: null,
      sourceTitle: null,
    });
  });

  it("keeps an episode file's dateAdded", () => {
    const [file] = fixture<unknown[]>('sonarr.episodefile-lost-tapes');
    expect(sonarrEpisodeFileReleaseSchema.parse(file)).toMatchObject({ id: 75669, dateAdded: '2026-09-10T15:04:00Z' });
  });
});
