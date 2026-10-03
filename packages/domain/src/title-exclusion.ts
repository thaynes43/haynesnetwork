// ADR-097 / DESIGN-052 D-27 / D-28 — the TITLE EXCLUSION (T-274).
//
// The owner's ruling of 2026-10-03 ("Block automation only"): a title deleted through Trash must never be re-added by
// automation. Kometa and the *arrs' own import lists skip a title on the *arr's import-list exclusion list (Kometa's
// ArrAPI client respects it on every add), while a person's Seerr request still adds it (Seerr's `POST /movie` /
// `POST /series` is not checked against the list), and the ADR-093 Release Block still stops the exact deleted release.
// Maintainerr writes the exclusion on its own delete only while its rule pools carry `listExclusions` (since
// 2026-09-14); the app now writes it itself, BEFORE the delete, so it no longer depends on that setting.
//
// Single writer: `ensureTitleExclusions`, under `pg_advisory_xact_lock('title-exclusion:<kind>')`, in one transaction:
// read the *arr's exclusion list, `POST` each missing title (one append-only `trash_title_exclusions` row per POST the
// *arr acknowledges, with the id it returned), then read the list back as the gate for the delete. A title already
// excluded gets no write and no row (idempotent). A failure throws TitleExclusionError after the transaction commits
// the rows of the writes that landed, so every exclusion the app wrote keeps its row. It never deletes or edits an
// exclusion.
//
// `backfillTitleExclusions` (D-28) is the one-off for titles Trash deleted before the app wrote exclusions: every title
// the ledger records as deleted through Trash, except one the *arr has in its library now (a person may have
// requested it again; the owner keeps those) and one already excluded. `apply: false` is the dry run (reads only).
//
// Hard rule 4 (amended by ADR-097): the exclusion `POST` is the write-back, through `@hnet/arr/write` from this package.
import {
  trashBatchItems,
  trashBatches,
  trashTitleExclusions,
  type DbClient,
  type TitleExclusionArrKind,
  type TitleExclusionOrigin,
} from '@hnet/db';
import { ARR_CLUSTER_URL_DEFAULTS, ArrConfigError, type ArrImportListExclusion } from '@hnet/arr';
import { RadarrClient, SonarrClient } from '@hnet/arr/read';
import { RadarrWriteClient, SonarrWriteClient } from '@hnet/arr/write';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import { TitleExclusionError } from './errors';

export type { TitleExclusionArrKind, TitleExclusionOrigin };

/** The exclusion surface of Radarr and Sonarr. ArrClientBundle and the Release Block clients satisfy it structurally. */
export interface TitleExclusionArrClients {
  read: {
    radarr: Pick<RadarrClient, 'listImportListExclusions'>;
    sonarr: Pick<SonarrClient, 'listImportListExclusions'>;
  };
  write: {
    radarr: Pick<RadarrWriteClient, 'addImportListExclusion'>;
    sonarr: Pick<SonarrWriteClient, 'addImportListExclusion'>;
  };
}

/** The backfill also reads each *arr's library, to leave out the titles that are there now (D-28). */
export interface TitleExclusionBackfillArrClients extends TitleExclusionArrClients {
  read: {
    radarr: Pick<RadarrClient, 'listImportListExclusions' | 'listMovies'>;
    sonarr: Pick<SonarrClient, 'listImportListExclusions' | 'listSeries'>;
  };
}

/**
 * The backfill's clients from env: RADARR_URL / RADARR_API_KEY and SONARR_URL / SONARR_API_KEY only (the URLs default
 * in-cluster). Built here so `@hnet/arr/write` stays confined to packages/domain.
 */
export function titleExclusionArrClientsFromEnv(
  env: Record<string, string | undefined> = process.env,
): TitleExclusionBackfillArrClients {
  const missing: string[] = [];
  const options = (kind: TitleExclusionArrKind) => {
    const prefix = kind.toUpperCase();
    const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? '';
    if (!apiKey) missing.push(`${prefix}_API_KEY`);
    return { baseUrl: env[`${prefix}_URL`]?.trim() || ARR_CLUSTER_URL_DEFAULTS[kind], apiKey };
  };
  const radarr = options('radarr');
  const sonarr = options('sonarr');
  if (missing.length > 0) throw new ArrConfigError(missing);
  return {
    read: { radarr: new RadarrClient(radarr), sonarr: new SonarrClient(sonarr) },
    write: { radarr: new RadarrWriteClient(radarr), sonarr: new SonarrWriteClient(sonarr) },
  };
}

/** One title to exclude: the *arr's key (tmdb id on Radarr, tvdb id on Sonarr), its title and year, and the audit
 *  links. */
