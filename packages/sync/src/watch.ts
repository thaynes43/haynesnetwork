// ADR-088 / ADR-089 / DESIGN-049 D-09 (PLAN-068 S6) — the `watch` sync mode: the owner's watch-history
// read-model. READ-ONLY against Tautulli, Plex, plex.tv and TMDB (the sync never scrobbles — only an
// owner-issued Watch Mark writes Plex); every write goes through the @hnet/domain watch single-writers.
// Steps, each isolated so one source's failure keeps the others' results (the DESIGN-008 posture):
//   1 owner · 2 events (+ the Q-06 show-guid retry) · 3 Plex progress · 4 assemble · 5 write ·
//   6 watchlist · 7 TMDB seeds (every 20 h, ≤ 15 seeds).
import type { DbClient, PlexServerSlug, WatchMarkRow, WatchTitleRow } from '@hnet/db';
import {
  WatchBudgetExceeded,
  appendWatchEvents,
  fillShowGuids,
  isPlexNotFound,
  newestEventStart,
  replaceRecoSignals,
  upsertWatchOwner,
  upsertWatchTitles,
  withDeadline,
  type RecoSignalInput,
  type ShowGuidFill,
  type WatchEventInput,
} from '@hnet/domain';
import type { TautulliHistoryRow } from '@hnet/arr';
import type { TautulliClient, TmdbClient } from '@hnet/arr/read';
import type { PlexReadClient } from '@hnet/plex/read';
import {
  PLEX_SERVERS,
  keysOf,
  parsePlexItemIds,
  selectAccountEvents,
  selectKnownShowGuids,
  selectLedgerIndex,
  selectLiveMarks,
  selectSignals,
  selectSignalsFetchedAt,
  selectTitleRows,
  selectUnresolvedShowPairs,
  selectWatchOwner,
  showState,
  type PlexItemLike,
  type WatchKind,
} from '@hnet/watch';
import { noopLogger, type SyncLogger } from './logger';
import {
  assembleTitleStates,
  groupTitles,
  obsKey,
  planShowRereads,
  type PlexObs,
} from './watch-assemble';

/** The Plex reads the sync makes (the read half of a PlexClientBundle). */
export type WatchSyncPlexRead = Pick<
  PlexReadClient,
  'getOwnerAccount' | 'listSections' | 'listSectionContentsPage' | 'listAllLeaves' | 'getMetadataItem' | 'getWatchlist'
>;

export interface WatchSyncPlex {
  read: Partial<Record<PlexServerSlug, WatchSyncPlexRead>>;
}

/** One configured Tautulli instance (its slug is the Plex server it tracks — ADR-068). */
export interface WatchTautulliSource {
  slug: PlexServerSlug;
  client: Pick<TautulliClient, 'getHistory' | 'getMetadata'>;
}

export type WatchTmdb = Pick<TmdbClient, 'getMovieRecommendations' | 'getTvRecommendations'>;

export interface WatchSyncTuning {
  /** Tautulli `length` (D-09: 500). */
  historyPageSize?: number;
  /** Pages per instance per run (D-09: 200). */
  maxHistoryPages?: number;
  /** Plex section listing page size. */
  sectionPageSize?: number;
  /** Q-06 retry: pairs per run (ruling: 40) and the ingest window (60 days). */
  showGuidRetryLimit?: number;
  showGuidRetryDays?: number;
  /** Q-06 retry: the step's time budget; when it runs out the rest of the pairs wait for the next run. */
  showGuidRetryBudgetMs?: number;
  /** Stored movies missing from the listings checked per run (a 404 = gone from that server). */
  absentMovieChecks?: number;
  /** D-17: at most 15 seeds, refreshed when older than 20 hours. */
  seedLimit?: number;
  seedMaxAgeHours?: number;
}

export interface WatchSyncInput {
  db: DbClient;
  plex: WatchSyncPlex;
  tautulli: readonly WatchTautulliSource[];
  tmdb?: WatchTmdb | null;
  logger?: SyncLogger;
  now?: Date;
  tuning?: WatchSyncTuning;
}

export interface WatchSyncError {
  step: 'owner' | 'events' | 'show_guids' | 'plex' | 'leaves' | 'titles' | 'watchlist' | 'seeds';
  source?: string;
  message: string;
}

