// ADR-045 / DESIGN-023 — the Authentik client env contract. The base URL is non-secret config with an
// in-cluster default; the API TOKEN is required with no default (a service-account app-password created
// out-of-band and delivered as the cluster-created `haynesnetwork-authentik-token` secret — OPS-011).
// Env is read at CALL TIME (a parameter defaulting to process.env) so tests inject a fake env map.
import { AuthentikConfigError } from './errors';

/**
 * In-cluster default: the Authentik server Service DNS (namespace `network`, port 80). Overridable via
 * AUTHENTIK_URL. Reaching Authentik in-cluster BYPASSES the Cloudflare edge, so the Cloudflare UA-1010
 * ban on Python's default UA (OPS-001/009) does not apply here — but the client still sends an explicit
 * `User-Agent: curl/8.5.0` so a fallback to the public `authentik.haynesnetwork.com` host also works.
 */
export const AUTHENTIK_CLUSTER_URL_DEFAULT = 'http://authentik-server.network.svc.cluster.local';

export interface AuthentikEnvConfig {
  baseUrl: string;
  token: string;
}

export function assertAuthentikEnv(
  env: Record<string, string | undefined> = process.env,
): AuthentikEnvConfig {
  const baseUrl = env.AUTHENTIK_URL?.trim() || AUTHENTIK_CLUSTER_URL_DEFAULT;
  const token = env.AUTHENTIK_API_TOKEN?.trim() ?? '';
  if (!token) throw new AuthentikConfigError(['AUTHENTIK_API_TOKEN']);
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}
