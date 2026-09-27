// ADR-017 / DESIGN-007 D-07 — stub Plex server for e2e (mirrors stub-arr.ts: a real node:http
// server because Next calls Plex over the network). ONE server stands in for all three PMS
// instances AND plex.tv: PMS reads (`/identity`, `/library/sections`) are disambiguated by the
// per-server X-Plex-Token; the plex.tv sharing API (`/api/servers/{machineId}/...`) is
// disambiguated by the machineIdentifier in the path. It is STATEFUL for shared_servers so an
// add → myLibraries round-trip reflects the change, and RECORDS every sharing write so specs
// can assert the read-merge-write preservation (ADR-017 D-02).
//
// ADR-088 / DESIGN-049 (PLAN-068 S3) — it also serves the OWNER's watch state for the Watch Companion: watch
// fields on section items / metadata / children, `/library/metadata/{rk}/allLeaves`, `/library/all?guid=`,
// section-listing filters (type / unwatched / inProgress, Start/Size paging), the plex.tv discover watchlist
// (`/library/sections/watchlist/all` — PLEX_DISCOVER_URL points here; ADR-092 / DESIGN-051 D-11: kept in memory
// and changed by `PUT /actions/addToWatchlist|removeFromWatchlist?ratingKey=`, with the external-id match
// `/library/metadata/matches?type=&guid=` and `/library/metadata/<id>/userState`, so an add, a list and an undo
// round-trip under `pnpm dev:local`), and the GET-shaped watched-state
// writes `/:/scrobble` + `/:/unscrobble`, which are RECORDED in `calls` and flip an in-memory watch map that
// every read overlays — so a mark → re-read round-trip behaves like a real server. Only the WATCH dataset
// below carries watch state; every pre-existing fixture item reads exactly as before.
//
// Control endpoints:
//   GET  /_stub/calls  → { calls: [{method, path, machineId, body}] } (sharing writes, poster uploads,
//                         scrobble/unscrobble)
//   POST /_stub/reset  → 204 (clears recorded calls AND resets shares, the watch map AND the watchlist)
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const STUB_PLEX_TOKENS = {
  haynestower: 'stub-plex-tower',
  haynesops: 'stub-plex-ops',
  hayneskube: 'stub-plex-kube',
} as const;

// The pinned machine identifiers (match packages/plex PLEX_MACHINE_IDENTIFIERS + the 0010 seed,
// so the e2e client's default machine ids route to the right server here).
export const STUB_PLEX_MACHINE_IDS = {
  haynestower: 'a5ec8cb29c425667637eabdb6a0615d6ccf68cc3',
  haynesops: '80b33acb1d207508990637ec151fe9abad8d3d7a',
  hayneskube: 'c1b23d688afea4a39ec2c214776832c16be6504d',
} as const;

/** The member persona's Plex account (email matches stub-oidc STUB_USERS.member). */
export const STUB_PLEX_MEMBER = { id: '77', email: 'member@example.test', username: 'member' };

/**
 * ADR-029 — the token account, i.e. the server OWNER (`GET /api/v2/user`). Its email matches NO
 * persona by default, so the member stays a *friend* (not owner) and existing specs are unchanged.
 * The owner email is overridable at runtime via `POST /_stub/owner { email }` so the owner-state /
 * unlinked-account UX can be captured against a real persona.
 */
export const STUB_PLEX_OWNER = { id: '12874060', email: 'plex-owner@example.test', username: 'plexowner' };

/**
 * ADR-093 / DESIGN-052 D-20 (PLAN-072) — the Watchlist Registry's roster fixture: the member (a friend whose
 * community list answers one title), a friend whose community list reads EMPTY (hidden and empty look alike), and a
 * MANAGED Home user community answers `User not found:` for. Uuids ride the roster `thumb`, as live. None of these
 * lists holds a Trash pool title by default (existing specs keep their expedite partitions; the owner's discover
 * watchlist holds Stub Runner, which its `dnd` tag already keeps); `POST /_stub/community`
 * sets a list, e.g. for the `pnpm dev:local` walk.
 */
export const STUB_REGISTRY_ACCOUNTS = {
  member: { id: STUB_PLEX_MEMBER.id, uuid: 'a1b2c3d4e5f60718' },
  hiddenFriend: { id: '78', uuid: 'b2c3d4e5f6071829' },
  managed: { id: '79', uuid: 'c3d4e5f60718293a' },
} as const;

/** The discover ids of the stub's default community lists (Stub Dune — a watchlist title that is not on Plex). */
export const STUB_COMMUNITY_DEFAULT_NODES: Array<{ id: string; type: 'MOVIE' | 'SHOW' }> = [
  { id: '5d776d1b0000000000000002', type: 'MOVIE' },
];

type Slug = keyof typeof STUB_PLEX_TOKENS;

interface StubSection {
  key: string;
  title: string;
  type: string;
  /** plex.tv-scoped section id (the share body's library_section_ids). */
  plexId: string;
}

// The canonical e2e library set — mirrors what seed-ledger.ts seeds into plex_libraries.
// ADR-038 (PLAN-022) — k8plex also carries the two ytdl-sub "TV Show by Date" libraries.
const LIBRARIES: Record<Slug, StubSection[]> = {
  haynestower: [
    { key: '1', title: 'HNet Movies', type: 'movie', plexId: '118181361' },
    // MUST stay in lockstep with seed-ledger.ts: an admin library REFRESH soft-marks any seeded
    // library this stub does not serve as `available = false` (plex-registry.ts), and
    // effectiveAllowedLibrariesForUser only offers AVAILABLE libraries — so a section missing here
    // silently drops that kind's /library tab for every non-admin once plex-library.spec runs.
    { key: '2', title: 'HNet TV', type: 'show', plexId: '118181362' },
    { key: '4', title: 'HNet Photos', type: 'photo', plexId: '118278404' }, // family-only
  ],
  haynesops: [{ key: '1', title: 'HOps Movies', type: 'movie', plexId: '200001' }],
  hayneskube: [
    { key: '2', title: 'HOps Music', type: 'artist', plexId: '300002' },
    { key: '4', title: 'HOps Peloton', type: 'show', plexId: '300004' },
    { key: '5', title: 'HOps YT', type: 'show', plexId: '300005' },
  ],
};

interface StubSectionItem {
  ratingKey: string;
  title: string;
  type: string;
  thumb?: string;
  childCount?: number;
  leafCount?: number;
  year?: number;
  addedAt?: number;
  // DESIGN-017 D-09 (drill-in) — hierarchy fields for /library/metadata/{key}[/children] items.
  index?: number;
  duration?: number; // ms
  originallyAvailableAt?: string; // 'YYYY-MM-DD'
  summary?: string;
  // ADR-088 / DESIGN-049 (PLAN-068) — identity + descriptive fields the watch reads consume. The watch
  // STATE (viewCount / lastViewedAt / viewOffset / viewedLeafCount) is never stored here: it is overlaid
  // from the stub's watch map at read time (see withWatch).
  guid?: string;
  Guid?: Array<{ id: string }>;
  Genre?: Array<{ tag: string }>;
  contentRating?: string;
  parentIndex?: number;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  grandparentGuid?: string;
}

