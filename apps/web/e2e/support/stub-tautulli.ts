// ADR-018 / DESIGN-008 D-14 — a stub Tautulli (/api/v2) for hermetic watch-stats harvest tests.
// ADR-088 / DESIGN-049 (PLAN-068 S3) — ONE server stands in for all THREE estate instances (HaynesOps,
// HaynesKube, HaynesTower), told apart by the `apikey` query parameter (the stub-plex per-server-token
// idiom), and it is wired into the DEFAULT stack env (composeRuntimeEnv), so `pnpm dev:local` and e2e both
// have Tautulli. Each instance serves its own history, shaped like the live `get_history` rows verified
// 2026-09-23: `row_id` is the per-row identity (`id` mirrors it, `reference_id` is the group's first row),
// the owner's rows carry his plex.tv id (12874060 = STUB_PLEX_OWNER.id), movies send "" for the episode
// indices, and the rating keys are stub-plex's keys ON THAT SERVER. `get_history` honors `user_id`,
// `media_type`, `after` (YYYY-MM-DD, strictly after that day), `order_dir`, `start` and `length`;
// `get_metadata` answers HTTP 400 for a key Plex no longer has (current Tautulli; the client maps it to
// "gone").
//
// Deliberately NOT served: `get_libraries_table` (answered like any unknown command — HTTP 400). Wiring
// Tautulli into the stack env makes the home page's play scoreboard (ADR-068) ask for it on every render;
// failing that read keeps the scoreboard hidden, so the home page renders exactly as it did before this
// stub was wired (no spec depends on the badge row). A scoreboard spec can serve it deliberately.
import { createServer, type Server } from 'node:http';

export const STUB_TAUTULLI_API_KEYS = {
  haynesops: 'stub-tautulli-ops',
  hayneskube: 'stub-tautulli-kube',
  haynestower: 'stub-tautulli-tower',
} as const;
/** Back-compat alias (the pre-PLAN-068 single key) — the HaynesOps instance. */
export const STUB_TAUTULLI_API_KEY = STUB_TAUTULLI_API_KEYS.haynesops;

/** The plex.tv numeric ids the histories use: the Server Owner, a household member, a friend. */
export const STUB_TAUTULLI_USERS = {
  owner: { user_id: 12874060, user: 'plexowner' },
  member: { user_id: 77, user: 'member' },
  friend: { user_id: 55501234, user: 'helmu15' },
} as const;

type Instance = keyof typeof STUB_TAUTULLI_API_KEYS;
type StubUser = (typeof STUB_TAUTULLI_USERS)[keyof typeof STUB_TAUTULLI_USERS];

export interface StubTautulliServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

/** Seconds since the epoch for a UTC wall time. */
const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** Tautulli's verdict at the estate's 85% threshold: 1 watched, 0.5 past half of it, else 0. */
const watchedStatus = (percent: number): number => (percent >= 85 ? 1 : percent >= 42.5 ? 0.5 : 0);

interface HistoryRow {
  reference_id: number;
  row_id: number;
  id: number;
  date: number;
  started: number;
  stopped: number;
  user_id: number;
  user: string;
  media_type: 'movie' | 'episode' | 'track';
  rating_key: number;
  parent_rating_key: number | '';
  grandparent_rating_key: number | '';
  title: string;
  grandparent_title: string;
  full_title: string;
  year: number | '';
  media_index: number | '';
  parent_media_index: number | '';
  guid: string;
  percent_complete: number;
  watched_status: number;
  group_count: 1;
}

function movieRow(
  rowId: number,
  who: StubUser,
  startedIso: string,
  movie: { ratingKey: number; title: string; year: number; guid: string },
  percent: number,
): HistoryRow {
  const started = at(startedIso);
  return {
    reference_id: rowId,
    row_id: rowId,
    id: rowId,
    date: started,
    started,
    stopped: started + 6000,
    user_id: who.user_id,
    user: who.user,
    media_type: 'movie',
    rating_key: movie.ratingKey,
    parent_rating_key: '',
    grandparent_rating_key: '',
    title: movie.title,
    grandparent_title: '',
    full_title: movie.title,
    year: movie.year,
    media_index: '',
    parent_media_index: '',
    guid: movie.guid,
    percent_complete: percent,
    watched_status: watchedStatus(percent),
    group_count: 1,
  };
}