export interface TitleExclusionTarget {
  externalId: number;
  title: string;
  /** Radarr only (sent as 0 when unknown); Sonarr's exclusion has no year. */
  year: number | null;
  mediaItemId?: string | null;
  batchItemId?: string | null;
}

/** A target the writer accepts: a positive integer key and a non-blank title (Radarr and Sonarr refuse anything else). */
export function isTitleExclusionTarget(t: {
  externalId: number | null | undefined;
  title: string | null | undefined;
  year?: number | null;
}): t is TitleExclusionTarget {
  return (
    typeof t.externalId === 'number' &&
    Number.isInteger(t.externalId) &&
    t.externalId > 0 &&
    typeof t.title === 'string' &&
    t.title.trim().length > 0 &&
    (t.year === undefined || t.year === null || (Number.isInteger(t.year) && t.year >= 0))
  );
}

export interface TitleExclusionReport {
  arrKind: TitleExclusionArrKind;
  /** Distinct titles asked for. */
  requested: number;
  /** Already on the *arr's exclusion list: no write, no row. */
  alreadyExcluded: number;
  /** Written, read back and audited. */
  written: number;
}

const exclusionLockKey = (kind: TitleExclusionArrKind) => sql`hashtext(${`title-exclusion:${kind}`})`;

const keyOf = (kind: TitleExclusionArrKind, e: ArrImportListExclusion): number | null =>
  kind === 'radarr' ? e.tmdbId : e.tvdbId;

async function listExclusions(
  arr: TitleExclusionArrClients,
  kind: TitleExclusionArrKind,
): Promise<ArrImportListExclusion[]> {
  return kind === 'radarr'
    ? arr.read.radarr.listImportListExclusions()
    : arr.read.sonarr.listImportListExclusions();
}

/** One deduplicated target per key (the first kept). */
function distinctTargets(targets: readonly TitleExclusionTarget[]): TitleExclusionTarget[] {
  const seen = new Set<number>();
  return targets.filter((t) => (seen.has(t.externalId) ? false : (seen.add(t.externalId), true)));
}

/**
 * D-27 — `ensureTitleExclusions({ arrKind, targets })`, the single writer of the app's import-list exclusions on one
 * *arr, under `pg_advisory_xact_lock('title-exclusion:<kind>')`, in one transaction:
 *  1. every target must carry the *arr's key and a title (`validate`, before the transaction);
 *  2. `GET` the exclusion list (`read`); a title already on it is left alone;
 *  3. `POST` each missing title (`write`): Radarr `{tmdbId, movieTitle, movieYear}`, Sonarr `{tvdbId, title}`; each
 *     POST the *arr acknowledges gets its `trash_title_exclusions` row at once, with the exclusion id it returned;
 *  4. when anything was written, `GET` the list again: every target must be on it (`read_back`).
 * A failure throws TitleExclusionError AFTER the transaction commits, so the rows of the writes that landed stay (a
 * retry finds those titles excluded and writes nothing more for them). Idempotent: a second call writes nothing.
 */
