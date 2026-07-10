// @hnet/plex/write — the WRITE surface (DESIGN-007 D-03 write table, read/write split).
// ADR-017: the ONLY sanctioned Plex write-backs are applying / revoking a per-user library
// share via the plex.tv v1 sharing API (POST/PUT/DELETE .../shared_servers). This entrypoint
// may be imported ONLY by the packages/domain share orchestrator and by packages/plex itself
// — enforced by the arr-write-import-guard test (extended for @hnet/plex/write). The
// read-merge-write invariant (never blind-overwrite a user's section set — ADR-017 D-02) is
// the domain orchestrator's job; this client issues the single computed mutation it is given.
import { PLEX_TV_BASE_URL } from './config';
import { PlexHttp } from './http';
import { childrenNamed } from './xml';
import type { PlexClientOptions } from './read';

/** The JSON body plex.tv's v1 shared_servers POST/PUT accepts (python-plexapi friend model). */
interface SharedServerBody {
  server_id: string;
  shared_server: {
    library_section_ids: number[];
    invited_id?: number;
  };
}

/**
 * ADR-024 — the body for toggling the server-wide all-libraries flag. `all_libraries` is the
 * plex.tv web-client convention (snake_case, consistent with the other shared_server keys); it is
 * NOT part of python-plexapi's write surface (which only ever sends `library_section_ids`), so the
 * ON path is INFERRED and deferred to live write-validation (ADR-017 C-13). The OFF path (an
 * explicit `library_section_ids` list, which demotes the account from all-libraries) IS the
 * verified python-plexapi shape; `all_libraries: false` is sent alongside it only to be explicit.
 */
interface SharedServerAllBody {
  server_id: string;
  shared_server: {
    all_libraries: boolean;
    library_section_ids?: number[];
    invited_id?: number;
  };
}

export class PlexWriteClient {
  private readonly http: PlexHttp;
  /** Direct PMS base URL — the poster-upload write goes to the server itself (not plex.tv). */
  private readonly baseUrl: string;
  private readonly plexTvBaseUrl: string;
  private readonly machineIdentifier: string;

  constructor(options: PlexClientOptions) {
    this.http = new PlexHttp(options);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.plexTvBaseUrl = (options.plexTvBaseUrl ?? PLEX_TV_BASE_URL).replace(/\/+$/, '');
    this.machineIdentifier = options.machineIdentifier;
  }

  /**
   * ADR-043 / DESIGN-021 (PLAN-024) — the ONLY direct-PMS write in this app: upload a poster to a
   * library item and select it. `POST {baseUrl}/library/metadata/{ratingKey}/posters` with the raw
   * image bytes as the body (token in the X-Plex-Token header, never the URL). Plex stores the upload
   * and makes it the item's selected poster; the previous art stays in the item's poster GALLERY, so a
   * re-apply is non-destructive and reversible (ADR-043 C-04). Used ONLY by the @hnet/domain poster
   * guard (runPelotonPosterGuard) — this write surface is import-confined to packages/domain (ADR-017).
   */
  async uploadPoster(input: {
    ratingKey: string;
    body: Uint8Array;
    contentType?: string;
  }): Promise<void> {
    await this.http.requestVoid(
      'POST',
      `${this.baseUrl}/library/metadata/${encodeURIComponent(input.ratingKey)}/posters`,
      {
        rawBody: input.body,
        contentType: input.contentType ?? 'image/png',
        accept: 'application/xml',
      },
    );
  }

  private sharedServersUrl(sharedServerId?: string): string {
    const base = `${this.plexTvBaseUrl}/api/servers/${this.machineIdentifier}/shared_servers`;
    return sharedServerId ? `${base}/${sharedServerId}` : base;
  }

