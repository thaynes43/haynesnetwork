// ADR-045 / DESIGN-023 — the READ surface for @hnet/openwebui group management. Safe to import anywhere.
import { OwuiHttp, type OwuiHttpOptions } from './http';
import { owuiGroupListSchema, type OwuiGroup } from './schemas';

export interface OwuiClientOptions extends OwuiHttpOptions {
  /** e.g. http://open-webui.ai.svc.cluster.local (no trailing slash). */
  baseUrl: string;
}

export class OwuiGroupReadClient {
  private readonly http: OwuiHttp;
  private readonly baseUrl: string;

  constructor(options: OwuiClientOptions) {
    this.http = new OwuiHttp(options);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** All Open WebUI groups (id + name). */
  async listGroups(): Promise<OwuiGroup[]> {
    return this.http.requestJson('GET', `${this.baseUrl}/api/v1/groups/`, owuiGroupListSchema);
  }
}

export function owuiGroupReadClient(options: OwuiClientOptions): OwuiGroupReadClient {
  return new OwuiGroupReadClient(options);
}