export async function ensureTitleExclusions(input: {
  db?: DbClient;
  arr: TitleExclusionArrClients;
  arrKind: TitleExclusionArrKind;
  targets: readonly TitleExclusionTarget[];
  origin: TitleExclusionOrigin;
  logger?: DomainLogger;
}): Promise<TitleExclusionReport> {
  const { arrKind, origin } = input;
  const logger = input.logger ?? consoleDomainLogger;
  if (!input.targets.every((t) => isTitleExclusionTarget(t))) {
    logger.warn('[title-exclusion] failed', { arrKind, origin, step: 'validate' });
    throw new TitleExclusionError(arrKind, 'validate');
  }
  const targets = distinctTargets(input.targets);
  const report: TitleExclusionReport = {
    arrKind,
    requested: targets.length,
    alreadyExcluded: 0,
    written: 0,
  };
  if (targets.length === 0) return report;
  // A failure is carried out of the transaction rather than thrown inside it, so the audit rows of the POSTs the *arr
  // already acknowledged commit with it: an exclusion the app wrote is never left without its row (a retry would find
  // it on the list and count it `alreadyExcluded`, never auditing it).
  let failure: TitleExclusionError | null = null;
  try {
    await inTransaction(input.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${exclusionLockKey(arrKind)})`);

      // 2 — what the *arr already excludes.
      let before: ArrImportListExclusion[];
      try {
        before = await listExclusions(input.arr, arrKind);
      } catch (cause) {
        failure = new TitleExclusionError(arrKind, 'read', { cause });
        return;
      }
      const have = new Set(before.map((e) => keyOf(arrKind, e)));
      const missing = targets.filter((t) => !have.has(t.externalId));
      report.alreadyExcluded = targets.length - missing.length;
      if (missing.length === 0) return;

      // 3 — the writes, each audited as soon as the *arr acknowledges it (its 201 carries the exclusion id).
      for (const t of missing) {
        let created: ArrImportListExclusion;
        try {
          created =
            arrKind === 'radarr'
              ? await input.arr.write.radarr.addImportListExclusion({
                  tmdbId: t.externalId,
                  title: t.title.trim(),
                  year: t.year,
                })
              : await input.arr.write.sonarr.addImportListExclusion({
                  tvdbId: t.externalId,
                  title: t.title.trim(),
                });
        } catch (cause) {
          failure = new TitleExclusionError(arrKind, 'write', { cause });
          return;
        }
        await tx.insert(trashTitleExclusions).values({
          arrKind,
          tmdbId: arrKind === 'radarr' ? t.externalId : null,
          tvdbId: arrKind === 'sonarr' ? t.externalId : null,
          title: t.title.trim(),
          year: arrKind === 'radarr' ? t.year : null,
          arrExclusionId: created.id,
          origin,
          mediaItemId: t.mediaItemId ?? null,
          batchItemId: t.batchItemId ?? null,
        });
        report.written += 1;
        logger.info('[title-exclusion] excluded', { arrKind, origin, title: t.title.trim(), year: t.year });
      }

      // 4 — the read-back: the gate for the delete (every target on the list), not for the audit.
      let after: ArrImportListExclusion[];
      try {
        after = await listExclusions(input.arr, arrKind);
      } catch (cause) {
        failure = new TitleExclusionError(arrKind, 'read_back', { cause });
        return;
      }
      const listed = new Set(after.map((e) => keyOf(arrKind, e)));
      if (!targets.every((t) => listed.has(t.externalId))) {
        failure = new TitleExclusionError(arrKind, 'read_back');
      }
    });
  } catch (error) {
    // A database error: the transaction rolled back (an acknowledged write may be left without its row).
    logger.warn('[title-exclusion] failed', { arrKind, origin, step: 'database' });
    throw error;
  }
  if (failure !== null) {
    const err: TitleExclusionError = failure;
    logger.warn('[title-exclusion] failed', { arrKind, origin, step: err.step, written: report.written });
    throw err;
  }
  return report;
}

// ---------------------------------------------------------------------------
// D-28 — the one-off backfill
// ---------------------------------------------------------------------------

/** D-28 — how many titles one writer transaction takes (a failure keeps every earlier chunk's confirmed writes). */
export const TITLE_EXCLUSION_BACKFILL_CHUNK = 25;

export interface TitleExclusionBackfillTitle {
  kind: TitleExclusionArrKind;
  externalId: number | null;
  title: string;
  year: number | null;
}

export interface TitleExclusionBackfillKindReport {
  /** Distinct titles the ledger records as deleted through Trash (by tmdb id for movies, tvdb id for shows). */
  population: number;
  /** In the *arr's library now (re-added since): left out. */
  present: number;
  /** Already on the *arr's exclusion list. */
  alreadyExcluded: number;
  /** Deleted rows with no tmdb / tvdb id: cannot be excluded. */
  noKey: number;
  /** The rest: written by `--apply`, counted by the dry run. */
  toExclude: number;
  /** Written and read back (`--apply` only). */
  written: number;
  /** The step that stopped this *arr (`--apply` only), or null. */
  failed: string | null;
}

export interface TitleExclusionBackfillReport {
  apply: boolean;
  radarr: TitleExclusionBackfillKindReport;
  sonarr: TitleExclusionBackfillKindReport;
  /** The titles left out because the *arr has them now, by name (the owner decides their fate separately). */
  presentTitles: TitleExclusionBackfillTitle[];
  /** The titles that cannot be excluded (no tmdb / tvdb id on the deleted row). */
  noKeyTitles: TitleExclusionBackfillTitle[];
}

const emptyKindReport = (): TitleExclusionBackfillKindReport => ({
  population: 0,
  present: 0,
  alreadyExcluded: 0,
  noKey: 0,
  toExclude: 0,
  written: 0,
  failed: null,
});

/**
 * D-28 — backfill the Title Exclusion for every title Trash deleted. Population: every `trash_batch_items` row in state
 * `deleted`, one per title (the newest deletion names it; a movie by tmdb id, a show by tvdb id). Left out: a title the
 * *arr has in its library now (one `GET /movie` or `GET /series`, matched by that id), and one already excluded. Every
 * read happens before any write; a failed read throws and nothing is written. `apply: false` (the dry run) stops there.
 * `apply: true` writes the rest through `ensureTitleExclusions` (origin `backfill`), 25 titles per transaction; a failed
 * chunk stops that *arr (`failed` names the step) and keeps what earlier chunks wrote. Idempotent: a second run finds
 * every title excluded and writes nothing.
 */
export async function backfillTitleExclusions(input: {
  db?: DbClient;
  arr: TitleExclusionBackfillArrClients;
  apply: boolean;
  logger?: DomainLogger;
}): Promise<TitleExclusionBackfillReport> {
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
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatches.id, trashBatchItems.batchId))
    .where(and(eq(trashBatchItems.state, 'deleted'), isNotNull(trashBatchItems.deletedAt)));

  const report: TitleExclusionBackfillReport = {
    apply: input.apply,
    radarr: emptyKindReport(),
    sonarr: emptyKindReport(),
    presentTitles: [],
    noKeyTitles: [],
  };

  // One target per title: the newest deletion names it.
  const byKind: Record<TitleExclusionArrKind, Map<number, TitleExclusionTarget & { deletedAt: number }>> = {
    radarr: new Map(),
    sonarr: new Map(),
  };
  const noKeySeen = new Set<string>();
  for (const row of rows) {
    const kind: TitleExclusionArrKind = row.mediaKind === 'movie' ? 'radarr' : 'sonarr';
    const externalId = kind === 'radarr' ? row.tmdbId : row.tvdbId;
    const candidate = {
      externalId,
      title: row.title,
      year: row.year,
      mediaItemId: row.mediaItemId,
      batchItemId: row.id,
    };
    if (!isTitleExclusionTarget(candidate)) {
      const key = `${kind}|${row.title}|${row.year ?? ''}`;
      if (!noKeySeen.has(key)) {
        noKeySeen.add(key);
        report[kind].noKey += 1;
        report.noKeyTitles.push({ kind, externalId: externalId ?? null, title: row.title, year: row.year });
      }
      continue;
    }
    const at = (row.deletedAt as Date).getTime();
    const prev = byKind[kind].get(candidate.externalId);
    if (!prev || at > prev.deletedAt) byKind[kind].set(candidate.externalId, { ...candidate, deletedAt: at });
  }

  // Every read first: the library and the exclusion list of each *arr with a population.
  const todo: Record<TitleExclusionArrKind, TitleExclusionTarget[]> = { radarr: [], sonarr: [] };
  for (const kind of ['radarr', 'sonarr'] as const) {
    const titles = [...byKind[kind].values()];
    report[kind].population = titles.length;
    if (titles.length === 0) continue;
    const library =
      kind === 'radarr'
        ? (await input.arr.read.radarr.listMovies()).map((m) => m.tmdbId)
        : (await input.arr.read.sonarr.listSeries()).map((s) => s.tvdbId);
    const present = new Set(library.filter((id): id is number => typeof id === 'number' && id > 0));
    const excluded = new Set(
      (await listExclusions(input.arr, kind)).map((e) => keyOf(kind, e)).filter((id) => id !== null),
    );
    for (const t of titles.sort((a, b) => a.title.localeCompare(b.title))) {
      if (present.has(t.externalId)) {
        report[kind].present += 1;
        report.presentTitles.push({ kind, externalId: t.externalId, title: t.title, year: t.year });
      } else if (excluded.has(t.externalId)) {
        report[kind].alreadyExcluded += 1;
      } else {
        const { deletedAt: _deletedAt, ...target } = t;
        todo[kind].push(target);
      }
    }
    report[kind].toExclude = todo[kind].length;
  }

  logger.info('[title-exclusion] backfill', {
    apply: input.apply,
    radarr: { ...report.radarr },
    sonarr: { ...report.sonarr },
  });
  if (!input.apply) return report;

  for (const kind of ['radarr', 'sonarr'] as const) {
    for (let i = 0; i < todo[kind].length; i += TITLE_EXCLUSION_BACKFILL_CHUNK) {
      try {
        const done = await ensureTitleExclusions({
          db: input.db,
          arr: input.arr,
          arrKind: kind,
          targets: todo[kind].slice(i, i + TITLE_EXCLUSION_BACKFILL_CHUNK),
          origin: 'backfill',
          logger,
        });
        report[kind].written += done.written;
      } catch (error) {
        if (!(error instanceof TitleExclusionError)) throw error;
        report[kind].failed = error.step;
        break;
      }
    }
  }
  logger.info('[title-exclusion] backfill_done', {
    radarr: { written: report.radarr.written, failed: report.radarr.failed },
    sonarr: { written: report.sonarr.written, failed: report.sonarr.failed },
  });
  return report;
}