function episodeRow(
  rowId: number,
  who: StubUser,
  startedIso: string,
  ep: { ratingKey: number; seasonKey: number; showKey: number; show: string; season: number; episode: number; year: number },
  percent = 100,
): HistoryRow {
  const started = at(startedIso);
  const title = `${ep.show} ${ep.season === 0 ? 'Special' : 'Episode'} ${ep.season}x${ep.episode}`;
  return {
    reference_id: rowId,
    row_id: rowId,
    id: rowId,
    date: started,
    started,
    stopped: started + 2700,
    user_id: who.user_id,
    user: who.user,
    media_type: 'episode',
    rating_key: ep.ratingKey,
    parent_rating_key: ep.seasonKey,
    grandparent_rating_key: ep.showKey,
    title,
    grandparent_title: ep.show,
    full_title: `${ep.show} - ${title}`,
    year: ep.year,
    media_index: ep.episode,
    parent_media_index: ep.season,
    guid: `plex://episode/${ep.ratingKey}`,
    percent_complete: percent,
    watched_status: watchedStatus(percent),
    group_count: 1,
  };
}

const { owner, member, friend } = STUB_TAUTULLI_USERS;
const FIXTURE = { title: 'The Fixture', year: 2022, guid: 'plex://movie/5d7768a4ad5437001f740001' };
const RUNNER = { title: 'Stub Runner', year: 2020, guid: 'plex://movie/5d7768a4ad5437001f740002' };
const TOONS_MOVIE = { title: 'Stub Toons: The Movie', year: 2021, guid: 'plex://movie/5d7768a4ad5437001f740003' };
const BP = { showKey: 501, show: 'Breaking Prod', year: 2019 };
const bp = (ratingKey: number, season: number, episode: number) => ({
  ...BP,
  ratingKey,
  season,
  episode,
  seasonKey: 5010 + season,
});
const toons = (ratingKey: number, episode: number) => ({
  showKey: 502,
  show: 'Stub Toons',
  year: 2020,
  ratingKey,
  season: 1,
  episode,
  seasonKey: 5021,
});

/**
 * Per-instance histories (row ids increase with time, as in a real session_history table).
 * - HaynesOps (viewing moved here recently): the owner's movies — The Fixture watched, Stub Runner in
 *   progress — and a household member's movie (proves the `user_id` filter).
 * - HaynesKube: music only for the owner (a track the watch sync skips).
 * - HaynesTower (the long history): Breaking Prod S1E1–S2E1 with a rewatched S1E1, a children's episode on
 *   the owner account, The Fixture watched twice (the harvest's SUM/MAX case), a friend's episode, and an
 *   episode of a show Plex has since deleted (get_metadata → 400 → "gone").
 */
const HISTORY: Record<Instance, HistoryRow[]> = {
  haynesops: [
    movieRow(201, owner, '2026-09-20T02:00:00Z', { ratingKey: 6001, ...FIXTURE }, 100),
    movieRow(202, member, '2026-09-21T19:00:00Z', { ratingKey: 6003, ...TOONS_MOVIE }, 100),
    movieRow(203, owner, '2026-09-22T02:30:00Z', { ratingKey: 6002, ...RUNNER }, 30),
  ],
  hayneskube: [
    {
      ...movieRow(31, owner, '2026-09-10T15:00:00Z', { ratingKey: 701, title: 'Stub Track', year: 2001, guid: 'plex://track/stub' }, 100),
      media_type: 'track',
    },
  ],
  haynestower: [
    movieRow(4001, owner, '2025-03-01T02:00:00Z', { ratingKey: 601, ...FIXTURE }, 100),
    movieRow(4002, owner, '2025-11-15T02:00:00Z', { ratingKey: 601, ...FIXTURE }, 100),
    episodeRow(4003, owner, '2026-01-06T02:00:00Z', bp(50111, 1, 1)),
    episodeRow(4004, owner, '2026-01-07T02:00:00Z', bp(50112, 1, 2)),
    episodeRow(4005, friend, '2026-01-08T02:00:00Z', bp(50111, 1, 1)),
    episodeRow(4006, owner, '2026-01-09T02:00:00Z', bp(50113, 1, 3)),
    episodeRow(4007, owner, '2026-02-01T02:00:00Z', {
      show: 'Deleted Show',
      showKey: 4040,
      seasonKey: 4041,
      ratingKey: 40401,
      season: 1,
      episode: 1,
      year: 2015,
    }),
    episodeRow(4008, owner, '2026-03-01T17:00:00Z', toons(50211, 1)),
    episodeRow(4009, owner, '2026-08-30T02:00:00Z', bp(50121, 2, 1)),
    episodeRow(4010, owner, '2026-09-05T02:00:00Z', bp(50111, 1, 1), 40), // a rewatch, abandoned at 40%
  ],
};

