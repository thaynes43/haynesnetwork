// @hnet/downloads — typed errors for the downloads-stack clients (qBittorrent + LazyLibrarian)
// the MAM compliance governor drives (ADR-054 / DESIGN-027, PLAN-039).

/**
 * A required env var for the governor clients was absent. Names every missing variable; NEVER
 * echoes a value (same discipline as @hnet/arr's ArrConfigError — CLAUDE.md hard rule 7).
 */
export class DownloadsConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Missing downloads-stack env: ${missing.join(', ')}`);
    this.name = 'DownloadsConfigError';
    this.missing = missing;
  }
}

/** A qBittorrent / LazyLibrarian HTTP request returned a non-2xx (or an unexpected wire shape). */
export class DownloadsHttpError extends Error {
  readonly status: number | undefined;
  readonly url: string;
  constructor(url: string, status: number | undefined, detail?: string) {
    super(
      `downloads request ${url} failed${status !== undefined ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'DownloadsHttpError';
    this.status = status;
    this.url = url;
  }
}

/**
 * ADR-095 / DESIGN-046 D-18 — a download-folder operation was refused before it touched anything: the path is not a
 * direct child of the configured download root, is a symlink, is not a directory, or the root itself is absent. The
 * message names the rule, never file contents.
 */
export class DownloadsPathError extends Error {
  readonly path: string;
  constructor(path: string, rule: string) {
    // The path stays on `.path`, out of the message: a folder name is a release name, and the message lands in the
    // janitor's `error` column (D-10: never a name).
    super(`download folder refused (${rule})`);
    this.name = 'DownloadsPathError';
    this.path = path;
  }
}
