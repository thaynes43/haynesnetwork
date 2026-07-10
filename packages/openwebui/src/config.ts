// ADR-045 / DESIGN-023 — the @hnet/openwebui group client env contract. Reuses the SAME env var names as
// the PLAN-021 usage client (OPENWEBUI_URL default = in-cluster service DNS; OPENWEBUI_API_KEY required),
// so the app needs no new secret for the OWUI side. Env read at CALL TIME (tests inject a fake map).
import { OwuiConfigError } from './errors';

/** In-cluster default: the Open WebUI Service DNS (namespace `ai`). Overridable via OPENWEBUI_URL. */
export const OPENWEBUI_CLUSTER_URL_DEFAULT = 'http://open-webui.ai.svc.cluster.local';

export interface OwuiEnvConfig {
  baseUrl: string;
  apiKey: string;
}

export function assertOwuiEnv(env: Record<string, string | undefined> = process.env): OwuiEnvConfig {
  const baseUrl = env.OPENWEBUI_URL?.trim() || OPENWEBUI_CLUSTER_URL_DEFAULT;
  const apiKey = env.OPENWEBUI_API_KEY?.trim() ?? '';
  if (!apiKey) throw new OwuiConfigError(['OPENWEBUI_API_KEY']);
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}
