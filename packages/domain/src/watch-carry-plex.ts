// ADR-114 C-02 — the Watch Carry's Plex clients from the D-03 env contract. Each server's owner token reads the show and
// switches its ordering; every friend's per-server token (plex.tv shared_servers, read at run time with the owner token)
// builds that friend's own read and write clients. The tokens stay inside the clients: nothing here returns, stores,
// logs or prints one. `@hnet/plex/write` stays confined to packages/domain (ADR-017 C-10).
import { assertPlexEnv, PLEX_SERVERS, type PlexServerName } from '@hnet/plex';
import { PlexReadClient, type PlexClientOptions } from '@hnet/plex/read';
import { PlexWriteClient } from '@hnet/plex/write';
import type { WatchCarryAccount, WatchCarryPlex, WatchCarryServer } from './watch-carry';

/** Per-request timeout for the carry's reads: a long show's `allLeaves` can take several seconds. */
const CARRY_TIMEOUT_MS = 60_000;

/** Build the carry's Plex surface from per-server owner client options (tests pass stub `fetchImpl`s). */
export function buildWatchCarryPlex(options: Partial<Record<PlexServerName, PlexClientOptions>>): WatchCarryPlex {
  const cache = new Map<string, WatchCarryServer>();
  return {
    server(slug) {
      const own = options[slug as PlexServerName];
      if (!own) return null;
      const hit = cache.get(slug);
      if (hit) return hit;
      const ownerRead = new PlexReadClient(own);
      const ownerWrite = new PlexWriteClient(own);
      const server: WatchCarryServer = {
        slug,
        read: ownerRead,
        write: ownerWrite,
        async accounts(librarySectionId) {
          const owner = await ownerRead.getOwnerAccount();
          if (!owner.id) throw new Error(`${slug}: plex.tv did not name the owner account`);
          const out: WatchCarryAccount[] = [{ accountId: String(owner.id), owner: true, read: ownerRead, write: ownerWrite }];
          for (const share of await ownerRead.listSharedServerAccess()) {
            if (share.userId === String(owner.id)) continue;
            if (librarySectionId !== null && !share.allLibraries && !share.sectionKeys.includes(librarySectionId)) continue;
            const friend: PlexClientOptions = { ...own, token: share.accessToken };
            out.push({ accountId: share.userId, owner: false, read: new PlexReadClient(friend), write: new PlexWriteClient(friend) });
          }
          return out;
        },
      };
      cache.set(slug, server);
      return server;
    },
  };
}

/** The production surface: every configured Plex server, owner tokens from the env (`PLEX_<SLUG>_TOKEN`). */
export function watchCarryPlexFromEnv(env: Record<string, string | undefined> = process.env): WatchCarryPlex {
  const config = assertPlexEnv(env);
  const options: Partial<Record<PlexServerName, PlexClientOptions>> = {};
  for (const slug of PLEX_SERVERS) {
    options[slug] = {
      baseUrl: config[slug].baseUrl,
      token: config[slug].token,
      machineIdentifier: config[slug].machineIdentifier,
      plexTvBaseUrl: config[slug].plexTvBaseUrl,
      plexDiscoverBaseUrl: config[slug].plexDiscoverBaseUrl,
      timeoutMs: CARRY_TIMEOUT_MS,
    };
  }
  return buildWatchCarryPlex(options);
}
