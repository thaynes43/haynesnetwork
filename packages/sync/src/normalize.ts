// DESIGN-005 D-07 — normalize raw *arr history eventTypes into ledger event types.
// The raw eventType is always preserved in payload.rawEventType; raw types outside the
// map (renames, ignored, retagged, albumImportIncomplete, unknown) are DROPPED — no
// ledger event, though the cursor still advances past them.
import type {
  LidarrHistoryRecord,
  RadarrHistoryRecord,
  SonarrHistoryRecord,
} from '@hnet/arr';
import type { ArrKind, LedgerEventType } from '@hnet/db';
import type { LedgerEventInput } from '@hnet/domain';

export type ArrHistoryRecord = SonarrHistoryRecord | RadarrHistoryRecord | LidarrHistoryRecord;

type NormalizedHistoryEventType = Extract<
  LedgerEventType,
  'grabbed' | 'imported' | 'deleted' | 'download_failed'
>;

/** The D-07 normalization map, exactly as tabled (dropped raw types are absent). */
export const HISTORY_EVENT_NORMALIZATION: Record<
  ArrKind,
  Readonly<Record<string, NormalizedHistoryEventType>>
> = {
  sonarr: {
    grabbed: 'grabbed',
    downloadFolderImported: 'imported',
    seriesFolderImported: 'imported',
    episodeFileDeleted: 'deleted',
    downloadFailed: 'download_failed',
  },
  radarr: {
    grabbed: 'grabbed',
    downloadFolderImported: 'imported',
    movieFolderImported: 'imported',
    movieFileDeleted: 'deleted',
    downloadFailed: 'download_failed',
  },
  lidarr: {
    grabbed: 'grabbed',
    trackFileImported: 'imported',
    downloadImported: 'imported',
    artistFolderImported: 'imported',
    trackFileDeleted: 'deleted',
    downloadFailed: 'download_failed',
  },
};

/** Map a raw eventType to its normalized ledger type, or null when it is dropped. */
export function normalizeHistoryEventType(
  arrKind: ArrKind,
  rawEventType: string,
): NormalizedHistoryEventType | null {
  return HISTORY_EVENT_NORMALIZATION[arrKind][rawEventType] ?? null;
}

/** The *arr item id a history record targets — resolves the media_items FK (D-14). */
export function historyTargetArrItemId(arrKind: ArrKind, record: ArrHistoryRecord): number {
  switch (arrKind) {
    case 'sonarr':
      return (record as SonarrHistoryRecord).seriesId;
    case 'radarr':
      return (record as RadarrHistoryRecord).movieId;
    case 'lidarr':
      return (record as LidarrHistoryRecord).artistId;
  }
}

function dataString(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export interface HistoryEventContext {
  arrKind: ArrKind;
  arrInstanceId: string;
  /** Resolved media_items.id for the record's target, or null when not in the ledger. */
  mediaItemId: string | null;
}

/**
 * Build the D-07 ledger event for one history record: normalized eventType, the *arr
 * history id as the (source, source_event_id) dedupe key, source timestamp, and a
 * sanitized payload (rawEventType, release metadata, child target ids — the keys
 * completeFixRequests matches on are `episodeId`/`albumId`). Returns null for dropped
 * raw eventTypes.
 */
export function historyRecordToLedgerEvent(
  record: ArrHistoryRecord,
  context: HistoryEventContext,
): LedgerEventInput | null {
  const eventType = normalizeHistoryEventType(context.arrKind, record.eventType);
  if (eventType === null) return null;

  const payload: Record<string, unknown> = {
    rawEventType: record.eventType,
    arrInstanceId: context.arrInstanceId,
    sourceTitle: record.sourceTitle ?? null,
    downloadId: record.downloadId ?? null,
    quality: record.quality?.quality.name ?? null,
    indexer: dataString(record.data, 'indexer'),
    releaseGroup: dataString(record.data, 'releaseGroup'),
    downloadClient: dataString(record.data, 'downloadClient'),
  };
  // History-sourced deletions are file-level; item-level removals come from the full
  // sync's tombstone pass with payload.kind = 'item_removed' (D-07).
  if (eventType === 'deleted') payload['kind'] = 'file_deleted';

  // Child target ids per kind (D-06: children are payload data, the FK is the parent).
  switch (context.arrKind) {
    case 'sonarr': {
      const r = record as SonarrHistoryRecord;
      payload['seriesId'] = r.seriesId;
      payload['episodeId'] = r.episodeId;
      break;
    }
    case 'radarr': {
      payload['movieId'] = (record as RadarrHistoryRecord).movieId;
      break;
    }
    case 'lidarr': {
      const r = record as LidarrHistoryRecord;
      payload['artistId'] = r.artistId;
      payload['albumId'] = r.albumId;
      break;
    }
  }

  return {
    mediaItemId: context.mediaItemId,
    eventType,
    source: context.arrKind,
    sourceEventId: String(record.id),
    occurredAt: new Date(record.date),
    payload,
  };
}
