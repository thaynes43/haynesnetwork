// ADR-045 / DESIGN-023 — typed error taxonomy for the @hnet/openwebui GROUP client (the portal's OWUI
// group-management surface, distinct from the packages/sync read-only usage client). The API key travels
// ONLY in the Authorization: Bearer header, never in URLs/logs.

export class OwuiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class OwuiConfigError extends OwuiError {
  readonly code = 'OWUI_CONFIG_MISSING' as const;
  constructor(readonly missing: readonly string[]) {
    super(`missing required Open WebUI environment variables: ${missing.join(', ')}`);
  }
}

export class OwuiHttpError extends OwuiError {
  readonly code = 'OWUI_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(`${method} ${url} → HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`);
  }
}

export class OwuiNetworkError extends OwuiError {
  readonly code = 'OWUI_NETWORK_ERROR' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(`${method} ${url} → network request failed (host unreachable, refused, or DNS)`, options);
  }
}

export class OwuiTimeoutError extends OwuiError {
  readonly code = 'OWUI_TIMEOUT' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} ${url} → timed out after ${timeoutMs}ms`);
  }
}

export class OwuiParseError extends OwuiError {
  readonly code = 'OWUI_PARSE_ERROR' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly issues: readonly string[],
  ) {
    super(
      `${method} ${url} → response failed shape validation (upstream schema drift?): ` +
        issues.slice(0, 5).join('; '),
    );
  }
}
