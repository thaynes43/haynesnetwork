// ADR-092 / DESIGN-051 D-11 (PLAN-071 S2) — the Playwright-free smoke of the `pnpm dev:local` stub: the stub
// Plex keeps the discover watchlist in memory and speaks the shapes the REAL @hnet/plex clients parse, so an add,
// a list, the userState read, the external-id match and a remove (the undo) round-trip — the path the local
// `set_watchlist` / `watchlist` / `undo_last_change` take. The write client comes from @hnet/domain's bundle
// builder (the Plex write surface stays import-confined to packages/domain, ADR-017).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPlexClientBundle, type PlexBundleOptions } from '@hnet/domain';
import { STUB_PLEX_MACHINE_IDS, STUB_PLEX_TOKENS, startStubPlex, type StubPlexServer } from '../../e2e/support/stub-plex';

let stub: StubPlexServer;

beforeAll(async () => {
  stub = await startStubPlex();
});

afterAll(async () => {
  await stub?.stop();
});

function bundle() {
  const options = {} as PlexBundleOptions;
  for (const slug of ['haynestower', 'haynesops', 'hayneskube'] as const) {
    options[slug] = {
      baseUrl: stub.baseUrl,
      token: STUB_PLEX_TOKENS[slug],
      machineIdentifier: STUB_PLEX_MACHINE_IDS[slug],
      plexTvBaseUrl: stub.baseUrl,
      plexDiscoverBaseUrl: stub.baseUrl,
      retryDelayMs: 0,
    };
  }
  return buildPlexClientBundle(options);
}

describe('stub Plex — the discover watchlist round trip (DESIGN-051 D-11)', () => {
  it('match → userState → add → list → remove → list, through the real clients', async () => {
    const { read, write } = bundle();
    const ops = read.haynesops;
    const titles = async () => (await ops.getWatchlist()).items.map((i) => i.title);
    const before = await titles();
    expect(before).toEqual(['Stub Severance', 'Stub Dune', 'Stub Runner']);

    // Stub Expanse is in the library, not on the watchlist: the external-id match finds its discover id.
    const match = await ops.matchDiscover({ kind: 'show', guid: 'tvdb://990003' });
    expect(match).toMatchObject({ kind: 'show', title: 'Stub Expanse', year: 2015, ratingKey: '5d9c086c46115600200a0003' });
    const id = match!.ratingKey;
    expect(await ops.matchDiscover({ kind: 'movie', guid: 'tvdb://990003' })).toBeNull();
    expect(await ops.getDiscoverUserState(id)).toEqual({ watchlistedAt: null });

    await write.haynesops.addToWatchlist(id);
    expect(await titles()).toEqual(['Stub Expanse', ...before]);
    expect((await ops.getDiscoverUserState(id)).watchlistedAt).toEqual(expect.any(Number));
    await write.haynesops.addToWatchlist(id); // idempotent, as live
    expect(await titles()).toEqual(['Stub Expanse', ...before]);

    await write.haynesops.removeFromWatchlist(id);
    expect(await titles()).toEqual(before);
    expect(await ops.getDiscoverUserState(id)).toEqual({ watchlistedAt: null });

    // An id plex.tv does not know is a 404; the writes were recorded like the other stub writes.
    await expect(write.haynesops.addToWatchlist('ffffffffffffffffffffffff')).rejects.toMatchObject({ status: 404 });
    expect(stub.calls.filter((c) => c.path.startsWith('/actions/')).map((c) => c.path)).toEqual([
      '/actions/addToWatchlist',
      '/actions/addToWatchlist',
      '/actions/removeFromWatchlist',
    ]);
  });
});
