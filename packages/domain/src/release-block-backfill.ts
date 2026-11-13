// ADR-117 / DESIGN-052 D-29 — one-off backfill of verified posted names onto titles Trash already deleted.
// Dry-run writes nothing and does not call Radarr or Sonarr. Apply inserts `active` records (origin
// `backfill`, 365 days from the original delete) through insertReleaseRecords, then reconcileReleaseBlock.
// It never removes a low-confidence row, never lengthens a term, and never terms a title the ledger
// still lists as live.
//
// Selection (the replica counts mirror these filters):
//   low — trash_deleted_releases state in (active, in_flight), identity_source arr_file,
//         term_confidence low_confidence.
//   movies — distinct tmdb of a deleted movie batch item whose media item is tombstoned
//         (deleted_from_arr_at is not null) and that has no termed record in
//         (active, in_flight, expired, pruned).
//   shows — the same for tvdb and media_kind tv. No size match: a series is many downloads.
import {
  ledgerEvents,
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
  type DbClient,
} from '@hnet/db';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import { matchLegacySab, postedReleaseName, type LegacySabJob } from './release-block-names';
import {
  RELEASE_TERM_LIFETIME_DAYS,
  draftForVerifiedName,
  insertReleaseRecords,
  reconcileReleaseBlock,
  type KeyedDrafts,
  type PostedRelease,
  type ReleaseArrKind,
  type ReleaseBlockArrClients,
  type ReleaseBlockReconcileReport,
  type ReleaseRecordDraft,
} from './release-block';

const DAY_MS = 86_400_000;
const TERMED_STATES = ['active', 'in_flight', 'expired', 'pruned'] as const;
const LIVE_STATES = ['active', 'in_flight'] as const;

/** Title counts: candidates = expired + named + unnamed + noNewTerm. Name counts are separate. */
export interface PostedNameBackfillClass {
  candidates: number;
  /** The delete is already 365 days old. Nothing is inserted, so the term's life is not restarted. */
  expired: number;
  /** At least one new verified term. */
  named: number;
  /** No posted name (a URL is not a name). */
  unnamed: number;
  /** Posted names, and none of them became a new term. */
  noNewTerm: number;
  namesSeen: number;
  records: number;
  untermed: number;
  alreadyBlocked: number;
  urlsSkipped: number;
  /** Deleted titles the ledger still lists as live. Not part of `candidates`. */
  skippedLive: number;
}

export interface PostedNameBackfillReport {
  apply: boolean;
  lowConfidence: PostedNameBackfillClass;
  movies: PostedNameBackfillClass;
  shows: PostedNameBackfillClass;
  reconciled: ReleaseBlockReconcileReport[];
}

interface Candidate {
  key: string;
  arrKind: ReleaseArrKind;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  mediaItemId: string | null;
  arrItemId: number | null;
  batchItemId: string | null;
  deletedAt: Date;
  sizeBytes: number | null;
  /** Movies only. */
  sab: boolean;
}

function emptyClass(): PostedNameBackfillClass {
  return {
    candidates: 0,
    expired: 0,
    named: 0,
    unnamed: 0,
    noNewTerm: 0,
    namesSeen: 0,
    records: 0,
    untermed: 0,
    alreadyBlocked: 0,
    urlsSkipped: 0,
    skippedLive: 0,
  };
}

