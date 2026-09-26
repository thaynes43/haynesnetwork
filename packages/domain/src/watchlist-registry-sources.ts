// ADR-093 / DESIGN-052 D-02 / D-20 (PLAN-072) — the Watchlist Registry's read sources.
//
// `watchlistRegistrySourcesFromEnv` builds the production readers from the env the `sync-watchlist-registry` and the
// sweep CronJobs already mount (`haynesnetwork-secret`): an owner-token PlexRegistryClient for HaynesOps and for
// HaynesTower (the fallback order `sync-watch` uses) and a Seerr client configured with the D-02 retry policy (10 s,
// 3 attempts on 429 / 5xx / network, 2 s × attempt). Every one of them is read-only.
//
// `createStaticWatchlistSources` is an in-memory implementation of the same seams for tests and seeds (no network):
// a fixture roster and fixed answers per account. It never reaches a live API (ADR-010).
import { ARR_CLUSTER_URL_DEFAULTS, registryRetryStatus, type SeerrUserSummary } from '@hnet/arr';
import { SeerrClient, type SeerrWatchlistAnswer } from '@hnet/arr/read';
import {
  PLEX_COMMUNITY_BASE_URL,
  PLEX_DISCOVER_BASE_URL,
  PLEX_TV_BASE_URL,
  PlexConfigError,
  type PlexSectionItem,
} from '@hnet/plex';
import {
  PlexRegistryClient,
  registryBackoffMs,
  type CommunityWatchlistAnswer,
  type DiscoverMetadata,
  type HomeUser,
  type RosterOwner,
  type RosterUser,
} from '@hnet/plex/read';
import type {
  WatchlistPlexReader,
  WatchlistRegistrySources,
  WatchlistSeerrReader,
} from './watchlist-registry';

/**
 * The production sources. At least one of PLEX_HAYNESOPS_TOKEN / PLEX_HAYNESTOWER_TOKEN is required (a
 * PlexConfigError names both when neither is set; values are never echoed). Seerr is read when SEERR_API_KEY is set;
 * without it every Seerr source reads as failed (fail closed: carried, then blocking after 24 hours).
 */
export function watchlistRegistrySourcesFromEnv(
  env: Record<string, string | undefined> = process.env,
): WatchlistRegistrySources {
  const plexTvBaseUrl = env.PLEX_TV_URL?.trim() || PLEX_TV_BASE_URL;
  const plexDiscoverBaseUrl = env.PLEX_DISCOVER_URL?.trim() || PLEX_DISCOVER_BASE_URL;
  const plexCommunityBaseUrl = env.PLEX_COMMUNITY_URL?.trim() || PLEX_COMMUNITY_BASE_URL;
  const plex: WatchlistPlexReader[] = [];
  for (const slug of ['haynesops', 'haynestower'] as const) {
    const token = env[`PLEX_${slug.toUpperCase()}_TOKEN`]?.trim();
    if (!token) continue;
    const client = new PlexRegistryClient({
      token,
      plexTvBaseUrl,
      plexDiscoverBaseUrl,
      plexCommunityBaseUrl,
    });
    plex.push(plexReaderFrom(slug, client));
  }
  if (plex.length === 0)
    throw new PlexConfigError(['PLEX_HAYNESOPS_TOKEN', 'PLEX_HAYNESTOWER_TOKEN']);

  const seerrKey = env.SEERR_API_KEY?.trim();
  const seerr = seerrKey
    ? seerrReaderFrom(
        new SeerrClient({
          baseUrl: env.SEERR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.seerr,
          apiKey: seerrKey,
          timeoutMs: 10_000,
          getRetries: 2,
          retryStatus: registryRetryStatus,
          retryBackoffMs: registryBackoffMs,
        }),
      )
    : null;
  return { plex, seerr };
}

/** Adapt a PlexRegistryClient to the reader seam (it already has the exact shape; this adds the label). */
export function plexReaderFrom(label: string, client: PlexRegistryClient): WatchlistPlexReader {
  return {
    label,
    getOwner: () => client.getOwner(),
    listUsers: () => client.listUsers(),
    listHomeUsers: () => client.listHomeUsers(),
    getOwnerWatchlist: () => client.getOwnerWatchlist(),
    communityWatchlist: (uuid) => client.communityWatchlist(uuid),
    discoverMetadata: (id) => client.discoverMetadata(id),
  };
}

/** Adapt a SeerrClient to the reader seam (Plex users only; the content rules run inside `readUserWatchlist`). */
export function seerrReaderFrom(client: SeerrClient): WatchlistSeerrReader {
  return {
    // A local Seerr user (userType 2) has no Plex watchlist; a user with no type is kept (fail toward reading).
    listUsers: async () => (await client.listUsers()).filter((u) => u.userType !== 2),
    readUserWatchlist: (userId) => client.readUserWatchlist(userId),
  };
}

// ---------------------------------------------------------------------------
// In-memory sources (tests, seeds) — no network.
// ---------------------------------------------------------------------------

/** One title a fixture watchlist holds. */
export interface StaticWatchlistTitle {
  discoverId: string;
  kind: 'movie' | 'show';
  tmdbId?: number | null;
  tvdbId?: number | null;
}

/** A fixture account: its roster class, its uuid, and what each source answers. */
export interface StaticWatchlistAccount {
  plexAccountId: string;
  cls: 'friend' | 'home_full' | 'home_managed';
  uuid?: string | null;
  /** The community answer (omit: `answered` with no nodes). */
  community?: CommunityWatchlistAnswer | { throws: true };
  /** A linked Seerr user (id) and its answer. */
  seerr?: { userId: number; answer: SeerrWatchlistAnswer };
}