/** D-09's report: `{ owner, events, shows, movies, titles, watchlist, seeds, errors[] }`. */
export interface WatchSyncReport {
  owner: { plexAccountId: number; username: string; from: 'plex' | 'stored' } | null;
  /** Events inserted per instance. */
  events: Partial<Record<PlexServerSlug, number>>;
  /** Instances whose history read stopped at the page cap (the older rows were not read this run). */
  eventsCapped: PlexServerSlug[];
  /**
   * Show guids: resolved at ingest, retried (Q-06) and events filled; `skipped` = retry pairs not asked this
   * run (the step's time budget ran out, or both sources of their instance had already failed this run).
   */
  showGuids: { resolved: number; retried: number; filled: number; skipped: number };
  shows: { listed: number; reread: number };
  /** Movies from the watched and in-progress listings. */
  movies: number;
  titles: { upserted: number; inserted: number; updated: number; rekeyed: number; unchanged: number };
  /** Watchlist titles stored, or null when the watchlist could not be read. */
  watchlist: number | null;
  /** TMDB seeds, or null when TMDB is not configured. */
  seeds: { refreshed: boolean; seeds: number; rows: number } | null;
  errors: WatchSyncError[];
  /** No owner could be resolved and none is stored: nothing else could run. */
  totalFailure: boolean;
}

const DEFAULTS = {
  historyPageSize: 500,
  maxHistoryPages: 200,
  sectionPageSize: 500,
  showGuidRetryLimit: 40,
  showGuidRetryDays: 60,
  showGuidRetryBudgetMs: 60_000,
  absentMovieChecks: 100,
  seedLimit: 15,
  seedMaxAgeHours: 20,
} satisfies Required<WatchSyncTuning>;
const MAX_SECTION_PAGES = 100;
const DAY_MS = 86_400_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Tautulli history row → Watch Event (movies and episodes with a row id only). */
export function eventFromHistory(instance: PlexServerSlug, row: TautulliHistoryRow): WatchEventInput | null {
  if (row.row_id === null || row.row_id === undefined) return null;
  const kind = row.media_type === 'movie' ? 'movie' : row.media_type === 'episode' ? 'episode' : null;
  if (!kind) return null;
  const started = row.started ?? row.date ?? null;
  if (typeof started !== 'number' || started <= 0) return null;
  const pct = row.percent_complete;
  return {
    instance,
    tautulliRowId: row.row_id,
    kind,
    itemGuid: row.guid ?? null,
    showGuid: null,
    title: row.title?.trim() || row.full_title?.trim() || '(untitled)',
    showTitle: kind === 'episode' ? (row.grandparent_title?.trim() || null) : null,
    season: kind === 'episode' ? row.parent_media_index : null,
    episode: kind === 'episode' ? row.media_index : null,
    year: row.year,
    ratingKey: row.rating_key === null || row.rating_key === undefined ? null : String(row.rating_key),
    grandparentRatingKey:
      kind === 'episode' && row.grandparent_rating_key !== null && row.grandparent_rating_key !== undefined
        ? String(row.grandparent_rating_key)
        : null,
    startedAt: new Date(started * 1000),
    stoppedAt: typeof row.stopped === 'number' && row.stopped > 0 ? new Date(row.stopped * 1000) : null,
    percentComplete: typeof pct === 'number' ? Math.max(0, Math.min(100, Math.round(pct))) : null,
    watched: row.watched_status === 1,
  };
}

type GuidAnswer = { guid: string | null; from: 'plex' | 'tautulli' | 'none' };

/** The per-run show-guid lookups (D-09 step 2 and the Q-06 retry) with their circuit breaker. */
interface ShowGuidLookups {
  /** Whether a source for this instance can still be asked this run. */
  available(instance: PlexServerSlug): boolean;
  resolve(instance: PlexServerSlug, grandparentKey: string): Promise<GuidAnswer>;
  /** Stop: a lookup still in flight asks nothing more and reports nothing. */
  close(): void;
}

/**
 * A show's Plex guid from its (instance, grandparent key) — the instance's OWN Plex server first (a 404 there
 * is truly gone; a success is authoritative), Tautulli's get_metadata only when Plex could not answer (Q-06
 * ruling). A `local://` show has no Plex guid (it never gets a `plex:` key, D-08).
 *
 * Circuit breaker: a source that fails with anything but "gone" (Plex 404; Tautulli's 400 / `{}` are already
 * `null`) is not asked again this run — a host that hangs instead of refusing would otherwise cost every
 * pair its full timeout and retries. `onTrip` hears the first failure of each source.
 */
