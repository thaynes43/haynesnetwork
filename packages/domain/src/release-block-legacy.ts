// ADR-117 / DESIGN-052 D-29 — the Release Block's reads of the legacy tables (migration 0110): the release names
// the Radarr and Sonarr databases from before the 2026-07-03 move recorded for a title's own id, and the old
// SABnzbd jobs near a file's size. Read-only: the loader (legacy-release-load.ts) is the only writer.
import {
  legacyDownloadJobs,
  legacyReleaseNames,
  type DbClient,
  type LegacyReleaseRecordKind,
} from '@hnet/db';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { LEGACY_SAB_SIZE_MIN_RATIO, type LegacySabJob } from './release-block-names';

/** One name the old database held for a title. */
export interface LegacyReleaseName {
  recordKind: LegacyReleaseRecordKind;
  /** As stored, never trimmed. */
  releaseName: string;
  sizeBytes: number | null;
  releaseGroup: string | null;
  season: number | null;
  quality: string | null;
}

/**
 * More rows than this for one title and the read is `truncated`: the caller keeps the title, because a name it did
 * not read is a release it would not block. Measured 2026-11-13 by the coordinator on the extract: the pool's movies
 * carry 8 grabbed-or-failed names at most. No per-series figure was measured; the whole Sonarr extract is 245,298
 * history rows and 59,408 file rows over every series.
 */
export const LEGACY_NAMES_PER_TITLE_LIMIT = 20_000;

/** Every legacy row of one title (the TMDB id on Radarr, the TVDB id on Sonarr), or `truncated` past the limit. */
export async function readLegacyReleaseNames(
  db: DbClient | undefined,
  arrKind: 'radarr' | 'sonarr',
  externalId: number | null | undefined,
  limit: number = LEGACY_NAMES_PER_TITLE_LIMIT,
): Promise<LegacyReleaseName[] | 'truncated'> {
  if (typeof externalId !== 'number' || externalId <= 0) return [];
  const t = legacyReleaseNames;
  const rows = await resolveDb(db)
    .select({
      recordKind: t.recordKind,
      releaseName: t.releaseName,
      sizeBytes: t.sizeBytes,
      releaseGroup: t.releaseGroup,
      season: t.season,
      quality: t.quality,
    })
    .from(t)
    .where(and(eq(t.arrKind, arrKind), eq(t.externalId, externalId)))
    .orderBy(asc(t.occurredAt), asc(t.id))
    .limit(limit + 1);
  if (rows.length > limit) return 'truncated';
  return rows;
}

/**
 * The legacy `file` rows that name one file on disk: the same title id (the caller's read), the IDENTICAL byte size
 * (never a ratio) and an original release name. For a series the season must be the file's too. A size of 0 names
 * nothing.
 */
export function legacyNamesOfFile(
  legacy: readonly LegacyReleaseName[],
  file: { sizeBytes: number | null | undefined; season?: number | null },
): LegacyReleaseName[] {
  const size = file.sizeBytes;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return [];
  return legacy.filter(
    (l) =>
      l.recordKind === 'file' &&
      l.sizeBytes === size &&
      (file.season === undefined || file.season === null || l.season === file.season) &&
      l.releaseName.trim().length > 0,
  );
}

/**
 * At most this many old download jobs are read for one file's size window; past it the read is `truncated` and the
 * caller keeps the title. The two old histories hold 60,581 jobs in all (the coordinator's extract, 2026-11-13), so
 * no window can reach the bound on that data.
 */
export const LEGACY_JOBS_PER_SIZE_LIMIT = 100_000;

/**
 * The old download jobs whose size could hold a file of `sizeBytes` under D-15's rule (the file is 90% to 100% of
 * the download), for `matchLegacySab` to test by title and year. Secondary evidence only: a match adds a term and
 * never names the file (D-29).
 */
export async function readLegacyJobsForSize(
  db: DbClient | undefined,
  sizeBytes: number | null | undefined,
  limit: number = LEGACY_JOBS_PER_SIZE_LIMIT,
): Promise<LegacySabJob[] | 'truncated'> {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return [];
  const t = legacyDownloadJobs;
  const rows = await resolveDb(db)
    .select({ name: t.name, bytes: t.bytes, completedAt: t.completedAt })
    .from(t)
    .where(and(gte(t.bytes, sizeBytes), lte(t.bytes, Math.ceil(sizeBytes / LEGACY_SAB_SIZE_MIN_RATIO))))
    .orderBy(asc(t.completedAt), asc(t.id))
    .limit(limit + 1);
  if (rows.length > limit) return 'truncated';
  return rows;
}
