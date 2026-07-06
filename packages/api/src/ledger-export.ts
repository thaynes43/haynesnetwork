// ADR-022 C-03 / DESIGN-009 D-06 — the emergency Ledger export. Streams the FULL filtered set
// (no cursor cap) as deterministic JSONL — one round-trippable object per row, ordered
// (sort_title, id). Reuses the shared buildLibraryWhere DSL so the export matches exactly what
// browse shows; iterates keyset pages server-side so a 17k-row export never buffers in memory.
// The auth + section gate live in the Next route handler (apps/web); this module is DB-only.
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { ARR_KINDS, mediaItems, mediaMetadata, RESOLUTIONS, type Database } from '@hnet/db';
import { buildLibraryWhere, HAS_FILE_FILTERS, ON_DISK_FILTERS, type LibraryWhereInput } from './ledger-query';

/** One exported row — the fields needed to re-import into the target *arr (ADR-022 C-03). Key
 *  order is fixed so the JSONL is byte-deterministic for a fixed filtered set (AC-12). */
export interface LedgerExportRow {
  kind: (typeof ARR_KINDS)[number];
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  musicbrainzArtistId: string | null;
  qualityProfileName: string;
  rootFolder: string;
  tags: string[];
  monitored: boolean;
  onDisk: boolean;
  tombstonedAt: string | null;
}

const EXPORT_PAGE = 500;

/**
 * Build the export filter from raw query params (the route handler passes req URL params).
 * Lenient: unknown params are ignored; comma-separated lists for the multi-value facets; the
 * tombstone gate is FORCED open (the export is "everything that ever was"). Invalid enum values
 * are dropped rather than erroring — an export should degrade to a broader set, never 500.
 */
export function buildExportFilterFromParams(params: URLSearchParams): LibraryWhereInput {
  const list = (key: string): string[] | undefined => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return undefined;
    const values = raw.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
    return values.length > 0 ? values : undefined;
  };
  const num = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const arrKindRaw = params.get('arrKind');
  const arrKind = ARR_KINDS.find((k) => k === arrKindRaw);
  const onDiskRaw = params.get('onDisk');
  const onDisk = ON_DISK_FILTERS.find((o) => o === onDiskRaw);
  const hasFileRaw = params.get('hasFile');
  const hasFile = HAS_FILE_FILTERS.find((h) => h === hasFileRaw);
  const monitoredRaw = params.get('monitored');
  const resolutions = list('resolutions')?.filter((r): r is (typeof RESOLUTIONS)[number] =>
    (RESOLUTIONS as readonly string[]).includes(r),
  );
  return {
    ...(params.get('query')?.trim() ? { query: params.get('query')!.trim() } : {}),
    ...(arrKind ? { arrKind } : {}),
    ...(onDisk ? { onDisk } : {}),
    ...(hasFile ? { hasFile } : {}),
    ...(monitoredRaw === 'true' ? { monitored: true } : monitoredRaw === 'false' ? { monitored: false } : {}),
    includeTombstoned: true,
    ...(list('genres') ? { genres: list('genres') } : {}),
    ...(resolutions?.length ? { resolutions } : {}),
    ...(list('requesters') ? { requesters: list('requesters') } : {}),
    ...(list('sourceCollections') ? { sourceCollections: list('sourceCollections') } : {}),
    ...(num('ratingMin') !== undefined ? { ratingMin: num('ratingMin') } : {}),
    ...(num('ratingMax') !== undefined ? { ratingMax: num('ratingMax') } : {}),
  };
}

const toExportRow = (row: {
  arrKind: (typeof ARR_KINDS)[number];
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  musicbrainzArtistId: string | null;
  qualityProfileName: string;
  rootFolder: string;
  arrTags: string[];
  monitored: boolean;
  onDiskFileCount: number;
  deletedFromArrAt: Date | null;
}): LedgerExportRow => ({
  kind: row.arrKind,
  title: row.title,
  year: row.year,
  tmdbId: row.tmdbId,
  tvdbId: row.tvdbId,
  musicbrainzArtistId: row.musicbrainzArtistId,
  qualityProfileName: row.qualityProfileName,
  rootFolder: row.rootFolder,
  tags: row.arrTags,
  monitored: row.monitored,
  onDisk: row.onDiskFileCount > 0,
  tombstonedAt: row.deletedFromArrAt === null ? null : row.deletedFromArrAt.toISOString(),
});

/**
 * Stream the filtered ledger as JSONL lines (each ending in "\n"), ordered (sort_title, id),
 * keyset-paginated in EXPORT_PAGE-row batches so runtime memory is bounded regardless of the
 * result size. The join-free query means the export never needs media_metadata.
 */
export async function* streamLedgerExportRows(
  db: Database,
  filter: LibraryWhereInput,
): AsyncGenerator<string> {
  // LEFT JOIN media_metadata unconditionally (matches search/browse) so the metadata facet
  // filters resolve; the projection stays media_items-only (the export is round-trip data).
  const baseWhere = buildLibraryWhere(filter);

  let cursor: { sortTitle: string; id: string } | null = null;
  for (;;) {
    const where: SQL[] = [...baseWhere];
    if (cursor !== null) {
      where.push(
        sql`(${mediaItems.sortTitle}, ${mediaItems.id}) > (${cursor.sortTitle}, ${cursor.id}::uuid)`,
      );
    }
    const rows = await db
      .select({
        id: mediaItems.id,
        sortTitle: mediaItems.sortTitle,
        arrKind: mediaItems.arrKind,
        title: mediaItems.title,
        year: mediaItems.year,
        tmdbId: mediaItems.tmdbId,
        tvdbId: mediaItems.tvdbId,
        musicbrainzArtistId: mediaItems.musicbrainzArtistId,
        qualityProfileName: mediaItems.qualityProfileName,
        rootFolder: mediaItems.rootFolder,
        arrTags: mediaItems.arrTags,
        monitored: mediaItems.monitored,
        onDiskFileCount: mediaItems.onDiskFileCount,
        deletedFromArrAt: mediaItems.deletedFromArrAt,
      })
      .from(mediaItems)
      .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
      .where(and(...where))
      .orderBy(asc(mediaItems.sortTitle), asc(mediaItems.id))
      .limit(EXPORT_PAGE);

    for (const row of rows) {
      yield `${JSON.stringify(toExportRow(row))}\n`;
    }
    if (rows.length < EXPORT_PAGE) break;
    const last = rows[rows.length - 1]!;
    cursor = { sortTitle: last.sortTitle, id: last.id };
  }
}
