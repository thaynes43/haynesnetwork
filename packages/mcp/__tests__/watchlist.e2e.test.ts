// ADR-092 / DESIGN-051 (PLAN-071 S2; PRD AC-29, AC-30) — the watchlist tools end to end: the SDK `Client` over
// HTTP against `handleMcpRequest`, an embedded Postgres 16 owner history (the PLAN-068 fixture: a 15-minute
// watchlist cache of Severance and Dark Matter) and a RECORDING FAKE plex.tv (never the real one — a live add of
// a title not on Plex downloads it). Covers: `watchlist` (newest first, kind, offset, past the end, started /
// watched, the 1,200-character cap and paging past it), `set_watchlist` (add on Plex, add not on Plex with the
// Seerr line, remove, already on, not found on the watchlist, ambiguous, a year in parentheses settling an add's
// TMDB ambiguity and TMDB titles that read the same answered without a question (D-15v, D-15w), a Plex failure), the
// very next `watchlist` / `watch_status` answers reflecting a change the cache predates, undo, the D-10
// `watchlist_changed` line (never a title), which Plex bundle each watchlist call went out on (DESIGN-051 D-15,
// the first pass's test fixes: the two deps are DIFFERENT fakes, so a swap of the 300 ms and the write budget fails
// here), and an add that reaches TMDB past a near title or a recommendation of another year (D-15x, D-15y); and from
// the seventh pass: a TMDB check made with the pool's answer in hand is one attempt, in real time before a mark's
// Plex work (D-15aa), and an add whose catalog lookup plex.tv answers in a second, through real clients on the
// discover bundle's production tuning (D-15ab).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TmdbClient } from '@hnet/arr/read';
import { watchMarks, type Database } from '@hnet/db';
import { buildPlexClientBundle, replaceRecoSignals, type PlexBundleOptions, type WatchPlexClients } from '@hnet/domain';
import { SPOKEN_MAX_CHARS } from '@hnet/watch';
import { DISCOVER_PLEX_TUNING } from '../src/deps';
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

/**
 * TMDB's `search/multi`: Andor, which the fixture knows only as a TMDB recommendation (so an add confirms it against
 * TMDB, DESIGN-051 D-15x), and titles no pool entry is: Dune: Part Three, and the 2024 and 1980 Shōgun (D-15y).
 */
const tmdbSearch = {
  searchMulti: async (q: string) => {
    const results = /andor/i.test(q)
      ? [{ id: 83867, media_type: 'tv', name: 'Andor', first_air_date: '2022-09-21' }]
      : /dune/i.test(q)
        ? [{ id: 1170608, media_type: 'movie', title: 'Dune: Part Three', release_date: '2026-12-18' }]
        : /sh.gun/i.test(q)
          ? [
              { id: 126308, media_type: 'tv', name: 'Shōgun', first_air_date: '2024-02-27' },
              { id: 1, media_type: 'tv', name: 'Shōgun', first_air_date: '1980-09-15' },
            ]
          : [];
    return { page: 1, total_pages: 1, total_results: results.length, results };
  },
};

function deps(): McpDeps {
  return {
    db,
    // Tagged per bundle (only the write one writes): the live userState before a change goes out on the short
    // budget, the catalog lookup and the re-read after a failed PUT on the discover budget, the PUT on the write
    // budget (DESIGN-051 D-14a, D-15b, D-15ab).
    revalidatePlex: () => fake.clients('short'),
    markPlex: () => fake.clients('write'),
    discoverPlex: () => fake.clients('discover'),
    tmdb: () => tmdbSearch,
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
    // D-02: no markdown, no URLs, no em or en dashes (an argument error names the tool, underscore and all).
    if (r.isError !== true) expect(text, name).not.toMatch(/[*#_`\u2014\u2013]|https?:\/\//);
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
    // DESIGN-051 D-15f: ten long titles do not fit in 1,200 characters, so the page keeps fewer, and the range and
    // "And N more." name exactly the titles it kept: paging on from the range's end skips none.
    const long = await say('watchlist', { limit: 10, offset: 2 });
    const range = /^Your watchlist has 152 titles\. Numbers 3 to (\d+): /.exec(long);
    expect(range, long).not.toBeNull();
    const to = Number(range![1]);
    const kept = (long.match(/Watchlist Movie Number \d+/g) ?? []).length;
    expect(kept).toBeLessThan(10);
    expect(to).toBe(2 + kept);
    expect(Number(/And (\d+) more\.$/.exec(long)![1])).toBe(152 - to);
    // The next page starts right after the last title said.
    expect(await say('watchlist', { limit: 1, offset: to })).toMatch(
      new RegExp(`^Your watchlist has 152 titles\\. Number ${to + 1}: The Extraordinarily Long Title of Watchlist Movie Number ${to - 2}: `),
    );
  });
});

