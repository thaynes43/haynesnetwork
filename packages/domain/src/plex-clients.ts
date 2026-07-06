// ADR-017 / DESIGN-007 D-03/D-04 — the Plex client bundle the registry-refresh and share
// orchestrators run against. `@hnet/plex/write` is import-guarded to packages/domain (ADR-011
// discipline: no other code path may apply a Plex share — see the arr-write-import-guard test,
// extended for @hnet/plex/write); packages/api receives this bundle as an opaque type and
// injects stubs in tests (mirrors arr-clients.ts).
import {
  assertPlexEnv,
  PLEX_SERVERS,
  type PlexEnvConfig,
  type PlexServerName,
} from '@hnet/plex';
import { PlexReadClient, type PlexClientOptions } from '@hnet/plex/read';
import { PlexWriteClient } from '@hnet/plex/write';

export type { PlexClientOptions, PlexServerName };

export interface PlexClientBundle {
  read: Record<PlexServerName, PlexReadClient>;
  write: Record<PlexServerName, PlexWriteClient>;
}

export type PlexBundleOptions = Record<PlexServerName, PlexClientOptions>;

/**
 * Build a bundle from explicit per-server client options. Production goes through
 * plexClientBundleFromEnv; tests inject `fetchImpl` stubs here so no code outside
 * packages/domain ever imports @hnet/plex/write (the guard).
 */
export function buildPlexClientBundle(options: PlexBundleOptions): PlexClientBundle {
  const read = {} as Record<PlexServerName, PlexReadClient>;
  const write = {} as Record<PlexServerName, PlexWriteClient>;
  for (const slug of PLEX_SERVERS) {
    read[slug] = new PlexReadClient(options[slug]);
    write[slug] = new PlexWriteClient(options[slug]);
  }
  return { read, write };
}

/**
 * Build the Plex client bundle from the D-03 env contract (`PLEX_<SLUG>_URL` default to the
 * in-cluster service DNS + `PLEX_<SLUG>_TOKEN` required; machine identifiers pinned in config,
 * overridable via `PLEX_<SLUG>_MACHINE_ID`). Missing tokens throw one PlexConfigError naming
 * every absent variable (values are never echoed).
 */
export function plexClientBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): PlexClientBundle {
  const config: PlexEnvConfig = assertPlexEnv(env);
  const options = {} as PlexBundleOptions;
  for (const slug of PLEX_SERVERS) {
    options[slug] = {
      baseUrl: config[slug].baseUrl,
      token: config[slug].token,
      machineIdentifier: config[slug].machineIdentifier,
      plexTvBaseUrl: config[slug].plexTvBaseUrl,
    };
  }
  return buildPlexClientBundle(options);
}