function showGuidLookups(
  plex: WatchSyncPlex['read'],
  tautulli: readonly WatchTautulliSource[],
  onTrip: (source: string, error: unknown) => void,
): ShowGuidLookups {
  const down = new Set<string>();
  let closed = false;
  const trip = (source: string, error: unknown) => {
    if (closed || down.has(source)) return;
    down.add(source);
    onTrip(source, error);
  };
  const plexOf = (instance: PlexServerSlug) => (down.has(`plex:${instance}`) ? undefined : plex[instance]);
  const tautulliOf = (instance: PlexServerSlug) =>
    down.has(`tautulli:${instance}`) ? undefined : tautulli.find((t) => t.slug === instance)?.client;
  return {
    available: (instance) => !closed && Boolean(plexOf(instance) ?? tautulliOf(instance)),
    close: () => {
      closed = true;
    },
    resolve: async (instance, grandparentKey) => {
      const p = closed ? undefined : plexOf(instance);
      if (p) {
        try {
          const meta = await p.getMetadataItem(grandparentKey);
          const guid = meta?.item.guid ?? null;
          return { guid: guid?.startsWith('plex://show/') ? guid : null, from: 'plex' };
        } catch (error) {
          if (isPlexNotFound(error)) return { guid: null, from: 'plex' };
          trip(`plex:${instance}`, error);
        }
      }
      const t = closed ? undefined : tautulliOf(instance);
      if (t) {
        try {
          const md = await t.getMetadata(grandparentKey);
          const guid = md?.guid ?? null;
          return { guid: guid?.startsWith('plex://show/') ? guid : null, from: 'tautulli' };
        } catch (error) {
          // Tautulli down too: unknown for now.
          trip(`tautulli:${instance}`, error);
        }
      }
      return { guid: null, from: 'none' };
    },
  };
}

/** Page one section listing to completion (throws when the page cap is hit — a partial read). */
async function listSection(
  client: WatchSyncPlexRead,
  sectionKey: string,
  filter: { type: number; unwatched?: boolean; inProgress?: boolean },
  size: number,
): Promise<PlexItemLike[]> {
  const out: PlexItemLike[] = [];
  let start = 0;
  for (let page = 0; page < MAX_SECTION_PAGES; page += 1) {
    const { items, totalSize } = await client.listSectionContentsPage(sectionKey, { start, size, ...filter });
    out.push(...items);
    start += items.length;
    // `totalSize` falls back to the page's own size when Plex omits it; a full page then proves nothing.
    const knownTotal = totalSize !== null && !(totalSize === items.length && items.length === size);
    if (items.length === 0 || items.length < size || (knownTotal && start >= totalSize)) return out;
  }
  throw new Error(`section ${sectionKey} listing exceeded ${MAX_SECTION_PAGES} pages`);
}

/**
 * D-17 seeds: the owner's most recent non-children's titles that are finished, caught up or at least 30%
 * watched (a show gone from Plex counts once three episodes are in the log — D-25's Taste Profile reading),
 * not dismissed, with a TMDB id; at most `limit`.
 */
export function pickSeeds(
  rows: readonly WatchTitleRow[],
  marks: readonly WatchMarkRow[],
  now: Date,
  limit: number,
): WatchTitleRow[] {
  const dismissed = new Set<string>();
  for (const m of marks) {
    if (m.action === 'watched') continue;
    for (const k of keysOf(m)) dismissed.add(`${m.kind}|${k}`);
  }
  const nowSec = Math.floor(now.getTime() / 1000);
  const eligible = rows.filter((r) => {
    if (r.isKids || !r.tmdbId || !r.lastWatchedAt) return false;
    if (keysOf(r).some((k) => dismissed.has(`${r.kind}|${k}`))) return false;
    if (r.kind === 'movie') return r.plexWatched || r.eventWatchedEpisodes > 0;
    const total = r.episodesTotal ?? 0;
    const watched = r.episodesWatched ?? 0;
    if (total === 0) return r.eventWatchedEpisodes >= 3;
    const state = showState(
      {
        episodesWatched: watched,
        episodesTotal: total,
        next: r.nextSeason !== null && r.nextEpisode !== null ? { season: r.nextSeason, episode: r.nextEpisode } : null,
        lastWatchedAt: Math.floor(r.lastWatchedAt.getTime() / 1000),
      },
      { showStatus: r.showStatus, now: nowSec },
    );
    return state === 'finished' || state === 'caught_up' || watched / total >= 0.3;
  });
  return eligible
    .sort(
      (a, b) =>
        (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0) || a.title.localeCompare(b.title),
    )
    .slice(0, limit);
}

