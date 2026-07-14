// ADR-056 (PLAN-046) — the Kapowarr client bundle the goodreads-sync comic-routing + the comic force-search
// run against. `@hnet/kapowarr/write` is import-guarded to packages/domain (the ADR-011/ADR-017/ADR-055
// discipline: no other code path may push an acquisition write — see the arr-write-import-guard test, extended
// for @hnet/kapowarr/write); packages/api + packages/sync receive this bundle as an OPAQUE type and inject
// fetch-stubbed clients in tests (mirrors lazylibrarian-clients.ts). Kapowarr acquires from ITS OWN sources
// (GetComics DDL) — this bundle is NEVER wired to MAM/qBittorrent/Prowlarr/the governor (PLAN-046 hard rule).
import { assertKapowarrEnv } from '@hnet/kapowarr';
import { KapowarrReadClient, type KapowarrClientOptions } from '@hnet/kapowarr/read';
import { KapowarrWriteClient } from '@hnet/kapowarr/write';

export type { KapowarrClientOptions };

export interface KapowarrClientBundle {
  read: KapowarrReadClient;
  write: KapowarrWriteClient;
}

/**
 * Build a bundle from explicit client options. Production goes through kapowarrBundleFromEnv; tests inject a
 * `fetchImpl` (+ `sleepImpl`) stub here so no code outside packages/domain ever imports @hnet/kapowarr/write
 * (the guard).
 */
export function buildKapowarrBundle(options: KapowarrClientOptions): KapowarrClientBundle {
  return {
    read: new KapowarrReadClient(options),
    write: new KapowarrWriteClient(options),
  };
}

/**
 * Build the Kapowarr bundle from the env contract (`KAPOWARR_URL` default to the in-cluster service DNS +
 * `KAPOWARR_API_KEY` required). A missing key throws one KapowarrConfigError naming the absent variable
 * (never its value).
 */
export function kapowarrBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): KapowarrClientBundle {
  const config = assertKapowarrEnv(env);
  return buildKapowarrBundle({ baseUrl: config.baseUrl, apiKey: config.apiKey });
}
