// ADR-093 C-13 / C-21 / DESIGN-052 D-15 (PLAN-072 S8) — SEEDING THE RELEASE BLOCK for deletions made before it existed.
//
// Population: every `trash_batch_items` row in state `deleted`, except rows whose *arr record still exists (a live
// `media_items` row whose *arr item answers a GET: "deleted" overstates reality when a handle failed, and a term would
// block the current release of a title that is still there) and rows already recorded. Each row takes the first
// identity that exists:
//   1. the ledger: the latest `imported` event before `deleted_at` and its `grabbed` twin (`ledger_grab`);
//   2. `--legacy-sab`: a completed job of the two legacy HaynesTower SABnzbd histories matching the title tokens, a year
//      within ±1, a completion before `deleted_at` and the deleted file's size at 90..100 % of the download
//      (`legacy_sab`; every match becomes a record, so two groups of one size are both blocked). Movies only;
//   3. neither: unblockable (ADR-093 C-21), counted.
// `--manual` adds the remediation titles' names (origin `remediation`). Records are written `active` (the delete is
// confirmed), their 365 days counted from `deleted_at`, then each *arr's profile is reconciled and read back.
// A dry run writes nothing (it still GETs the *arr to confirm what is gone). The legacy SAB file never enters git.
import {
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
  type DbClient,
} from '@hnet/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import {
  identifyFromLedger,
  insertReleaseRecords,
  reconcileReleaseBlock,
  type KeyedDrafts,
  type ReleaseArrKind,
  type ReleaseBlockArrClients,
  type ReleaseBlockReconcileReport,
  type ReleaseRecordDraft,
} from './release-block';
import { deriveTerm, parseReleaseName, releaseTokens } from './release-terms';

/** One completed job of a legacy SABnzbd history (name, downloaded bytes, completion time). No URL, ever. */
export interface LegacySabJob {
  name: string;
  bytes: number;
  completedAt: Date;
}

/** One remediation title (D-15 `--manual`): its tmdb id and the release names to block. */
export interface ManualSeedEntry {
  tmdbId: number;
  title: string;
  year: number;
  releaseNames: string[];
}

/** The titles the dry run reports by name (D-15: only the legacy SAB can seed them). */
export const SEED_NAMED_TITLES = ['Silent Night', 'The Unholy Trinity'] as const;

/** D-15 — the size window: the deleted file is 90 % to 100 % of the download (par and container overhead). */
export const LEGACY_SAB_SIZE_MIN_RATIO = 0.9;

/**
 * Parse a legacy SAB export: one job per line, either JSON (`{"name","bytes","completed"}`, `completed` an ISO time or
 * epoch seconds) or tab-separated `name<TAB>bytes<TAB>completed`. Blank lines and `#` comments are skipped; a line that
 * does not parse throws (the file is the coordinator's, so a bad line is a mistake to see, not skip).
 */
