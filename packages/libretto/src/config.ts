// ADR-070 / DESIGN-043 (PLAN-052) — env contract for Libretto. The URL is non-secret config with an
// in-cluster service-DNS default (Libretto runs in ns `media`, port 8080 — the proven live surface). The
// API key is a SECRET (ExternalSecret in-cluster from the 1Password `libretto` item, .env.local in dev —
// hard rule 7) and is REQUIRED: there is no default and the value never appears in errors. The app talks
// to Libretto's REST API READ + the confined write surface only — it NEVER holds Libretto's own
// connection config (target/source keys live in Libretto's env; DESIGN-037 D-12).
import { LibrettoConfigError } from './errors';

/** In-cluster service DNS default (Libretto is ns `media`, API on :8080; DESIGN-037 D-14). */
export const LIBRETTO_CLUSTER_URL_DEFAULT = 'http://libretto.media.svc.cluster.local:8080';

export interface LibrettoEnvConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Read `LIBRETTO_URL` (defaulted) + `LIBRETTO_API_KEY` (required) from `env`. A missing key throws a
 * single LibrettoConfigError naming the absent variable — the value is never echoed.
 */
export function assertLibrettoEnv(
  env: Record<string, string | undefined> = process.env,
): LibrettoEnvConfig {
  const missing: string[] = [];
  const apiKey = env.LIBRETTO_API_KEY?.trim() ?? '';
  if (!apiKey) missing.push('LIBRETTO_API_KEY');
  if (missing.length > 0) throw new LibrettoConfigError(missing);
  return {
    baseUrl: (env.LIBRETTO_URL?.trim() || LIBRETTO_CLUSTER_URL_DEFAULT).replace(/\/+$/, ''),
    apiKey,
  };
}
