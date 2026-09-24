// ADR-091 / DESIGN-050 D-04 — `POST /oauth/register`, RFC 7591 dynamic client registration: open and
// unauthenticated (ChatGPT registers one client per connector), rate-limited to 10 per hour per client IP (D-10:
// 429 + Retry-After + `{"error":"rate_limited"}`). @hnet/domain `registerClient` validates and writes; the
// response is 201 with the client id (and a confidential client's secret, once) and `Cache-Control: no-store`.
import { registerClient } from '@hnet/domain';
import {
  clientIp,
  json,
  limitRequest,
  oauthErrorResponse,
  preflight,
  rateLimitedResponse,
  readJsonBody,
} from '@/lib/oauth/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** D-10: 10 registrations per hour per client IP. */
export const REGISTER_LIMIT = { windowSeconds: 3600, max: 10 } as const;

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req.headers);
  const limit = await limitRequest(
    'register',
    ip,
    REGISTER_LIMIT.windowSeconds,
    REGISTER_LIMIT.max,
  );
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterSeconds);
  try {
    const body = await readJsonBody(req);
    const client = await registerClient({ body, registeredIp: ip === 'unknown' ? null : ip });
    return json(client, { status: 201 });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export function OPTIONS(): Response {
  return preflight();
}
