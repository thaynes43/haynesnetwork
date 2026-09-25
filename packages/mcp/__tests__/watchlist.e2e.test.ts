// ADR-092 / DESIGN-051 (PLAN-071 S2; PRD AC-29, AC-30) — the watchlist tools end to end: the SDK `Client` over
// HTTP against `handleMcpRequest`, an embedded Postgres 16 owner history (the PLAN-068 fixture: a 15-minute
// watchlist cache of Severance and Dark Matter) and a RECORDING FAKE plex.tv (never the real one — a live add of
// a title not on Plex downloads it). Covers: `watchlist` (newest first, kind, offset, past the end, started /
// watched, the 1,200-character cap), `set_watchlist` (add on Plex, add not on Plex with the Seerr line, remove,
// already on, not found on the watchlist, ambiguous, a Plex failure), the very next `watchlist` / `watch_status`
// answers reflecting a change the cache predates, undo, and the D-10 `watchlist_changed` line (never a title).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { watchMarks, type Database } from '@hnet/db';
import { replaceRecoSignals } from '@hnet/domain';
import { SPOKEN_MAX_CHARS } from '@hnet/watch';
import type { McpDeps } from '../src/index';
import { DISCOVER, FakePlex, NOW, OWNER, ownerWorld, seedWorld, serveMcp, type McpHttp } from './fixture';
import { bootMigratedDb, type TestDb } from './helpers';

const TOKEN = 'test-hop-token-000000000000000000000000000000000';
const ENV = { HNET_MCP_HOP_TOKEN: TOKEN };

let t: TestDb;
let db: Database;
let fake: FakePlex;
let http: McpHttp;
let clock = NOW;

