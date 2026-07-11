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
