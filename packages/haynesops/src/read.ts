// @hnet/haynesops/read — the READ surface for the haynes-ops GitOps repo (safe to import anywhere in the
// server; contains no mutation). It reads the app-owned Kometa managed include back (the recipe source of
// truth — DESIGN-042 D-01), lists the app's OWN open collection PRs (the "awaiting merge" state), and
// resolves a PR's required-check conclusion (the auto-merge gate). No write, no browser use.
import { HaynesopsHttp, type HaynesopsHttpOptions } from './http';
import { HAYNESOPS_BRANCH_PREFIX } from './config';

export interface HaynesopsClientOptions extends HaynesopsHttpOptions {
  repo: string;
  baseBranch: string;
}

/** A file's decoded text + its blob sha (the sha is required to UPDATE it via the contents API). */
export interface RepoFile {
  text: string;
  sha: string;
}

/** An open app-authored collection PR — the "awaiting merge" surface for the Movies/TV lists. */
export interface OpenManagedPr {
  number: number;
  title: string;
  url: string;
  headBranch: string;
  headSha: string;
}

/** The rolled-up conclusion of a ref's required checks (the `--validate-file` CI gate). */
export type ChecksConclusion = 'success' | 'failure' | 'pending' | 'none';

export class HaynesopsReadClient {
  protected readonly http: HaynesopsHttp;
  protected readonly repo: string;
  protected readonly baseBranch: string;

  constructor(options: HaynesopsClientOptions) {
    this.http = new HaynesopsHttp(options);
    this.repo = options.repo;
    this.baseBranch = options.baseBranch;
  }

  /**
   * `GET /repos/{repo}/contents/{path}?ref=` — the file's decoded text + blob sha, or null when the file
   * does not exist yet (the bootstrap case: the managed include has not been created). Base64-decodes the
   * contents API payload.
   */
  async getFile(path: string, ref?: string): Promise<RepoFile | null> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const raw = (await this.http.requestJson({
      method: 'GET',
      path: `/repos/${this.repo}/contents/${path}${q}`,
      allow404: true,
    })) as { content?: string; encoding?: string; sha?: string } | null;
    if (!raw || typeof raw.sha !== 'string') return null;
    const text =
      raw.encoding === 'base64' && typeof raw.content === 'string'
        ? Buffer.from(raw.content, 'base64').toString('utf8')
        : (raw.content ?? '');
    return { text, sha: raw.sha };
  }

  /**
   * `GET /repos/{repo}/contents/{dir}?ref=` on a DIRECTORY → the file basenames it holds (type `file`
   * only). Used to enumerate the estate's hand-authored Kometa config files (movies-*.yml / shows-*.yml)
   * so the overview can read + surgically edit them (owner ruling 2026-07-18). Returns [] when the dir is
   * absent (never throws on a missing path — the honest degrade).
   */
  async listDirectory(dir: string, ref?: string): Promise<string[]> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const raw = (await this.http.requestJson({
      method: 'GET',
      path: `/repos/${this.repo}/contents/${dir}${q}`,
      allow404: true,
    })) as Array<{ name?: string; type?: string }> | null;
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => e.type === 'file' && typeof e.name === 'string').map((e) => e.name!);
  }

  /**
   * The app's OWN open PRs (head branch under the `hnet-collections/` namespace) — the "awaiting merge"
   * rows. GitHub filters `pulls` by `head=owner:branch`; there is no prefix filter, so this lists open PRs
   * and keeps the ones whose head branch is in the app namespace.
   */
  async listOpenManagedPrs(): Promise<OpenManagedPr[]> {
    const owner = this.repo.split('/')[0];
    const raw = (await this.http.requestJson({
      method: 'GET',
      path: `/repos/${this.repo}/pulls?state=open&per_page=100`,
    })) as Array<{
      number: number;
      title: string;
      html_url: string;
      head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
    }>;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (p) =>
          p.head?.repo?.full_name === this.repo &&
          typeof p.head?.ref === 'string' &&
          p.head.ref.startsWith(`${HAYNESOPS_BRANCH_PREFIX}/`) &&
          owner !== undefined,
      )
      .map((p) => ({
        number: p.number,
        title: p.title,
        url: p.html_url,
        headBranch: p.head!.ref!,
        headSha: p.head?.sha ?? '',
      }));
  }

  /**
   * The conclusion of a ref's CHECK RUNS. With `requiredCheckName` (the norm — DESIGN-042 D-10 as-implemented
   * 2026-07-20) the roll-up is SCOPED to the ONE named validate gate; every sibling check on the head (the
   * full Flux Local matrix + Diff Scope) is IGNORED. Without a name it rolls up ALL checks (legacy behaviour).
   *
   * Why the scope matters: a haynes-ops PR head carries ~9 unrelated Flux Local runs; the validate gate was
   * green on the FIRST poll while the matrix was still in progress, so the unscoped roll-up returned `pending`
   * and the eligible add degraded to a human merge — a pure timing/scope false-negative (live 2026-07-20,
   * haynes-ops #2170/#2171). Scoping to the named gate removes that race.
   *
   * Returns: `success` when the (named) gate is complete + green; `failure` when it completed non-green;
   * `pending` when it is still queued/in-progress OR — with a name — has NOT reported yet (never `success`:
   * the workflow triggers on the managed-include PR, so it WILL report; the caller must not merge until it
   * does); `none` only when NO check at all has reported on the head.
   */
  async getChecksConclusion(
    ref: string,
    opts?: { requiredCheckName?: string },
  ): Promise<ChecksConclusion> {
    const raw = (await this.http.requestJson({
      method: 'GET',
      path: `/repos/${this.repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    })) as {
      total_count?: number;
      check_runs?: Array<{ name?: string; status?: string; conclusion?: string }>;
    } | null;
    const allRuns = raw?.check_runs ?? [];
    if (allRuns.length === 0) return 'none';
    const name = opts?.requiredCheckName?.trim();
    const runs = name ? allRuns.filter((r) => r.name === name) : allRuns;
    // The named gate has not reported yet — PENDING, never a merge (the safe default).
    if (name && runs.length === 0) return 'pending';
    let anyPending = false;
    let anyFailed = false;
    let anySucceeded = false;
    for (const run of runs) {
      if (run.status !== 'completed') {
        anyPending = true;
        continue;
      }
      const c = run.conclusion ?? '';
      if (c === 'success' || c === 'neutral' || c === 'skipped') anySucceeded = true;
      else anyFailed = true; // failure / cancelled / timed_out / action_required
    }
    if (anyFailed) return 'failure';
    if (anyPending) return 'pending';
    return anySucceeded ? 'success' : 'pending';
  }
}
