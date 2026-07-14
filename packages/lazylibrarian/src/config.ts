// ADR-055 / DESIGN-028 (PLAN-044) — env contract for LazyLibrarian.
// The URL is non-secret config with an in-cluster service-DNS default (LL runs in ns `downloads`, port
// 5299 — verified 2026-07-13). The API key is a SECRET (ExternalSecret in-cluster from the LazyLibrarian
// 1Password item, .env.local in dev — hard rule 7) and is REQUIRED: there is no default and the value
// never appears in errors. The app talks to LL's HTTP API READ + the confined write surface only — it
// NEVER writes LL provider config (Prowlarr fullSync owns it — OPS-013 / PLAN-044 hard constraint).
import { LazyLibrarianConfigError } from './errors';

/** In-cluster service DNS default (LL is ns `downloads`, container `app`, API on :5299). */
export const LAZYLIBRARIAN_CLUSTER_URL_DEFAULT = 'http://lazylibrarian.downloads.svc.cluster.local:5299';

export interface LazyLibrarianEnvConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Read `LAZYLIBRARIAN_URL` (defaulted) + `LAZYLIBRARIAN_API_KEY` (required) from `env`. A missing key
 * throws a single LazyLibrarianConfigError naming the absent variable — the value is never echoed.
 */
export function assertLazyLibrarianEnv(
  env: Record<string, string | undefined> = process.env,
): LazyLibrarianEnvConfig {
  const missing: string[] = [];
  const apiKey = env.LAZYLIBRARIAN_API_KEY?.trim() ?? '';
  if (!apiKey) missing.push('LAZYLIBRARIAN_API_KEY');
  if (missing.length > 0) throw new LazyLibrarianConfigError(missing);
  return {
    baseUrl: (env.LAZYLIBRARIAN_URL?.trim() || LAZYLIBRARIAN_CLUSTER_URL_DEFAULT).replace(/\/+$/, ''),
    apiKey,
  };
}
