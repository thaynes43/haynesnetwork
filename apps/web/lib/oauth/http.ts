// ADR-091 / DESIGN-050 D-02 / D-04 / D-06 / D-10 — the small HTTP layer the OAuth route handlers share (ported from
// cigar-journal `apps/web/lib/oauth/http.ts`): CORS for the metadata / register / token / revoke routes (never
// `/mcp`), bounded form and JSON body reading, the RFC 6749 §5.2 error mapping, the D-10 rate limit with its 429,
// and the client IP (`CF-Connecting-IP` first).
import { consumeRateLimit } from '@hnet/domain';
import { OAuthError, authEvent, invalidClientMetadata, invalidRequest } from '@hnet/oauth';

/** D-02: CORS on the metadata, register, token and revoke routes only. */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, mcp-protocol-version',
};

/** Largest register / token / revoke body read (a real one is well under 1 KB). */
export const MAX_OAUTH_BODY_BYTES = 16 * 1024;

export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
}

/** A JSON response with CORS. Token responses are `no-store` (D-06); the metadata passes its public cache. */
export function json(
  body: unknown,
  init: { status?: number; cache?: string; headers?: Record<string, string> } = {},
): Response {
  const cache = init.cache ?? 'no-store';
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': cache,
      ...(cache === 'no-store' ? { pragma: 'no-cache' } : {}),
      ...CORS_HEADERS,
      ...init.headers,
    },
  });
}

/**
 * Map a thrown error onto the RFC 6749 §5.2 JSON body + status. A 401 for a client that tried HTTP Basic carries
 * `WWW-Authenticate: Basic` (RFC 6749 §5.2). Anything that is not an OAuthError is a server fault: logged
 * server-side, answered with a generic 500 — never the internals.
 */
export function oauthErrorResponse(
  error: unknown,
  opts: { basicChallenge?: boolean } = {},
): Response {
  if (error instanceof OAuthError) {
    return json(error.toBody(), {
      status: error.status,
      headers:
        error.status === 401 && opts.basicChallenge
          ? { 'www-authenticate': 'Basic realm="haynesnetwork"' }
          : {},
    });
  }
  console.error('[oauth] unexpected error', error instanceof Error ? error.message : String(error));
  return json({ error: 'server_error', error_description: 'Unexpected error' }, { status: 500 });
}

/** D-10: a rate-limited register / token request — 429, `Retry-After`, body `{"error":"rate_limited"}`. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return json(
    { error: 'rate_limited' },
    { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
  );
}

const IP_SHAPE = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * The client IP the D-10 limits key on: `CF-Connecting-IP` first (Cloudflare sets it at the edge and overwrites
 * any client value), then `X-Real-IP` (Traefik's connecting client — the closest a route handler gets to the
 * socket address), then the first `X-Forwarded-For` hop. The same order Better Auth's limiter uses. A value that
 * is not an IP literal is ignored, so a header cannot mint arbitrary bucket keys.
 */
export function clientIp(headers: Headers): string {
  const candidates = [
    headers.get('cf-connecting-ip'),
    headers.get('x-real-ip'),
    headers.get('x-forwarded-for')?.split(',')[0],
  ];
  for (const c of candidates) {
    const ip = c?.trim();
    if (ip && IP_SHAPE.test(ip)) return ip;
  }
  return 'unknown';
}

/**
 * What a D-10 bucket is keyed on: an IPv4 address as is (an IPv4-mapped IPv6 address as its IPv4), an IPv6
 * address by its /64 — one subscriber usually holds a whole /64, so per-address buckets would be free to dodge.
 * Anything unparseable stays as given (it already passed the IP-literal check).
 */
export function rateLimitSubject(ip: string): string {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const halves = ip.split('::');
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/** D-10 — count one request against `oauth:<route>|<subject>`; a refusal logs `rate_limited`. */
export async function limitRequest(
  route: 'register' | 'token' | 'authorize',
  ip: string,
  windowSeconds: number,
  max: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const decision = await consumeRateLimit({
    key: `oauth:${route}|${rateLimitSubject(ip)}`,
    windowSeconds,
    max,
  });
  if (!decision.allowed) authEvent('rate_limited', { route, ip, count: decision.count });
  return decision;
}

/** Read a request body with a hard byte cap; null = too large. */
async function readCapped(req: Request, cap: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const mediaType = (req: Request) =>
  (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();

/**
 * D-02 / D-06 — the token and revoke endpoints take `application/x-www-form-urlencoded` (RFC 6749 §4.1.3); a JSON
 * (or any other) body is a malformed request, `invalid_request` — never a 500.
 */
export async function readFormBody(req: Request): Promise<URLSearchParams> {
  if (mediaType(req) !== 'application/x-www-form-urlencoded') {
    throw invalidRequest('Request body must be application/x-www-form-urlencoded');
  }
  const raw = await readCapped(req, MAX_OAUTH_BODY_BYTES);
  if (raw === null) throw invalidRequest('Request body is too large');
  return new URLSearchParams(raw);
}

/** D-04 — registration takes a JSON object (RFC 7591 §3.1); anything else is `invalid_client_metadata`. */
export async function readJsonBody(req: Request): Promise<unknown> {
  if (mediaType(req) !== 'application/json')
    throw invalidClientMetadata('Request body must be JSON');
  const raw = await readCapped(req, MAX_OAUTH_BODY_BYTES);
  if (raw === null) throw invalidClientMetadata('Request body is too large');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalidClientMetadata('Request body must be JSON');
  }
}
