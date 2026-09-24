// ADR-087 / DESIGN-049 D-03 — consumer auth. A machine consumer presents `Authorization: Bearer <token>`,
// compared as SHA-256 digests with `timingSafeEqual` (the webhook-secret pattern). Missing or wrong ⇒ 401
// with `WWW-Authenticate: Bearer`; no consumer token configured ⇒ 503 (like an unconfigured webhook source).
// Consumers and their scopes are CONFIG: a second consumer (say, read-only) is one more entry below, not a
// code change. Never a login method (hard rule 5).
import { createHash, timingSafeEqual } from 'node:crypto';

export type WatchScope = 'watch:read' | 'watch:write';

/**
 * Who is calling, once authenticated. Two sources share everything after authentication (ADR-091 C-09): the
 * configured hop consumers (below) and a delegated OAuth token (`authenticateOAuth`, `./oauth.ts`).
 */
export interface McpConsumer {
  /** Logged as `consumer`, recorded on marks as `watch_marks.consumer` (`hop`, `oauth:<client_id>`). */
  name: string;
  scopes: readonly WatchScope[];
  /**
   * The principal. Absent: the Server Owner (the hop, ADR-087 / DESIGN-049 D-03). Present (a delegated OAuth
   * token, ADR-091 C-04): that app user, acting as their OWN tracked Plex account (D-07).
   */
  userId?: string;
}

/** A configured machine consumer: a bearer token from the environment, acting as the Server Owner. */
export interface HopConsumer extends McpConsumer {
  /** The env var holding its bearer token. */
  tokenEnv: string;
}

/** v1: one consumer, the hop (T-252), acting as the Server Owner with both watch scopes. */
export const MCP_CONSUMERS: readonly HopConsumer[] = [
  { name: 'hop', tokenEnv: 'HNET_MCP_HOP_TOKEN', scopes: ['watch:read', 'watch:write'] },
];

export type AuthResult =
  | {
      ok: true;
      consumer: McpConsumer;
      /**
       * The answer to a `tools/call` of a known tool outside the consumer's scopes, when this source answers it at
       * the HTTP layer (the OAuth consumer's 403 `insufficient_scope`, D-07). Absent (the hop): the tool is simply
       * not registered for the connection, as before.
       */
      insufficientScope?: (required: WatchScope) => Response;
    }
  | { ok: false; response: Response };

const digest = (s: string) => createHash('sha256').update(s).digest();

/** A JSON-RPC-shaped error body with an HTTP status (MCP clients read the status). */
export function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Authenticate a request against the configured consumers. Every configured token is compared (constant
 * time, no early exit), so timing never tells which consumer — or whether any — nearly matched.
 */
export function authenticate(
  req: Request,
  env: Record<string, string | undefined> = process.env,
  consumers: readonly HopConsumer[] = MCP_CONSUMERS,
): AuthResult {
  const configured = consumers.flatMap((c) => {
    const token = env[c.tokenEnv]?.trim();
    return token ? [{ consumer: c, expected: digest(token) }] : [];
  });
  if (configured.length === 0) {
    return { ok: false, response: jsonRpcError(503, -32000, 'MCP is not configured') };
  }
  const header = req.headers.get('authorization') ?? '';
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  const provided = m?.[1]?.trim() ?? '';
  let match: McpConsumer | null = null;
  const presented = digest(provided);
  for (const c of configured) {
    const equal = timingSafeEqual(presented, c.expected);
    if (equal && provided.length > 0 && match === null) match = c.consumer;
  }
  if (!match) {
    return {
      ok: false,
      response: jsonRpcError(401, -32001, 'Unauthorized', { 'www-authenticate': 'Bearer' }),
    };
  }
  return { ok: true, consumer: match };
}
