// ADR-030 amendment (2026-07-09) / DESIGN-013 D-07 — a THIN, read-only Prometheus range client for
// the native free-space trend (`storage.trend`). Deliberately NOT part of @hnet/arr (whose /write
// subpath is import-confined to @hnet/domain — this client has no write surface at all): it speaks
// only `GET /api/v1/query_range` against the in-cluster Prometheus and zod-validates the matrix
// subset the trend consumes. Injection mirrors the *arr/Plex bundles: tests hand a stubbed reader
// via ctx; production builds one lazily from env (resolvePrometheusReader in trpc.ts).
import { z } from 'zod';

/**
 * The in-cluster Prometheus service (verified 2026-07-09 against the haynes-ops Grafana datasource:
 * `kubernetes/main/apps/observability/grafana/app/helmrelease.yaml` points at this same URL). The
 * code DEFAULTS to it so the haynesnetwork helmrelease needs no new env line; `PROMETHEUS_URL`
 * overrides it for local stacks (the e2e/dev-local stub) or if the service ever moves.
 */
export const PROMETHEUS_DEFAULT_URL =
  'http://prometheus-operated.observability.svc.cluster.local:9090';

/** One matrix series: the label set + `[unixSeconds, "value"]` sample pairs (Prometheus wire shape). */
export const promMatrixSeriesSchema = z.object({
  metric: z.record(z.string(), z.string()),
  values: z.array(z.tuple([z.number(), z.string()])),
});
export type PromMatrixSeries = z.infer<typeof promMatrixSeriesSchema>;

/** The `query_range` success envelope, matrix results only (the only shape the trend asks for). */
export const promRangeResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z.array(promMatrixSeriesSchema),
  }),
});

/** The minimal read surface the trend needs — the seam tests stub (like UtilizationArrBundle). */
export interface PrometheusRangeReader {
  /** `GET /api/v1/query_range` — start/end are unix SECONDS, step is seconds. */
  queryRange(query: string, startSec: number, endSec: number, stepSec: number): Promise<PromMatrixSeries[]>;
}

export interface PrometheusClientOptions {
  baseUrl: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). The trend degrades on failure, so keep this short. */
  timeoutMs?: number;
}

/** Build the thin range client. Throws plain Errors on HTTP/shape failures — getStorageTrend
 *  catches ANY failure into the `unavailable` degrade (never a crashed tab). */
export function createPrometheusClient(options: PrometheusClientOptions): PrometheusRangeReader {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async queryRange(query, startSec, endSec, stepSec) {
      const params = new URLSearchParams({
        query,
        start: String(startSec),
        end: String(endSec),
        step: String(stepSec),
      });
      const res = await fetchImpl(`${base}/api/v1/query_range?${params.toString()}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Prometheus query_range failed: HTTP ${res.status}`);
      }
      const parsed = promRangeResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(`Prometheus query_range returned an unexpected shape: ${parsed.error.message}`);
      }
      return parsed.data.data.result;
    },
  };
}

/** Env factory (production): `PROMETHEUS_URL` when set, else the in-cluster default. */
export function prometheusClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): PrometheusRangeReader {
  return createPrometheusClient({ baseUrl: env.PROMETHEUS_URL ?? PROMETHEUS_DEFAULT_URL });
}
