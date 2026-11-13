// ADR-117 / DESIGN-052 D-29 — a posted release name as stored, and the size match D-15 used for a download
// history. No URL is ever accepted: a name containing "://" is not a release name (those strings carry keys).
import { parseReleaseName, releaseTokens } from './release-terms';

/** One completed or failed download job (name, bytes, completion). No URL, no storage path. */
export interface LegacySabJob {
  name: string;
  bytes: number;
  completedAt: Date;
}

/** D-15 — the deleted file is 90% to 100% of the download (par and container overhead). */
export const LEGACY_SAB_SIZE_MIN_RATIO = 0.9;

/**
 * A string that can be stored as a release name: not blank, and not a URL. Returned EXACTLY as stored, never
 * trimmed (D-29, review F3): Radarr and Sonarr test a term against the release title as it is, so a term must be
 * built from, and checked against, the stored name. A name with a leading space whose term starts `^title` does
 * not match and is not verified.
 */
export function postedReleaseName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (value.trim().length === 0 || value.includes('://')) return null;
  return value;
}

/**
 * D-15 — the download-history jobs matching one movie (title tokens, year ±1, completed before the
 * delete, size 90..100%). Movies only: a series is many downloads, so the size rule does not apply.
 * D-29: a match is evidence that a release was fetched, so it adds a term. It never names the file on disk
 * (the rule cannot tell two releases of one title, or two films of one name, apart).
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
