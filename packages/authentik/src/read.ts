// ADR-045 / DESIGN-023 — the READ surface for the Authentik directory (@hnet/authentik). Safe to import
// anywhere (no mutations). Pages the users + groups endpoints and normalizes them. The WRITE surface
// (group create / membership) lives in ./write and is import-confined to packages/domain.
import { AuthentikHttp, type AuthentikHttpOptions } from './http';
import {
  authentikUserSchema,
  paginatedGroupsSchema,
  paginatedUsersSchema,
  type AuthentikGroup,
  type AuthentikUser,
} from './schemas';

export interface AuthentikClientOptions extends AuthentikHttpOptions {
  /** e.g. http://authentik-server.network.svc.cluster.local (no trailing slash). */
  baseUrl: string;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 50; // safety bound (10k identities) — Authentik households are far smaller.

export class AuthentikReadClient {
  private readonly http: AuthentikHttp;
  private readonly baseUrl: string;

  constructor(options: AuthentikClientOptions) {
    this.http = new AuthentikHttp(options);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** Every Authentik identity, following pagination — INCLUDING external (Plex) + never-logged-in. */
  async listUsers(): Promise<AuthentikUser[]> {
    const all: AuthentikUser[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.http.requestJson(
        'GET',
        `${this.baseUrl}/api/v3/core/users/`,
        paginatedUsersSchema,
        { query: { page_size: PAGE_SIZE, page } },
      );
      all.push(...res.results);
      if (!res.pagination.next || res.results.length === 0) break;
    }
    return all;
  }

  /** Every Authentik group (name + pk). */
  async listGroups(): Promise<AuthentikGroup[]> {
    const all: AuthentikGroup[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.http.requestJson(
        'GET',
        `${this.baseUrl}/api/v3/core/groups/`,
        paginatedGroupsSchema,
        { query: { page_size: PAGE_SIZE, page, include_users: false } },
      );
      all.push(...res.results);
      if (!res.pagination.next || res.results.length === 0) break;
    }
    return all;
  }

  /** A single user by pk (used to re-read a subject after a membership write). */
  async getUser(pk: number): Promise<AuthentikUser> {
    // The detail endpoint returns a bare user object (no pagination envelope).
    return this.http.requestJson(
      'GET',
      `${this.baseUrl}/api/v3/core/users/${pk}/`,
      authentikUserSchema,
    );
  }

  /** Find a group by exact name (returns null if absent). */
  async findGroupByName(name: string): Promise<AuthentikGroup | null> {
    const res = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/api/v3/core/groups/`,
      paginatedGroupsSchema,
      { query: { name, include_users: false } },
    );
    const exact = res.results.find((g) => g.name === name);
    return exact ?? null;
  }
}

export function authentikReadClient(options: AuthentikClientOptions): AuthentikReadClient {
  return new AuthentikReadClient(options);
}