function deps(): McpDeps {
  return {
    db,
    revalidatePlex: () => fake.clients(),
    markPlex: () => fake.clients(),
    tmdb: () => null,
    now: () => clock,
    log: () => {},
  };
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const c = new Client({ name: 'vitest', version: '1.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }),
  );
  try {
    const r = await c.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text: string }>;
    expect(r.structuredContent).toBeUndefined();
    const text = content.map((x) => x.text).join('');
    expect(text.length, name).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    // D-02: no markdown, no URLs, no em-dashes (an argument error names the tool, underscore and all).
    if (r.isError !== true) expect(text, name).not.toMatch(/[*#_`—]|https?:\/\//);
    return { text, isError: r.isError === true };
  } finally {
    await c.close();
  }
}

const say = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).text;
const changedLines = () => http.logs.filter((l) => l.startsWith('[mcp] watchlist_changed '));

beforeAll(async () => {
  t = await bootMigratedDb();
  db = t.db;
});

afterAll(async () => {
  await http?.stop();
  await t.stop();
});

beforeEach(async () => {
  clock = NOW;
  await http?.stop();
  await db.execute(
    sql`TRUNCATE watch_marks, watch_titles, watch_events, watch_reco_signals, watch_accounts, media_plex_matches, media_metadata, media_items, plex_libraries CASCADE`,
  );
  fake = ownerWorld();
  await seedWorld(db, fake);
  fake.calls.length = 0;
  http = await serveMcp(deps(), ENV);
});

describe('watchlist (DESIGN-051 D-02, AC-29)', () => {
  it('lists newest first with year, kind and on-Plex state; filters by kind; pages with offset; says the end', async () => {
    expect(await say('watchlist')).toBe(
      'Your watchlist has two titles. Newest first: Severance, a 2022 show, on Plex. Dark Matter, a 2024 show, not on Plex yet.',
    );
    expect(await say('watchlist', { kind: 'show', limit: 1 })).toBe(
      'Your watchlist has two shows. Newest first: Severance, a 2022 show, on Plex. And 1 more.',
    );
    expect(await say('watchlist', { limit: 1, offset: 1 })).toBe(
      'Your watchlist has two titles. Number 2: Dark Matter, a 2024 show, not on Plex yet.',
    );
    expect(await say('watchlist', { kind: 'movie' })).toBe('Your watchlist has no movies.');
    expect(await say('watchlist', { offset: 5 })).toBe("That's the end of your watchlist.");
    // A read: no Plex call at all (the cache plus the overlay answer it).
    expect(fake.calls).toEqual([]);
  });

  it('says started (in progress or stalled) and watched (Ever Watched, not unfinished), and caps a long list', async () => {
    const none = { tvdbId: null, imdbId: null, plexGuid: null };
    await replaceRecoSignals({
      db,
      plexAccountId: OWNER,
      source: 'watchlist',
      rows: [
        { ...none, kind: 'show', title: 'Silo', year: 2023, tvdbId: 403245, tmdbId: 125988, plexGuid: 'plex://show/silo', rank: 0 },
        { ...none, kind: 'show', title: 'The Expanse', year: 2015, tvdbId: 280619, tmdbId: 63639, plexGuid: 'plex://show/exp', rank: 1 },
        ...Array.from({ length: 150 }, (_, i) => ({
          ...none,
          kind: 'movie' as const,
          title: `The Extraordinarily Long Title of Watchlist Movie Number ${i}: A Tale in Several Parts`,
          year: 2001,
          tmdbId: 700_000 + i,
          rank: i + 2,
        })),
      ],
      fetchedAt: new Date(NOW.getTime() - 600_000),
    });
    expect(await say('watchlist', { limit: 2 })).toBe(
      'Your watchlist has 152 titles. Newest first: Silo, a 2023 show, on Plex, started. The Expanse, a 2015 show, on Plex, watched. And 150 more.',
    );
    const long = await say('watchlist', { limit: 10, offset: 2 });
    expect(long).toMatch(/^Your watchlist has 152 titles\. Numbers 3 to 12: /);
    expect(long).toMatch(/And \d+ more\.$/);
  });
});

describe('set_watchlist (DESIGN-051 D-03, AC-30)', () => {
  it('add on Plex: one add call, one mark; the next watchlist and watch_status show it; a repeat is "already on"', async () => {
    expect(await say('set_watchlist', { title: 'Foundation', action: 'add' })).toBe(
      "Added Foundation (2021 show) to your watchlist. It's on Plex.",
    );
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${DISCOVER.foundation}`]);
    const [row] = await db.select().from(watchMarks);
    expect(row).toMatchObject({ action: 'watchlist_add', consumer: 'hop', plexResult: 'written', plexGuid: `plex://show/${DISCOVER.foundation}` });
    // The cache predates the change; the overlay puts it on top (D-05).
    expect(await say('watchlist')).toBe(
      'Your watchlist has three titles. Newest first: Foundation, a 2021 show, on Plex. Severance, a 2022 show, on Plex. Dark Matter, a 2024 show, not on Plex yet.',
    );
    expect(await say('watch_status', { title: 'foundation' })).toBe(
      'Foundation (2021 show): not watched yet. On Plex and on your watchlist.',
    );
    // A watchlist change is not a watch statement: Foundation stays a pick (now "on your watchlist").
    expect(await say('recommend')).toContain('Foundation, a 2021 show, on your watchlist.');

    expect(await say('set_watchlist', { title: 'Foundation', action: 'add' })).toBe(
      'Foundation (2021 show) is already on your watchlist.',
    );
    expect(fake.watchlistWrites()).toHaveLength(1);
    expect(await db.select().from(watchMarks)).toHaveLength(1);

    // D-10: exactly the five fields — never the title or the query.
    expect(changedLines()).toEqual([
      '[mcp] watchlist_changed {"consumer":"hop","action":"add","kind":"show","result":"written","onPlex":true}',
      '[mcp] watchlist_changed {"consumer":"hop","action":"add","kind":"show","result":"unchanged","onPlex":true}',
    ]);
    expect(http.logs.join('\n')).not.toMatch(/Foundation|foundation/);
  });

  it('add not on Plex says Seerr will request it; undo removes it again and says Seerr may already have', async () => {
    expect(await say('set_watchlist', { title: 'Andor', action: 'add' })).toBe(
      "Added Andor (2022 show) to your watchlist. It isn't on Plex yet, so Seerr will request it.",
    );
    expect(changedLines().at(-1)).toBe(
      '[mcp] watchlist_changed {"consumer":"hop","action":"add","kind":"show","result":"written","onPlex":false}',
    );
    expect(await say('watch_status', { title: 'andor' })).toBe(
      'Andor (2022 show): not watched yet. Not on Plex, but on your watchlist.',
    );
    fake.calls.length = 0;
    expect(await say('undo_last_change')).toBe(
      'Removed Andor (2022 show) from your watchlist again. Seerr may already have requested it.',
    );
    expect(fake.watchlistWrites()).toEqual([`removeFromWatchlist:${DISCOVER.andor}`]);
    expect(await say('watch_status', { title: 'andor' })).toBe(
      'Andor (2022 show): not watched yet. Not on Plex or your watchlist.',
    );
  });

  it('remove: the next answers drop it at once; undo puts it back (not on Plex ⇒ Seerr will request it)', async () => {
    // Dark Matter is known only through the watchlist: once it is off, only TMDB still knows the name.
    await http.stop();
    http = await serveMcp(
      {
        ...deps(),
        tmdb: () => ({
          searchMulti: async () => ({
            page: 1,
            total_pages: 1,
            total_results: 1,
            results: [{ id: 203744, media_type: 'tv', name: 'Dark Matter', first_air_date: '2024-05-08' }],
          }),
        }),
      },
      ENV,
    );
    expect(await say('set_watchlist', { title: 'dark matter', action: 'remove' })).toBe(
      'Removed Dark Matter (2024 show) from your watchlist.',
    );
    // Its cached row carries its plex guid: no read-back, just the live state and the write.
    expect(fake.calls.map((c) => `${c.op}:${c.key}`)).toEqual([
      `getDiscoverUserState:${DISCOVER.darkMatter}`,
      `removeFromWatchlist:${DISCOVER.darkMatter}`,
    ]);
    expect(await say('watchlist')).toBe('Your watchlist has one title. Newest first: Severance, a 2022 show, on Plex.');
    expect(await say('watch_status', { title: 'dark matter' })).toBe(
      'Dark Matter (2024 show): not watched yet. Not on Plex or your watchlist.',
    );
    fake.calls.length = 0;
    expect(await say('undo_last_change')).toBe('Put Dark Matter (2024 show) back on your watchlist. Seerr will request it.');
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${DISCOVER.darkMatter}`]);
    expect(await say('watchlist')).toMatch(/^Your watchlist has two titles\. Newest first: Dark Matter, a 2024 show/);
  });

  it('remove resolves only among watchlist titles: a title only in the library is not found there, with no call', async () => {
    expect(await say('set_watchlist', { title: 'Arrival', action: 'remove' })).toBe(
      "I couldn't find Arrival on your watchlist.",
    );
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(watchMarks)).toEqual([]);
    expect(changedLines()).toEqual([
      '[mcp] watchlist_changed {"consumer":"hop","action":"remove","kind":null,"result":"not_found","onPlex":null}',
    ]);
  });

  it('an ambiguous title asks and changes nothing', async () => {
    expect(await say('set_watchlist', { title: 'Dune', action: 'add' })).toBe(
      'More than one match for Dune: Dune (2021, movie), Dune (1984, movie). Which one?',
    );
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(watchMarks)).toEqual([]);
  });

  it('a Plex failure changes nothing it says it did; undo then says it never reached Plex', async () => {
    fake.failWatchlistWrites.add(DISCOVER.arrival);
    expect(await say('set_watchlist', { title: 'arrival', action: 'add', kind: 'movie' })).toBe(
      "I couldn't reach Plex, so your watchlist didn't change.",
    );
    expect(await say('watch_status', { title: 'arrival' })).toMatch(/On Plex, not on your watchlist\.$/);
    expect(await say('undo_last_change')).toBe(
      'Your last change, adding Arrival (2016 movie) to your watchlist, never reached Plex, so there was nothing to undo.',
    );
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${DISCOVER.arrival}`]);
  });

  it('a watchlist change is not a watch statement: Unfinished, recent history and watch_status progress are untouched', async () => {
    const before = {
      unfinished: await say('unfinished', { kind: 'any', limit: 10 }),
      recent: await say('recent_history'),
      silo: await say('watch_status', { title: 'Silo' }),
    };
    expect(await say('set_watchlist', { title: 'Silo', action: 'add' })).toBe("Added Silo (2023 show) to your watchlist. It's on Plex.");
    expect(await say('set_watchlist', { title: 'Severance', action: 'remove' })).toBe(
      'Removed Severance (2022 show) from your watchlist.',
    );
    expect(await say('unfinished', { kind: 'any', limit: 10 })).toBe(before.unfinished);
    expect(await say('recent_history')).toBe(before.recent);
    // The same progress wording (never "someone else's viewing", never "dismissed") — only availability moves.
    expect(before.silo).toMatch(/ On Plex, not on your watchlist\.$/);
    expect(await say('watch_status', { title: 'Silo' })).toBe(
      before.silo.replace('On Plex, not on your watchlist.', 'On Plex and on your watchlist.'),
    );
    expect((await db.select().from(watchMarks)).map((m) => m.action)).toEqual(['watchlist_add', 'watchlist_remove']);
  });

  it('refuses a missing action (strict inputs) before anything runs', async () => {
    const r = await call('set_watchlist', { title: 'Foundation' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Invalid arguments for set_watchlist: action: /);
    expect(fake.calls).toEqual([]);
  });
});