export interface StaticWatchlistFixture {
  ownerId: string;
  ownerUuid?: string | null;
  /** The owner's own list (omit: empty). */
  owner?: StaticWatchlistTitle[];
  /** Fail the owner read (`throw`) or truncate it. */
  ownerFailure?: 'throw' | 'truncated';
  accounts?: StaticWatchlistAccount[];
  /** Fail the roster read. */
  rosterFails?: boolean;
  /** Seerr users that are not in the roster (seerr_only). */
  seerrOnly?: Array<{ plexId: string; userId: number; answer: SeerrWatchlistAnswer }>;
  /** Fail the Seerr user list. */
  seerrUsersFail?: boolean;
  /** No Seerr configured. */
  noSeerr?: boolean;
  /** discover-id → external ids (`null`: plex.tv answers 404). Unknown ids throw (the lookup fails). */
  discover?: Record<string, DiscoverMetadata | null>;
}

/** Build a discover watchlist row the owner read returns (the PlexSectionItem the discover provider serves). */
export function discoverWatchlistRow(t: StaticWatchlistTitle): PlexSectionItem {
  const guids = [
    ...(t.tmdbId ? [{ id: `tmdb://${t.tmdbId}` }] : []),
    ...(t.tvdbId ? [{ id: `tvdb://${t.tvdbId}` }] : []),
  ];
  return {
    ratingKey: t.discoverId,
    type: t.kind,
    title: 'x',
    guid: `plex://${t.kind}/${t.discoverId}`,
    Guid: guids,
    Label: [],
  } as unknown as PlexSectionItem;
}

/**
 * In-memory registry sources over a mutable fixture: change the fixture between refreshes to script a scenario.
 * `calls` counts reads per kind (tests assert, e.g., that the web path never refreshed).
 */
export function createStaticWatchlistSources(fixture: StaticWatchlistFixture): {
  sources: WatchlistRegistrySources;
  fixture: StaticWatchlistFixture;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  const count = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
  const reader: WatchlistPlexReader = {
    label: 'static',
    async getOwner(): Promise<RosterOwner> {
      count('roster');
      if (fixture.rosterFails) throw new Error('roster unavailable');
      return { id: fixture.ownerId, uuid: fixture.ownerUuid ?? null };
    },
    async listUsers(): Promise<RosterUser[]> {
      if (fixture.rosterFails) throw new Error('roster unavailable');
      return (fixture.accounts ?? []).map((a) => ({
        id: a.plexAccountId,
        uuid: a.uuid === undefined ? staticAccountUuid(a.plexAccountId) : a.uuid,
        home: a.cls !== 'friend',
        restricted: a.cls === 'home_managed',
      }));
    },
    async listHomeUsers(): Promise<HomeUser[]> {
      if (fixture.rosterFails) throw new Error('roster unavailable');
      return [
        { id: fixture.ownerId, uuid: fixture.ownerUuid ?? null, admin: true, restricted: false },
        ...(fixture.accounts ?? [])
          .filter((a) => a.cls !== 'friend')
          .map((a) => ({
            id: a.plexAccountId,
            uuid: null,
            admin: false,
            restricted: a.cls === 'home_managed',
          })),
      ];
    },
    async getOwnerWatchlist() {
      count('owner');
      if (fixture.ownerFailure === 'throw') throw new Error('owner list unavailable');
      const items = (fixture.owner ?? []).map(discoverWatchlistRow);
      return { items, totalSize: items.length, truncated: fixture.ownerFailure === 'truncated' };
    },
    async communityWatchlist(uuid: string): Promise<CommunityWatchlistAnswer> {
      count('community');
      const account = (fixture.accounts ?? []).find(
        (a) => (a.uuid === undefined ? staticAccountUuid(a.plexAccountId) : a.uuid) === uuid,
      );
      const answer = account?.community ?? { kind: 'answered', nodes: [] };
      if ('throws' in answer) return { kind: 'failed', errorClass: 'network' };
      return answer;
    },
    async discoverMetadata(id: string): Promise<DiscoverMetadata | null> {
      count('discover');
      const known = fixture.discover ?? {};
      if (!(id in known)) throw new Error('lookup failed');
      return known[id] ?? null;
    },
  };
  const seerr: WatchlistSeerrReader = {
    async listUsers(): Promise<SeerrUserSummary[]> {
      count('seerrUsers');
      if (fixture.seerrUsersFail) throw new Error('seerr users unavailable');
      return [
        ...(fixture.accounts ?? [])
          .filter((a) => a.seerr !== undefined)
          .map((a) => ({ id: a.seerr!.userId, plexId: a.plexAccountId, userType: 1 })),
        ...(fixture.seerrOnly ?? []).map((s) => ({ id: s.userId, plexId: s.plexId, userType: 1 })),
      ];
    },
    async readUserWatchlist(userId: number): Promise<SeerrWatchlistAnswer> {
      count('seerr');
      const linked = (fixture.accounts ?? []).find((a) => a.seerr?.userId === userId)?.seerr;
      const only = (fixture.seerrOnly ?? []).find((s) => s.userId === userId);
      return linked?.answer ?? only?.answer ?? { kind: 'empty' };
    },
  };
  return {
    fixture,
    calls,
    sources: {
      get plex() {
        return [reader];
      },
      get seerr() {
        return fixture.noSeerr ? null : seerr;
      },
    },
  };
}

/** A fixture uuid for an account id (the static roster's default `thumb` uuid). */
export function staticAccountUuid(plexAccountId: string): string {
  return `${plexAccountId.padStart(16, '0')}`.slice(-16).replace(/[^0-9a-f]/g, 'a');
}
