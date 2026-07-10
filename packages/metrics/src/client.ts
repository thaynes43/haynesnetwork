// ADR-037 C-07 / DESIGN-016 D-02 — the read-only Prometheus HTTP client for the Metrics section.
// It speaks ONLY `GET /api/v1/query` (instant vector) + `GET /api/v1/query_range` (range matrix) against
// the in-cluster Prometheus and zod-validates the two wire shapes it consumes. There is NO write surface
// at all, so (unlike the arr/plex mutating subpaths) this package needs no import-confinement.
//
// This is a SEPARATE, self-contained client from ADR-030's inline `packages/api/src/prometheus.ts`
// (range-only, storage-trend): that shipped vertical is left untouched. The small client-core overlap is
// a deliberate, documented duplication (ADR-037 C-07) — a future consolidation is deferred.
import { z } from 'zod';

/**
 * The in-cluster Prometheus query-API service, verified live 2026-07-10
 * (`kubectl -n observability get svc` → `kube-prometheus-stack-prometheus`). The code DEFAULTS to it so
 * the haynesnetwork helmrelease needs no new env line; `PROMETHEUS_URL` overrides it for the e2e/dev-local
 * stub or if the service ever moves.
 */
export const PROMETHEUS_DEFAULT_URL =
  'http://kube-prometheus-stack-prometheus.observability.svc.cluster.local:9090';

/** One instant-vector sample: the label set + a single `[unixSeconds, "value"]` pair. */
export const promVectorSampleSchema = z.object({
  metric: z.record(z.string(), z.string()),
  value: z.tuple([z.number(), z.string()]),
});
export type PromVectorSample = z.infer<typeof promVectorSampleSchema>;

/** The `GET /api/v1/query` success envelope, vector results only (the only shape the Overview asks for). */
export const promInstantResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('vector'),
    result: z.array(promVectorSampleSchema),
  }),
});

/** One matrix series: the label set + `[unixSeconds, "value"]` sample pairs. */
export const promMatrixSeriesSchema = z.object({
  metric: z.record(z.string(), z.string()),
  values: z.array(z.tuple([z.number(), z.string()])),
});
export type PromMatrixSeries = z.infer<typeof promMatrixSeriesSchema>;

/** The `GET /api/v1/query_range` success envelope, matrix results only. */
export const promRangeResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z.array(promMatrixSeriesSchema),
  }),
});

/** The read surface the Metrics reads use — the seam tests stub (like UtilizationArrBundle). */
export interface PrometheusReader {
  /** `GET /api/v1/query` — instant vector at eval time (or `atSec` if given). */
  query(promQL: string, atSec?: number): Promise<PromVectorSample[]>;
  /** `GET /api/v1/query_range` — start/end are unix SECONDS, step is seconds. */
  queryRange(
    promQL: string,
    startSec: number,
    endSec: number,
    stepSec: number,
  ): Promise<PromMatrixSeries[]>;
}

export interface PrometheusClientOptions {
  baseUrl: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). The Overview degrades on failure, so keep this short. */
  timeoutMs?: number;
}

/**
 * Build the thin read client. Throws plain Errors on HTTP/shape failures — the Overview reads catch ANY
 * failure into a per-tile `unavailable` degrade (never a crashed tab).
 */
export function createPrometheusClient(options: PrometheusClientOptions): PrometheusReader {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function getJson(path: string, params: URLSearchParams): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}?${params.toString()}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Prometheus ${path} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  return {
    async query(promQL, atSec) {
      const params = new URLSearchParams({ query: promQL });
      if (atSec !== undefined) params.set('time', String(atSec));
      const parsed = promInstantResponseSchema.safeParse(await getJson('/api/v1/query', params));
      if (!parsed.success) {
        throw new Error(`Prometheus query returned an unexpected shape: ${parsed.error.message}`);
      }
      return parsed.data.data.result;
    },

    async queryRange(promQL, startSec, endSec, stepSec) {
      const params = new URLSearchParams({
        query: promQL,
        start: String(startSec),
        end: String(endSec),
        step: String(stepSec),
      });
      const parsed = promRangeResponseSchema.safeParse(await getJson('/api/v1/query_range', params));
      if (!parsed.success) {
        throw new Error(
          `Prometheus query_range returned an unexpected shape: ${parsed.error.message}`,
        );
      }
      return parsed.data.data.result;
    },
  };
}

/** Env factory (production): `PROMETHEUS_URL` when set, else the in-cluster default. No secret. */
export function prometheusClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): PrometheusReader {
  return createPrometheusClient({ baseUrl: env.PROMETHEUS_URL ?? PROMETHEUS_DEFAULT_URL });
}
