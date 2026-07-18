// ADR-072 / DESIGN-042 D-02 (PLAN-052 PR4b) — typed error taxonomy for the confined haynes-ops git-write
// client. Messages NEVER contain the write token: it travels only as the `Authorization: Bearer` header the
// http layer sets, and is never interpolated into an error string (the @hnet/libretto / @hnet/plex
// discipline). A caller that catches HaynesopsUnreachableError renders the honest degrade (the Movies/TV
// Collections surface stays up, `reachable: false`) — a network/timeout/5xx is unreachable, a 4xx is a real
// client error surfaced as-is.

/** Base class — lets callers `catch (e) { if (e instanceof HaynesopsError) … }`. */
export class HaynesopsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** assertHaynesopsEnv failed — names the missing variables, never their values. */
export class HaynesopsConfigError extends HaynesopsError {
  readonly code = 'HAYNESOPS_CONFIG_MISSING' as const;
  constructor(readonly missing: readonly string[]) {
    super(`missing required haynes-ops git-write environment variables: ${missing.join(', ')}`);
  }
}

/**
 * The GitHub API could not be reached (network refused/DNS/reset, a timeout, or a 5xx after retries). The
 * Movies/TV Collections surface degrades to its honest `reachable: false` state on this — it never crashes.
 */
export class HaynesopsUnreachableError extends HaynesopsError {
  readonly code = 'HAYNESOPS_UNREACHABLE' as const;
  constructor(
    readonly method: string,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(
      `haynes-ops ${method} ${path} → GitHub API unreachable (network, timeout, or 5xx after retries)`,
      options,
    );
  }
}

/**
 * A non-2xx client response (4xx) from the GitHub API — a real error the caller must see (a 401/403 is a
 * bad/insufficient token, a 404 a missing repo/branch, a 422 a validation failure). The status + a short
 * body excerpt ride along; the token never does.
 */
export class HaynesopsHttpError extends HaynesopsError {
  readonly code = 'HAYNESOPS_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly bodyExcerpt?: string,
  ) {
    super(`haynes-ops ${method} ${path} → HTTP ${status}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`);
  }
}

/**
 * The write client refused to AUTO-MERGE because a D-10 safety assertion failed AFTER the PR opened (e.g.
 * the PR diff touched a file outside the app-owned managed include). The PR is left OPEN for a human — the
 * app never force-merges past a tripped assertion.
 */
export class HaynesopsAutoMergeBlockedError extends HaynesopsError {
  readonly code = 'HAYNESOPS_AUTOMERGE_BLOCKED' as const;
  constructor(
    message: string,
    readonly prNumber: number,
    readonly prUrl: string,
  ) {
    super(message);
  }
}
