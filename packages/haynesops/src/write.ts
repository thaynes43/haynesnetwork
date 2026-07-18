// @hnet/haynesops/write — the WRITE surface for the haynes-ops GitOps repo (ADR-072 / DESIGN-042 D-02/D-10).
// The ONLY sanctioned mutations: create an app-namespaced branch, commit the ONE app-owned Kometa managed
// include onto it, open a bot-authored PR, and — when the domain proves D-10's four auto-merge conditions —
// squash-merge it. A write is a config CHANGE (Flux-applied, realized by the next Kometa run), NEVER a live
// Plex mutation (mirror-only, ADR-064).
//
// This entrypoint may be imported ONLY by the packages/domain Kometa orchestrator and by packages/haynesops
// itself — enforced by the arr-write-import-guard test (extended for @hnet/haynesops/write). It is NEVER
// reached from the browser: every call rides a role-checked tRPC procedure → the @hnet/domain single-writer.
import { HaynesopsReadClient, type ChecksConclusion, type HaynesopsClientOptions } from './read';
import { HAYNESOPS_BRANCH_PREFIX } from './config';

/** The result of opening a collection PR. */
export interface OpenedPr {
  number: number;
  url: string;
  headBranch: string;
  headSha: string;
}

export interface CommitFilePrInput {
  /** Repo-relative path of the app-owned managed include (e.g. `.../config/hnet-managed-movies.yml`). */
  path: string;
  /** The full regenerated file content. */
  content: string;
  /** A stable slug appended to the branch namespace (`hnet-collections/<slug>`). */
  branchSlug: string;
  /** The PR title (bot-authored). */
  title: string;
  /** The PR body (the audit-trail prose — the collection + requester + auto-merge intent). */
  body: string;
}

export class HaynesopsWriteClient extends HaynesopsReadClient {
  constructor(options: HaynesopsClientOptions) {
    super(options);
  }

  /** `GET /git/ref/heads/{base}` → the base branch's tip sha (the new branch's start point). */
  private async baseSha(): Promise<string> {
    const raw = (await this.http.requestJson({
      method: 'GET',
      path: `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(this.baseBranch)}`,
    })) as { object?: { sha?: string } };
    const sha = raw?.object?.sha;
    if (typeof sha !== 'string') throw new Error('haynes-ops base branch has no tip sha');
    return sha;
  }

  /**
   * Regenerate the ONE managed include on a fresh app-namespaced branch and open a bot-authored PR. Reads
   * the file's current blob sha on the base branch so the contents API UPDATES it (or creates it when
   * absent). Returns the PR number/url + head sha (the ref the CI gate + auto-merge act on).
   */
  async openManagedFilePr(input: CommitFilePrInput): Promise<OpenedPr> {
    const branch = `${HAYNESOPS_BRANCH_PREFIX}/${input.branchSlug}`;
    const startSha = await this.baseSha();
    // Create the branch (idempotent-ish: a 422 "already exists" surfaces as HaynesopsHttpError to the
    // caller, who uses a unique slug per write so a collision is a real, visible error).
    await this.http.requestJson({
      method: 'POST',
      path: `/repos/${this.repo}/git/refs`,
      body: { ref: `refs/heads/${branch}`, sha: startSha },
    });
    // Commit the file onto the branch (create or update).
    const existing = await this.getFile(input.path, branch);
    await this.http.requestJson({
      method: 'PUT',
      path: `/repos/${this.repo}/contents/${input.path}`,
      body: {
        message: input.title,
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        branch,
        ...(existing ? { sha: existing.sha } : {}),
      },
    });
    // Open the PR.
    const pr = (await this.http.requestJson({
      method: 'POST',
      path: `/repos/${this.repo}/pulls`,
      body: { title: input.title, head: branch, base: this.baseBranch, body: input.body },
    })) as { number: number; html_url: string; head?: { sha?: string } };
    return { number: pr.number, url: pr.html_url, headBranch: branch, headSha: pr.head?.sha ?? '' };
  }

  /**
   * The repo-relative paths a PR changes — the D-10 "managed-file-only" safety assertion reads this and
   * ABORTS the auto-merge if the diff touches anything but the app-owned managed include.
   */
  async getPrFilePaths(prNumber: number): Promise<string[]> {
    const raw = (await this.http.requestJson({
      method: 'GET',
      path: `/repos/${this.repo}/pulls/${prNumber}/files?per_page=100`,
    })) as Array<{ filename?: string }>;
    return Array.isArray(raw) ? raw.map((f) => f.filename ?? '').filter((f) => f !== '') : [];
  }

  /**
   * Poll the head ref's required checks until they SETTLE (success/failure) or the bound elapses. Returns
   * the final conclusion; a `pending` return means the checks did not settle in time (the caller leaves the
   * PR for a human — it never force-merges a not-yet-green gate).
   */
  async waitForChecks(
    headSha: string,
    opts?: { attempts?: number; intervalMs?: number; sleepImpl?: (ms: number) => Promise<void> },
  ): Promise<ChecksConclusion> {
    const attempts = opts?.attempts ?? 20;
    const intervalMs = opts?.intervalMs ?? 6_000;
    const sleep = opts?.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: ChecksConclusion = 'none';
    for (let i = 0; i < attempts; i++) {
      last = await this.getChecksConclusion(headSha);
      if (last === 'success' || last === 'failure') return last;
      await sleep(intervalMs);
    }
    return last;
  }

  /** `PUT /pulls/{n}/merge` (squash) — the merged PR is the audit trail; a bad recipe is a `git revert`. */
  async squashMergePr(prNumber: number, commitTitle: string): Promise<void> {
    await this.http.requestJson({
      method: 'PUT',
      path: `/repos/${this.repo}/pulls/${prNumber}/merge`,
      body: { merge_method: 'squash', commit_title: commitTitle },
    });
  }
}