const payloadString = (payload: Record<string, unknown>, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

function blockKey(candidate: Candidate, term: string): string {
  const id =
    candidate.arrKind === 'radarr'
      ? `tmdb:${candidate.tmdbId ?? ''}`
      : `tvdb:${candidate.tvdbId ?? ''}`;
  return `${candidate.arrKind}|${id}|${term}`;
}

/**
 * D-29 — verified terms for deleted titles that have only a renamed-file record, or none. `apply: false`
 * writes nothing and does not call the *arr. A legacy download history is optional; without it only the
 * ledger's grabbed and failed-download names are used.
 */
export async function backfillPostedReleaseNames(input: {
  db?: DbClient;
  /** Required for `--apply` (the reconcile). A dry run never calls it. */
  arr?: ReleaseBlockArrClients;
  apply: boolean;
  legacySab?: readonly LegacySabJob[];
  logger?: DomainLogger;
  now?: Date;
}): Promise<PostedNameBackfillReport> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const logger = input.logger ?? consoleDomainLogger;
  const report: PostedNameBackfillReport = {
    apply: input.apply,
    lowConfidence: emptyClass(),
    movies: emptyClass(),
    shows: emptyClass(),
    reconciled: [],
  };

  const liveTerms = await db
    .select({
      arrKind: trashDeletedReleases.arrKind,
      tmdbId: trashDeletedReleases.tmdbId,
      tvdbId: trashDeletedReleases.tvdbId,
      term: trashDeletedReleases.term,
    })
    .from(trashDeletedReleases)
    .where(and(inArray(trashDeletedReleases.state, [...LIVE_STATES]), isNotNull(trashDeletedReleases.term)));
  const blocked = new Set(
    liveTerms.map(
      (row) =>
        `${row.arrKind}|${row.arrKind === 'radarr' ? `tmdb:${row.tmdbId ?? ''}` : `tvdb:${row.tvdbId ?? ''}`}|${row.term}`,
    ),
  );

  const termedMovies = new Set(
    (
      await db
        .select({ tmdbId: trashDeletedReleases.tmdbId })
        .from(trashDeletedReleases)
        .where(
          and(
            eq(trashDeletedReleases.arrKind, 'radarr'),
            inArray(trashDeletedReleases.state, [...TERMED_STATES]),
            isNotNull(trashDeletedReleases.term),
            isNotNull(trashDeletedReleases.tmdbId),
          ),
        )
    ).map((row) => row.tmdbId as number),
  );
  const termedShows = new Set(
    (
      await db
        .select({ tvdbId: trashDeletedReleases.tvdbId })
        .from(trashDeletedReleases)
        .where(
          and(
            eq(trashDeletedReleases.arrKind, 'sonarr'),
            inArray(trashDeletedReleases.state, [...TERMED_STATES]),
            isNotNull(trashDeletedReleases.term),
            isNotNull(trashDeletedReleases.tvdbId),
          ),
        )
    ).map((row) => row.tvdbId as number),
  );

  const lowRows = await db
    .select({
      id: trashDeletedReleases.id,
      arrKind: trashDeletedReleases.arrKind,
      title: trashDeletedReleases.title,
      year: trashDeletedReleases.year,
      tmdbId: trashDeletedReleases.tmdbId,
      tvdbId: trashDeletedReleases.tvdbId,
      imdbId: trashDeletedReleases.imdbId,
      mediaItemId: trashDeletedReleases.mediaItemId,
      arrItemId: trashDeletedReleases.arrItemId,
      batchItemId: trashDeletedReleases.batchItemId,
      sizeBytes: trashDeletedReleases.sizeBytes,
      recordedAt: trashDeletedReleases.recordedAt,
      deletedAt: trashBatchItems.deletedAt,
      deletedSizeBytes: trashBatchItems.deletedSizeBytes,
    })
    .from(trashDeletedReleases)
    .leftJoin(trashBatchItems, eq(trashBatchItems.id, trashDeletedReleases.batchItemId))
    .where(
      and(
        inArray(trashDeletedReleases.state, [...LIVE_STATES]),
        eq(trashDeletedReleases.identitySource, 'arr_file'),
        eq(trashDeletedReleases.termConfidence, 'low_confidence'),
      ),
    );

  const deletedRows = await db
    .select({
      id: trashBatchItems.id,
      mediaKind: trashBatches.mediaKind,
      title: trashBatchItems.title,
      year: trashBatchItems.year,
      tmdbId: trashBatchItems.tmdbId,
      tvdbId: trashBatchItems.tvdbId,
      mediaItemId: trashBatchItems.mediaItemId,
      deletedAt: trashBatchItems.deletedAt,
      deletedSizeBytes: trashBatchItems.deletedSizeBytes,
      imdbId: mediaItems.imdbId,
      arrItemId: mediaItems.arrItemId,
      tombstoned: mediaItems.deletedFromArrAt,
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatches.id, trashBatchItems.batchId))
    .innerJoin(mediaItems, eq(mediaItems.id, trashBatchItems.mediaItemId))
    .where(and(eq(trashBatchItems.state, 'deleted'), isNotNull(trashBatchItems.deletedAt)))
    .orderBy(desc(trashBatchItems.deletedAt));

  const candidates: Array<{ bucket: PostedNameBackfillClass; candidate: Candidate }> = [];
  for (const row of lowRows) {
    if (row.arrKind !== 'radarr' && row.arrKind !== 'sonarr') continue;
    candidates.push({
      bucket: report.lowConfidence,
      candidate: {
        key: `low:${row.id}`,
        arrKind: row.arrKind,
        title: row.title,
        year: row.year,
        tmdbId: row.tmdbId,
        tvdbId: row.tvdbId,
        imdbId: row.imdbId,
        mediaItemId: row.mediaItemId,
        arrItemId: row.arrItemId,
        batchItemId: row.batchItemId,
        deletedAt: row.deletedAt ?? row.recordedAt,
        sizeBytes: row.deletedSizeBytes ?? row.sizeBytes,
        sab: row.arrKind === 'radarr',
      },
    });
  }

  const seenMovie = new Set<number>();
  const seenShow = new Set<number>();
  for (const row of deletedRows) {
    const deletedAt = row.deletedAt as Date;
    if (row.mediaKind === 'movie') {
      if (row.tmdbId === null || seenMovie.has(row.tmdbId)) continue;
      seenMovie.add(row.tmdbId);
      if (termedMovies.has(row.tmdbId)) continue;
      if (row.tombstoned === null) {
        report.movies.skippedLive += 1;
        continue;
      }
      candidates.push({
        bucket: report.movies,
        candidate: {
          key: `movie:${row.tmdbId}`,
          arrKind: 'radarr',
          title: row.title,
          year: row.year,
          tmdbId: row.tmdbId,
          tvdbId: row.tvdbId,
          imdbId: row.imdbId,
          mediaItemId: row.mediaItemId,
          arrItemId: row.arrItemId,
          batchItemId: row.id,
          deletedAt,
          sizeBytes: row.deletedSizeBytes,
          sab: true,
        },
      });
    } else if (row.mediaKind === 'tv') {
      if (row.tvdbId === null || seenShow.has(row.tvdbId)) continue;
      seenShow.add(row.tvdbId);
      if (termedShows.has(row.tvdbId)) continue;
      if (row.tombstoned === null) {
        report.shows.skippedLive += 1;
        continue;
      }
      candidates.push({
        bucket: report.shows,
        candidate: {
          key: `show:${row.tvdbId}`,
          arrKind: 'sonarr',
          title: row.title,
          year: row.year,
          tmdbId: row.tmdbId,
          tvdbId: row.tvdbId,
          imdbId: row.imdbId,
          mediaItemId: row.mediaItemId,
          arrItemId: row.arrItemId,
          batchItemId: row.id,
          deletedAt,
          sizeBytes: null,
          sab: false,
        },
      });
    }
  }

  const mediaIds = [
    ...new Set(candidates.map((c) => c.candidate.mediaItemId).filter((id): id is string => id !== null)),
  ];
  const events =
    mediaIds.length === 0
      ? []
      : await db
          .select({
            mediaItemId: ledgerEvents.mediaItemId,
            occurredAt: ledgerEvents.occurredAt,
            payload: ledgerEvents.payload,
          })
          .from(ledgerEvents)
          .where(
            and(
              inArray(ledgerEvents.mediaItemId, mediaIds),
              inArray(ledgerEvents.eventType, ['grabbed', 'download_failed']),
            ),
          );
  const eventsByItem = new Map<string, typeof events>();
  for (const event of events) {
    if (event.mediaItemId === null) continue;
    const list = eventsByItem.get(event.mediaItemId) ?? [];
    list.push(event);
    eventsByItem.set(event.mediaItemId, list);
  }

  const items: KeyedDrafts[] = [];
  const deletedAtByKey = new Map<string, Date>();
  for (const { bucket, candidate } of candidates) {
    bucket.candidates += 1;
    if (candidate.deletedAt.getTime() + RELEASE_TERM_LIFETIME_DAYS * DAY_MS <= now.getTime()) {
      bucket.expired += 1;
      continue;
    }
    const names = namesFor(candidate, eventsByItem.get(candidate.mediaItemId ?? '') ?? [], input.legacySab ?? [], bucket);
    if (names.length === 0) {
      bucket.unnamed += 1;
      continue;
    }
    const drafts: ReleaseRecordDraft[] = [];
    for (const posted of names) {
      const built = draftForVerifiedName({
        arrKind: candidate.arrKind,
        arrItemId: candidate.arrItemId,
        mediaItemId: candidate.mediaItemId,
        title: candidate.title,
        year: candidate.year,
        tmdbId: candidate.tmdbId,
        tvdbId: candidate.tvdbId,
        imdbId: candidate.imdbId,
        arrYears: [candidate.year],
        posted,
      });
      if (built === 'untermed') {
        bucket.untermed += 1;
        continue;
      }
      if (built === 'skip' || built.term === null) continue;
      if (blocked.has(blockKey(candidate, built.term))) {
        bucket.alreadyBlocked += 1;
        continue;
      }
      blocked.add(blockKey(candidate, built.term));
      drafts.push({ ...built, sizeBytes: built.sizeBytes ?? candidate.sizeBytes });
    }
    if (drafts.length === 0) {
      bucket.noNewTerm += 1;
      continue;
    }
    bucket.named += 1;
    bucket.records += drafts.length;
    items.push({ key: candidate.key, drafts, batchItemId: candidate.batchItemId });
    deletedAtByKey.set(candidate.key, candidate.deletedAt);
  }

  if (!input.apply || items.length === 0) return report;
  if (!input.arr) throw new Error('backfill apply needs the Release Block clients');
  const arr = input.arr;
  await insertReleaseRecords({
    db: input.db,
    items,
    origin: 'backfill',
    state: 'active',
    recordedAt: now,
    expiresFrom: (key) => deletedAtByKey.get(key),
    logger,
  });
  const kinds = new Set(items.flatMap((item) => item.drafts.map((d) => d.arrKind)));
  for (const arrKind of ['radarr', 'sonarr'] as const) {
    if (!kinds.has(arrKind)) continue;
    report.reconciled.push(
      await reconcileReleaseBlock({ db: input.db, arr, arrKind, logger, now }),
    );
  }
  return report;
}

