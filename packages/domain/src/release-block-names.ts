// ADR-117 / DESIGN-052 D-29 — a verified posted release name, and the size match the 2026-09-28
// backfill used for a legacy download history. No URL is ever accepted: a name containing "://" is
// not a release name (those strings carry keys).
import { parseReleaseName, releaseTokens } from './release-terms';

/** One completed or failed download job (name, bytes, completion). No URL, no storage path. */
export interface LegacySabJob {
  name: string;
  bytes: number;
  completedAt: Date;
}

/** D-15 — the deleted file is 90% to 100% of the download (par and container overhead). */
export const LEGACY_SAB_SIZE_MIN_RATIO = 0.9;

/** A string that can be stored as a release name: non-empty, and not a URL. */
export function postedReleaseName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name.length === 0 || name.includes('://')) return null;
  return name;
}

/**
 * D-15 — the download-history jobs matching one movie (title tokens, year ±1, completed before the
 * delete, size 90..100%). Movies only: a series is many downloads, so the size rule does not apply.
 */
export function matchLegacySab(
  item: { title: string; year: number | null; deletedAt: Date; deletedSizeBytes: number | null },
  jobs: readonly LegacySabJob[],
): LegacySabJob[] {
  if (item.year === null || item.deletedSizeBytes === null || item.deletedSizeBytes <= 0) return [];
  const want = releaseTokens(item.title).join(' ');
  return jobs.filter((job) => {
    if (job.completedAt.getTime() >= item.deletedAt.getTime()) return false;
    const parsed = parseReleaseName(job.name, [item.year as number]);
    if (parsed.year === null || Math.abs(parsed.year - (item.year as number)) > 1) return false;
    if (parsed.titleTokens.join(' ') !== want) return false;
    const ratio = (item.deletedSizeBytes as number) / job.bytes;
    return ratio >= LEGACY_SAB_SIZE_MIN_RATIO && ratio <= 1;
  });
}