/** get_metadata per instance — the keys Plex still has there. Anything else is gone (HTTP 400). */
const METADATA: Record<Instance, Record<string, Record<string, unknown>>> = {
  haynesops: {
    '6001': { media_type: 'movie', guid: FIXTURE.guid, guids: ['imdb://tt8800010', 'tmdb://880001'] },
    '6002': { media_type: 'movie', guid: RUNNER.guid, guids: ['tmdb://880002'] },
    '6003': { media_type: 'movie', guid: TOONS_MOVIE.guid, guids: ['tmdb://880003'] },
  },
  hayneskube: {},
  haynestower: {
    '601': { media_type: 'movie', guid: FIXTURE.guid, guids: ['imdb://tt8800010', 'tmdb://880001'] },
    '501': {
      media_type: 'show',
      guid: 'plex://show/5d9c086c46115600200a0001',
      guids: ['imdb://tt9900010', 'tmdb://55501', 'tvdb://990001'],
    },
    '502': { media_type: 'show', guid: 'plex://show/5d9c086c46115600200a0002', guids: ['tvdb://990002'] },
    ...Object.fromEntries(
      [50111, 50112, 50113, 50121].map((rk) => [
        String(rk),
        { media_type: 'episode', guid: `plex://episode/${rk}`, grandparent_rating_key: 501 },
      ]),
    ),
    '50211': { media_type: 'episode', guid: 'plex://episode/50211', grandparent_rating_key: 502 },
  },
};

const INSTANCE_BY_KEY = new Map<string, Instance>(
  (Object.entries(STUB_TAUTULLI_API_KEYS) as Array<[Instance, string]>).map(([inst, key]) => [key, inst]),
);

/** Tautulli's `after`: rows whose start falls on a day strictly after YYYY-MM-DD (UTC here). */
function startedAfter(row: HistoryRow, after: string): boolean {
  return new Date(row.started * 1000).toISOString().slice(0, 10) > after;
}

export async function startStubTautulli(): Promise<StubTautulliServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const params = url.searchParams;
    const cmd = params.get('cmd') ?? '';
    const reply = (status: number, result: 'success' | 'error', data: unknown, message: string | null = null) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: { result, message, data } }));
    };
    if (url.pathname !== '/api/v2') {
      res.writeHead(404);
      return res.end();
    }
    const instance = INSTANCE_BY_KEY.get(params.get('apikey') ?? '');
    if (!instance) return reply(401, 'error', {}, 'Invalid apikey');

    if (cmd === 'get_history') {
      const all = HISTORY[instance];
      const userId = params.get('user_id');
      const mediaType = params.get('media_type');
      const after = params.get('after');
      const filtered = all
        .filter((row) => userId === null || String(row.user_id) === userId)
        .filter((row) => mediaType === null || row.media_type === mediaType)
        .filter((row) => after === null || startedAfter(row, after))
        .sort((a, b) => (params.get('order_dir') === 'asc' ? a.date - b.date : b.date - a.date));
      const start = Math.max(Number(params.get('start') ?? 0) || 0, 0);
      const length = Math.max(Number(params.get('length') ?? 25) || 25, 1);
      return reply(200, 'success', {
        recordsTotal: all.length,
        recordsFiltered: filtered.length,
        draw: 1,
        data: filtered.slice(start, start + length),
      });
    }
    if (cmd === 'get_metadata') {
      const key = params.get('rating_key') ?? '';
      const meta = METADATA[instance][key];
      if (!meta) return reply(400, 'error', {}, `Unable to retrieve metadata for rating_key '${key}'`);
      return reply(200, 'success', { rating_key: key, ...meta });
    }
    return reply(400, 'error', {}, `Unknown command: ${cmd}`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-tautulli failed to bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
