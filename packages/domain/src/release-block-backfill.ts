// ADR-117 / DESIGN-052 D-29 — one-off backfill of posted release names onto titles Trash already deleted.
// A dry run writes nothing and does not call Radarr or Sonarr. Apply inserts permanent records (origin `backfill`)
// through insertReleaseRecords, reconciles the profile through reconcileReleaseBlock and only then turns them
// `active`. It never removes or weakens an existing record, never expires a term or prunes an older term to make room,
// and never terms a title the ledger lists as live.
//
// Selection: every TITLE Trash deleted that is still gone. A title is one (arr kind, tmdb id or tvdb id) with a
// `deleted` batch item, or a protected Deleted-Release Record (including legacy `expired` / `pruned`; an Expedite
// delete has no batch item), whose media item is tombstoned (`deleted_from_arr_at` set). Each title lands in ONE class:
//   lowConfidence — it has a live record from the renamed file (`arr_file`, `low_confidence`);
//   movies / shows — it has no record with a term at all;
//   otherNames — every other title: it has a term, and may still have a posted name no live term matches
//                (review F5: an earlier grab, a failed download, an upgrade's predecessor).
// For each title, its posted names are the ledger's `grabbed` and `download_failed` rows up to the delete, every row
// of the legacy tables for its id, and for a movie the old download jobs the D-15 size rule matches. A name that a
// live term of the same *arr already matches is `alreadyBlocked`; every other name that terms gets a record.
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
import { matchLegacySab, postedReleaseName, verifiedFileName } from './release-block-names';
import { readLegacyJobsForSize, readLegacyReleaseNames } from './release-block-legacy';
import {
  RELEASE_BLOCK_TERM_CAP,
  RELEASE_BLOCK_PROTECTED_STATES,
  abandonReleaseRecords,
  activateReleaseRecords,
  draftForVerifiedName,
  insertReleaseRecords,
  reconcileReleaseBlock,
  reserveTermsUnderCap,
  type KeyedDrafts,
  type PostedRelease,
  type ReleaseArrKind,
  type ReleaseBlockArrClients,
  type ReleaseBlockReconcileReport,
  type ReleaseRecordDraft,
} from './release-block';
import { termMatchesRaw } from './release-terms';

/** D-33 — legacy expiry encoded the actual delete plus the former lifetime. Evidence bound only, never retention. */
function legacyDeletionTimeFromExpiry(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() - 365 * 86_400_000);
}

/** Title counts: titles = named + unnamed + noNewTerm + capRefused + unread. Name counts are separate. */
export interface PostedNameBackfillClass {
  titles: number;
  /** At least one new term. */
  named: number;
  /** No posted name in any source (a URL is not a name). */
  unnamed: number;
  /** Posted names, and none of them became a new term (all blocked already, skipped or untermed). */
  noNewTerm: number;
  /** New terms that would not all fit under the cap: nothing is inserted for the title, nothing older is pruned. */
  capRefused: number;
  /** A legacy read for the title did not finish (past its row bound): nothing is inserted for it. */
  unread: number;
  namesSeen: number;
  /** New records (one per new term). */
  records: number;
  /** Names that name a release and yield no term the *arr would match. */
  untermed: number;
  /** Names that name no release (a season-0 special, a bare title). */
  skipped: number;
  /** Names a live term already matches. */
  alreadyBlocked: number;
  urlsSkipped: number;
}

export interface PostedNameBackfillReport {
  apply: boolean;
  lowConfidence: PostedNameBackfillClass;
  movies: PostedNameBackfillClass;
  shows: PostedNameBackfillClass;
  otherNames: PostedNameBackfillClass;
  /** Deleted titles the ledger lists as live again (re-added): never termed, not part of any class. */
  skippedLive: { movies: number; shows: number };
  /** Per *arr: the complete protected terms before, the distinct terms this run adds, and the cap. */
  terms: Record<ReleaseArrKind, { live: number; added: number; cap: number }>;
  reconciled: ReleaseBlockReconcileReport[];
}

interface Candidate {
  key: string;
  arrKind: ReleaseArrKind;
  externalId: number;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  mediaItemId: string;
  arrItemId: number | null;
  batchItemId: string | null;
  /** The actual delete time bounds evidence; it never controls term retention. */
  deletedAt: Date;
  sizeBytes: number | null;
}