function namesFor(
  candidate: Candidate,
  events: ReadonlyArray<{ occurredAt: Date; payload: Record<string, unknown> }>,
  jobs: readonly LegacySabJob[],
  bucket: PostedNameBackfillClass,
): PostedRelease[] {
  const seen = new Set<string>();
  const out: PostedRelease[] = [];
  const add = (posted: PostedRelease | null) => {
    if (!posted || seen.has(posted.name)) return;
    seen.add(posted.name);
    out.push(posted);
    bucket.namesSeen += 1;
  };
  const ordered = [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  for (const event of ordered) {
    if (event.occurredAt.getTime() > candidate.deletedAt.getTime()) continue;
    const raw = payloadString(event.payload, 'sourceTitle');
    if (raw !== null && raw.includes('://')) {
      bucket.urlsSkipped += 1;
      continue;
    }
    const name = postedReleaseName(raw);
    if (!name) continue;
    add({
      name,
      releaseGroup: payloadString(event.payload, 'releaseGroup'),
      quality: payloadString(event.payload, 'quality'),
      indexer: payloadString(event.payload, 'indexer'),
      source: 'ledger_grab',
      sizeBytes: null,
    });
  }
  if (candidate.sab && jobs.length > 0) {
    for (const job of matchLegacySab(
      {
        title: candidate.title,
        year: candidate.year,
        deletedAt: candidate.deletedAt,
        deletedSizeBytes: candidate.sizeBytes,
      },
      jobs,
    )) {
      if (job.name.includes('://')) {
        bucket.urlsSkipped += 1;
        continue;
      }
      const name = postedReleaseName(job.name);
      if (!name) continue;
      add({
        name,
        releaseGroup: null,
        quality: null,
        indexer: null,
        source: 'legacy_sab',
        sizeBytes: job.bytes,
      });
    }
  }
  return out;
}
