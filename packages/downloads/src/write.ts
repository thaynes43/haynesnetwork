// @hnet/downloads/write — the WRITE surface (the MAM-governor gate seam). ADR-054: the ONLY sanctioned
// downloads-stack write is TOGGLING the MyAnonaMouse Prowlarr indexer's `enable` flag (pause the torrent
// fallback near the rank cap; resume when headroom returns). This entrypoint may be imported ONLY by
// packages/domain (the governor evaluator) — enforced by the arr-write-import-guard test, extended to cover
// `@hnet/downloads/write`. Exercised exclusively via fetch stubs in tests; never in @hnet/sync.
//
// Seam choice (ADR-054 C-01): Prowlarr's OWN indexer `enable` flag, NOT the LazyLibrarian provider toggle.
// Prowlarr owns LL's provider entries through its LazyLibrarian application (syncLevel=fullSync, verified
// live): a manual LL-side `enabled` edit is CLOBBERED by the next fullSync (it re-enabled a manually
// disabled provider within the hour), so the LL-side seam is NOT durable. Disabling the Prowlarr indexer,
// by contrast, TRIGGERS a fullSync that propagates `enabled=false` down to LL's Torznab_0 (verified live:
// within ~6s LL listNabProviders flips MAM Enabled 1→0 and config.ini drops the `enabled` line), so LL
// stops QUERYING the provider entirely — no failed Torznab searches, so LL's provider-failure blocklist is
// never tripped. Re-enabling propagates back cleanly. Single durable seam, blast radius = the MAM indexer.
//
// GET-then-PUT discipline (owner ruling 2026-07-11 (d)): the toggle GETs the FULL indexer object and PUTs
// it back with ONLY `enable` changed — it never rewrites priority/fields/categories (Prowlarr indexer
// priority is owner-tuned to 50 to pin usenet-first via the LL dlpriority = 51 − priority mapping).
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { DownloadsHttpError, DownloadsPathError } from './errors';
import { isDirectChildOf, nodeDownloadPathFs, type DownloadPathFs } from './paths';
import {
  ProwlarrReadClient,
  SabnzbdReadClient,
  type ProwlarrReadClientOptions,
  type SabnzbdReadClientOptions,
} from './read';

/** Prowlarr's PUT echoes the updated indexer; we only assert `enable` came back as requested. */
const prowlarrPutEchoSchema = z.object({ enable: z.boolean().optional() }).passthrough();

export type ProwlarrWriteClientOptions = ProwlarrReadClientOptions;

/**
 * The confined Prowlarr WRITE client. Its ONE method flips the MAM indexer's `enable` flag via a
 * GET-then-PUT of the full indexer object (`GET /api/v1/indexer/{id}` → set `enable` → `PUT
 * /api/v1/indexer/{id}`, verified live: PUT → HTTP 202). A non-2xx (or a non-boolean echo) throws so the
 * governor never records a gate change that did not actually take. Idempotent: PUTting the current value
 * back is a harmless no-op the evaluator avoids by reading first.
 */
export class ProwlarrWriteClient extends ProwlarrReadClient {
  constructor(options: ProwlarrWriteClientOptions) {
    super(options);
  }