function emptyClass(): PostedNameBackfillClass {
  return {
    titles: 0,
    named: 0,
    unnamed: 0,
    noNewTerm: 0,
    capRefused: 0,
    unread: 0,
    namesSeen: 0,
    records: 0,
    untermed: 0,
    skipped: 0,
    alreadyBlocked: 0,
    urlsSkipped: 0,
  };
}

const payloadString = (payload: Record<string, unknown>, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

const titleKey = (arrKind: ReleaseArrKind, externalId: number) => `${arrKind}:${externalId}`;

/**
 * D-29 — records for the posted names of deleted titles that no live term matches. `apply: false` writes nothing
 * and does not call the *arr. `apply: true` refuses a title whose terms would not fit under the cap, and stops
 * (records abandoned, nothing left in the profile) when the profile cannot be written and read back.
 */
export async function backfillPostedReleaseNames(input: {
  db?: DbClient;
  /** Required for `--apply` (the reconcile). A dry run never calls it. */
  arr?: ReleaseBlockArrClients;
  apply: boolean;
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
    otherNames: emptyClass(),
    skippedLive: { movies: 0, shows: 0 },
    terms: {
      radarr: { live: 0, added: 0, cap: RELEASE_BLOCK_TERM_CAP },
      sonarr: { live: 0, added: 0, cap: RELEASE_BLOCK_TERM_CAP },
    },
    reconciled: [],
  };
  const t = trashDeletedReleases;

  // Every record that has (or had) a term, per title: the live terms, whether any is the renamed-file kind, and the
  // actual deletion time for bounding evidence. Legacy finite expiry retains its historical interpretation.
  const records = await db
    .select({
      arrKind: t.arrKind,
      tmdbId: t.tmdbId,
      tvdbId: t.tvdbId,
      imdbId: t.imdbId,
      title: t.title,
      year: t.year,
      mediaItemId: t.mediaItemId,
      arrItemId: t.arrItemId,
      batchItemId: t.batchItemId,
      sizeBytes: t.sizeBytes,
      term: t.term,
      state: t.state,
      identitySource: t.identitySource,
      termConfidence: t.termConfidence,
      expiresAt: t.expiresAt,
      batchDeletedAt: trashBatchItems.deletedAt,
      ledgerDeletedAt: mediaItems.deletedFromArrAt,
    })
    .from(t)
    .leftJoin(trashBatchItems, eq(trashBatchItems.id, t.batchItemId))
    .leftJoin(mediaItems, eq(mediaItems.id, t.mediaItemId))
    .where(and(inArray(t.state, [...RELEASE_BLOCK_PROTECTED_STATES]), isNotNull(t.term)));
  const liveTerms: Record<ReleaseArrKind, Set<string>> = { radarr: new Set(), sonarr: new Set() };
  const termed = new Set<string>();
  const lowConfidence = new Set<string>();
  const fromRecords = new Map<string, Candidate>();
  for (const r of records) {
    if (r.arrKind !== 'radarr' && r.arrKind !== 'sonarr') continue;
    liveTerms[r.arrKind].add(r.term as string);
    const externalId = r.arrKind === 'radarr' ? r.tmdbId : r.tvdbId;
    if (externalId === null || externalId <= 0) continue;
    const key = titleKey(r.arrKind, externalId);
    termed.add(key);
    if (r.identitySource === 'arr_file' && r.termConfidence === 'low_confidence') lowConfidence.add(key);
    if (r.mediaItemId === null) continue;
    const deletedAt =
      r.expiresAt !== null
        ? legacyDeletionTimeFromExpiry(r.expiresAt)
        : (r.batchDeletedAt ?? r.ledgerDeletedAt);
    // A new record has no expiry clock. Never replace an unknown deletion time with recorded_at or now.
    // A viable tombstoned title has ledgerDeletedAt; live/unknown items cannot supply deletion evidence.
    if (deletedAt === null) continue;
    const known = fromRecords.get(key);
    if (known && known.deletedAt.getTime() >= deletedAt.getTime()) continue;
    fromRecords.set(key, {
      key,
      arrKind: r.arrKind,
      externalId,
      title: r.title,
      year: r.year,
      tmdbId: r.tmdbId,
      tvdbId: r.tvdbId,
      imdbId: r.imdbId,
      mediaItemId: r.mediaItemId,
      arrItemId: r.arrItemId,
      batchItemId: r.batchItemId,
      deletedAt,
      sizeBytes: r.sizeBytes,
    });
  }
  report.terms.radarr.live = liveTerms.radarr.size;
  report.terms.sonarr.live = liveTerms.sonarr.size;

  // Every title a batch deleted (the newest delete of each).
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
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatches.id, trashBatchItems.batchId))
    .innerJoin(mediaItems, eq(mediaItems.id, trashBatchItems.mediaItemId))
    .where(and(eq(trashBatchItems.state, 'deleted'), isNotNull(trashBatchItems.deletedAt)))
    .orderBy(desc(trashBatchItems.deletedAt));
  const titles = new Map<string, Candidate>();
  for (const row of deletedRows) {
    const arrKind: ReleaseArrKind | null =
      row.mediaKind === 'movie' ? 'radarr' : row.mediaKind === 'tv' ? 'sonarr' : null;
    if (arrKind === null || row.mediaItemId === null) continue;
    const externalId = arrKind === 'radarr' ? row.tmdbId : row.tvdbId;
    if (externalId === null || externalId <= 0) continue;
    const key = titleKey(arrKind, externalId);
    if (titles.has(key)) continue; // newest delete first
    titles.set(key, {
      key,
      arrKind,
      externalId,
      title: row.title,
      year: row.year,
      tmdbId: row.tmdbId,
      tvdbId: row.tvdbId,
      imdbId: row.imdbId,
      mediaItemId: row.mediaItemId,
      arrItemId: row.arrItemId,
      batchItemId: row.id,
      deletedAt: row.deletedAt as Date,
      sizeBytes: arrKind === 'radarr' ? row.deletedSizeBytes : null,
    });
  }
  for (const [key, candidate] of fromRecords) if (!titles.has(key)) titles.set(key, candidate);

  // Only a title that is still gone: one the ledger lists as live again is never termed.
  const mediaIds = [...new Set([...titles.values()].map((c) => c.mediaItemId))];
  const tombstoned = new Set<string>();
  for (let at = 0; at < mediaIds.length; at += 1_000) {
    const rows = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(inArray(mediaItems.id, mediaIds.slice(at, at + 1_000)), isNotNull(mediaItems.deletedFromArrAt)));
    for (const row of rows) tombstoned.add(row.id);
  }

  const eventsByItem = new Map<string, Array<{ occurredAt: Date; payload: Record<string, unknown> }>>();
  const goneIds = mediaIds.filter((id) => tombstoned.has(id));
  for (let at = 0; at < goneIds.length; at += 500) {
    const events = await db
      .select({
        mediaItemId: ledgerEvents.mediaItemId,
        occurredAt: ledgerEvents.occurredAt,
        payload: ledgerEvents.payload,
      })
      .from(ledgerEvents)
      .where(
        and(
          inArray(ledgerEvents.mediaItemId, goneIds.slice(at, at + 500)),
          inArray(ledgerEvents.eventType, ['grabbed', 'download_failed']),
        ),
      );
    for (const event of events) {
      if (event.mediaItemId === null) continue;
      const list = eventsByItem.get(event.mediaItemId) ?? [];
      list.push(event);
      eventsByItem.set(event.mediaItemId, list);
    }
  }

  // The cap, as the delete path applies it: the live terms plus what this run has reserved so far.
  const reserved: Record<ReleaseArrKind, Set<string>> = {
    radarr: new Set(liveTerms.radarr),
    sonarr: new Set(liveTerms.sonarr),
  };
  const items: KeyedDrafts[] = [];
  for (const candidate of titles.values()) {
    if (!tombstoned.has(candidate.mediaItemId)) {
      report.skippedLive[candidate.arrKind === 'radarr' ? 'movies' : 'shows'] += 1;
      continue;
    }
    const bucket = lowConfidence.has(candidate.key)
      ? report.lowConfidence
      : !termed.has(candidate.key)
        ? candidate.arrKind === 'radarr'
          ? report.movies
          : report.shows
        : report.otherNames;
    bucket.titles += 1;
    const names = await namesFor(db, candidate, eventsByItem.get(candidate.mediaItemId) ?? [], bucket);
    if (names === 'unread') {
      bucket.unread += 1;
      continue;
    }
    if (names.length === 0) {
      bucket.unnamed += 1;
      continue;
    }
    const live = [...liveTerms[candidate.arrKind]];
    const drafts: ReleaseRecordDraft[] = [];
    const mine = new Set<string>();
    for (const posted of names) {
      // Review F5 — a name is blocked only when a live term matches it as the *arr would test it.
      if (live.some((term) => termMatchesRaw(term, posted.name))) {
        bucket.alreadyBlocked += 1;
        continue;
      }
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
      if (built === 'skip' || built.term === null) {
        bucket.skipped += 1;
        continue;
      }
      if (mine.has(built.term)) continue; // two names of this title, one term
      mine.add(built.term);
      drafts.push({ ...built, sizeBytes: built.sizeBytes ?? candidate.sizeBytes });
    }
    if (drafts.length === 0) {
      bucket.noNewTerm += 1;
      continue;
    }
    // The reconcile must never prune an older term to make room: a title that does not fit is left out, whole.
    const room = reserveTermsUnderCap(reserved[candidate.arrKind], drafts);
    if (!room.fits) {
      bucket.capRefused += 1;
      continue;
    }
    report.terms[candidate.arrKind].added += room.fresh;
    bucket.named += 1;
    bucket.records += drafts.length;
    items.push({ key: candidate.key, drafts, batchItemId: candidate.batchItemId });
  }

  if (!input.apply || items.length === 0) return report;
  if (!input.arr) throw new Error('backfill apply needs the Release Block clients');
  const arr = input.arr;
  // Phase A's shape: the records go in `in_flight`, the profile is written and read back with them, and only then
  // are they `active`. A failure abandons them and takes their terms back out, so a second apply starts clean.
  const inserted = await insertReleaseRecords({
    db: input.db,
    items,
    origin: 'backfill',
    state: 'in_flight',
    recordedAt: now,
    logger,
  });
  const recordIds = [...inserted.values()].flat();
  const kinds = (['radarr', 'sonarr'] as const).filter((kind) =>
    items.some((item) => item.drafts.some((d) => d.arrKind === kind)),
  );
  try {
    for (const arrKind of kinds) {
      report.reconciled.push(
        await reconcileReleaseBlock({ db: input.db, arr, arrKind, logger, now }),
      );
    }
  } catch (error) {
    await abandonReleaseRecords({ db: input.db, recordIds, at: now });
    for (const arrKind of kinds) {
      try {
        await reconcileReleaseBlock({ db: input.db, arr, arrKind, logger, now });
      } catch {
        // best effort: the upkeep's drift check removes an orphan term
      }
    }
    throw error;
  }
  await activateReleaseRecords({ db: input.db, recordIds, at: now });
  return report;
}

