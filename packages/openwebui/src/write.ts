// ADR-045 / DESIGN-023 — the Open WebUI group WRITE surface (`@hnet/openwebui/write`). Import-confined to
// packages/domain + packages/openwebui by the import-confinement guard test. OWUI deliberately does NOT
// auto-create groups from OIDC claims (creation stays OFF there), so the portal must PRE-CREATE the
// same-named group at synced-tier creation for the claim-sync to have a target. This client issues the
// single computed mutation it is given; the domain orchestrator decides idempotency (ensure-exists).
import { OwuiHttp } from './http';
import type { OwuiClientOptions } from './read';
import { owuiGroupSchema, type OwuiGroup } from './schemas';

export class OwuiWriteClient {
  private readonly http: OwuiHttp;
  private readonly baseUrl: string;

  constructor(options: OwuiClientOptions) {
    this.http = new OwuiHttp(options);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** Create an Open WebUI group. `POST /api/v1/groups/create` → the created group. */
  async createGroup(name: string, description = ''): Promise<OwuiGroup> {
    return this.http.requestJson('POST', `${this.baseUrl}/api/v1/groups/create`, owuiGroupSchema, {
      body: { name, description },
    });
  }
}

export function owuiWriteClient(options: OwuiClientOptions): OwuiWriteClient {
  return new OwuiWriteClient(options);
}
