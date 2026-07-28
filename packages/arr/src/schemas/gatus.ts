// ADR-079 / DESIGN-004 D-25 — Gatus consumed-subset schemas (BC-03 ACL: only what the
// uptime badge reads enters the app). Wire shapes live-verified in-cluster 2026-07-28
// against Gatus v5.x (`gatus.observability.svc.cluster.local:80`).
import { z } from 'zod';

/**
 * `GET /api/v1/endpoints/{key}/uptimes/{window}` returns a PLAIN-TEXT float 0..1
 * (e.g. `0.999783`, Content-Type text/plain) — the one non-JSON body in this package.
 * Validated from the RAW text: empty/whitespace bodies must fail (Number('') is 0 —
 * a silent fake-perfect-downtime), as must NaN and out-of-range values.
 */
export const gatusUptimeTextSchema = z
  .string()
  .trim()
  .min(1)
  .transform((raw) => Number(raw))
  .pipe(z.number().min(0).max(1));

/**
 * `GET /api/v1/endpoints/{key}/statuses` — the endpoint status page. Current status is
 * `results[last].success`; at least one result is required (an endpoint with no history
 * yet cannot honestly report a status). The response's top-level `uptime` is `null` on
 * the live wire and is DELIBERATELY absent here — it must never be parsed for uptime
 * (the plain-text uptimes endpoints are the ratio source).
 */
export const gatusEndpointStatusSchema = z.object({
  results: z.array(z.object({ success: z.boolean() })).min(1),
});
export type GatusEndpointStatus = z.infer<typeof gatusEndpointStatusSchema>;
