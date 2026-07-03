// D-07 normalization map unit tests (no DB): every tabled raw type maps as specified;
// everything outside the map is dropped; payload/event shapes carry the fix-completion
// keys (episodeId/albumId) and preserve rawEventType.
import { describe, expect, it } from 'vitest';
import type { LidarrHistoryRecord, SonarrHistoryRecord } from '@hnet/arr';
import { historyRecordToLedgerEvent, normalizeHistoryEventType } from '../src/index';

describe('normalizeHistoryEventType (D-07 map)', () => {
  it('maps every tabled raw type for each kind', () => {
    // sonarr
    expect(normalizeHistoryEventType('sonarr', 'grabbed')).toBe('grabbed');
    expect(normalizeHistoryEventType('sonarr', 'downloadFolderImported')).toBe('imported');
    expect(normalizeHistoryEventType('sonarr', 'seriesFolderImported')).toBe('imported');
    expect(normalizeHistoryEventType('sonarr', 'episodeFileDeleted')).toBe('deleted');
    expect(normalizeHistoryEventType('sonarr', 'downloadFailed')).toBe('download_failed');
    // radarr
    expect(normalizeHistoryEventType('radarr', 'downloadFolderImported')).toBe('imported');
    expect(normalizeHistoryEventType('radarr', 'movieFolderImported')).toBe('imported');
    expect(normalizeHistoryEventType('radarr', 'movieFileDeleted')).toBe('deleted');
    // lidarr
    expect(normalizeHistoryEventType('lidarr', 'trackFileImported')).toBe('imported');
    expect(normalizeHistoryEventType('lidarr', 'downloadImported')).toBe('imported');
    expect(normalizeHistoryEventType('lidarr', 'artistFolderImported')).toBe('imported');
    expect(normalizeHistoryEventType('lidarr', 'trackFileDeleted')).toBe('deleted');
    expect(normalizeHistoryEventType('lidarr', 'downloadFailed')).toBe('download_failed');
  });

  it('drops renames, ignored, retagged, incomplete, and unknown', () => {
    expect(normalizeHistoryEventType('sonarr', 'episodeFileRenamed')).toBeNull();
    expect(normalizeHistoryEventType('sonarr', 'downloadIgnored')).toBeNull();
    expect(normalizeHistoryEventType('sonarr', 'unknown')).toBeNull();
    expect(normalizeHistoryEventType('radarr', 'movieFileRenamed')).toBeNull();
    expect(normalizeHistoryEventType('lidarr', 'trackFileRetagged')).toBeNull();
    expect(normalizeHistoryEventType('lidarr', 'albumImportIncomplete')).toBeNull();
  });
});

describe('historyRecordToLedgerEvent', () => {
  const sonarrRecord: SonarrHistoryRecord = {
    id: 77,
    eventType: 'downloadFolderImported',
    date: '2026-07-03T15:20:22Z',
    sourceTitle: 'Show S01E01',
    downloadId: 'abc',
    quality: { quality: { id: 4, name: 'WEBDL-1080p' } },
    data: { indexer: 'Idx', releaseGroup: 'GRP', downloadClient: 'sab' },
    seriesId: 9,
    episodeId: 901,
  };

  it('builds the D-07 event: dedupe key, source timestamp, sanitized payload', () => {
    const event = historyRecordToLedgerEvent(sonarrRecord, {
      arrKind: 'sonarr',
      arrInstanceId: 'main',
      mediaItemId: 'uuid-1',
    })!;
    expect(event).toMatchObject({
      mediaItemId: 'uuid-1',
      eventType: 'imported',
      source: 'sonarr',
      sourceEventId: '77',
    });
    expect(event.occurredAt.toISOString()).toBe('2026-07-03T15:20:22.000Z');
    expect(event.payload).toMatchObject({
      rawEventType: 'downloadFolderImported',
      sourceTitle: 'Show S01E01',
      quality: 'WEBDL-1080p',
      indexer: 'Idx',
      releaseGroup: 'GRP',
      downloadClient: 'sab',
      seriesId: 9,
      episodeId: 901, // completeFixRequests matches on this key
    });
    expect(event.payload).not.toHaveProperty('kind'); // only deletions carry payload.kind
  });

  it('marks history-sourced deletions payload.kind=file_deleted (vs item_removed)', () => {
    const event = historyRecordToLedgerEvent(
      { ...sonarrRecord, id: 78, eventType: 'episodeFileDeleted' },
      { arrKind: 'sonarr', arrInstanceId: 'main', mediaItemId: null },
    )!;
    expect(event.eventType).toBe('deleted');
    expect(event.payload).toMatchObject({ kind: 'file_deleted' });
  });

  it('returns null for dropped raw types and carries albumId for lidarr', () => {
    expect(
      historyRecordToLedgerEvent(
        { ...sonarrRecord, eventType: 'episodeFileRenamed' },
        { arrKind: 'sonarr', arrInstanceId: 'main', mediaItemId: null },
      ),
    ).toBeNull();

    const lidarrRecord: LidarrHistoryRecord = {
      id: 5,
      eventType: 'trackFileImported',
      date: '2026-07-02T21:48:31Z',
      sourceTitle: 'Album',
      downloadId: null,
      artistId: 4610,
      albumId: 12013,
    };
    const event = historyRecordToLedgerEvent(lidarrRecord, {
      arrKind: 'lidarr',
      arrInstanceId: 'main',
      mediaItemId: null,
    })!;
    expect(event.payload).toMatchObject({ artistId: 4610, albumId: 12013 });
  });
});
