// ADR-023 / DESIGN-010 D-07 (addendum c) — the Maintainerr notification receiver. Maintainerr's
// Webhook notification agent POSTs deletion-lifecycle events here (target the IN-CLUSTER service,
// not the public URL — both are in-cluster, so no public exposure and it works before the R-64
// cutover). Session-UNAUTHENTICATED (Maintainerr can't hold a session) but SHARED-SECRET-REQUIRED:
// the request must carry MAINTAINERR_WEBHOOK_SECRET (via the `x-webhook-secret` header, an
// `Authorization: Bearer <secret>` header, OR a `?token=` query param — whichever Maintainerr's
// agent can send). Reject anything without it. The persisted event is the generic notification
// store (PLAN-009 Bulletin extends this); Trash's Activity tab reads source='maintainerr'.
import { recordNotification } from '@hnet/domain';
import {
  MAX_WEBHOOK_BODY_BYTES,
  parseMaintainerrWebhook,
  secretsMatch,
} from '@/lib/maintainerr-webhook';

export const runtime = 'nodejs';

function providedSecret(req: Request, url: URL): string | null {
  const header = req.headers.get('x-webhook-secret');
  if (header) return header.trim();
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  const token = url.searchParams.get('token');
  return token ? token.trim() : null;
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const expected = process.env.MAINTAINERR_WEBHOOK_SECRET?.trim();
  // Fail closed: without a configured secret the endpoint is disabled (never open).
  if (!expected) return new Response('webhook disabled', { status: 503 });
  const provided = providedSecret(req, url);
  // Constant-time compare (never a timing-observable `===`).
  if (!secretsMatch(provided, expected)) {
    return new Response('unauthorized', { status: 401 });
  }

  // Cap the body BEFORE parsing — an unauthenticated endpoint must not buffer/persist unbounded input.
  const rawText = await req.text();
  if (Buffer.byteLength(rawText, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    return new Response('payload too large', { status: 413 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return new Response('bad request', { status: 400 });
  }

  // Zod-validate to the known shape + strip arbitrary/proto keys + cap stored strings (never persist
  // unbounded caller JSON). An unexpected shape is rejected, not stored.
  const parsed = parseMaintainerrWebhook(json);
  if (!parsed) return new Response('bad request', { status: 400 });

  const { id } = await recordNotification({ source: 'maintainerr', ...parsed });
  return Response.json({ ok: true, id }, { status: 202 });
}
