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
  metadataContainerSchema,
  plexServerSectionSchema,
  sectionContentsSchema,
  sharedServerSchema,
  type PlexAccount,
  type PlexFriend,
  type PlexIdentity,
  type PlexLibrarySection,
  type PlexSectionItem,
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

  /**
   * ADR-038 / DESIGN-017 (PLAN-022) — `GET /library/sections/{key}/all`: the section's top-level items
   * (the shows of a TV-Show-by-Date ytdl-sub library). Read-only, container-size bounded (ADR-038 C-08);
   * the token stays in the X-Plex-Token header, never the URL. Consumed by the ytdl-sub Library router.
   */
  async listSectionContents(
    sectionKey: string,
    opts?: { limit?: number },
  ): Promise<PlexSectionItem[]> {
    const size = Math.min(Math.max(opts?.limit ?? 500, 1), 1000);
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all`,
      sectionContentsSchema,
      { query: { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': size } },
    );
    return body.MediaContainer.Metadata;
  }

  /**
   * ADR-047 / DESIGN-025 (PLAN-028 — plex-match) — ONE page of `GET /library/sections/{key}/all`
   * (`X-Plex-Container-Start`/`-Size`), returning the items plus the library's `totalSize` so the
   * match sweep can page a large Movies/TV library to completion. `includeGuids=1` is REQUIRED:
   * without it Plex OMITS the external `Guid` array (tmdb://, imdb://, tvdb://, mbid://) from
   * section listings — verified live against k8plex 2026-07-11 (the v0.40.0 sweep matched 0/17,269
   * indexed titles without it; with the param the mbid:// GUIDs appear). Read-only; token stays in
   * the header. Callers loop `start += size` until `start >= totalSize` (or a short page returns).
   */
  async listSectionContentsPage(
    sectionKey: string,
    opts: { start: number; size: number },
  ): Promise<{ items: PlexSectionItem[]; totalSize: number | null }> {
    const size = Math.min(Math.max(opts.size, 1), 1000);
    const start = Math.max(opts.start, 0);
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all`,
      sectionContentsSchema,
      {
        query: {
          'X-Plex-Container-Start': start,
          'X-Plex-Container-Size': size,
          includeGuids: 1,
        },
      },
    );
    return {
      items: body.MediaContainer.Metadata,
      totalSize: body.MediaContainer.totalSize ?? body.MediaContainer.size ?? null,
    };
  }

  /**
   * DESIGN-017 D-09 (ytdl-sub drill-in) — `GET /library/metadata/{ratingKey}`: one item (a show /
   * season / episode) plus the library section that owns it (the drill-in's section-confinement
   * check). Read-only; token in the header. A bogus ratingKey throws the typed 404 PlexHttpError —
   * callers map it to their not-found shape.
   */
  async getMetadataItem(
    ratingKey: string,
  ): Promise<{ item: PlexSectionItem; librarySectionId: string | null } | null> {
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/metadata/${encodeURIComponent(ratingKey)}`,
      metadataContainerSchema,
    );
    const item = body.MediaContainer.Metadata[0];
    if (!item) return null;
    return {
      item,
      librarySectionId: item.librarySectionID ?? body.MediaContainer.librarySectionID ?? null,
    };
  }

  /**
   * DESIGN-017 D-09 (ytdl-sub drill-in) — `GET /library/metadata/{ratingKey}/children`: a show's
   * seasons or a season's episodes, container-size bounded like listSectionContents (ADR-038 C-08).
   * Returns the items plus the owning librarySectionID (container-level) for section confinement.
   */
  async listMetadataChildren(
    ratingKey: string,
    opts?: { limit?: number },
  ): Promise<{ items: PlexSectionItem[]; librarySectionId: string | null; totalSize: number | null }> {
    const size = Math.min(Math.max(opts?.limit ?? 500, 1), 1000);
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/metadata/${encodeURIComponent(ratingKey)}/children`,
      metadataContainerSchema,
      { query: { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': size } },
    );
    const mc = body.MediaContainer;
    return {
      items: mc.Metadata,
      librarySectionId: mc.librarySectionID ?? mc.Metadata[0]?.librarySectionID ?? null,
      totalSize: mc.totalSize ?? null,
    };
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

  /**
   * fix/plex-numeric-id — resolve an app user to their Plex friend account by the plex.tv NUMERIC
   * user id (the friend list's `<User id=…>`). The id is immutable and the one identity Authentik
   * reliably surfaces for a source-linked account, so callers try this BEFORE email/username
   * matching. Exact string match (both sides are the plex.tv id as a string); blank id → null.
   */
  async findFriendById(plexUserId: string): Promise<PlexFriend | null> {
    const needle = plexUserId.trim();
    if (!needle) return null;
    const friends = await this.listFriends();
    return friends.find((f) => f.id === needle) ?? null;
  }

  /** Case-insensitive email match against the friend list (ADR-017 D-01 user→account map). */
  async findFriendByEmail(email: string): Promise<PlexFriend | null> {
    const needle = email.trim().toLowerCase();
    if (!needle) return null;
    const friends = await this.listFriends();
    return friends.find((f) => (f.email ?? '').toLowerCase() === needle) ?? null;
  }

  /**
   * fix/plex-identity-mapping — resolve an app user to their Plex friend account by the caller's
   * REAL Plex identity (email OR username, case-insensitive), falling back to their app/OIDC email.
   * The OIDC id_token carries the Authentik email, which for a linked pre-existing account need NOT
   * equal the plex.tv email/username; email-only matching (findFriendByEmail) therefore misses such
   * users. The username arm covers accounts whose plex.tv email is private/absent but whose
   * username is known. Returns the first matching friend, or null.
   */
  async findFriendByIdentity(
    identity: { email: string | null; username: string | null },
    fallbackEmail: string,
  ): Promise<PlexFriend | null> {
    const emails = new Set(
      [identity.email, fallbackEmail]
        .map((e) => (e ?? '').trim().toLowerCase())
        .filter((e): e is string => e.length > 0),
    );
    const username = (identity.username ?? '').trim().toLowerCase();
    if (emails.size === 0 && !username) return null;
    const friends = await this.listFriends();
    return (
      friends.find((f) => {
        const fe = (f.email ?? '').trim().toLowerCase();
        const fu = (f.username ?? '').trim().toLowerCase();
        return (fe !== '' && emails.has(fe)) || (username !== '' && fu === username);
      }) ?? null
    );
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