  /**
   * `POST .../shared_servers` — share the server with a friend for the first time. Creates a
   * new SharedServer with exactly `librarySectionIds` (plex.tv section ids). Returns the new
   * sharedServerId when the response carries it.
   */
  async createSharedServer(input: {
    invitedUserId: number;
    librarySectionIds: number[];
  }): Promise<{ sharedServerId: string | null }> {
    const body: SharedServerBody = {
      server_id: this.machineIdentifier,
      shared_server: {
        library_section_ids: input.librarySectionIds,
        invited_id: input.invitedUserId,
      },
    };
    const root = await this.http.requestXml('POST', this.sharedServersUrl(), { body });
    const created = childrenNamed(root, 'SharedServer')[0] ?? root;
    return { sharedServerId: created.attrs.id ?? null };
  }

  /**
   * `PUT .../shared_servers/{id}` — replace an existing SharedServer's shared section set with
   * `librarySectionIds` (the read-merge-write result the domain computed: current ∪/∖ target).
   */
  async updateSharedServer(input: {
    sharedServerId: string;
    librarySectionIds: number[];
  }): Promise<void> {
    const body: SharedServerBody = {
      server_id: this.machineIdentifier,
      shared_server: { library_section_ids: input.librarySectionIds },
    };
    await this.http.requestVoid('PUT', this.sharedServersUrl(input.sharedServerId), {
      body,
      accept: 'application/xml',
    });
  }

  /**
   * `DELETE .../shared_servers/{id}` — remove the share entirely (used when a remove empties a
   * user's section set — a SharedServer with zero sections is not a valid state).
   */
  async deleteSharedServer(sharedServerId: string): Promise<void> {
    await this.http.requestVoid('DELETE', this.sharedServersUrl(sharedServerId), {
      accept: 'application/xml',
    });
  }

  /**
   * ADR-024 — set the server-wide all-libraries flag for a friend's SharedServer.
   * - `on: true`  → PUT `.../{id}` `{ shared_server: { all_libraries: true } }` when the friend
   *   already has a SharedServer, else POST `.../shared_servers` `{ shared_server: { all_libraries:
   *   true, invited_id } }` to create one. (INFERRED plex.tv-web shape — see SharedServerAllBody.)
   * - `on: false` → PUT `.../{id}` `{ shared_server: { all_libraries: false, library_section_ids }
   *   }` — the explicit list (the caller seeds it with the account's current full section set) is
   *   what actually demotes the account from all-libraries; this is the VERIFIED python-plexapi
   *   shape. Returns the (possibly newly created) sharedServerId.
   */
  async updateSharedServerAll(input: {
    sharedServerId: string | null;
    invitedUserId: number;
    on: boolean;
    librarySectionIds?: number[];
  }): Promise<{ sharedServerId: string | null }> {
    if (input.on) {
      if (input.sharedServerId) {
        const body: SharedServerAllBody = {
          server_id: this.machineIdentifier,
          shared_server: { all_libraries: true },
        };
        await this.http.requestVoid('PUT', this.sharedServersUrl(input.sharedServerId), {
          body,
          accept: 'application/xml',
        });
        return { sharedServerId: input.sharedServerId };
      }
      const body: SharedServerAllBody = {
        server_id: this.machineIdentifier,
        shared_server: { all_libraries: true, invited_id: input.invitedUserId },
      };
      const root = await this.http.requestXml('POST', this.sharedServersUrl(), { body });
      const created = childrenNamed(root, 'SharedServer')[0] ?? root;
      return { sharedServerId: created.attrs.id ?? null };
    }
    // OFF — an explicit list demotes the account from all-libraries (verified shape).
    if (!input.sharedServerId) return { sharedServerId: null };
    const body: SharedServerAllBody = {
      server_id: this.machineIdentifier,
      shared_server: { all_libraries: false, library_section_ids: input.librarySectionIds ?? [] },
    };
    await this.http.requestVoid('PUT', this.sharedServersUrl(input.sharedServerId), {
      body,
      accept: 'application/xml',
    });
    return { sharedServerId: input.sharedServerId };
  }
}

export function plexWriteClient(options: PlexClientOptions): PlexWriteClient {
  return new PlexWriteClient(options);
}
