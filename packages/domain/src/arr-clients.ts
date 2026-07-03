// DESIGN-005 D-12/D-18 — the *arr client bundle the fix/restore orchestrators run
// against. `@hnet/arr/write` is import-guarded to packages/domain (ADR-008: no other
// code path may call a mutating *arr endpoint — see __tests__/arr-write-import-guard);
// packages/api receives this bundle as an opaque type and injects stubs in tests.
import { ARR_CLUSTER_URL_DEFAULTS, ArrConfigError } from '@hnet/arr';
import { LidarrClient, RadarrClient, SonarrClient, type ArrClientOptions } from '@hnet/arr/read';
import { LidarrWriteClient, RadarrWriteClient, SonarrWriteClient } from '@hnet/arr/write';
import type { ArrKind } from '@hnet/db';

export type { ArrClientOptions };

export interface ArrClientBundle {
  read: {
    sonarr: SonarrClient;
    radarr: RadarrClient;
    lidarr: LidarrClient;
  };
  write: {
    sonarr: SonarrWriteClient;
    radarr: RadarrWriteClient;
    lidarr: LidarrWriteClient;
  };
}

/** The API base path per kind — used only to render endpoint strings into audit rows. */
export function arrApiBasePath(kind: ArrKind): string {
  return kind === 'lidarr' ? '/api/v1' : '/api/v3';
}

export interface ArrBundleOptions {
  sonarr: ArrClientOptions;
  radarr: ArrClientOptions;
  lidarr: ArrClientOptions;
}

/**
 * Build a bundle from explicit per-kind client options. Production goes through
 * arrClientBundleFromEnv; tests inject `fetchImpl` stubs here so no code outside
 * packages/domain ever imports @hnet/arr/write (the D-12 guard).
 */
export function buildArrClientBundle(options: ArrBundleOptions): ArrClientBundle {
  return {
    read: {
      sonarr: new SonarrClient(options.sonarr),
      radarr: new RadarrClient(options.radarr),
      lidarr: new LidarrClient(options.lidarr),
    },
    write: {
      sonarr: new SonarrWriteClient(options.sonarr),
      radarr: new RadarrWriteClient(options.radarr),
      lidarr: new LidarrWriteClient(options.lidarr),
    },
  };
}

/**
 * Build the fix/restore client bundle from the D-18 env contract
 * (`SONARR_URL`/`SONARR_API_KEY` + RADARR_/LIDARR_; URLs default to the in-cluster
 * service DNS — same contract as @hnet/sync). Seerr is not part of the bundle:
 * fix/restore never talk to it. Missing keys throw one ArrConfigError naming every
 * absent variable (values are never echoed).
 */
export function arrClientBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): ArrClientBundle {
  const missing: string[] = [];
  const options = {} as Record<ArrKind, { baseUrl: string; apiKey: string }>;
  for (const kind of ['sonarr', 'radarr', 'lidarr'] as const) {
    const prefix = kind.toUpperCase();
    const baseUrl = env[`${prefix}_URL`]?.trim() || ARR_CLUSTER_URL_DEFAULTS[kind];
    const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? '';
    if (!apiKey) missing.push(`${prefix}_API_KEY`);
    options[kind] = { baseUrl, apiKey };
  }
  if (missing.length > 0) throw new ArrConfigError(missing);
  return buildArrClientBundle(options);
}