describe('set_watchlist (DESIGN-051 D-03, AC-30)', () => {
  it('add on Plex: one add call, one mark; the next watchlist and watch_status show it; a repeat is "already on"', async () => {
    expect(await say('set_watchlist', { title: 'Foundation', action: 'add' })).toBe(
      "Added Foundation (2021 show) to your watchlist. It's on Plex.",
    );
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${DISCOVER.foundation}`]);
    // The catalog lookup on the discover budget (D-15ab), the live state on the short one, the PUT on the write one.
    expect(fake.watchlistCalls()).toEqual([
      `discover:matchDiscover:show:tmdb://93740`,
      `short:getDiscoverUserState:${DISCOVER.foundation}`,
      `write:addToWatchlist:${DISCOVER.foundation}`,
    ]);
    const rows = await db.select().from(watchMarks);
    expect(rows).toHaveLength(1);
    const [row] = rows;
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

  it('a retried add of a title not on Plex hears "already on" and still the Seerr sentence (D-15j)', async () => {
    expect(await say('set_watchlist', { title: 'Andor', action: 'add' })).toBe(
      "Added Andor (2022 show) to your watchlist. It isn't on Plex yet, so Seerr will request it.",
    );
    // HA's trailing tools/list failed after the write (DESIGN-049 D-05), so the model retries the add: the first
    // answer never reached anyone, and the retry is the one the owner hears.
    expect(await say('set_watchlist', { title: 'Andor', action: 'add' })).toBe(
      "Andor (2022 show) is already on your watchlist. It isn't on Plex yet, so Seerr will request it if it hasn't already.",
    );
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${DISCOVER.andor}`]);
    expect(await db.select().from(watchMarks)).toHaveLength(1);
    expect(changedLines().at(-1)).toBe(
      '[mcp] watchlist_changed {"consumer":"hop","action":"add","kind":"show","result":"unchanged","onPlex":false}',
    );
  });

  it('an add plex.tv never confirmed (the PUT failed, its re-read got no answer) says it may download (D-15j)', async () => {
    fake.failWatchlistWrites.add(DISCOVER.andor);
    fake.landFailedWatchlistWrites = true; // it did land…
    fake.failUserStateReads.add('discover'); // …but the re-read (discover budget, D-15ab) could not tell
    expect(await say('set_watchlist', { title: 'Andor', action: 'add' })).toBe(
      "Plex didn't answer in time, so I can't tell whether Andor (2022 show) changed. It isn't on Plex yet, so if it was added, Seerr will request it.",
    );
    expect(fake.watchlistCalls().slice(-2)).toEqual([
      `write:addToWatchlist:${DISCOVER.andor}`,
      `discover:getDiscoverUserState:${DISCOVER.andor}`,
    ]);
    expect(fake.watchlist.has(DISCOVER.andor)).toBe(true);
    const rows = await db.select().from(watchMarks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.plexError).toMatch(/^unknown: /);
    expect(changedLines().at(-1)).toBe(
      '[mcp] watchlist_changed {"consumer":"hop","action":"add","kind":"show","result":"unknown","onPlex":false}',
    );
  });

  it("the add's TMDB fallback goes through the single-attempt client; other tools keep the retrying one (D-15g)", async () => {
    const BRUTALIST = '6a1b2c3d4e5f60718293a4b5';
    fake.catalog.push({ id: BRUTALIST, kind: 'movie', title: 'The Brutalist', year: 2024, guids: ['tmdb://549509'] });
    const retrying: string[] = [];
    const once: string[] = [];
    const search = (calls: string[]) => ({
      searchMulti: async (q: string) => {
        calls.push(q);
        const results = /brutalist/i.test(q)
          ? [{ id: 549509, media_type: 'movie', title: 'The Brutalist', release_date: '2024-12-20' }]
          : [];
        return { page: 1, total_pages: 1, total_results: results.length, results };
      },
    });
    await http.stop();
    http = await serveMcp({ ...deps(), tmdb: () => search(retrying), tmdbOnce: () => search(once) }, ENV);
    // Known to nothing but TMDB: `set_watchlist` resolves it through `tmdbOnce` (no GET retries, so the add's worst
    // case stays inside the 9 s deadline) and never through the retrying client.
    expect(await say('set_watchlist', { title: 'The Brutalist', action: 'add' })).toBe(
      "Added The Brutalist (2024 movie) to your watchlist. It isn't on Plex yet, so Seerr will request it.",
    );
    expect(once).toEqual(['The Brutalist']);
    expect(retrying).toEqual([]);
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${BRUTALIST}`]);
    // `watch_status` (and every other tool) keeps the retrying client.
    expect(await say('watch_status', { title: 'Nosferatu' })).toBe("I couldn't find anything called Nosferatu.");
    expect(retrying).toEqual(['Nosferatu']);
    expect(once).toEqual(['The Brutalist']);
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
    // Its cached row carries its plex guid: no read-back, just the live state (short budget) and the write.
    expect(fake.watchlistCalls()).toEqual([
      `short:getDiscoverUserState:${DISCOVER.darkMatter}`,
      `write:removeFromWatchlist:${DISCOVER.darkMatter}`,
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

  it('two watchlist titles under one name: no question nothing can answer, nothing changed (D-15e, D-15l)', async () => {
    const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    fake.catalog.push({ id: OTHER, kind: 'show', title: 'Dark Matter', year: 2024, guids: ['tmdb://999001'] });
    fake.watchlist.set(OTHER, 0);
    const none = { tvdbId: null, imdbId: null };
    await replaceRecoSignals({
      db,
      plexAccountId: OWNER,
      source: 'watchlist',
      rows: [
        { ...none, kind: 'show', title: 'Severance', year: 2022, tmdbId: 95396, tvdbId: 371980, plexGuid: null, rank: 0 },
        { ...none, kind: 'show', title: 'Dark Matter', year: 2024, tmdbId: 203744, plexGuid: `plex://show/${DISCOVER.darkMatter}`, rank: 1 },
        { ...none, kind: 'show', title: 'Dark Matter', year: 2024, tmdbId: 999001, plexGuid: `plex://show/${OTHER}`, rank: 2 },
      ],
      fetchedAt: NOW,
    });
    fake.calls.length = 0;
    const answer =
      "Your watchlist has more than one Dark Matter (2024 show), and I can't tell them apart, so I left it as it is. You can change it in the Plex app.";
    // Every retry would land here again (a year only scores, it never splits the group), so it is never a question.
    for (const title of ['dark matter', 'Dark Matter 2024']) {
      expect(await say('set_watchlist', { title, action: 'remove' })).toBe(answer);
    }
    expect(await say('set_watchlist', { title: 'dark matter', action: 'add', kind: 'show' })).toBe(answer);
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(watchMarks)).toEqual([]);
    expect(changedLines().at(-1)).toBe(
      '[mcp] watchlist_changed {"consumer":"hop","action":"add","kind":"show","result":"ambiguous","onPlex":null}',
    );
  });

  it("an add's TMDB fallback: a year in parentheses settles it, and titles that read the same are no question (D-15v, D-15w)", async () => {
    const SHOGUN = '6b2c3d4e5f60718293a4b5c6';
    fake.catalog.push({ id: SHOGUN, kind: 'show', title: 'Shōgun', year: 2024, guids: ['tmdb://126308'] });
    const search = {
      searchMulti: async (q: string) => {
        const results = /sh.gun/i.test(q)
          ? [
              { id: 126308, media_type: 'tv', name: 'Shōgun', first_air_date: '2024-02-27' },
              { id: 1, media_type: 'tv', name: 'Shōgun', first_air_date: '1980-09-15' },
            ]
          : /alone/i.test(q)
            ? [
                { id: 612706, media_type: 'movie', title: 'Alone', release_date: '2020-09-18' },
                { id: 614409, media_type: 'movie', title: 'Alone', release_date: '2020-06-12' },
                { id: 62941, media_type: 'tv', name: 'Alone', first_air_date: '2015-06-18' },
              ]
            : [];
        return { page: 1, total_pages: 1, total_results: results.length, results };
      },
    };
    await http.stop();
    http = await serveMcp({ ...deps(), tmdb: () => search, tmdbOnce: () => search }, ENV);
    expect(await say('set_watchlist', { title: 'Shōgun', action: 'add' })).toBe(
      'More than one match for Shōgun: Shōgun (2024, show), Shōgun (1980, show). Which one?',
    );
    // The agent's natural retry puts the year in the title, in the answer's own format.
    expect(await say('set_watchlist', { title: 'Shōgun (2024)', action: 'add', kind: 'show' })).toBe(
      "Added Shōgun (2024 show) to your watchlist. It isn't on Plex yet, so Seerr will request it.",
    );
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${SHOGUN}`]);
    // Two different 2020 movies called Alone: the question names each title that reads differently once, and the
    // answer to it ("the 2020 movie") is not asked again, since nothing set_watchlist takes can split the two.
    expect(await say('set_watchlist', { title: 'Alone', action: 'add' })).toBe(
      'More than one match for Alone: Alone (2020, movie), Alone (2015, show). Which one?',
    );
    expect(await say('set_watchlist', { title: 'Alone (2020)', action: 'add', kind: 'movie' })).toBe(
      "I found more than one Alone (2020 movie) and can't tell them apart, so I left your watchlist as it is. You can add it in the Plex app.",
    );
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${SHOGUN}`]);
    expect(await db.select().from(watchMarks)).toHaveLength(1);
    expect(changedLines().at(-1)).toBe(
      '[mcp] watchlist_changed {"consumer":"hop","action":"add","kind":"movie","result":"ambiguous","onPlex":null}',
    );
  });

  it('an add reaches TMDB past a near title or a recommendation of another year; a near title alone is asked about (D-15x, D-15y)', async () => {
    const DUNE3 = '64d2b1d3a8e0f2c1b0e4d3a1';
    const SHOGUN = '6b2c3d4e5f60718293a4b5c6';
    const SHOGUN80 = '7c3d4e5f60718293a4b5c6d7';
    fake.catalog.push(
      { id: DUNE3, kind: 'movie', title: 'Dune: Part Three', year: 2026, guids: ['tmdb://1170608'] },
      { id: SHOGUN, kind: 'show', title: 'Shōgun', year: 2024, guids: ['tmdb://126308'] },
      { id: SHOGUN80, kind: 'show', title: 'Shōgun', year: 1980, guids: ['tmdb://1'] },
    );
    // Two TMDB recommendations, neither on Plex: Dune: Part Two and the 1980 Shōgun.
    const none = { tvdbId: null, imdbId: null, plexGuid: null, seedTitleKey: 'x', seedTitle: 'X' };
    await replaceRecoSignals({
      db,
      plexAccountId: OWNER,
      source: 'tmdb_seed',
      rows: [
        { ...none, kind: 'movie', title: 'Dune: Part Two', year: 2024, tmdbId: 693134, rank: 0 },
        { ...none, kind: 'show', title: 'Shōgun', year: 1980, tmdbId: 1, rank: 1 },
      ],
      fetchedAt: NOW,
    });
    fake.calls.length = 0;
    // US-15 and the D-02 example: before, this asked "Did you mean Dune: Part Two (2024, movie)?" on every retry.
    expect(await say('set_watchlist', { title: 'Dune: Part Three', action: 'add' })).toBe(
      "Added Dune: Part Three (2026 movie) to your watchlist. It isn't on Plex yet, so Seerr will request it.",
    );
    // Before, the 1980 recommendation won both (and Seerr downloaded it): the named year reaches TMDB, and a bare
    // name TMDB lists twice asks.
    expect(await say('set_watchlist', { title: 'Shōgun (2024)', action: 'add' })).toBe(
      "Added Shōgun (2024 show) to your watchlist. It isn't on Plex yet, so Seerr will request it.",
    );
    fake.watchlist.delete(SHOGUN);
    await db.execute(sql`TRUNCATE watch_marks`);
    expect(await say('set_watchlist', { title: 'shogun', action: 'add' })).toBe(
      'More than one match for shogun: Shōgun (2024, show), Shōgun (1980, show). Which one?',
    );
    // The Fixture (2022) is in history; "The Fixture 2" is only a prefix of it, which TMDB does not know either.
    expect(await say('set_watchlist', { title: 'The Fixture 2', action: 'add' })).toBe(
      'Did you mean The Fixture (2022, movie)?',
    );
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${DUNE3}`, `addToWatchlist:${SHOGUN}`]);
    expect(await db.select().from(watchMarks)).toEqual([]);
  });

  it('a Plex failure changes nothing it says it did; its undo removes the title anyway (a removal never downloads)', async () => {
    fake.failWatchlistWrites.add(DISCOVER.arrival);
    expect(await say('set_watchlist', { title: 'arrival', action: 'add', kind: 'movie' })).toBe(
      "I couldn't reach Plex, so your watchlist didn't change.",
    );
    // DESIGN-051 D-15b, D-15ab: the failed PUT's userState re-read went out on the discover budget (one 1.5 s
    // attempt), never the 300 ms one.
    expect(fake.watchlistCalls().slice(-2)).toEqual([
      `write:addToWatchlist:${DISCOVER.arrival}`,
      `discover:getDiscoverUserState:${DISCOVER.arrival}`,
    ]);
    expect(changedLines().at(-1)).toBe(
      '[mcp] watchlist_changed {"consumer":"hop","action":"add","kind":"movie","result":"failed","onPlex":true}',
    );
    expect(await say('watch_status', { title: 'arrival' })).toMatch(/On Plex, not on your watchlist\.$/);
    // The add may have landed: undo sends the (idempotent) removal anyway, and plex.tv's re-read settles it.
    fake.calls.length = 0;
    expect(await say('undo_last_change')).toBe(
      "Your last change, adding Arrival (2016 movie) to your watchlist, may not have reached Plex, so I made sure it's off your watchlist.",
    );
    // The undo's re-read on the discover budget too (D-15ab).
    expect(fake.watchlistCalls()).toEqual([
      `write:removeFromWatchlist:${DISCOVER.arrival}`,
      `discover:getDiscoverUserState:${DISCOVER.arrival}`,
    ]);
    expect(fake.watchlistWrites()).toEqual([`removeFromWatchlist:${DISCOVER.arrival}`]);
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

/** Resolves after `ms`, or rejects as an aborted fetch does when `signal` fires first. */
function waitOrAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

describe('the seventh review pass on PR #580 (DESIGN-051 D-15aa, D-15ab)', () => {
  it("every tool's TMDB check with the pool's answer in hand goes through the single-attempt client; not found keeps the retries (D-15aa)", async () => {
    const retrying: string[] = [];
    const once: string[] = [];
    const search = (calls: string[]) => ({
      searchMulti: async (q: string) => {
        calls.push(q);
        return { page: 1, total_pages: 1, total_results: 0, results: [] };
      },
    });
    await http.stop();
    http = await serveMcp({ ...deps(), tmdb: () => search(retrying), tmdbOnce: () => search(once) }, ENV);
    // Foundation is the pool's (2021); a named 2020 sends the query on to TMDB, whose miss leaves the pool's title.
    expect(await say('watch_status', { title: 'Foundation 2020' })).toMatch(/^Foundation \(2021 show\): /);
    expect(await say('mark_watched', { title: 'Foundation 2020', season: 1 })).toBe(
      'Marked season 1 of Foundation (2021) as watched in Plex, 10 episodes.',
    );
    expect(await say('dismiss', { title: 'Foundation 2020' })).toMatch(/Foundation \(2021/);
    // The search term drops the trailing year (DESIGN-049 D-13).
    expect(once).toEqual(['Foundation', 'Foundation', 'Foundation']);
    expect(retrying).toEqual([]);
    // "Not found" is D-13's own last resort: the retrying client, as on main.
    expect(await say('watch_status', { title: 'Nosferatu' })).toBe("I couldn't find anything called Nosferatu.");
    expect(retrying).toEqual(['Nosferatu']);
  });

  it("mark_watched with a year the pool's title does not have answers inside the deadline while TMDB stalls (D-15aa)", async () => {
    // Scaled down 1:4 from production: TMDB never answers and each attempt times out at 400 ms (1.5 s live), the
    // real client; Plex answers each of the mark's calls in 250 ms; the deadline is 1.6 s. Three TMDB attempts (1.2 s)
    // before the mark's reads and scrobble would miss it, which is what a live `Foundation 2020` did at 9 s.
    const tmdbRequests: string[] = [];
    const stalled = ((input: string | URL | Request, init?: RequestInit) => {
      tmdbRequests.push(String(input instanceof Request ? input.url : input));
      return waitOrAbort(60_000, init?.signal).then(() => new Response('{}'));
    }) as typeof fetch;
    const tmdbClient = (getRetries: number) =>
      new TmdbClient({ apiKey: 'test-tmdb-key', timeoutMs: 400, retryDelayMs: 0, timeoutCoversBody: true, getRetries, fetchImpl: stalled });
    const slowMark = (): WatchPlexClients => {
      const clients = fake.clients();
      for (const [server, read] of Object.entries(clients.read)) {
        if (!read) continue;
        clients.read[server as keyof typeof clients.read] = {
          ...read,
          listAllLeaves: async (key) => {
            await waitOrAbort(250);
            return read.listAllLeaves(key);
          },
        };
      }
      for (const [server, write] of Object.entries(clients.write)) {
        if (!write) continue;
        clients.write[server as keyof typeof clients.write] = {
          ...write,
          scrobble: async (key) => {
            await waitOrAbort(250);
            return write.scrobble(key);
          },
        };
      }
      return clients;
    };
    await http.stop();
    http = await serveMcp(
      { ...deps(), markPlex: slowMark, tmdb: () => tmdbClient(2), tmdbOnce: () => tmdbClient(0) },
      ENV,
      { deadlineMs: 1_600 },
    );
    expect(await call('mark_watched', { title: 'Foundation 2020', season: 1 })).toEqual({
      text: 'Marked season 1 of Foundation (2021) as watched in Plex, 10 episodes.',
      isError: false,
    });
    expect(tmdbRequests).toHaveLength(1);
    expect(tmdbRequests[0]).toContain('/3/search/multi');
  });

  it("an add whose catalog lookup plex.tv answers in a second is written, on the discover bundle's own budget (D-15ab)", async () => {
    // plex.tv's `matches` takes a second for Foundation (a long-running show's lookup, measured up to 1.3 s live):
    // real Plex clients on the production tuning of the discover bundle, where the 300 ms bundle timed out.
    const lookups: string[] = [];
    const slowMatches = (async (input: string | URL | Request, init?: RequestInit) => {
      lookups.push(String(input instanceof Request ? input.url : input));
      await waitOrAbort(1_000, init?.signal);
      const foundation = { ratingKey: DISCOVER.foundation, type: 'show', title: 'Foundation', year: 2021, Guid: [{ id: 'tmdb://93740' }] };
      return new Response(JSON.stringify({ MediaContainer: { size: 1, Metadata: [foundation] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const server = {
      baseUrl: 'http://plex.test',
      token: 'test-plex-token',
      machineIdentifier: 'test-machine',
      plexDiscoverBaseUrl: 'https://discover.test',
      fetchImpl: slowMatches,
      ...DISCOVER_PLEX_TUNING,
    };
    const options: PlexBundleOptions = { haynestower: server, haynesops: server, hayneskube: server };
    const discover = buildPlexClientBundle(options);
    await http.stop();
    http = await serveMcp({ ...deps(), discoverPlex: () => discover }, ENV);
    expect(await say('set_watchlist', { title: 'Foundation', action: 'add' })).toBe(
      "Added Foundation (2021 show) to your watchlist. It's on Plex.",
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toContain('/library/metadata/matches');
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${DISCOVER.foundation}`]);
    const rows = await db.select().from(watchMarks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'watchlist_add', plexResult: 'written' });
  });
});
