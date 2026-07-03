// Liveness/readiness endpoint for the k8s probes (ADR-006 helmrelease).
// Deliberately process-only — no DB round trip. A Postgres blip must not make
// the kubelet restart-loop the app; CNPG owns database health, and the app's
// pages surface DB errors on their own.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}
