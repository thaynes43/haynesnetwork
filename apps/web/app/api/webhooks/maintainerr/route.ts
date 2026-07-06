// ADR-023 / DESIGN-010 D-07 (addendum c) — the Maintainerr notification receiver. Maintainerr's
// Webhook notification agent POSTs deletion-lifecycle events here (target the IN-CLUSTER service,
// not the public URL — both are in-cluster, so no public exposure and it works before the R-64
// cutover). Session-UNAUTHENTICATED (Maintainerr can't hold a session) but SHARED-SECRET-REQUIRED:
// the request must carry MAINTAINERR_WEBHOOK_SECRET (via the `x-webhook-secret` header, an
// `Authorization: Bearer <secret>` header, OR a `?token=` query param — whichever Maintainerr's
// agent can send). Reject anything without it. The persisted event is the generic notification
// store (PLAN-009 Bulletin extends this); Trash's Activity tab reads source='maintainerr'.
import { recordNotification } from '@hnet/domain';

export const runtime = 'nodejs';

function providedSecret(req: Request, url: URL): string | null {
  const header = req.headers.get('x-webhook-secret');
  if (header) return header.trim();
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  const token = url.searchParams.get('token');
  return token ? token.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const expected = process.env.MAINTAINERR_WEBHOOK_SECRET?.trim();
  // Fail closed: without a configured secret the endpoint is disabled (never open).
  if (!expected) return new Response('webhook disabled', { status: 503 });
  const provided = providedSecret(req, url);
  if (!provided || provided !== expected) {
    return new Response('unauthorized', { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = asRecord(await req.json());
  } catch {
    return new Response('bad request', { status: 400 });
  }

  // Tolerant field mapping — Maintainerr's webhook body is a configurable JSON template; accept the
  // common Overseerr-style keys and fall back to sensible defaults. The full body is persisted.
  const type =
    str(payload['notification_type']) ?? str(payload['type']) ?? str(payload['event']) ?? 'event';
  const title =
    str(payload['subject']) ??
    str(payload['title']) ??
    str(asRecord(payload['media'])['title']) ??
    'Maintainerr notification';
  const body = str(payload['message']) ?? str(payload['body']) ?? '';

  const { id } = await recordNotification({
    source: 'maintainerr',
    type,
    title,
    body,
    payload,
  });
  return Response.json({ ok: true, id }, { status: 202 });
}
