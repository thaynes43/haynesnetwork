// ADR-023 / DESIGN-010 D-07 + ADR-026 / DESIGN-012 D-03 — the GENERIC secured webhook receiver.
// ONE parameterized handler for every notification source (`[source]` ∈ NOTIFICATION_SOURCES:
// maintainerr / seerr / tautulli). Each source POSTs the IN-CLUSTER service URL (not the public
// URL — no public exposure, works before the R-64 cutover). Session-UNAUTHENTICATED (the source
// services can't hold a session) but PER-SOURCE SHARED-SECRET-REQUIRED: the request must carry that
// source's secret (via the `x-webhook-secret` header, an `Authorization` header — raw or Bearer —,
// OR a `?token=` query param), matched constant-time against the source's env secret. The parsed +
// sanitized event is persisted through the @hnet/domain `recordNotification` single-writer (so the
// no-direct-state-writes guard passes); the Bulletin Feed + Trash Activity read it back.
import { recordNotification } from '@hnet/domain';
import {
  WEBHOOK_SECRET_ENV,
  WEBHOOK_SOURCES,
  parserForSource,
  readWebhookBodyCapped,
  secretsMatch,
  type WebhookSource,
} from '@/lib/webhook-sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Only INBOUND webhook sources are routable here — app-internal notification sources (e.g. 'trash')
// have no receiver, so a POST to their path 404s exactly like any other unknown source.
function isKnownSource(source: string): source is WebhookSource {
  return (WEBHOOK_SOURCES as readonly string[]).includes(source);
}

function providedSecret(req: Request, url: URL): string | null {
  const header = req.headers.get('x-webhook-secret');
  if (header) return header.trim();
  const auth = req.headers.get('authorization');
  if (auth) {
    // Overseerr sends its `authHeader` verbatim as Authorization; accept a raw value OR Bearer.
    return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : auth.trim();
  }
  const token = url.searchParams.get('token');
  return token ? token.trim() : null;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ source: string }> },
): Promise<Response> {
  const { source } = await ctx.params;
  if (!isKnownSource(source)) return new Response('unknown source', { status: 404 });

  const url = new URL(req.url);
  const expected = process.env[WEBHOOK_SECRET_ENV[source]]?.trim();
  // Fail closed: without a configured secret the source's endpoint is disabled (never open).
  if (!expected) return new Response('webhook disabled', { status: 503 });
  const provided = providedSecret(req, url);
  // Constant-time compare (never a timing-observable `===`); never echo the secret.
  if (!secretsMatch(provided, expected)) return new Response('unauthorized', { status: 401 });

  // Cap the body BEFORE buffering/parsing — the stream is read with a hard byte cap (never
  // accumulating more than the cap), so even a lying/chunked sender can't make us buffer
  // unbounded input.
  const rawText = await readWebhookBodyCapped(req);
  if (rawText === null) return new Response('payload too large', { status: 413 });

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return new Response('bad request', { status: 400 });
  }

  // Per-source parser: Zod-free validation to the known shape + strip arbitrary/proto keys + cap
  // stored strings. An unexpected shape is rejected, not stored.
  const parsed = parserForSource(source)(json);
  if (!parsed) return new Response('bad request', { status: 400 });

  const { id, deduped } = await recordNotification({ source, ...parsed });
  return Response.json({ ok: true, id, deduped }, { status: 202 });
}