// ADR-038 — canned `/library/sections/{key}/all` contents per (slug, sectionKey). One show carries a
// Plex thumb (the poster-proxy round-trip); another omits it (the KindIcon fallback tile).
const SECTION_CONTENTS: Partial<Record<Slug, Record<string, StubSectionItem[]>>> = {
  hayneskube: {
    '4': [
      {
        ratingKey: '9001',
        title: 'Bike Bootcamp',
        type: 'show',
        thumb: '/library/metadata/9001/thumb/1699',
        childCount: 4,
        leafCount: 128,
        year: 2024,
        addedAt: 1_699_990_000,
      },
      { ratingKey: '9002', title: 'Power Zone Endurance', type: 'show', childCount: 3, leafCount: 57 },
    ],
    '5': [
      {
        ratingKey: '7001',
        title: 'Documentaries',
        type: 'show',
        thumb: '/library/metadata/7001/thumb/1701',
        childCount: 6,
        leafCount: 240,
        addedAt: 1_701_000_000,
      },
    ],
  },
};

// ADR-064 / DESIGN-035 (PLAN-037) — canned `/library/sections/{key}/collections` per (slug,
// sectionKey): the HOps Movies section carries one mirrored collection whose members are the two
// seeded ledger movies' would-be Plex titles. A collections-sync run pointed at this stub mirrors
// it end-to-end; the members ride METADATA_CHILDREN like every drill-in read. (The seeded e2e
// journey itself is deferred — see the PLAN-037 plan file: the shared seed keeps its movies
// UNMATCHED, and a collections wall needs media_plex_matches rows.)
const SECTION_COLLECTIONS: Partial<Record<Slug, Record<string, StubSectionItem[]>>> = {
  haynesops: {
    '1': [{ ratingKey: '77001', title: 'Stub Franchise', type: 'collection', childCount: 2 }],
  },
};

// DESIGN-017 D-09 — the drill-in hierarchy for the k8plex stub: show ratingKey → its seasons;
// season ratingKey → its episodes. Every metadata item also records the section that owns it
// (`librarySectionID` — the router's confinement check). Bike Bootcamp (9001, section 4) mirrors the
// real Peloton shape: duration-encoded season titles, dated episodes with runtimes and stills.
const METADATA_SECTION: Record<string, string> = {
  '9001': '4',
  '9002': '4',
  '7001': '5',
  '9101': '4', // Bike Bootcamp — Season 30
  '9102': '4', // Bike Bootcamp — Season 45
  '9201': '4', // episodes…
  '9202': '4',
  '9203': '4',
  '7101': '5', // Documentaries — Season 2024
  '7201': '5',
  '77001': '1', // Stub Franchise (HOps Movies collection — ADR-064)
};

const METADATA_CHILDREN: Record<string, StubSectionItem[]> = {
  // Bike Bootcamp → seasons (duration-encoded titles, the T-111 idiom).
  '9001': [
    {
      ratingKey: '9101',
      title: 'Season 30',
      type: 'season',
      index: 30,
      leafCount: 2,
      thumb: '/library/metadata/9101/thumb/1700',
    },
    { ratingKey: '9102', title: 'Season 45', type: 'season', index: 45, leafCount: 1 },
  ],
  // Season 30 → episodes.
  '9101': [
    {
      ratingKey: '9201',
      title: '2026-06-09 - 30 min Bootcamp',
      type: 'episode',
      index: 701,
      duration: 1_991_936,
      originallyAvailableAt: '2026-06-09',
      thumb: '/library/metadata/9201/thumb/1701',
    },
    {
      ratingKey: '9202',
      title: '2026-06-02 - 30 min Bootcamp',
      type: 'episode',
      index: 700,
      duration: 1_800_000,
      originallyAvailableAt: '2026-06-02',
    },
  ],
  // Season 45 → one episode.
  '9102': [
    {
      ratingKey: '9203',
      title: '2026-05-20 - 45 min Bootcamp',
      type: 'episode',
      index: 650,
      duration: 2_700_000,
      originallyAvailableAt: '2026-05-20',
      thumb: '/library/metadata/9203/thumb/1702',
    },
  ],
  // ADR-064 (PLAN-037) — Stub Franchise (HOps Movies collection) → its member movies. The
  // ratingKeys are the HOps Plex ids the seeded ledger movies WOULD match into (tmdb 880001/880002).
  '77001': [
    { ratingKey: '6001', title: 'The Fixture', type: 'movie', year: 2022 },
    { ratingKey: '6002', title: 'Stub Runner', type: 'movie', year: 2020 },
  ],
  // Documentaries (YouTube) → one season → one episode.
  '7001': [
    { ratingKey: '7101', title: 'Season 2024', type: 'season', index: 2024, leafCount: 1 },
  ],
  '7101': [
    {
      ratingKey: '7201',
      title: 'A Stub Documentary',
      type: 'episode',
      index: 1,
      duration: 3_600_000,
      originallyAvailableAt: '2024-03-15',
      thumb: '/library/metadata/7201/thumb/1703',
    },
  ],
};

// ---------------------------------------------------------------------------
// ADR-088 / DESIGN-049 (PLAN-068 S3) — the Watch Companion dataset: the OWNER's library and watch state on
// HaynesOps (movies) and HaynesTower (movies + TV), in the SEEDED sections only (adding a section would
// change the registry refresh — see LIBRARIES). Identities line up with seed-ledger.ts (The Fixture / Stub
// Runner / Breaking Prod = tmdb 880001 / 880002 / tvdb 990001; HaynesTower 601 / 602 / 501 are the seeded
// media_plex_matches keys; HaynesOps 6001 / 6002 are the keys the Stub Franchise collection lists) and with
// stub-tautulli.ts's histories, so a `watch` sync against this stack assembles coherent Title States.
// Season 0 (specials) and a children's show exercise DESIGN-049 D-10's exclusions.
// ---------------------------------------------------------------------------

const GUID_FIXTURE = 'plex://movie/5d7768a4ad5437001f740001';
const GUID_RUNNER = 'plex://movie/5d7768a4ad5437001f740002';
const GUID_TOONS_MOVIE = 'plex://movie/5d7768a4ad5437001f740003';
const GUID_BREAKING_PROD = 'plex://show/5d9c086c46115600200a0001';
const GUID_STUB_TOONS = 'plex://show/5d9c086c46115600200a0002';

const FIXTURE: Omit<StubSectionItem, 'ratingKey'> = {
  title: 'The Fixture',
  type: 'movie',
  year: 2022,
  guid: GUID_FIXTURE,
  Guid: [{ id: 'imdb://tt8800010' }, { id: 'tmdb://880001' }],
  Genre: [{ tag: 'Action' }, { tag: 'Thriller' }],
  contentRating: 'PG-13',
  duration: 6_600_000,
  addedAt: 1_751_600_000,
};
const RUNNER: Omit<StubSectionItem, 'ratingKey'> = {
  title: 'Stub Runner',
  type: 'movie',
  year: 2020,
  guid: GUID_RUNNER,
  Guid: [{ id: 'tmdb://880002' }],
  Genre: [{ tag: 'Science Fiction' }],
  contentRating: 'R',
  duration: 6_000_000,
  addedAt: 1_751_700_000,
};
const TOONS_MOVIE: StubSectionItem = {
  ratingKey: '6003',
  title: 'Stub Toons: The Movie',
  type: 'movie',
  year: 2021,
  guid: GUID_TOONS_MOVIE,
  Guid: [{ id: 'tmdb://880003' }],
  Genre: [{ tag: 'Animation' }, { tag: 'Family' }],
  contentRating: 'G',
  duration: 5_400_000,
  addedAt: 1_751_800_000,
};
const BREAKING_PROD: StubSectionItem = {
  ratingKey: '501',
  title: 'Breaking Prod',
  type: 'show',
  year: 2019,
  guid: GUID_BREAKING_PROD,
  Guid: [{ id: 'imdb://tt9900010' }, { id: 'tmdb://55501' }, { id: 'tvdb://990001' }],
  Genre: [{ tag: 'Drama' }, { tag: 'Crime' }],
  contentRating: 'TV-MA',
  addedAt: 1_751_500_000,
};
const STUB_TOONS: StubSectionItem = {
  ratingKey: '502',
  title: 'Stub Toons',
  type: 'show',
  year: 2020,
  guid: GUID_STUB_TOONS,
  Guid: [{ id: 'tvdb://990002' }],
  Genre: [{ tag: 'Animation' }, { tag: 'Kids' }],
  contentRating: 'TV-Y7',
  addedAt: 1_751_400_000,
};