async function namesFor(
  db: DbClient,
  candidate: Candidate,
  events: ReadonlyArray<{ occurredAt: Date; payload: Record<string, unknown> }>,
  bucket: PostedNameBackfillClass,
): Promise<PostedRelease[] | 'unread'> {
  const seen = new Set<string>();
  const out: PostedRelease[] = [];
  const add = (posted: PostedRelease) => {
    if (seen.has(posted.name)) return;
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
  const legacy = await readLegacyReleaseNames(db, candidate.arrKind, candidate.externalId);
  if (legacy === 'truncated') return 'unread';
  for (const row of legacy) {
    // A file record is a name of the file. A library id token there is the rename and is not a term. A grab,
    // a failed download or an import keeps the name: it is termed, or counted when the grammar cannot write one.
    const name =
      row.recordKind === 'file' ? verifiedFileName(row.releaseName) : postedReleaseName(row.releaseName);
    if (!name) continue;
    add({
      name,
      releaseGroup: row.releaseGroup,
      quality: row.quality,
      indexer: null,
      source: 'legacy_arr',
      sizeBytes: row.sizeBytes,
    });
  }
  if (candidate.arrKind === 'radarr') {
    const nearSize = await readLegacyJobsForSize(db, candidate.sizeBytes);
    if (nearSize === 'truncated') return 'unread';
    const jobs = matchLegacySab(
      {
        title: candidate.title,
        year: candidate.year,
        deletedAt: candidate.deletedAt,
        deletedSizeBytes: candidate.sizeBytes,
      },
      nearSize,
    );
    for (const job of jobs) {
      const name = postedReleaseName(job.name);
      if (!name) continue;
      add({ name, releaseGroup: null, quality: null, indexer: null, source: 'legacy_sab', sizeBytes: job.bytes });
    }
  }
  return out;
}