export function parseLegacySabFile(text: string): LegacySabJob[] {
  const out: LegacySabJob[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    let name: unknown;
    let bytes: unknown;
    let completed: unknown;
    if (line.startsWith('{')) {
      const o = JSON.parse(line) as Record<string, unknown>;
      name = o.name;
      bytes = o.bytes;
      completed = o.completed ?? o.completedAt;
    } else {
      [name, bytes, completed] = line.split('\t');
    }
    const when =
      typeof completed === 'number' || /^\d+$/.test(String(completed))
        ? new Date(Number(completed) * 1000)
        : new Date(String(completed));
    const size = Number(bytes);
    if (
      typeof name !== 'string' ||
      name.trim() === '' ||
      !Number.isFinite(size) ||
      Number.isNaN(when.getTime())
    ) {
      throw new Error(`legacy SAB line ${i + 1} does not parse`);
    }
    if (/:\/\//.test(name))
      throw new Error(`legacy SAB line ${i + 1} carries a URL; export names only`);
    out.push({ name: name.trim(), bytes: size, completedAt: when });
  }
  return out;
}

/** Parse the `--manual` file: a JSON array of `{tmdbId, title, year, releaseNames}`. */
export function parseManualSeedFile(text: string): ManualSeedEntry[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error('manual seed file: expected a JSON array');
  return parsed.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const names = Array.isArray(o.releaseNames)
      ? o.releaseNames.filter((n): n is string => typeof n === 'string')
      : [];
    if (
      !Number.isInteger(o.tmdbId) ||
      typeof o.title !== 'string' ||
      !Number.isInteger(o.year) ||
      names.length === 0
    ) {
      throw new Error(`manual seed entry ${i + 1}: needs tmdbId, title, year and releaseNames`);
    }
    if (names.some((n) => /:\/\//.test(n)))
      throw new Error(`manual seed entry ${i + 1}: a release name is a URL`);
    return {
      tmdbId: o.tmdbId as number,
      title: o.title,
      year: o.year as number,
      releaseNames: names,
    };
  });
}

/** D-15 — the legacy SAB jobs matching one deleted movie (title tokens, year ±1, completed before, size 90..100 %). */
export function matchLegacySab(
  item: { title: string; year: number | null; deletedAt: Date; deletedSizeBytes: number | null },
  jobs: readonly LegacySabJob[],
): LegacySabJob[] {
  if (item.year === null || item.deletedSizeBytes === null || item.deletedSizeBytes <= 0) return [];
  const want = releaseTokens(item.title).join(' ');
  return jobs.filter((job) => {
    if (job.completedAt.getTime() >= item.deletedAt.getTime()) return false;
    const p = parseReleaseName(job.name, [item.year as number]);
    if (p.year === null || Math.abs(p.year - (item.year as number)) > 1) return false;
    if (p.titleTokens.join(' ') !== want) return false;
    const ratio = (item.deletedSizeBytes as number) / job.bytes;
    return ratio >= LEGACY_SAB_SIZE_MIN_RATIO && ratio <= 1;
  });
}

function legacyDraft(
  job: LegacySabJob,
  base: {
    arrItemId: number | null;
    mediaItemId: string | null;
    tmdbId: number | null;
    imdbId: string | null;
  },
  title: string,
  year: number,
): ReleaseRecordDraft | null {
  const p = parseReleaseName(job.name, [year]);
  const derived = deriveTerm({
    kind: 'movie',
    arrTitle: title,
    arrYears: [year],
    releaseNames: [job.name],
    renamedFileName: null,
    releaseGroup: p.group,
    resolution: p.resolution,
    remux: p.remux,
  });
  if (!derived) return null;
  return {
    arrKind: 'radarr',
    arrItemId: base.arrItemId,
    mediaItemId: base.mediaItemId,
    tmdbId: base.tmdbId,
    tvdbId: null,
    imdbId: base.imdbId,
    title,
    year,
    season: null,
    identitySource: 'legacy_sab',
    releaseTitle: job.name,
    releaseGroup: p.group,
    quality: null,
    resolution: p.resolution,
    sizeBytes: job.bytes,
    fileName: null,
    indexer: null,
    years: derived.years,
    term: derived.term,
    termConfidence: derived.confidence,
    shape: derived.shape,
  };
}

export interface ReleaseBlockSeedReport {
  apply: boolean;
  population: number;
  skippedPresent: number;
  skippedUnverified: number;
  skippedAlreadyRecorded: number;
  identified: { ledger: number; legacySab: number };
  manual: { entries: number; records: number; skipped: number };
  records: number;
  unblockable: { movies: number; series: number };
  named: Array<{
    title: string;
    batchRows: number;
    matchedBy: 'ledger' | 'legacy_sab' | 'manual' | null;
  }>;
  reconciled: ReleaseBlockReconcileReport[];
}

/**
 * D-15 — seed the Release Block. `apply: false` is the dry run (counts only). Returns per-source counts, the rows
 * skipped because their *arr record still exists, the named titles and what stays unblockable.
 */
export async function seedReleaseBlock(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients;
  apply: boolean;
  legacySab?: readonly LegacySabJob[];
  manual?: readonly ManualSeedEntry[];
  logger?: DomainLogger;
  now?: Date;
}): Promise<ReleaseBlockSeedReport> {
  const db = resolveDb(input.db);
  const logger = input.logger ?? consoleDomainLogger;
  const rows = await db
    .select({
      id: trashBatchItems.id,
      mediaKind: trashBatches.mediaKind,
      mediaItemId: trashBatchItems.mediaItemId,
      title: trashBatchItems.title,
      year: trashBatchItems.year,
      tmdbId: trashBatchItems.tmdbId,
      tvdbId: trashBatchItems.tvdbId,
      deletedAt: trashBatchItems.deletedAt,
      deletedSizeBytes: trashBatchItems.deletedSizeBytes,
      arrItemId: mediaItems.arrItemId,
      imdbId: mediaItems.imdbId,
      liveInLedger: mediaItems.deletedFromArrAt,
      ledgerKnown: mediaItems.id,
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatches.id, trashBatchItems.batchId))
    .leftJoin(mediaItems, eq(mediaItems.id, trashBatchItems.mediaItemId))
    .where(and(eq(trashBatchItems.state, 'deleted'), isNotNull(trashBatchItems.deletedAt)));
  const recorded = new Set(
    (
      await db
        .select({ batchItemId: trashDeletedReleases.batchItemId })
        .from(trashDeletedReleases)
        .where(
          and(
            isNotNull(trashDeletedReleases.batchItemId),
            inArray(trashDeletedReleases.state, ['in_flight', 'active', 'expired', 'pruned']),
          ),
        )
    ).map((r) => r.batchItemId as string),
  );

  const report: ReleaseBlockSeedReport = {
    apply: input.apply,
    population: rows.length,
    skippedPresent: 0,
    skippedUnverified: 0,
    skippedAlreadyRecorded: 0,
    identified: { ledger: 0, legacySab: 0 },
    manual: { entries: input.manual?.length ?? 0, records: 0, skipped: 0 },
    records: 0,
    unblockable: { movies: 0, series: 0 },
    named: SEED_NAMED_TITLES.map((title) => ({ title, batchRows: 0, matchedBy: null })),
    reconciled: [],
  };
  const namedOf = (title: string) =>
    report.named.find((n) => n.title.toLowerCase() === title.trim().toLowerCase()) ?? null;
  const items: KeyedDrafts[] = [];
  const deletedAtByKey = new Map<string, Date>();

  for (const row of rows) {
    const kind: ReleaseArrKind = row.mediaKind === 'movie' ? 'radarr' : 'sonarr';
    const deletedAt = row.deletedAt as Date;
    const named = namedOf(row.title);
    if (named) named.batchRows += 1;
    if (recorded.has(row.id)) {
      report.skippedAlreadyRecorded += 1;
      continue;
    }
    // Is the *arr record still there? A live ledger row is confirmed by a GET (fail closed on an unanswered GET).
    if (row.ledgerKnown !== null && row.liveInLedger === null && row.arrItemId !== null) {
      try {
        const present =
          kind === 'radarr'
            ? await input.arr.read.radarr.findMovie(row.arrItemId)
            : await input.arr.read.sonarr.findSeries(row.arrItemId);
        if (present !== null) {
          report.skippedPresent += 1;
          continue;
        }
      } catch {
        report.skippedUnverified += 1;
        continue;
      }
    }
    let drafts: ReleaseRecordDraft[] | null = null;
    let source: 'ledger' | 'legacy_sab' | null = null;
    if (row.mediaItemId !== null) {
      drafts = await identifyFromLedger({
        db: input.db,
        mediaItemId: row.mediaItemId,
        before: deletedAt,
      });
      if (drafts) source = 'ledger';
    }
    if (!drafts && kind === 'radarr' && input.legacySab && row.year !== null) {
      const jobs = matchLegacySab(
        { title: row.title, year: row.year, deletedAt, deletedSizeBytes: row.deletedSizeBytes },
        input.legacySab,
      );
      const built = jobs
        .map((job) =>
          legacyDraft(
            job,
            {
              arrItemId: row.arrItemId,
              mediaItemId: row.mediaItemId,
              tmdbId: row.tmdbId,
              imdbId: row.imdbId,
            },
            row.title,
            row.year as number,
          ),
        )
        .filter((d): d is ReleaseRecordDraft => d !== null);
      if (built.length > 0) {
        drafts = built;
        source = 'legacy_sab';
      }
    }
    if (!drafts || source === null) {
      if (kind === 'radarr') report.unblockable.movies += 1;
      else report.unblockable.series += 1;
      continue;
    }
    if (source === 'ledger') report.identified.ledger += 1;
    else report.identified.legacySab += 1;
    if (named && named.matchedBy === null) named.matchedBy = source;
    report.records += drafts.length;
    items.push({ key: row.id, drafts, batchItemId: row.id });
    deletedAtByKey.set(row.id, deletedAt);
  }

  // --manual: the remediation titles (Babygirl, Another Simple Favor, Terrifier), each release name its own record.
  const manualItems: KeyedDrafts[] = [];
  if (input.manual && input.manual.length > 0) {
    const existing = await db
      .select({ tmdbId: trashDeletedReleases.tmdbId, term: trashDeletedReleases.term })
      .from(trashDeletedReleases)
      .where(
        and(
          eq(trashDeletedReleases.origin, 'remediation'),
          inArray(trashDeletedReleases.state, ['in_flight', 'active']),
        ),
      );
    const have = new Set(existing.map((e) => `${e.tmdbId}|${e.term}`));
    for (const entry of input.manual) {
      const match = rows.find((r) => r.mediaKind === 'movie' && r.tmdbId === entry.tmdbId);
      const drafts: ReleaseRecordDraft[] = [];
      for (const name of entry.releaseNames) {
        const d = legacyDraft(
          { name, bytes: 0, completedAt: new Date(0) },
          {
            arrItemId: match?.arrItemId ?? null,
            mediaItemId: match?.mediaItemId ?? null,
            tmdbId: entry.tmdbId,
            imdbId: match?.imdbId ?? null,
          },
          entry.title,
          entry.year,
        );
        if (!d || have.has(`${entry.tmdbId}|${d.term}`)) {
          report.manual.skipped += 1;
          continue;
        }
        drafts.push({ ...d, sizeBytes: null });
      }
      if (drafts.length > 0) {
        const key = `manual:${entry.tmdbId}`;
        manualItems.push({ key, drafts });
        if (match?.deletedAt) deletedAtByKey.set(key, match.deletedAt);
        report.manual.records += drafts.length;
        const named = namedOf(entry.title);
        if (named && named.matchedBy === null) named.matchedBy = 'manual';
      }
    }
  }

  logger.info('[release-block] seed', {
    apply: input.apply,
    population: report.population,
    skippedPresent: report.skippedPresent,
    skippedUnverified: report.skippedUnverified,
    skippedAlreadyRecorded: report.skippedAlreadyRecorded,
    ledger: report.identified.ledger,
    legacySab: report.identified.legacySab,
    manual: report.manual.records,
    unblockable: report.unblockable,
  });
  if (!input.apply) return report;

  const now = input.now ?? new Date();
  if (items.length > 0) {
    await insertReleaseRecords({
      db: input.db,
      items,
      origin: 'backfill',
      state: 'active',
      recordedAt: now,
      expiresFrom: (key) => deletedAtByKey.get(key),
      logger,
    });
  }
  if (manualItems.length > 0) {
    await insertReleaseRecords({
      db: input.db,
      items: manualItems,
      origin: 'remediation',
      state: 'active',
      recordedAt: now,
      expiresFrom: (key) => deletedAtByKey.get(key),
      logger,
    });
  }
  const kinds = new Set(
    [...items, ...manualItems].flatMap((i) =>
      i.drafts.filter((d) => d.term !== null).map((d) => d.arrKind),
    ),
  );
  for (const kind of ['radarr', 'sonarr'] as const) {
    if (!kinds.has(kind)) continue;
    report.reconciled.push(
      await reconcileReleaseBlock({ db: input.db, arr: input.arr, arrKind: kind, logger, now }),
    );
  }
  return report;
}