  /** GET the indexer, set ONLY `enable`, PUT the full object back. */
  async setIndexerEnabled(indexerId: number, enabled: boolean): Promise<void> {
    const current = await this.getIndexer(indexerId);
    const body = { ...current, enable: enabled };
    const url = `${this.base}/api/v1/indexer/${indexerId}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'X-Api-Key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DownloadsHttpError(
        url,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok) throw new DownloadsHttpError(url, res.status);
    // Prowlarr PUT echoes the updated indexer; confirm the flag took (a 200/202 with the old value would
    // be a phantom success). An empty/near-empty body is tolerated (some builds 202 with no echo).
    const raw = await res.text();
    if (raw.trim() !== '') {
      const parsed = prowlarrPutEchoSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.enable !== undefined && parsed.data.enable !== enabled) {
        throw new DownloadsHttpError(
          url,
          res.status,
          `indexer enable did not take (wanted ${enabled}, got ${parsed.data.enable})`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ADR-095 / DESIGN-046 D-18 — the queue janitor's LazyLibrarian write-backs on the downloads stack. Confined to
// packages/domain like every @hnet/downloads/write export (the arr-write-import-guard test).
// ---------------------------------------------------------------------------

/** SAB's answer to a history delete: `{ status: true }` (it says true for an unknown id too). */
const sabStatusSchema = z.object({ status: z.boolean().optional() }).passthrough();

/**
 * The confined SABnzbd WRITE client. Its ONE method deletes a job from SABnzbd's history (`mode=history&name=delete
 * &value=<nzo_id>`), which SABnzbd archives (its default). That is the janitor's LazyLibrarian `bad_release`: once
 * SABnzbd no longer shows the job, LazyLibrarian reads the snatch as 0% and aborts it after its task age (Failed, the
 * format Wanted again). It never passes `del_files` and never touches a completed folder (SABnzbd 5.1.3 would only
 * remove the incomplete one anyway); the folder is the `leftover` class's business.
 */
export class SabnzbdWriteClient extends SabnzbdReadClient {
  constructor(options: SabnzbdReadClientOptions) {
    super(options);
  }

  async deleteHistoryJob(nzoId: string): Promise<void> {
    const id = nzoId.trim();
    if (id === '') throw new DownloadsHttpError(`${this.base}/api?mode=history&name=delete`, undefined, 'empty job id');
    const data = await this.getJson({ mode: 'history', name: 'delete', value: id }, sabStatusSchema);
    if (data.status === false) {
      throw new DownloadsHttpError(`${this.base}/api?mode=history&name=delete`, undefined, 'SABnzbd refused the delete');
    }
  }
}

/** The filesystem calls the cleaner makes: the probe's reads plus the recursive remove (injectable for tests). */
export interface DownloadFolderFs extends DownloadPathFs {
  rm(path: string, options: { recursive: true; force: false }): Promise<void>;
}

const nodeDownloadFolderFs: DownloadFolderFs = { ...nodeDownloadPathFs, rm };

/**
 * The confined delete behind the janitor's LazyLibrarian `leftover` class: remove ONE completed SABnzbd job folder.
 * It re-checks, immediately before the remove, that the folder is a direct child of the configured download root
 * (lexically and by real path), a real directory and not a symlink; anything else throws DownloadsPathError and
 * nothing is touched. The caller (packages/domain) has already confirmed every library copy the download recorded.
 * `rm` removes symlinks inside the folder as links, never their targets.
 */
export class DownloadFolderCleaner {
  private readonly fs: DownloadFolderFs;

  constructor(
    readonly downloadRoot: string,
    fs: DownloadFolderFs = nodeDownloadFolderFs,
  ) {
    this.fs = fs;
  }

  async removeFolder(path: string): Promise<void> {
    if (!isDirectChildOf(path, this.downloadRoot)) throw new DownloadsPathError(path, 'not a direct child of the root');
    const target = resolve(path);
    let st: Awaited<ReturnType<DownloadPathFs['lstat']>>;
    try {
      st = await this.fs.lstat(target);
    } catch {
      throw new DownloadsPathError(path, 'missing');
    }
    if (st.isSymbolicLink()) throw new DownloadsPathError(path, 'a symlink');
    if (!st.isDirectory()) throw new DownloadsPathError(path, 'not a directory');
    const [realTarget, realRoot] = await Promise.all([this.fs.realpath(target), this.fs.realpath(this.downloadRoot)]);
    if (dirname(realTarget) !== realRoot) throw new DownloadsPathError(path, 'resolves outside the root');
    await this.fs.rm(realTarget, { recursive: true, force: false });
  }
}
