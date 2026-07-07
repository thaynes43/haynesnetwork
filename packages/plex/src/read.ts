// @hnet/plex/read — the READ surface (DESIGN-007 D-03 read/write split, mirroring
// @hnet/arr/read). Consumers: the registry refresh (`/library/sections`, `/identity`) and the
// share orchestrator's read-merge-write base (the plex.tv friend list + a user's current
// SharedServer). Nothing here mutates a Plex account; the write surface lives in
// `@hnet/plex/write` and is import-guarded to packages/domain.
import { PLEX_TV_BASE_URL } from './config';
import { PlexHttp } from './http';
import { childrenNamed, parseXml, type XmlElement } from './xml';
import { PlexParseError } from './errors';
import {
  identitySchema,
  librarySectionsSchema,
  plexAccountSchema,
  plexFriendSchema,
  plexServerSectionSchema,
  sharedServerSchema,
  type PlexAccount,
  type PlexFriend,
  type PlexIdentity,
  type PlexLibrarySection,
  type PlexServerSection,
  type PlexSharedServer,
} from './schemas';

export interface PlexClientOptions {
  /** Direct PMS base URL — registry reads (`/library/sections`, `/identity`). */
  baseUrl: string;
  /** The server's owner X-Plex-Token (secret; header-only). */
  token: string;
  /** The Plex server GUID the plex.tv sharing API keys on. */
  machineIdentifier: string;
  /** plex.tv host for the sharing API. Defaults to PLEX_TV_BASE_URL. */
  plexTvBaseUrl?: string;
  clientIdentifier?: string;
  product?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Injectable fetch for fixture/stub-driven tests (ADR-010: no live-API tests in CI). */
  fetchImpl?: typeof fetch;
}

const xmlBool = (v: string | undefined): boolean => v === '1' || v === 'true';

function attr(el: XmlElement, name: string): string | undefined {
  return el.attrs[name];
}

export class PlexReadClient {
  protected readonly http: PlexHttp;
  protected readonly baseUrl: string;
  protected readonly plexTvBaseUrl: string;
  readonly machineIdentifier: string;
  /** Cache for `getOwnerAccount` — the owner is stable for the client's lifetime. */
  private ownerAccount?: PlexAccount;

  constructor(options: PlexClientOptions) {
    this.http = new PlexHttp(options);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.plexTvBaseUrl = (options.plexTvBaseUrl ?? PLEX_TV_BASE_URL).replace(/\/+$/, '');
    this.machineIdentifier = options.machineIdentifier;
  }

  // ---- PMS reads (registry refresh) ----

  /** `GET /identity` — the server GUID + version. */
  async getIdentity(): Promise<{ machineIdentifier: string; version: string | null }> {
    const body: PlexIdentity = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/identity`,
      identitySchema,
    );
    return {
      machineIdentifier: body.MediaContainer.machineIdentifier,
      version: body.MediaContainer.version ?? null,
    };
  }

  /** `GET /library/sections` — the server's libraries (registry upsert source). */
  async listSections(): Promise<PlexLibrarySection[]> {
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/sections`,
      librarySectionsSchema,
    );
    return body.MediaContainer.Directory;
  }

  // ---- plex.tv account read (owner identity) ----

  /**
   * `GET /api/v2/user` (JSON) — the account the owner token authenticates as (the server OWNER).
   * The owner is NEVER in their own friend list (`/api/users` lists friends only), so
   * owner-vs-friend must be resolved here, not via `findFriendByEmail` (ADR-029). Cached per
   * client (the owner account is stable for the client's lifetime). Throws the usual typed
   * PlexError on failure — callers that want to degrade (plex.myLibraries) catch it.
   */
  async getOwnerAccount(): Promise<PlexAccount> {
    if (this.ownerAccount) return this.ownerAccount;
    const account = await this.http.requestJson(
      'GET',
      `${this.plexTvBaseUrl}/api/v2/user`,
      plexAccountSchema,
    );
    this.ownerAccount = account;
    return account;
  }

  /** The server owner's plex.tv account email, trimmed + lowercased — or null if it has none. */
  async getOwnerEmail(): Promise<string | null> {
    const email = (await this.getOwnerAccount()).email?.trim().toLowerCase();
    return email ? email : null;
  }

  // ---- plex.tv v1 sharing reads (share orchestration base) ----

  /** `GET /api/users` — the account's friend list (maps app user → Plex account by email). */
  async listFriends(): Promise<PlexFriend[]> {
    const root = await this.http.requestXml('GET', `${this.plexTvBaseUrl}/api/users`);
    return childrenNamed(root, 'User').map((u) =>
      plexFriendSchema.parse({
        id: attr(u, 'id') ?? '',
        email: attr(u, 'email') ?? null,
        username: attr(u, 'username') ?? null,
        title: attr(u, 'title') ?? null,
      }),
    );
  }

  /** Case-insensitive email match against the friend list (ADR-017 D-01 user→account map). */
  async findFriendByEmail(email: string): Promise<PlexFriend | null> {
    const needle = email.trim().toLowerCase();
    if (!needle) return null;
    const friends = await this.listFriends();
    return friends.find((f) => (f.email ?? '').toLowerCase() === needle) ?? null;
  }

  /**
   * `GET /api/servers/{machineId}` — the section-id map: each `<Section>` carries both the
   * server section `key` (our registry identity) and the plex.tv `id` the share body uses.
   */
  async listServerSections(): Promise<PlexServerSection[]> {
    const root = await this.http.requestXml(
      'GET',
      `${this.plexTvBaseUrl}/api/servers/${this.machineIdentifier}`,
    );
    const server = childrenNamed(root, 'Server')[0];
    if (!server) {
      throw new PlexParseError('GET', `${this.plexTvBaseUrl}/api/servers/${this.machineIdentifier}`, [
        'no <Server> element in /api/servers response',
      ]);
    }
    return childrenNamed(server, 'Section').map((s) =>
      plexServerSectionSchema.parse({
        id: attr(s, 'id') ?? '',
        key: attr(s, 'key') ?? '',
        title: attr(s, 'title') ?? '',
        type: attr(s, 'type') ?? '',
      }),
    );
  }

  /** `GET /api/servers/{machineId}/shared_servers` — every friend the server is shared with. */
  async listSharedServers(): Promise<PlexSharedServer[]> {
    const root = await this.http.requestXml(
      'GET',
      `${this.plexTvBaseUrl}/api/servers/${this.machineIdentifier}/shared_servers`,
    );
    return childrenNamed(root, 'SharedServer').map((ss) =>
      sharedServerSchema.parse({
        id: attr(ss, 'id') ?? '',
        userID: attr(ss, 'userID') ?? null,
        email: attr(ss, 'email') ?? null,
        username: attr(ss, 'username') ?? null,
        allLibraries: xmlBool(attr(ss, 'allLibraries')),
        sections: childrenNamed(ss, 'Section').map((sec) => ({
          id: attr(sec, 'id') ?? '',
          key: attr(sec, 'key') ?? '',
          shared: xmlBool(attr(sec, 'shared')),
        })),
      }),
    );
  }

  /** The SharedServer for a Plex user id, or null when the server isn't shared with them yet. */
  async findSharedServerForUser(plexUserId: string): Promise<PlexSharedServer | null> {
    const all = await this.listSharedServers();
    return all.find((ss) => ss.userID === plexUserId) ?? null;
  }
}

export function plexReadClient(options: PlexClientOptions): PlexReadClient {
  return new PlexReadClient(options);
}

export { parseXml };
export type { PlexAccount, PlexFriend, PlexServerSection, PlexSharedServer, PlexLibrarySection };
