// ADR-045 / DESIGN-023 — the Authentik group WRITE surface. This module (`@hnet/authentik/write`) may be
// imported ONLY by the packages/domain group orchestrator and by packages/authentik itself — enforced by
// the import-confinement guard test (packages/domain/__tests__/arr-write-import-guard.test.ts), exactly
// like @hnet/plex/write and @hnet/arr/write.
//
// This client does NO policy: the owned-groups guardrail (never touch a non-owned group), the
// exclusive-tier membership diff, and the audit-after are the DOMAIN orchestrator's job. This client
// issues the single computed mutation it is given (create a group / add-remove one membership).
import { AuthentikHttp } from './http';
import type { AuthentikClientOptions } from './read';
import { authentikGroupSchema, type AuthentikGroup } from './schemas';

export class AuthentikWriteClient {
  private readonly http: AuthentikHttp;
  private readonly baseUrl: string;

  constructor(options: AuthentikClientOptions) {
    this.http = new AuthentikHttp(options);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** Create an Authentik group by name. Returns the created group (pk + name). */
  async createGroup(name: string): Promise<AuthentikGroup> {
    return this.http.requestJson('POST', `${this.baseUrl}/api/v3/core/groups/`, authentikGroupSchema, {
      body: { name },
    });
  }

  /** Add a user (by pk) to a group (by pk). `POST /api/v3/core/groups/{group_pk}/add_user/`. */
  async addUserToGroup(groupPk: string, userPk: number): Promise<void> {
    await this.http.requestVoid(
      'POST',
      `${this.baseUrl}/api/v3/core/groups/${encodeURIComponent(groupPk)}/add_user/`,
      { body: { pk: userPk } },
    );
  }

  /** Remove a user (by pk) from a group (by pk). `POST /api/v3/core/groups/{group_pk}/remove_user/`. */
  async removeUserFromGroup(groupPk: string, userPk: number): Promise<void> {
    await this.http.requestVoid(
      'POST',
      `${this.baseUrl}/api/v3/core/groups/${encodeURIComponent(groupPk)}/remove_user/`,
      { body: { pk: userPk } },
    );
  }
}

export function authentikWriteClient(options: AuthentikClientOptions): AuthentikWriteClient {
  return new AuthentikWriteClient(options);
}