function yearOf(date: string | null | undefined): number | null {
  const m = /^(\d{4})-/.exec(date ?? '');
  return m ? Number(m[1]) : null;
}

/** Run the `watch` sync (D-09). Never throws for a source failure — read `errors` / `totalFailure`. */
export async function runWatchSync(input: WatchSyncInput): Promise<WatchSyncReport> {
  const db = input.db;
  const logger = input.logger ?? noopLogger;
  const now = input.now ?? new Date();
  const tune = { ...DEFAULTS, ...input.tuning };
  const report: WatchSyncReport = {
    owner: null,
    events: {},
    eventsCapped: [],
    showGuids: { resolved: 0, retried: 0, filled: 0, skipped: 0 },
    shows: { listed: 0, reread: 0 },
    movies: 0,
    titles: { upserted: 0, inserted: 0, updated: 0, rekeyed: 0, unchanged: 0 },
    watchlist: null,
    seeds: null,
    errors: [],
    totalFailure: false,
  };
  const fail = (step: WatchSyncError['step'], error: unknown, source?: string) => {
    const e: WatchSyncError = { step, message: message(error), ...(source ? { source } : {}) };
    report.errors.push(e);
    logger.warn(`watch: ${step} failed`, { ...(source ? { source } : {}), error: e.message });
  };

  // 1 — the owner: HaynesOps, falling back to HaynesTower; a stored owner carries a plex.tv outage.
  for (const slug of ['haynesops', 'haynestower'] as const) {
    const client = input.plex.read[slug];
    if (!client) continue;
    try {
      const account = await client.getOwnerAccount();
      if (!account.id) throw new Error('plex.tv returned no account id');
      const row = await upsertWatchOwner({
        db,
        account: { id: account.id, username: account.username, email: account.email },
        now,
      });
      report.owner = { plexAccountId: row.plexAccountId, username: row.username, from: 'plex' };
      break;
    } catch (error) {
      fail('owner', error, slug);
    }
  }
  if (!report.owner) {
    const stored = await selectWatchOwner(db);
    if (!stored) {
      report.totalFailure = true;
      logger.error('watch: no Server Owner (plex.tv unreachable and none stored) — nothing synced');
      return report;
    }
    report.owner = { plexAccountId: stored.plexAccountId, username: stored.username, from: 'stored' };
  }
  const acct = report.owner.plexAccountId;

  // 2 — Watch Events, per Tautulli instance: a 3-day overlap window after the newest stored start (none on
  // the first run: the whole history), newest first, insert-or-ignore on (instance, row_id).
  const freshEventIds = new Set<number>();
  const attempted = new Set<string>();
  const guids = showGuidLookups(input.plex.read, input.tautulli, (source, error) =>
    fail('show_guids', error, source),
  );
  for (const src of input.tautulli) {
    try {
      const newest = await newestEventStart(db, acct, src.slug);
      const after = newest ? isoDay(new Date(newest.getTime() - 3 * DAY_MS)) : undefined;
      const events: WatchEventInput[] = [];
      let complete = false;
      for (let page = 0; page < tune.maxHistoryPages; page += 1) {
        const rows = await src.client.getHistory({
          userId: acct,
          grouping: 0,
          includeActivity: false,
          length: tune.historyPageSize,
          start: page * tune.historyPageSize,
          orderColumn: 'date',
          orderDir: 'desc',
          ...(after ? { after } : {}),
        });
        for (const row of rows) {
          const e = eventFromHistory(src.slug, row);
          if (e) events.push(e);
        }
        if (rows.length < tune.historyPageSize) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        // The page cap: the rows older than the last page read are not ingested this run (and the next
        // window starts after them), so say so — slug and counts only, never a title.
        report.eventsCapped.push(src.slug);
        logger.warn('watch: Tautulli history hit the page cap', {
          source: src.slug,
          pages: tune.maxHistoryPages,
          pageSize: tune.historyPageSize,
        });
      }
      // A new episode's show guid: stored events first, then Plex, then Tautulli — once per grandparent key.
      const keys = [
        ...new Set(events.flatMap((e) => (e.grandparentRatingKey ? [e.grandparentRatingKey] : []))),
      ];
      const known = await selectKnownShowGuids(db, acct, src.slug, keys);
      const resolved: ShowGuidFill[] = [];
      for (const key of keys) {
        if (known.has(key)) continue;
        attempted.add(`${src.slug}\u0000${key}`);
        const answer = await guids.resolve(src.slug, key);
        if (answer.guid) {
          known.set(key, answer.guid);
          resolved.push({ instance: src.slug, grandparentRatingKey: key, showGuid: answer.guid });
          report.showGuids.resolved += 1;
        }
      }
      for (const e of events) {
        if (e.kind === 'episode' && e.grandparentRatingKey) e.showGuid = known.get(e.grandparentRatingKey) ?? null;
      }
      const { inserted } = await appendWatchEvents({ db, plexAccountId: acct, events });
      report.events[src.slug] = inserted.length;
      for (const e of inserted) freshEventIds.add(e.id);
      // A guid learned now also belongs to the pair's earlier, still guid-less events (Q-06).
      if (resolved.length > 0) {
        report.showGuids.filled += (await fillShowGuids({ db, plexAccountId: acct, fills: resolved })).filled;
      }
    } catch (error) {
      fail('events', error, src.slug);
    }
  }

  // 2b — Q-06: a NULL show guid is not final. Retry up to 40 (instance, grandparent key) pairs ingested in the
  // last 60 days (a rotating slice), Plex first, Tautulli second; fill the events in place. The step has a
  // time budget (60 s): a slow source must not hold up the Title States, the watchlist and the seeds.
  try {
    const slot = String(Math.floor(now.getTime() / (15 * 60_000)));
    const candidates = await selectUnresolvedShowPairs(db, acct, {
      since: new Date(now.getTime() - tune.showGuidRetryDays * DAY_MS),
      limit: tune.showGuidRetryLimit + attempted.size,
      salt: slot,
    });
    const pairs = candidates
      .filter((p) => !attempted.has(`${p.instance}\u0000${p.grandparentRatingKey}`))
      .slice(0, tune.showGuidRetryLimit);
    const fills: ShowGuidFill[] = [];
    const deadline = Date.now() + tune.showGuidRetryBudgetMs;
    let outOfTime = false;
    for (const [i, p] of pairs.entries()) {
      if (Date.now() >= deadline) {
        outOfTime = true;
        report.showGuids.skipped += pairs.length - i;
        break;
      }
      if (!guids.available(p.instance)) {
        report.showGuids.skipped += 1;
        continue;
      }
      let answer: GuidAnswer;
      try {
        answer = await withDeadline(guids.resolve(p.instance, p.grandparentRatingKey), deadline);
      } catch (error) {
        if (!(error instanceof WatchBudgetExceeded)) throw error;
        outOfTime = true;
        report.showGuids.skipped += pairs.length - i;
        break;
      }
      report.showGuids.retried += 1;
      if (answer.guid) fills.push({ ...p, showGuid: answer.guid });
    }
    if (outOfTime) {
      logger.warn('watch: show-guid retry ran out of time', {
        budgetMs: tune.showGuidRetryBudgetMs,
        retried: report.showGuids.retried,
        skipped: report.showGuids.skipped,
      });
    }
    if (fills.length > 0) {
      report.showGuids.filled += (await fillShowGuids({ db, plexAccountId: acct, fills })).filled;
    }
  } catch (error) {
    fail('show_guids', error);
  } finally {
    // A lookup abandoned at the deadline asks nothing more and reports nothing after this step.
    guids.close();
  }

  // 3 — Plex progress on every server with movie or show sections (decided from /library/sections).
  const shows: PlexObs[] = [];
  const movies: PlexObs[] = [];
  const showServersRead = new Set<PlexServerSlug>();
  const movieServersRead = new Set<PlexServerSlug>();
  for (const server of PLEX_SERVERS) {
    const client = input.plex.read[server];
    if (!client) continue;
    let sections;
    try {
      sections = await client.listSections();
    } catch (error) {
      fail('plex', error, server);
      continue;
    }
    let showsOk = true;
    let moviesOk = true;
    for (const section of sections) {
      if (section.type === 'show') {
        try {
          const items = await listSection(client, section.key, { type: 2 }, tune.sectionPageSize);
          for (const item of items) shows.push({ server, item });
        } catch (error) {
          showsOk = false;
          fail('plex', error, `${server}/${section.key}`);
        }
      } else if (section.type === 'movie') {
        try {
          const watched = await listSection(client, section.key, { type: 1, unwatched: false }, tune.sectionPageSize);
          const started = await listSection(client, section.key, { type: 1, inProgress: true }, tune.sectionPageSize);
          const seen = new Set<string>();
          for (const item of [...watched, ...started]) {
            if (seen.has(item.ratingKey)) continue;
            seen.add(item.ratingKey);
            movies.push({ server, item });
          }
        } catch (error) {
          moviesOk = false;
          fail('plex', error, `${server}/${section.key}`);
        }
      }
    }
    if (showsOk) showServersRead.add(server);
    if (moviesOk) movieServersRead.add(server);
  }
  report.shows.listed = shows.length;
  report.movies = movies.length;

  // 4 + 5 — assemble the Title States and write the changed ones.
  try {
    const [stored, events, ledger] = await Promise.all([
      selectTitleRows(db, acct),
      selectAccountEvents(db, acct),
      selectLedgerIndex(db),
    ]);

    // Stored movies missing from a complete watched/in-progress listing: unwatched there now, or gone. Only
    // an entry whose STORED state says watched or resuming on that server can have left those listings (one
    // already unwatched there is expected to be absent — re-reading it every run changed nothing); the check
    // writes its fresh state, so each one is read once. Oldest row first, so the order is stable.
    const listed = new Set(movies.map((m) => obsKey(m.server, m.item.ratingKey)));
    const goneMovies = new Set<string>();
    const absent = stored
      .filter((row) => row.kind === 'movie')
      .sort((a, b) => a.id - b.id)
      .flatMap((row) =>
        row.onPlex
          .filter(
            (e) =>
              movieServersRead.has(e.server) &&
              !listed.has(obsKey(e.server, e.ratingKey)) &&
              ((row.plexCounts[e.server]?.viewedLeafCount ?? 0) > 0 ||
                (row.nextServer === e.server && row.resumePercent !== null)),
          )
          .map((e) => ({ server: e.server, ratingKey: e.ratingKey })),
      )
      .slice(0, tune.absentMovieChecks);
    for (const e of absent) {
      const key = obsKey(e.server, e.ratingKey);
      const client = input.plex.read[e.server];
      if (!client || listed.has(key)) continue;
      try {
        const meta = await client.getMetadataItem(e.ratingKey);
        if (meta) {
          movies.push({ server: e.server, item: meta.item });
          listed.add(key);
        } else goneMovies.add(key);
      } catch (error) {
        if (isPlexNotFound(error)) goneMovies.add(key);
      }
    }

    const groups = groupTitles({ stored, shows, movies, events, ledger });
    const leaves = new Map<string, PlexItemLike[]>();
    for (const obs of planShowRereads(groups, freshEventIds)) {
      const client = input.plex.read[obs.server];
      if (!client) continue;
      try {
        const listing = await client.listAllLeaves(obs.item.ratingKey);
        if (listing.truncated) throw new Error(`allLeaves ${obs.item.ratingKey} was truncated`);
        leaves.set(obsKey(obs.server, obs.item.ratingKey), listing.items);
        report.shows.reread += 1;
      } catch (error) {
        fail('leaves', error, `${obs.server}/${obs.item.ratingKey}`);
      }
    }

    const titles = assembleTitleStates(
      { stored, shows, movies, leaves, goneMovies, showServersRead, movieServersRead, events, ledger },
      groups,
    );
    const written = await upsertWatchTitles({ db, plexAccountId: acct, titles, now });
    report.titles = {
      upserted: written.inserted + written.updated,
      inserted: written.inserted,
      updated: written.updated,
      rekeyed: written.rekeyed,
      unchanged: written.unchanged,
    };
  } catch (error) {
    fail('titles', error);
  }

  // 6 — the plex.tv watchlist (owner token), replacing `source = watchlist`.
  for (const slug of ['haynesops', 'haynestower'] as const) {
    const client = input.plex.read[slug];
    if (!client) continue;
    try {
      const listing = await client.getWatchlist();
      if (listing.truncated) throw new Error('the watchlist read was truncated');
      const rows: RecoSignalInput[] = [];
      for (const item of listing.items) {
        const kind: WatchKind | null = item.type === 'show' ? 'show' : item.type === 'movie' ? 'movie' : null;
        if (!kind) continue;
        const ids = parsePlexItemIds(item);
        rows.push({
          kind,
          title: item.title,
          year: item.year ?? null,
          tmdbId: ids.tmdbId,
          tvdbId: kind === 'show' ? ids.tvdbId : null,
          imdbId: ids.imdbId,
          plexGuid: ids.plexGuid,
          rank: rows.length,
        });
      }
      await replaceRecoSignals({ db, plexAccountId: acct, source: 'watchlist', rows, fetchedAt: now });
      report.watchlist = rows.length;
      break;
    } catch (error) {
      fail('watchlist', error, slug);
    }
  }

  // 7 — TMDB seed recommendations, when older than 20 hours (D-17).
  if (input.tmdb) {
    try {
      const last = await selectSignalsFetchedAt(db, acct, 'tmdb_seed');
      if (last && now.getTime() - last.getTime() < tune.seedMaxAgeHours * 3_600_000) {
        report.seeds = { refreshed: false, seeds: 0, rows: 0 };
      } else {
        const [rows, marks] = await Promise.all([selectTitleRows(db, acct), selectLiveMarks(db, acct)]);
        const seeds = pickSeeds(rows, marks, now, tune.seedLimit);
        const fresh: RecoSignalInput[] = [];
        const failed = new Set<string>();
        for (const seed of seeds) {
          try {
            const page =
              seed.kind === 'show'
                ? await input.tmdb.getTvRecommendations(seed.tmdbId as number)
                : await input.tmdb.getMovieRecommendations(seed.tmdbId as number);
            let rank = 0;
            for (const r of page.results) {
              if (r.media_type && r.media_type !== (seed.kind === 'show' ? 'tv' : 'movie')) continue;
              const title = (seed.kind === 'show' ? r.name : r.title) ?? r.name ?? r.title;
              if (!title) continue;
              fresh.push({
                kind: seed.kind,
                title,
                year: yearOf(seed.kind === 'show' ? r.first_air_date : r.release_date),
                tmdbId: r.id,
                tvdbId: null,
                imdbId: null,
                plexGuid: null,
                seedTitleKey: seed.titleKey,
                seedTitle: seed.title,
                rank: rank++,
              });
            }
          } catch (error) {
            failed.add(seed.titleKey);
            // The TMDB id names the seed, never its title (the owner's viewing history stays out of logs).
            fail('seeds', error, `tmdb:${seed.kind}:${String(seed.tmdbId)}`);
          }
        }
        if (seeds.length > 0 && failed.size === seeds.length) {
          // Every call failed: keep yesterday's seeds rather than erase them.
          report.seeds = { refreshed: false, seeds: seeds.length, rows: 0 };
        } else {
          // A seed whose call failed keeps its previous rows (and their fetched_at).
          const kept: RecoSignalInput[] = (await selectSignals(db, acct, 'tmdb_seed'))
            .filter((r) => r.seedTitleKey !== null && failed.has(r.seedTitleKey))
            .map((r) => ({ ...r, fetchedAt: r.fetchedAt }));
          await replaceRecoSignals({
            db,
            plexAccountId: acct,
            source: 'tmdb_seed',
            rows: [...fresh, ...kept],
            fetchedAt: now,
          });
          report.seeds = { refreshed: true, seeds: seeds.length, rows: fresh.length + kept.length };
        }
      }
    } catch (error) {
      fail('seeds', error);
    }
  }

  logger.info('watch sync complete', {
    owner: report.owner.plexAccountId,
    events: report.events,
    ...(report.eventsCapped.length > 0 ? { eventsCapped: report.eventsCapped } : {}),
    showGuids: report.showGuids,
    shows: report.shows,
    movies: report.movies,
    titles: report.titles,
    watchlist: report.watchlist,
    seeds: report.seeds,
    errors: report.errors.length,
  });
  return report;
}
