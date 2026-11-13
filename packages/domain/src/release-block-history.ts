// ADR-117 / DESIGN-052 D-29 — load the download client's history once per delete run, as name, bytes and
// completion only. A missing key or a failed read does not stop Trash: the caller continues without it,
// and a file with no other verified name still takes the renamed-file term.
import { DownloadsConfigError, assertSabnzbdEnv } from '@hnet/downloads';
import { SabnzbdReadClient } from '@hnet/downloads/read';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import { type LegacySabJob } from './release-block-names';

/** One page of the download history. `slotCount` is the page before names that carry a URL are dropped. */
export interface ReleaseDownloadHistoryPage {
  jobs: LegacySabJob[];
  slotCount: number;
}

export interface ReleaseDownloadHistorySource {
  listReleaseJobs(query: {
    archive: boolean;
    start: number;
    limit: number;
  }): Promise<ReleaseDownloadHistoryPage>;
}

/** Measured 2026-11-13: the live archive is 19,903 slots and the queue 41, 21 pages of 1,000. */
export const RELEASE_DOWNLOAD_HISTORY_PAGE_SIZE = 1000;
/** Forty pages per view (live, then archive) covers the measured history with room; a full last page is truncated. */
export const RELEASE_DOWNLOAD_HISTORY_MAX_PAGES = 40;

export async function loadReleaseDownloadHistory(
  source: ReleaseDownloadHistorySource,
): Promise<{ jobs: LegacySabJob[]; truncated: boolean }> {
  const jobs: LegacySabJob[] = [];
  let truncated = false;
  for (const archive of [false, true]) {
    let start = 0;
    for (let page = 0; page < RELEASE_DOWNLOAD_HISTORY_MAX_PAGES; page += 1) {
      const result = await source.listReleaseJobs({
        archive,
        start,
        limit: RELEASE_DOWNLOAD_HISTORY_PAGE_SIZE,
      });
      jobs.push(...result.jobs);
      if (result.slotCount < RELEASE_DOWNLOAD_HISTORY_PAGE_SIZE) break;
      start += result.slotCount;
      if (page === RELEASE_DOWNLOAD_HISTORY_MAX_PAGES - 1) truncated = true;
    }
  }
  return { jobs, truncated };
}

/**
 * Read both history views when `SABNZBD_API_KEY` is set. Returns undefined when the key is absent or the
 * read fails, and never logs a name, a URL or the key. The sweep and Expedite then proceed without it.
 */
export async function downloadHistoryFromEnv(
  env: Record<string, string | undefined> = process.env,
  logger: DomainLogger = consoleDomainLogger,
): Promise<readonly LegacySabJob[] | undefined> {
  let config: { baseUrl: string; apiKey: string };
  try {
    config = assertSabnzbdEnv(env);
  } catch (error) {
    if (error instanceof DownloadsConfigError) {
      logger.warn('[release-block] download_history_unavailable', { reason: 'no_key' });
      return undefined;
    }
    throw error;
  }
  try {
    const client = new SabnzbdReadClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      timeoutMs: 30_000,
    });
    const { jobs, truncated } = await loadReleaseDownloadHistory(client);
    if (truncated) {
      logger.warn('[release-block] download_history_truncated', { jobs: jobs.length });
    }
    return jobs;
  } catch (error) {
    logger.warn('[release-block] download_history_unavailable', {
      reason: error instanceof Error ? error.name : 'unavailable',
    });
    return undefined;
  }
}