// PLAN-068 S8 — the rest of the owner's local history: a fully watched show (caught up: the stub ledger
// carries no Sonarr "ended" status for it), a Taster (one episode of twelve, months ago), and an unwatched
// show on the owner's watchlist that IS on Plex (the dev:local demo seed gives it a ledger row, so
// `recommend` has an on-Plex pick and `mark_watched` a real target).
const STUB_EXPANSE: StubSectionItem = {
  ratingKey: '503',
  title: 'Stub Expanse',
  type: 'show',
  year: 2015,
  guid: 'plex://show/5d9c086c46115600200a0003',
  Guid: [{ id: 'tvdb://990003' }, { id: 'tmdb://55503' }],
  Genre: [{ tag: 'Science Fiction' }, { tag: 'Drama' }],
  contentRating: 'TV-14',
  addedAt: 1_751_300_000,
};
const STUB_BIG_BROTHER: StubSectionItem = {
  ratingKey: '504',
  title: 'Stub Big Brother',
  type: 'show',
  year: 2000,
  guid: 'plex://show/5d9c086c46115600200a0004',
  Guid: [{ id: 'tvdb://990004' }],
  Genre: [{ tag: 'Reality' }],
  contentRating: 'TV-14',
  addedAt: 1_751_200_000,
};
const STUB_SEVERANCE: StubSectionItem = {
  ratingKey: '506',
  title: 'Stub Severance',
  type: 'show',
  year: 2022,
  guid: 'plex://show/5d9f35110000000000000001',
  Guid: [{ id: 'imdb://tt9900020' }, { id: 'tmdb://95396' }, { id: 'tvdb://990020' }],
  Genre: [{ tag: 'Drama' }, { tag: 'Mystery' }, { tag: 'Science Fiction' }],
  contentRating: 'TV-MA',
  addedAt: 1_758_000_000,
};

/** The watch sections, per (slug, sectionKey) — served ALONGSIDE SECTION_CONTENTS. */
const WATCH_SECTION_CONTENTS: Partial<Record<Slug, Record<string, StubSectionItem[]>>> = {
  haynesops: { '1': [{ ratingKey: '6001', ...FIXTURE }, { ratingKey: '6002', ...RUNNER }, TOONS_MOVIE] },
  haynestower: {
    '1': [
      { ratingKey: '601', ...FIXTURE },
      { ratingKey: '602', ...RUNNER },
    ],
    '2': [BREAKING_PROD, STUB_TOONS, STUB_EXPANSE, STUB_BIG_BROTHER, STUB_SEVERANCE],
  },
};

function watchSeason(show: StubSectionItem, ratingKey: string, index: number): StubSectionItem {
  return {
    ratingKey,
    title: index === 0 ? 'Specials' : `Season ${index}`,
    type: 'season',
    index,
    parentRatingKey: show.ratingKey,
    guid: `plex://season/${show.ratingKey}-${index}`,
  };
}

function watchEpisode(
  show: StubSectionItem,
  seasonKey: string,
  season: number,
  episode: number,
  ratingKey: string,
  airDate: string,
): StubSectionItem {
  return {
    ratingKey,
    title: `${show.title} ${season === 0 ? 'Special' : 'Episode'} ${season}x${episode}`,
    type: 'episode',
    index: episode,
    parentIndex: season,
    parentRatingKey: seasonKey,
    grandparentRatingKey: show.ratingKey,
    grandparentTitle: show.title,
    grandparentGuid: show.guid,
    guid: `plex://episode/${ratingKey}`,
    contentRating: show.contentRating,
    duration: 2_700_000,
    originallyAvailableAt: airDate,
  };
}

/** The watch shows' hierarchy (show → seasons → episodes), served ALONGSIDE METADATA_CHILDREN. */
const WATCH_CHILDREN: Record<string, StubSectionItem[]> = {
  '501': [
    watchSeason(BREAKING_PROD, '5010', 0),
    watchSeason(BREAKING_PROD, '5011', 1),
    watchSeason(BREAKING_PROD, '5012', 2),
  ],
  '5010': [watchEpisode(BREAKING_PROD, '5010', 0, 1, '50101', '2019-12-20')],
  '5011': [
    watchEpisode(BREAKING_PROD, '5011', 1, 1, '50111', '2019-01-06'),
    watchEpisode(BREAKING_PROD, '5011', 1, 2, '50112', '2019-01-13'),
    watchEpisode(BREAKING_PROD, '5011', 1, 3, '50113', '2019-01-20'),
  ],
  '5012': [
    watchEpisode(BREAKING_PROD, '5012', 2, 1, '50121', '2020-01-05'),
    watchEpisode(BREAKING_PROD, '5012', 2, 2, '50122', '2020-01-12'),
  ],
  '502': [watchSeason(STUB_TOONS, '5021', 1)],
  '5021': [
    watchEpisode(STUB_TOONS, '5021', 1, 1, '50211', '2020-03-01'),
    watchEpisode(STUB_TOONS, '5021', 1, 2, '50212', '2020-03-08'),
  ],
  '503': [watchSeason(STUB_EXPANSE, '5031', 1), watchSeason(STUB_EXPANSE, '5032', 2)],
  '5031': [
    watchEpisode(STUB_EXPANSE, '5031', 1, 1, '50311', '2015-12-14'),
    watchEpisode(STUB_EXPANSE, '5031', 1, 2, '50312', '2015-12-21'),
  ],
  '5032': [
    watchEpisode(STUB_EXPANSE, '5032', 2, 1, '50321', '2017-02-01'),
    watchEpisode(STUB_EXPANSE, '5032', 2, 2, '50322', '2017-02-08'),
  ],
  '504': [watchSeason(STUB_BIG_BROTHER, '5041', 1)],
  '5041': Array.from({ length: 12 }, (_, i) =>
    watchEpisode(STUB_BIG_BROTHER, '5041', 1, i + 1, `5041${String(i + 1).padStart(2, '0')}`, '2000-07-05'),
  ),
  '506': [watchSeason(STUB_SEVERANCE, '5061', 1)],
  '5061': Array.from({ length: 3 }, (_, i) =>
    watchEpisode(STUB_SEVERANCE, '5061', 1, i + 1, `5061${i + 1}`, '2022-02-18'),
  ),
};

/** The owning section of every watch item (the metadata/children `librarySectionID`). */
const WATCH_SECTION_OF: Record<string, string> = Object.fromEntries([
  ...['6001', '6002', '6003', '601', '602'].map((k) => [k, '1'] as const),
  ...['501', '502', ...Object.keys(WATCH_CHILDREN)].map((k) => [k, '2'] as const),
  ...Object.values(WATCH_CHILDREN)
    .flat()
    .map((i) => [i.ratingKey, '2'] as const),
]);

/** Show/season keys whose counts (leafCount / viewedLeafCount / lastViewedAt) derive from the watch map. */
const WATCH_CONTAINERS = new Set<string>(['501', '502', ...Object.keys(WATCH_CHILDREN)]);

/** Seconds since the epoch for a UTC wall time. */
function epochSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** The owner's watch state for one item: plays, last view (epoch s), resume point (ms). */
interface WatchState {
  viewCount: number;
  lastViewedAt?: number;
  viewOffset?: number;
}

