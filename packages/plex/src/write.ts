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

export class PlexWriteClient {
  private readonly http: PlexHttp;
  private readonly plexTvBaseUrl: string;
  private readonly machineIdentifier: string;

  constructor(options: PlexClientOptions) {
    this.http = new PlexHttp(options);
    this.plexTvBaseUrl = (options.plexTvBaseUrl ?? PLEX_TV_BASE_URL).replace(/\/+$/, '');
    this.machineIdentifier = options.machineIdentifier;
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
}

export function plexWriteClient(options: PlexClientOptions): PlexWriteClient {
  return new PlexWriteClient(options);
}