/**
 * The SEEDED owner state (reset by POST /_stub/reset). The Fixture is watched on both servers (plex.tv
 * view-state sync); Stub Runner is in progress on HaynesOps only (resume points do not sync); Breaking
 * Prod is watched through S2E1 (next: S2E2) with its special unwatched; Stub Toons (a children's show)
 * has one episode watched; Stub Expanse is fully watched; Stub Big Brother is a Taster (1 of 12); Stub
 * Severance (on the watchlist) is untouched.
 */
const WATCH_SEED: Record<string, WatchState> = {
  // Last views = the stop times of the matching stub-tautulli history rows.
  '6001': { viewCount: 1, lastViewedAt: epochSeconds('2026-09-20T03:40:00Z') },
  '601': { viewCount: 1, lastViewedAt: epochSeconds('2026-09-20T03:40:00Z') },
  '6002': { viewCount: 0, lastViewedAt: epochSeconds('2026-09-22T04:10:00Z'), viewOffset: 1_800_000 },
  '50111': { viewCount: 1, lastViewedAt: epochSeconds('2026-01-06T02:45:00Z') },
  '50112': { viewCount: 1, lastViewedAt: epochSeconds('2026-01-07T02:45:00Z') },
  '50113': { viewCount: 1, lastViewedAt: epochSeconds('2026-01-09T02:45:00Z') },
  '50121': { viewCount: 1, lastViewedAt: epochSeconds('2026-08-30T02:45:00Z') },
  '50211': { viewCount: 1, lastViewedAt: epochSeconds('2026-03-01T17:45:00Z') },
  // Stub Expanse: every episode watched in March 2025. Stub Big Brother: one episode sampled in May.
  '50311': { viewCount: 1, lastViewedAt: epochSeconds('2025-03-01T02:45:00Z') },
  '50312': { viewCount: 1, lastViewedAt: epochSeconds('2025-03-02T02:45:00Z') },
  '50321': { viewCount: 1, lastViewedAt: epochSeconds('2025-03-08T02:45:00Z') },
  '50322': { viewCount: 1, lastViewedAt: epochSeconds('2025-03-09T02:45:00Z') },
  '504101': { viewCount: 1, lastViewedAt: epochSeconds('2026-05-01T02:45:00Z') },
};

/** A plex.tv discover watchlist (newest-watchlisted first): one title on Plex, two that are not. */
const WATCHLIST: StubSectionItem[] = [
  {
    ratingKey: '5d9f35110000000000000001',
    title: 'Stub Severance',
    type: 'show',
    year: 2022,
    guid: 'plex://show/5d9f35110000000000000001',
    Guid: [{ id: 'imdb://tt9900020' }, { id: 'tmdb://95396' }, { id: 'tvdb://990020' }],
    contentRating: 'TV-MA',
    addedAt: 1_645_142_400, // a CATALOG date, as live — not the watchlist time
  },
  {
    ratingKey: '5d776d1b0000000000000002',
    title: 'Stub Dune',
    type: 'movie',
    year: 2021,
    guid: 'plex://movie/5d776d1b0000000000000002',
    Guid: [{ id: 'imdb://tt8800020' }, { id: 'tmdb://880020' }],
    contentRating: 'PG-13',
    addedAt: 1_631_664_000,
  },
  { ratingKey: '5d7768a4ad5437001f740002', ...RUNNER },
];

/** Plex metadata `type` numbers the section-listing `type=` filter accepts. */
const PLEX_TYPE_NUMBERS: Record<string, string> = { '1': 'movie', '2': 'show', '3': 'season', '4': 'episode' };

/**
 * ADR-092 / DESIGN-051 D-11 — the discover catalog the stub's `library/metadata/matches` answers from: every
 * watchlist title and every library title whose guid is a `plex://movie|show/<24 hex>` (its discover id is the
 * suffix, as live), once each.
 */
function discoverCatalog(): StubSectionItem[] {
  const out = new Map<string, StubSectionItem>();
  const library = Object.values(WATCH_SECTION_CONTENTS).flatMap((bySection) => Object.values(bySection ?? {}).flat());
  for (const item of [...WATCHLIST, ...library]) {
    const m = /^plex:\/\/(movie|show)\/([0-9a-f]{24})$/.exec(item.guid ?? '');
    if (!m || out.has(m[2]!)) continue;
    out.set(m[2]!, { ...item, ratingKey: m[2]! });
  }
  return [...out.values()];
}

/** A section's items: the canned fixtures plus the watch dataset. */
function sectionItems(slug: Slug, sectionKey: string): StubSectionItem[] {
  return [
    ...(SECTION_CONTENTS[slug]?.[sectionKey] ?? []),
    ...(WATCH_SECTION_CONTENTS[slug]?.[sectionKey] ?? []),
  ];
}

/** An item's direct children (seasons of a show, episodes of a season, members of a collection). */
function childrenOf(ratingKey: string): StubSectionItem[] {
  return METADATA_CHILDREN[ratingKey] ?? WATCH_CHILDREN[ratingKey] ?? [];
}

/** Every episode under a show or season (specials included), in (season, episode) order; a leaf is itself. */
function leavesOf(item: StubSectionItem): StubSectionItem[] {
  if (item.type === 'movie' || item.type === 'episode') return [item];
  return childrenOf(item.ratingKey)
    .flatMap((child) =>
      child.type === 'season' ? childrenOf(child.ratingKey) : child.type === 'episode' ? [child] : [],
    )
    .sort((a, b) => (a.parentIndex ?? 0) - (b.parentIndex ?? 0) || (a.index ?? 0) - (b.index ?? 0));
}

/**
 * The server each WATCH item lives on. Real ratingKeys are server-local, so a watch item (and everything
 * under a watch show) answers ONLY to its own server's token: a server / ratingKey mix-up — the core risk of
 * a Watch Mark — 404s here as it would live. The pre-existing fixtures stay server-agnostic, as before.
 */
const WATCH_SERVER_OF = new Map<string, Slug>();
for (const [slug, bySection] of Object.entries(WATCH_SECTION_CONTENTS) as Array<
  [Slug, Record<string, StubSectionItem[]>]
>) {
  const claim = (item: StubSectionItem): void => {
    WATCH_SERVER_OF.set(item.ratingKey, slug);
    for (const child of WATCH_CHILDREN[item.ratingKey] ?? []) claim(child);
  };
  for (const items of Object.values(bySection)) items.forEach(claim);
}

/** A watch item is addressable only with its own server's token; anything else answers as before. */
function watchVisible(ratingKey: string, slug: Slug | undefined): boolean {
  const owner = WATCH_SERVER_OF.get(ratingKey);
  return owner === undefined || owner === slug;
}

/**
 * Find one metadata item (show/season/episode/movie) by ratingKey across the canned hierarchy, as seen by
 * `slug`'s token: the watch pools only yield the token's own server's items (see WATCH_SERVER_OF).
 */
function findMetadataItem(ratingKey: string, slug?: Slug): StubSectionItem | undefined {
  const ownWatch = (items: StubSectionItem[]) =>
    items.filter((i) => WATCH_SERVER_OF.get(i.ratingKey) === slug);
  const pools = [
    ...Object.values(SECTION_CONTENTS.hayneskube ?? {}),
    ...Object.values(WATCH_SECTION_CONTENTS)
      .flatMap((bySection) => Object.values(bySection ?? {}))
      .map(ownWatch),
    ...Object.values(METADATA_CHILDREN),
    ...Object.values(WATCH_CHILDREN).map(ownWatch),
  ];
  for (const items of pools) {
    const hit = items.find((i) => i.ratingKey === ratingKey);
    if (hit) return hit;
  }
  return undefined;
}

// A 1x1 transparent PNG the stub streams for any Plex thumb path (so the poster proxy returns a 200).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const SLUG_BY_TOKEN = new Map<string, Slug>(
  (Object.entries(STUB_PLEX_TOKENS) as Array<[Slug, string]>).map(([slug, token]) => [token, slug]),
);
const SLUG_BY_MID = new Map<string, Slug>(
  (Object.entries(STUB_PLEX_MACHINE_IDS) as Array<[Slug, string]>).map(([slug, mid]) => [mid, slug]),
);

export interface RecordedPlexShareWrite {
  method: string;
  path: string;
  machineId: string;
  body: unknown;
}

export interface StubPlexServer {
  baseUrl: string;
  port: number;
  calls: RecordedPlexShareWrite[];
  stop: () => Promise<void>;
}

interface SharedServerState {
  id: string;
  userId: string;
  sectionIds: Set<string>; // plex.tv section ids currently shared
  /** ADR-017 C-14 — a share-everything (incl. future libraries) grant; read-only in self-service. */
  allLibraries?: boolean;
}

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function xml(res: import('node:http').ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
}

export async function startStubPlex(): Promise<StubPlexServer> {
  const calls: RecordedPlexShareWrite[] = [];
  // Per-machine shared_servers state (userId → SharedServerState).
  const shares = new Map<string, Map<string, SharedServerState>>();
  const sharesFor = (mid: string) => {
    let m = shares.get(mid);
    if (!m) shares.set(mid, (m = new Map()));
    return m;
  };
  // ADR-024 (live 2026-07-06) — the member's role ALL-grants haynesops (seed-ledger) and their
  // account starts in the plex.tv all-libraries state on that server (share-everything, incl. future
  // libraries; the owner's-wife case). The My Plex page can then exercise the leave-All / re-enter-All
  // flow. Set directly (NOT via a recorded write) so the add/remove specs' call log stays clean.
  const seedFixtures = () => {
    const opsMid = STUB_PLEX_MACHINE_IDS.haynesops;
    sharesFor(opsMid).set(STUB_PLEX_MEMBER.id, {
      id: 'ss-alllibs',
      userId: STUB_PLEX_MEMBER.id,
      sectionIds: new Set(LIBRARIES.haynesops.map((s) => s.plexId)),
      allLibraries: true,
    });
  };
  // ADR-029 — the OWNER account email `GET /api/v2/user` reports (runtime-overridable for UX capture).
  let ownerEmail = STUB_PLEX_OWNER.email;
  // ADR-088 / DESIGN-049 (PLAN-068) — the owner's watch map (ratingKey → state), flipped by
  // /:/scrobble + /:/unscrobble and overlaid on every read.
  const watch = new Map<string, WatchState>();
  const seedWatch = () => {
    watch.clear();
    for (const [key, state] of Object.entries(WATCH_SEED)) watch.set(key, { ...state });
  };
  // ADR-092 / DESIGN-051 D-11 — the owner's plex.tv watchlist (newest first) and when each title was added.
  const catalog = discoverCatalog();
  let watchlist: StubSectionItem[] = [];
  const watchlistedAt = new Map<string, number>();
  const seedWatchlist = () => {
    watchlist = WATCHLIST.map((item) => ({ ...item }));
    watchlistedAt.clear();
    const now = Math.floor(Date.now() / 1000);
    watchlist.forEach((item, i) => watchlistedAt.set(item.ratingKey, now - (i + 1) * 86_400));
  };
  // ADR-093 / DESIGN-052 D-20 — community lists by account uuid (the managed user is absent ⇒ `User not found:`).
  const communityLists = new Map<string, Array<{ id: string; type: 'MOVIE' | 'SHOW' }>>();
  const seedCommunity = () => {
    communityLists.clear();
    communityLists.set(STUB_REGISTRY_ACCOUNTS.member.uuid, STUB_COMMUNITY_DEFAULT_NODES.map((n) => ({ ...n })));
    communityLists.set(STUB_REGISTRY_ACCOUNTS.hiddenFriend.uuid, []);
  };
  const resetState = () => {
    calls.length = 0;
    shares.clear();
    ownerEmail = STUB_PLEX_OWNER.email;
    seedFixtures();
    seedWatch();
    seedWatchlist();
    seedCommunity();
  };
  seedFixtures();
  seedWatch();
  seedWatchlist();
  seedCommunity();

  /**
   * Overlay the watch map the way Plex reports it: a leaf (movie/episode) gains viewCount only once
   * watched, lastViewedAt once ever viewed, viewOffset only with a resume point; a WATCH show/season derives
   * leafCount / viewedLeafCount / lastViewedAt / viewCount from its episodes (specials included, as Plex
   * counts them). Items outside the watch dataset with no state come back untouched. The state is the
   * token's server's only: another server's token reading a same-numbered key never sees it.
   */
  const withWatch = (item: StubSectionItem, slug: Slug | undefined): Record<string, unknown> => {
    if (item.type === 'movie' || item.type === 'episode') {
      const state = watchVisible(item.ratingKey, slug) ? watch.get(item.ratingKey) : undefined;
      if (!state) return { ...item };
      return {
        ...item,
        ...(state.viewCount > 0 ? { viewCount: state.viewCount } : {}),
        ...(state.lastViewedAt ? { lastViewedAt: state.lastViewedAt } : {}),
        ...(state.viewOffset ? { viewOffset: state.viewOffset } : {}),
      };
    }
    if (!WATCH_CONTAINERS.has(item.ratingKey) || !watchVisible(item.ratingKey, slug)) return { ...item };
    const states = leavesOf(item).map((leaf) => watch.get(leaf.ratingKey));
    const watched = states.filter((state) => (state?.viewCount ?? 0) > 0);
    const lastViewedAt = Math.max(0, ...states.map((state) => state?.lastViewedAt ?? 0));
    return {
      ...item,
      leafCount: states.length,
      viewedLeafCount: watched.length,
      ...(item.type === 'show' ? { childCount: childrenOf(item.ratingKey).length } : {}),
      ...(watched.length > 0 ? { viewCount: watched.reduce((n, st) => n + (st?.viewCount ?? 0), 0) } : {}),
      ...(lastViewedAt > 0 ? { lastViewedAt } : {}),
    };
  };

  /** Plex's `unwatched` / `inProgress` section filters, over overlaid items (verified-live semantics). */
  const matchesWatchFilters = (item: Record<string, unknown>, params: URLSearchParams): boolean => {
    const viewCount = Number(item.viewCount ?? 0);
    const leafCount = Number(item.leafCount ?? 0);
    const viewedLeafCount = Number(item.viewedLeafCount ?? 0);
    const isContainer = item.type === 'show' || item.type === 'season';
    const fullyWatched = isContainer ? leafCount > 0 && viewedLeafCount >= leafCount : viewCount > 0;
    const unwatched = params.get('unwatched');
    if (unwatched === '1' && fullyWatched) return false;
    if (unwatched === '0' && !fullyWatched) return false;
    if (params.get('inProgress') === '1' && !(Number(item.viewOffset ?? 0) > 0)) return false;
    return true;
  };

  /** One X-Plex-Container window of `items`, with the MediaContainer paging fields Plex sends. */
  const containerPage = (items: Array<Record<string, unknown>>, params: URLSearchParams) => {
    const start = Math.max(Number(params.get('X-Plex-Container-Start') ?? 0) || 0, 0);
    const rawSize = params.get('X-Plex-Container-Size');
    const size = rawSize === null ? items.length : Math.max(Number(rawSize) || 0, 0);
    const withGuids = params.get('includeGuids') === '1';
    const Metadata = items.slice(start, start + size).map((item) => {
      if (withGuids) return item;
      const copy = { ...item };
      delete copy.Guid; // Plex sends the external Guid[] only with includeGuids=1
      return copy;
    });
    return { size: Metadata.length, totalSize: items.length, offset: start, Metadata };
  };

  const thumb = (uuid: string) => `https://plex.tv/users/${uuid}/avatar?c=1700000000`;
  const usersXml = () =>
    `<MediaContainer friendlyName="StubPlex" identifier="com.plexapp.plugins.myplex" size="3">` +
    `<User id="${STUB_PLEX_MEMBER.id}" title="Marge Member" username="${STUB_PLEX_MEMBER.username}" email="${esc(STUB_PLEX_MEMBER.email)}" thumb="${thumb(STUB_REGISTRY_ACCOUNTS.member.uuid)}" home="0" restricted="0">` +
    `<Server id="900" machineIdentifier="${STUB_PLEX_MACHINE_IDS.haynestower}" name="HaynesTower" owned="0" allLibraries="0" numLibraries="2"/>` +
    `</User>` +
    // ADR-093 / DESIGN-052 D-20 — the registry fixture's hidden-empty friend and managed Home user (no email, as
    // managed users have none; they match no persona, so the sharing specs are unchanged).
    `<User id="${STUB_REGISTRY_ACCOUNTS.hiddenFriend.id}" title="Quiet Friend" username="quietfriend" thumb="${thumb(STUB_REGISTRY_ACCOUNTS.hiddenFriend.uuid)}" home="0" restricted="0"/>` +
    `<User id="${STUB_REGISTRY_ACCOUNTS.managed.id}" title="Little One" thumb="${thumb(STUB_REGISTRY_ACCOUNTS.managed.uuid)}" home="1" restricted="1"/>` +
    `</MediaContainer>`;
  const homeUsersXml = () =>
    `<MediaContainer friendlyName="StubPlex" size="2">` +
    `<User id="${STUB_PLEX_OWNER.id}" admin="1" restricted="0" guest="0" title="Stub Owner"/>` +
    `<User id="${STUB_REGISTRY_ACCOUNTS.managed.id}" admin="0" restricted="1" guest="0" title="Little One" thumb="${thumb(STUB_REGISTRY_ACCOUNTS.managed.uuid)}"/>` +
    `</MediaContainer>`;

  const serverSectionsXml = (slug: Slug) =>
    `<MediaContainer size="1"><Server name="${slug}" machineIdentifier="${STUB_PLEX_MACHINE_IDS[slug]}">` +
    LIBRARIES[slug]
      .map((s) => `<Section id="${s.plexId}" key="${s.key}" type="${s.type}" title="${esc(s.title)}"/>`)
      .join('') +
    `</Server></MediaContainer>`;

  const sharedServersXml = (slug: Slug, mid: string) => {
    const state = sharesFor(mid);
    const rows = [...state.values()]
      .map((ss) => {
        const sections = LIBRARIES[slug]
          .map(
            (s) =>
              `<Section id="${s.plexId}" key="${s.key}" title="${esc(s.title)}" type="${s.type}" shared="${ss.sectionIds.has(s.plexId) ? '1' : '0'}"/>`,
          )
          .join('');
        return (
          `<SharedServer id="${ss.id}" username="${STUB_PLEX_MEMBER.username}" email="${esc(STUB_PLEX_MEMBER.email)}" userID="${ss.userId}" name="${slug}" allLibraries="${ss.allLibraries ? '1' : '0'}" owned="0">` +
          sections +
          `</SharedServer>`
        );
      })
      .join('');
    return `<MediaContainer size="${state.size}" machineIdentifier="${mid}">${rows}</MediaContainer>`;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const path = url.pathname;
      const token = req.headers['x-plex-token'];
      const tokenStr = Array.isArray(token) ? token[0] : token;
      // ADR-088 (PLAN-068) — the server this token belongs to: scopes the watch dataset and its state.
      const viewer = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
      const overlay = (item: StubSectionItem) => withWatch(item, viewer);

      // ---- control surface ----
      if (path === '/_stub/calls') return json(res, 200, { calls });
      if (path === '/_stub/reset' && method === 'POST') {
        resetState();
        res.writeHead(204);
        return res.end();
      }
      // ADR-029 — set the OWNER email so a persona can be recognized as the server owner.
      if (path === '/_stub/owner' && method === 'POST') {
        const raw = await readBody(req);
        const b = raw === '' ? {} : (JSON.parse(raw) as { email?: string });
        ownerEmail = (b.email ?? '').trim();
        res.writeHead(204);
        return res.end();
      }

      // ADR-093 / DESIGN-052 D-20 — set one account's community list (`{ uuid, nodes }`), e.g. for the dev walk.
      if (path === '/_stub/community' && method === 'POST') {
        const raw = await readBody(req);
        const b = raw === '' ? {} : (JSON.parse(raw) as { uuid?: string; nodes?: Array<{ id: string; type: 'MOVIE' | 'SHOW' }> });
        if (b.uuid) communityLists.set(b.uuid, b.nodes ?? []);
        res.writeHead(204);
        return res.end();
      }
      // ADR-093 / DESIGN-052 D-02 — community.plex.tv GraphQL (PLEX_COMMUNITY_URL points here): `user(id:$uuid)
      // .watchlist` as an HTTP GET, answered by content like the live API: data for a readable account (the
      // upper-case MOVIE / SHOW enum), an empty list for the hidden friend, `User not found:` otherwise.
      if (path === '/api' && method === 'GET') {
        if (!tokenStr || !SLUG_BY_TOKEN.has(tokenStr)) return json(res, 401, { errors: [{ message: 'unauthorized' }] });
        let vars: { uuid?: string; first?: number; after?: string | null } = {};
        try {
          vars = JSON.parse(url.searchParams.get('variables') ?? '{}') as typeof vars;
        } catch {
          return json(res, 400, { errors: [{ message: 'bad variables' }] });
        }
        const nodes = communityLists.get(vars.uuid ?? '');
        if (nodes === undefined) {
          return json(res, 200, { data: { user: null }, errors: [{ message: 'User not found: Data loader item not found' }] });
        }
        return json(res, 200, {
          data: {
            user: {
              watchlist: {
                nodes: nodes.map((n) => ({ ...n, guid: `plex://${n.type === 'MOVIE' ? 'movie' : 'show'}/${n.id}`, title: 'x', year: 2021 })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      if (path === '/api/home/users') return xml(res, 200, homeUsersXml());

      // ---- plex.tv account read (owner identity — ADR-029) ----
      if (path === '/api/v2/user') {
        return json(res, 200, {
          id: Number(STUB_PLEX_OWNER.id),
          uuid: 'stub-owner-uuid',
          username: STUB_PLEX_OWNER.username,
          title: 'Stub Owner',
          email: ownerEmail,
        });
      }

      // ---- PMS reads (disambiguated by token) ----
      if (path === '/identity') {
        const slug = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
        const mid = slug ? STUB_PLEX_MACHINE_IDS[slug] : 'stub-unknown';
        return json(res, 200, { MediaContainer: { machineIdentifier: mid, version: '1.43.2.10687-e2e' } });
      }
      if (path === '/library/sections') {
        const slug = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
        const Directory = slug
          ? LIBRARIES[slug].map((s) => ({ key: s.key, type: s.type, title: s.title, agent: 'tv.plex.agents.none' }))
          : [];
        return json(res, 200, { MediaContainer: { size: Directory.length, Directory } });
      }
      // ADR-089 / DESIGN-049 D-09 step 6 (PLAN-068) — the plex.tv DISCOVER watchlist (PLEX_DISCOVER_URL points
      // here). Matched BEFORE the section listing below, which would take `watchlist` for a section key. Any
      // owner token reads it (all three are the owner's account); a container over 100 is refused with 400,
      // exactly like the live provider.
      if (path === '/library/sections/watchlist/all') {
        if (!tokenStr || !SLUG_BY_TOKEN.has(tokenStr)) return json(res, 401, { error: 'unauthorized' });
        if (Number(url.searchParams.get('X-Plex-Container-Size') ?? 20) > 100) {
          return json(res, 400, { error: 'X-Plex-Container-Size must be at most 100' });
        }
        const params = new URLSearchParams(url.searchParams);
        if (!params.has('X-Plex-Container-Size')) params.set('X-Plex-Container-Size', '20');
        return json(res, 200, {
          MediaContainer: {
            librarySectionID: 'watchlist',
            identifier: 'tv.plex.provider.discover',
            ...containerPage(
              watchlist.map((item) => ({ ...item })),
              params,
            ),
          },
        });
      }
      // ADR-092 / DESIGN-051 D-11 — the discover provider's watchlist writes, its external-id match and its
      // per-title userState, all against the in-memory watchlist above. Matched BEFORE the generic
      // `/library/metadata/<key>` routes below (which would take `matches` for a key). Any owner token (all
      // three are the owner's account), like the listing.
      if ((path === '/actions/addToWatchlist' || path === '/actions/removeFromWatchlist') && method === 'PUT') {
        if (!tokenStr || !SLUG_BY_TOKEN.has(tokenStr)) return json(res, 401, { error: 'unauthorized' });
        const id = url.searchParams.get('ratingKey') ?? '';
        const item = catalog.find((c) => c.ratingKey === id);
        if (!item) {
          return json(res, 404, {
            Error: { error: 'Not Found', message: `MetadataItem for ${id} not found!`, statusCode: 404 },
          });
        }
        calls.push({ method, path, machineId: viewer ?? '', body: { ratingKey: id } });
        const on = watchlist.some((w) => w.ratingKey === id);
        if (path === '/actions/addToWatchlist' && !on) {
          watchlist = [{ ...item }, ...watchlist];
          watchlistedAt.set(id, Math.floor(Date.now() / 1000));
        }
        if (path === '/actions/removeFromWatchlist' && on) {
          watchlist = watchlist.filter((w) => w.ratingKey !== id);
          watchlistedAt.delete(id);
        }
        return json(res, 200, { MediaContainer: { size: 0 } });
      }
      if (path === '/library/metadata/matches') {
        if (!tokenStr || !SLUG_BY_TOKEN.has(tokenStr)) return json(res, 401, { error: 'unauthorized' });
        const type = PLEX_TYPE_NUMBERS[url.searchParams.get('type') ?? ''];
        if (type !== 'movie' && type !== 'show') return json(res, 400, { error: 'type is required' });
        const guid = url.searchParams.get('guid') ?? '';
        const Metadata = catalog
          .filter((c) => c.type === type && (c.Guid ?? []).some((g) => g.id === guid))
          .map((c) => ({ type: c.type, title: c.title, year: c.year, ratingKey: c.ratingKey, guid: c.guid, Guid: c.Guid ?? [] }));
        return json(res, 200, {
          MediaContainer: { size: Metadata.length, identifier: 'tv.plex.provider.metadata', ...(Metadata.length > 0 ? { Metadata } : {}) },
        });
      }
      const userStateMatch = path.match(/^\/library\/metadata\/([0-9a-f]{24})\/userState$/);
      if (userStateMatch) {
        if (!tokenStr || !SLUG_BY_TOKEN.has(tokenStr)) return json(res, 401, { error: 'unauthorized' });
        const id = userStateMatch[1]!;
        const item = catalog.find((c) => c.ratingKey === id);
        if (!item) return json(res, 404, { Error: { error: 'Not Found', statusCode: 404 } });
        const at = watchlistedAt.get(id);
        // The one-element-array form (both it and a bare object were seen live).
        return json(res, 200, {
          MediaContainer: {
            size: 1,
            UserState: [{ ratingKey: id, type: item.type, ...(at !== undefined ? { watchlistedAt: at } : {}) }],
          },
        });
      }
      // ADR-038 (PLAN-022) — a library section's contents (the ytdl-sub shows). ADR-088 / DESIGN-049 (PLAN-068)
      // adds the watch dataset, the `type` / `unwatched` / `inProgress` filters, Start/Size paging with the
      // filtered totalSize, and `includeGuids` (Guid[] only when asked, as Plex does).
      const allMatch = path.match(/^\/library\/sections\/([^/]+)\/all$/);
      if (allMatch) {
        const slug = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
        const key = allMatch[1]!;
        const top = slug ? sectionItems(slug, key) : [];
        const typeName = url.searchParams.has('type')
          ? PLEX_TYPE_NUMBERS[url.searchParams.get('type') ?? ''] ?? 'unsupported'
          : null;
        const listed =
          typeName === null
            ? top
            : typeName === 'episode'
              ? top.flatMap(leavesOf)
              : typeName === 'season'
                ? top.flatMap((show) => childrenOf(show.ratingKey).filter((c) => c.type === 'season'))
                : top.filter((item) => item.type === typeName);
        const items = listed.map(overlay).filter((item) => matchesWatchFilters(item, url.searchParams));
        return json(res, 200, { MediaContainer: containerPage(items, url.searchParams) });
      }
      // ADR-088 / DESIGN-049 D-14 step 2 (PLAN-068) — `/library/all?guid=`: this server's items with the guid.
      if (path === '/library/all') {
        const slug = viewer;
        const guid = url.searchParams.get('guid') ?? '';
        const hits = slug
          ? LIBRARIES[slug]
              .flatMap((section) => sectionItems(slug, section.key))
              .filter((item) => guid !== '' && item.guid === guid)
              .map(overlay)
          : [];
        return json(res, 200, { MediaContainer: containerPage(hits, url.searchParams) });
      }
      // ADR-088 / DESIGN-049 D-14/D-15 (PLAN-068) — Plex's GET-shaped watched-state WRITES. Recorded in `calls`
      // (like the other writes) and applied to the watch map: scrobble marks every leaf under the key watched
      // (a show or season key covers all its episodes), unscrobble clears them (resume points included).
      if ((path === '/:/scrobble' || path === '/:/unscrobble') && method === 'GET') {
        const slug = viewer;
        if (!slug) return json(res, 401, { message: 'unauthorized' });
        if (url.searchParams.get('identifier') !== 'com.plexapp.plugins.library') {
          return json(res, 400, { message: 'identifier must be com.plexapp.plugins.library' });
        }
        const key = url.searchParams.get('key') ?? '';
        const target = findMetadataItem(key, slug);
        if (!target) return json(res, 404, { message: 'no such metadata' });
        calls.push({ method, path, machineId: slug, body: { key } });
        const now = Math.floor(Date.now() / 1000);
        for (const leaf of leavesOf(target)) {
          const prev = watch.get(leaf.ratingKey);
          watch.set(
            leaf.ratingKey,
            path === '/:/scrobble' ? { viewCount: (prev?.viewCount ?? 0) + 1, lastViewedAt: now } : { viewCount: 0 },
          );
        }
        res.writeHead(200);
        return res.end();
      }
      // ADR-064 (PLAN-037) — a section's Plex collections (the collections-sync fetcher's listing).
      // The fixture fits one container page; totalSize ends the client's paging loop immediately.
      const collectionsMatch = path.match(/^\/library\/sections\/([^/]+)\/collections$/);
      if (collectionsMatch) {
        const slug = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
        const key = collectionsMatch[1]!;
        const Metadata = (slug && SECTION_COLLECTIONS[slug]?.[key]) || [];
        return json(res, 200, {
          MediaContainer: { size: Metadata.length, totalSize: Metadata.length, Metadata },
        });
      }
      // ADR-043 (PLAN-024) — the poster-upload WRITE surface (the confined Plex write client's uploadPoster): the poster
      // guard POSTs raw image bytes to select a durable override poster. Record the call (so a guard
      // integration test can assert which ratingKeys were re-pushed) and 200. This is the ONLY direct-PMS
      // write the stub accepts.
      const postersMatch = path.match(/^\/library\/metadata\/([^/]+)\/posters$/);
      if (postersMatch && method === 'POST') {
        const raw = await readBody(req);
        const slug = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
        calls.push({ method, path, machineId: slug ?? '', body: `poster:${raw.length}` });
        return json(res, 200, { MediaContainer: { size: 1 } });
      }
      // ADR-038 — the Plex thumb the poster proxy streams (a tiny PNG for any /library/…/thumb/… path).
      if (/^\/library\/metadata\/[^/]+\/thumb\//.test(path)) {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(TINY_PNG.length) });
        return res.end(TINY_PNG);
      }
      // ADR-041 D-07 — the photo-transcode endpoint the sized poster variants ride. The stub serves
      // the same tiny image (webp-labelled) for any known /library/… url= target; an unknown target
      // 404s so the route's original-art fallback is exercised in tests that want it.
      if (path === '/photo/:/transcode') {
        const target = url.searchParams.get('url') ?? '';
        if (!target.startsWith('/library/')) return json(res, 404, { message: 'bad transcode url' });
        res.writeHead(200, { 'content-type': 'image/webp', 'content-length': String(TINY_PNG.length) });
        return res.end(TINY_PNG);
      }
      // DESIGN-017 D-09 — a show's/season's children (seasons/episodes) with the owning section id.
      const childrenMatch = path.match(/^\/library\/metadata\/([^/]+)\/children$/);
      if (childrenMatch) {
        const key = childrenMatch[1]!;
        const Metadata = (watchVisible(key, viewer) ? childrenOf(key) : []).map(overlay);
        const sectionId = METADATA_SECTION[key] ?? WATCH_SECTION_OF[key];
        return json(res, 200, {
          MediaContainer: {
            size: Metadata.length,
            totalSize: Metadata.length,
            librarySectionID: sectionId ? Number(sectionId) : undefined,
            Metadata,
          },
        });
      }
      // ADR-088 / DESIGN-049 D-09/D-11 (PLAN-068) — every episode under a show/season (specials included),
      // overlaid with the watch map, paged with X-Plex-Container-Start/Size and the full totalSize.
      const leavesMatch = path.match(/^\/library\/metadata\/([^/]+)\/allLeaves$/);
      if (leavesMatch) {
        const key = leavesMatch[1]!;
        const item = findMetadataItem(key, viewer);
        if (!item) return json(res, 404, { message: 'no such metadata' });
        const sectionId = METADATA_SECTION[key] ?? WATCH_SECTION_OF[key];
        return json(res, 200, {
          MediaContainer: {
            ...containerPage(leavesOf(item).map(overlay), url.searchParams),
            librarySectionID: sectionId ? Number(sectionId) : undefined,
          },
        });
      }
      // ADR-093 / DESIGN-052 D-03 — the discover provider's per-title metadata (`includeGuids`), the registry's
      // discover-id → external-id map. Only a 24-hex discover id the catalog knows; PMS keys are numeric.
      const discoverMeta = path.match(/^\/library\/metadata\/([0-9a-f]{24})$/);
      if (discoverMeta && url.searchParams.get('includeGuids') === '1') {
        const item = catalog.find((c) => c.ratingKey === discoverMeta[1]);
        if (item) {
          return json(res, 200, { MediaContainer: { size: 1, Metadata: [{ type: item.type, Guid: item.Guid ?? [] }] } });
        }
        return json(res, 404, { Error: { error: 'Not Found', statusCode: 404 } });
      }
      // DESIGN-017 D-09 — one metadata item (the drill-in head), with librarySectionID on the item.
      const metaMatch = path.match(/^\/library\/metadata\/([^/]+)$/);
      if (metaMatch) {
        const key = metaMatch[1]!;
        const item = findMetadataItem(key, viewer);
        if (!item) return json(res, 404, { message: 'no such metadata' });
        const sectionId = METADATA_SECTION[key] ?? WATCH_SECTION_OF[key];
        return json(res, 200, {
          MediaContainer: {
            size: 1,
            Metadata: [{ ...overlay(item), librarySectionID: sectionId ? Number(sectionId) : undefined }],
          },
        });
      }

      // ---- plex.tv sharing API (disambiguated by machineId in the path) ----
      if (path === '/api/users') return xml(res, 200, usersXml());

      const serverMatch = path.match(/^\/api\/servers\/([^/]+)(\/shared_servers(?:\/([^/]+))?)?$/);
      if (serverMatch) {
        const mid = serverMatch[1]!;
        const isShared = Boolean(serverMatch[2]);
        const sharedServerId = serverMatch[3];
        const slug = SLUG_BY_MID.get(mid);
        if (!slug) return xml(res, 404, `<MediaContainer size="0"/>`);

        if (!isShared && method === 'GET') return xml(res, 200, serverSectionsXml(slug));

        if (isShared && method === 'GET') return xml(res, 200, sharedServersXml(slug, mid));

        // Mutations — record + mutate state.
        if (isShared && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
          const raw = await readBody(req);
          const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
          calls.push({ method, path, machineId: mid, body });
          const state = sharesFor(mid);

          if (method === 'POST') {
            const b = body as {
              shared_server?: { library_section_ids?: number[]; invited_id?: number; all_libraries?: boolean };
            };
            const invited = String(b.shared_server?.invited_id ?? STUB_PLEX_MEMBER.id);
            const all = b.shared_server?.all_libraries === true; // ADR-024 enter-all create
            const ids = (b.shared_server?.library_section_ids ?? []).map(String);
            const id = `ss-${invited}`;
            state.set(invited, { id, userId: invited, sectionIds: new Set(ids), allLibraries: all });
            return xml(
              res,
              201,
              `<MediaContainer size="1"><SharedServer id="${id}" userID="${invited}" username="${STUB_PLEX_MEMBER.username}" allLibraries="${all ? '1' : '0'}"/></MediaContainer>`,
            );
          }
          if (method === 'PUT') {
            const b = body as { shared_server?: { library_section_ids?: number[]; all_libraries?: boolean } };
            const all = b.shared_server?.all_libraries;
            for (const ss of state.values()) {
              if (ss.id !== sharedServerId) continue;
              if (all === true) {
                // ADR-024 enter-all: set the flag; the section set is irrelevant while all.
                ss.allLibraries = true;
              } else {
                // Explicit list (all_libraries omitted or false) demotes from all-libraries.
                ss.allLibraries = false;
                if (b.shared_server?.library_section_ids !== undefined) {
                  ss.sectionIds = new Set(b.shared_server.library_section_ids.map(String));
                }
              }
            }
            return xml(res, 200, `<MediaContainer size="1"/>`);
          }
          // DELETE
          for (const [uid, ss] of state) if (ss.id === sharedServerId) state.delete(uid);
          return xml(res, 200, `<MediaContainer size="0"/>`);
        }
      }

      return json(res, 404, { message: `stub-plex: no handler for ${method} ${path}` });
    })().catch((err: unknown) => {
      json(res, 500, { message: `stub-plex error: ${String(err)}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-plex failed to bind a port');
  }
  const port = address.port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
