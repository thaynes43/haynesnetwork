// ADR-018 / DESIGN-008 D-03 — the metadata-refresh harvest. A DISTINCT sync mode from
// full/incremental (which never touch media_metadata): it re-derives descriptive/quality
// metadata for stale-or-missing Media Items from the priority-ordered tiers, then upserts via
// the @hnet/domain single-writer. PER-SOURCE DEGRADATION IS MANDATORY (today's Plex lesson):
// each tier (arr, arr-lookup, tautulli, tmdb, tvdb, maintainerr) fails independently — it logs,
// records itself absent in `sources`, and never aborts the run; a wholly-failed tier still lets
// the others land.
//
// Structure: the cross-kind Tautulli watch-stats + Maintainerr collection indices are built
// ONCE (buildMetadataContext); the per-*arr-kind harvest (runMetadataRefreshForKind) reuses
// them, so the orchestrator can bracket one sync_runs row per arr source (D-03) without
// re-harvesting Tautulli three times.
import type { ArrKind, DbClient, Resolution } from '@hnet/db';
import {
  getPlexUserIdToAppUserMap,
  mergeUserWatchContributions,
  parseArrTags,
  upsertMediaMetadataBatch,
  upsertUserMediaWatchBatch,
  type MediaMetadataFields,
  type UserWatchContribution,
  type UserWatchStat,
} from '@hnet/domain';
import type { LidarrLookup, RadarrLookup, SonarrLookup, TautulliMetadata } from '@hnet/arr';
import {
  dominantResolution,
  guidsFromMetadata,
  mergeWatchContributions,
  metadataFromLidarrArtist,
  metadataFromLidarrLookup,
  metadataFromRadarrLookup,
  metadataFromRadarrMovie,
  metadataFromSonarrLookup,
  metadataFromSonarrSeries,
  metadataFromTmdbMovie,
  metadataFromTmdbTv,
  metadataFromTvdbSeries,
  resolutionFromInt,
  tautulliDate,
  type MetadataPatch,
  type ParsedGuids,
  type WatchContribution,
  type WatchStat,
} from './adapt-metadata';
import { requireClient, type MetadataSourceClients, type SyncClients } from './clients';
import {
  loadPlexRatingGuids,
  plexRatingGuidKey,
  selectMetadataTargets,
  type MetadataTarget,
  type PlexRatingGuids,
} from './db-reads';
import type { SyncLogger } from './logger';
import { projectUserWatchRows } from './watch-user-projection';
import {
  identifiableWatchTarget,
  usableWatchGuids,
  type WatchKind,
  type WatchTarget,
} from './watch-identity';

export const METADATA_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // D-03 — 6h
/**
 * DESIGN-008 D-03 amendment (2026-09-23): the DEFAULT threshold is applied 30 min early. The
 * sync-metadata CronJob fires every 6h, the same period as the threshold, and a run stamps each row's
 * fetched_at (DB now()) seconds to a minute AFTER the run starts. At the next tick, exactly 6h later,
 * those rows were still a few seconds too fresh to count as stale. Live 2026-09-22/23: 18,460 rows at
 * 16:15Z, then 1 at 22:15Z, 18,460 at 04:15Z, 32 at 10:15Z. So every row, household and per-user watch
 * state included, refreshed every 12h, not 6h. The slack absorbs that write lag plus scheduling jitter,
 * so each tick re-harvests what the previous tick wrote. An explicit `staleThresholdMs` is exact.
 */
export const METADATA_STALE_SLACK_MS = 30 * 60 * 1000;
const DEFAULT_BATCH = 500;

/**
 * DESIGN-008 D-03 (2026-11-13). Page size measured the same day: a walk of HaynesTower's episode
 * history returned full pages of 500 and then a short page, and the rows read equalled
 * `recordsFiltered` (32,661). Kept at 500.
 */
export const TAUTULLI_HISTORY_PAGE_SIZE = 500;
/**
 * Safety cap on history pages per instance. Measured 2026-11-13: the largest grouped history
 * (HaynesTower, every media type) was 39,010 rows, which is ceil(39010/500) = 79 pages. The cap
 * is twice that (158). A walk that reaches the cap is incomplete, and the harvest does not store
 * a zero for a title it did not see.
 */
export const TAUTULLI_HISTORY_PAGE_CAP = 158;

/** The cross-kind indices harvested once and shared by every per-kind run. */
export interface MetadataContext {
  watchIndex: WatchIndex;
  /**
   * True when every configured Tautulli instance returned its history through a short or empty
   * page, under the cap, and no `get_metadata` lookup threw. A stored zero is written only then.
   */
  watchComplete: boolean;
  watchInstances: HouseholdWatchInstance[];
  maintainerrByTmdb: Map<number, string[]>;
  /** tiers that threw and were degraded-past while building the context. */
  degraded: string[];
}

export interface BuildMetadataContextInput {
  sources: MetadataSourceClients;
  logger: SyncLogger;
  /** Present in the sync runner so a rating key already matched to the ledger skips `get_metadata`. */
  db?: DbClient;
  /**
   * Test hook. When set, the harvest uses this map and does not read `media_plex_matches`.
   * Absent: load the map from `db` when `db` is set, otherwise resolve every key with `get_metadata`.
   */
  ratingKeyGuids?: ReadonlyMap<string, PlexRatingGuids>;
  tautulliPageSize?: number;
  tautulliMaxPages?: number;
}

/** Build the shared Tautulli watch-stats + Maintainerr collection indices (degradable). */
export async function buildMetadataContext(
  input: BuildMetadataContextInput,
): Promise<MetadataContext> {
  const degraded: string[] = [];
  let watchIndex = emptyWatchIndex();
  let watchComplete = false;
  let watchInstances: HouseholdWatchInstance[] = [];
  if (input.sources.tautulli.length > 0) {
    try {
      const ratingKeyGuids =
        input.ratingKeyGuids ?? (input.db ? await loadPlexRatingGuids(input.db) : new Map());
      const read = await readHouseholdWatch({ ...input, ratingKeyGuids });
      watchIndex = read.index;
      watchComplete = read.complete;
      watchInstances = read.instances;
    } catch (err) {
      input.logger.error('metadata-refresh: tautulli tier failed', { error: msg(err) });
      degraded.push('tautulli');
    }
  }
  let maintainerrByTmdb = new Map<number, string[]>();
  if (input.sources.maintainerr) {
    try {
      maintainerrByTmdb = await harvestMaintainerr(input.sources);
    } catch (err) {
      input.logger.error('metadata-refresh: maintainerr tier failed', { error: msg(err) });
      degraded.push('maintainerr');
    }
  }
  return { watchIndex, watchComplete, watchInstances, maintainerrByTmdb, degraded };
}

export interface MetadataKindRefreshInput {
  db: DbClient;
  clients: SyncClients;
  sources: MetadataSourceClients;
  context: MetadataContext;
  arrKind: ArrKind;
  arrInstanceId?: string;
  logger: SyncLogger;
  /** rows older than now-threshold (or missing) refresh. Default 6h (D-03) less
   *  METADATA_STALE_SLACK_MS; an explicit value is exact. */
  staleThresholdMs?: number;
  /** cap the rows harvested this run (steady progress); default all eligible. */
  limit?: number;
  batchSize?: number;
}

export interface MetadataRefreshStats extends Record<string, unknown> {
  arrKind: ArrKind;
  targets: number;
  written: number;
  tierArr: number;
  tierArrLookup: number;
  tierTautulli: number;
  tierTmdb: number;
  tierTvdb: number;
  tierMaintainerr: number;
  /** ADR-053 — app users with a plex.tv id in the Plex Account Map when this kind ran. */
  userWatchMappedUsers: number;
  /** ADR-053 — per-user watch rows (user_media_watch) upserted this run; 0 when nobody is mapped. */
  userWatchWritten: number;
  /** True when this run's history read may store a zero. */
  watchComplete: boolean;
  /** Movies and shows with no joined history row on a complete read. */
  watchZeros: number;
  degraded: string[];
}

/** Harvest metadata for the stale/missing rows of ONE *arr kind (using the shared context). */
export async function runMetadataRefreshForKind(
  input: MetadataKindRefreshInput,
): Promise<MetadataRefreshStats> {
  const { db, logger, arrKind } = input;
  const staleBefore = new Date(
    Date.now() - (input.staleThresholdMs ?? METADATA_STALE_THRESHOLD_MS - METADATA_STALE_SLACK_MS),
  );
  const batchSize = input.batchSize ?? DEFAULT_BATCH;
  const degraded = [...input.context.degraded];

  const targets = await selectMetadataTargets(db, {
    staleBefore,
    arrKind,
    arrInstanceId: input.arrInstanceId,
    limit: input.limit,
  });

  // ADR-053 / DESIGN-026 D-07 — the plex.tv user id → app user id map for per-user watch attribution.
  // Empty (no mapped users) ⇒ the per-user emission is a clean no-op; the household aggregate is unchanged.
  const plexUserMap = await getPlexUserIdToAppUserMap(db);
  const userWatchTargets: (MetadataTarget & { perUser?: Map<string, UserWatchStat> })[] = [];

  // Tier: the *arr live list (base descriptive fields for LIVE rows) — one call, degradable.
  let arrList = new Map<number, MetadataPatch>();
  if (targets.some((t) => !t.tombstoned)) {
    try {
      arrList = await fetchArrList(input.clients, arrKind);
    } catch (err) {
      logger.error('metadata-refresh: arr list tier failed', { kind: arrKind, error: msg(err) });
      degraded.push(`arr:${arrKind}`);
    }
  }

  // Sonarr per-series resolution (D-02 resolution fix): the series list carries no per-file
  // data, so derive the DOMINANT episode-file tier per LIVE target from GET /episodefile.
  // Cheap in-cluster (~16ms/req; ~17s for the ~1026-series estate) and per-series degradable.
  // Radarr gets resolution inline from `movieFile` (no extra request); Lidarr (music) → null.
  let sonarrResolution = new Map<number, Resolution>();
  if (arrKind === 'sonarr' && arrList.size > 0) {
    const liveSeriesIds = [
      ...new Set(
        targets.filter((t) => !t.tombstoned && arrList.has(t.arrItemId)).map((t) => t.arrItemId),
      ),
    ];
    sonarrResolution = await fetchSonarrResolutions(input.clients, liveSeriesIds, logger);
  }

  const stats: MetadataRefreshStats = {
    arrKind,
    targets: targets.length,
    written: 0,
    tierArr: 0,
    tierArrLookup: 0,
    tierTautulli: 0,
    tierTmdb: 0,
    tierTvdb: 0,
    tierMaintainerr: 0,
    userWatchMappedUsers: plexUserMap.size,
    userWatchWritten: 0,
    watchComplete: input.context.watchComplete,
    watchZeros: 0,
    degraded,
  };

  let batch: MediaMetadataFields[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const { written } = await upsertMediaMetadataBatch({ db, rows: batch });
    stats.written += written;
    batch = [];
  };

  for (const target of targets) {
    const sourcesFlags: Record<string, boolean> = {};
    let patch: MetadataPatch = {};

    const live = !target.tombstoned ? arrList.get(target.arrItemId) : undefined;
    if (live) {
      patch = live;
      sourcesFlags.arr = true;
      stats.tierArr += 1;
    } else {
      const looked = await tryArrLookup(input.clients, target).catch((err) => {
        logger.warn('metadata-refresh: arr lookup failed', { id: target.id, error: msg(err) });
        return null;
      });
      if (looked) {
        patch = looked;
        sourcesFlags.arr_lookup = true;
        stats.tierArrLookup += 1;
      } else {
        const direct = await tryDirect(input.sources, target).catch((err) => {
          logger.warn('metadata-refresh: direct tmdb/tvdb failed', {
            id: target.id,
            error: msg(err),
          });
          return null;
        });
        if (direct) {
          patch = direct.patch;
          sourcesFlags[direct.source] = true;
          if (direct.source === 'tmdb') stats.tierTmdb += 1;
          else stats.tierTvdb += 1;
        }
      }
    }

    // Resolution (D-02 resolution fix) — the REAL per-item on-disk tier: Radarr from the inline
    // movieFile (carried on `patch`), Sonarr from the dominant episode-file tier, Lidarr (music)
    // and every non-live row (tombstoned/lookup/TMDB/TVDB — no file on disk) → null.
    let resolution: Resolution | null = null;
    if (live) {
      if (arrKind === 'radarr') resolution = patch.resolution ?? null;
      else if (arrKind === 'sonarr') resolution = sonarrResolution.get(target.arrItemId) ?? null;
    }
    const { requesters, sourceCollections } = parseArrTags(target.arrTags);

    const extra: Record<string, unknown> = {};
    const watch = matchWatch(input.context.watchIndex, target);
    // A finished read stores 0: no attributable play found, not proof of never played.
    // Null stays "unknown":
    // the read stopped early, a lookup threw, this title has no usable id, or the kind is music.
    const knownZero = !watch && input.context.watchComplete && identifiableWatchTarget(target);
    if (knownZero) stats.watchZeros += 1;
    if (watch) {
      sourcesFlags.tautulli = true;
      stats.tierTautulli += 1;
      extra.tautulli = watch.household.perInstance;
    }
    userWatchTargets.push({ ...target, perUser: watch?.perUser });

    const collections =
      target.tmdbId !== null ? input.context.maintainerrByTmdb.get(target.tmdbId) : undefined;
    if (collections && collections.length > 0) {
      sourcesFlags.maintainerr = true;
      stats.tierMaintainerr += 1;
      extra.maintainerr = { collections };
    }

    batch.push({
      mediaItemId: target.id,
      ...patch,
      resolution,
      requesters,
      sourceCollections,
      playCount: watch ? watch.household.playCount : knownZero ? 0 : null,
      lastViewedAt: watch?.household.lastViewedAt ?? null,
      // DESIGN-010 D-12 — the watch-visibility pair: the SAME cross-server MAX instant as
      // lastViewedAt, stored with the server that owns it so the walls/detail can show
      // "Last watched on <server> · <Mon YYYY>". Info only — protection reads lastViewedAt.
      // Zero means no attributable play found; unresolved historical identity may hide plays.
      lastWatchedAt: watch?.household.lastViewedAt ?? null,
      lastWatchedServer: watch?.household.lastWatchedServer ?? null,
      sources: sourcesFlags,
      extra,
    });
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  // ADR-053 / DESIGN-026 D-07 — persist the per-user watch rows (additive; the domain writer chunks). A
  // no-op when no user is mapped. Isolated: a failure here must not lose the household metadata just
  // written, so it's logged and swallowed (self-heals next cycle).
  try {
    const userWatchBatch = await projectUserWatchRows({
      db,
      targets: userWatchTargets,
      mappedUsers: plexUserMap,
    });
    const { written } = await upsertUserMediaWatchBatch({ db, rows: userWatchBatch });
    stats.userWatchWritten = written;
  } catch (err) {
    logger.error('metadata-refresh: per-user watch upsert failed', {
      kind: arrKind,
      error: msg(err),
    });
  }

  logger.info('metadata-refresh: kind done', { ...stats });
  return stats;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────

function msg(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/apikey=[^&\s]+/gi, 'apikey=redacted').slice(0, 300);
}

async function fetchArrList(
  clients: SyncClients,
  kind: ArrKind,
): Promise<Map<number, MetadataPatch>> {
  const map = new Map<number, MetadataPatch>();
  if (kind === 'radarr') {
    for (const m of await requireClient(clients, 'radarr').listMovies())
      map.set(m.id, metadataFromRadarrMovie(m));
  } else if (kind === 'sonarr') {
    for (const s of await requireClient(clients, 'sonarr').listSeries())
      map.set(s.id, metadataFromSonarrSeries(s));
  } else {
    for (const a of await requireClient(clients, 'lidarr').listArtists())
      map.set(a.id, metadataFromLidarrArtist(a));
  }
  return map;
}

/**
 * DESIGN-008 D-02 (resolution fix) — per LIVE Sonarr series, fetch `GET /episodefile?seriesId=`
 * and reduce to the DOMINANT episode-file resolution tier. Serial: cheap in-cluster (~16ms/req
 * live-measured 2026-07-06; ~17s across the ~1026-series estate — well inside the 6h cadence).
 * A per-series fetch failure is logged and skipped (that series keeps null resolution this
 * cycle — per-source degradation, D-03). Series with no episode files ⇒ omitted (null).
 */
async function fetchSonarrResolutions(
  clients: SyncClients,
  seriesIds: number[],
  logger: SyncLogger,
): Promise<Map<number, Resolution>> {
  const out = new Map<number, Resolution>();
  const sonarr = requireClient(clients, 'sonarr');
  for (const seriesId of seriesIds) {
    try {
      const files = await sonarr.listEpisodeFiles(seriesId);
      const dominant = dominantResolution(
        files.map((f) => resolutionFromInt(f.quality?.quality?.resolution)),
      );
      if (dominant !== null) out.set(seriesId, dominant);
    } catch (err) {
      logger.warn('metadata-refresh: sonarr episodefile fetch failed', {
        seriesId,
        error: msg(err),
      });
    }
  }
  return out;
}

/** The *arr /lookup tier for tombstoned / never-listed rows (D-05) — no re-add. */
async function tryArrLookup(
  clients: SyncClients,
  target: MetadataTarget,
): Promise<MetadataPatch | null> {
  if (target.arrKind === 'radarr' && target.tmdbId !== null) {
    const [m] = await requireClient(clients, 'radarr').lookupMovie(`tmdb:${target.tmdbId}`);
    return m ? metadataFromRadarrLookup(m as RadarrLookup) : null;
  }
  if (target.arrKind === 'sonarr' && target.tvdbId !== null) {
    const [s] = await requireClient(clients, 'sonarr').lookupSeries(`tvdb:${target.tvdbId}`);
    return s ? metadataFromSonarrLookup(s as SonarrLookup) : null;
  }
  if (target.arrKind === 'lidarr' && target.musicbrainzArtistId) {
    const [a] = await requireClient(clients, 'lidarr').lookupArtist(
      `lidarr:${target.musicbrainzArtistId}`,
    );
    return a ? metadataFromLidarrLookup(a as LidarrLookup) : null;
  }
  return null;
}

/** The direct TMDB/TVDB fallback tier for holes the *arrs can't fill (D-05). */
async function tryDirect(
  sources: MetadataSourceClients,
  target: MetadataTarget,
): Promise<{ patch: MetadataPatch; source: 'tmdb' | 'tvdb' } | null> {
  const { tmdb, tvdb } = sources;
  if (tmdb) {
    if (target.arrKind === 'radarr' && target.tmdbId !== null) {
      return { patch: metadataFromTmdbMovie(await tmdb.getMovie(target.tmdbId)), source: 'tmdb' };
    }
    if (target.arrKind === 'sonarr') {
      let tmdbId = target.tmdbId;
      if (tmdbId === null && target.tvdbId !== null) {
        tmdbId = (await tmdb.findByTvdb(target.tvdbId)).tv_results?.[0]?.id ?? null;
      }
      if (tmdbId !== null) {
        return { patch: metadataFromTmdbTv(await tmdb.getTv(tmdbId)), source: 'tmdb' };
      }
    }
  }
  if (tvdb && target.arrKind === 'sonarr' && target.tvdbId !== null) {
    return { patch: metadataFromTvdbSeries(await tvdb.getSeries(target.tvdbId)), source: 'tvdb' };
  }
  return null;
}

// ── Tautulli watch-stats aggregation (cross-server) ──────────────────────────────────────

export interface TitleWatch {
  /** Source key retained in memory for the one-off contamination proof. */
  ratingKey: string;
  arrKind: WatchKind;
  instanceSlug: string;
  guids: ParsedGuids;
  playCount: number;
  lastViewedAt: Date | null;
  // ADR-053 / DESIGN-026 D-07 — the per-user breakdown for this (instance, title): plex.tv user id →
  // that user's contribution. Empty when Tautulli carried no user_id (older data / anonymized).
  perUser: Map<string, UserWatchContribution>;
}

/** Normalize a Tautulli history `user_id` (number|string) to the string form user_account_map stores. */
function plexUserIdString(value: number | string | null | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

export interface WatchIndex {
  byTmdb: Map<number, Set<TitleWatch>>;
  byImdb: Map<string, Set<TitleWatch>>;
  byTvdb: Map<number, Set<TitleWatch>>;
}

function emptyWatchIndex(): WatchIndex {
  return { byTmdb: new Map(), byImdb: new Map(), byTvdb: new Map() };
}

function indexTitle(index: WatchIndex, tw: TitleWatch): void {
  const add = <K>(map: Map<K, Set<TitleWatch>>, key: K | undefined) => {
    if (key === undefined) return;
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(tw);
  };
  const ids = usableWatchGuids(tw.guids);
  add(index.byTmdb, ids.tmdbId);
  add(index.byImdb, ids.imdbId);
  add(index.byTvdb, ids.tvdbId);
}

/** One Tautulli instance's history walk. Dates are household instants (ISO), never one account's row. */
export interface HouseholdWatchInstance {
  slug: string;
  pages: number;
  rows: number;
  oldest: string | null;
  newest: string | null;
  /** The walk ended on an empty or short page, under the cap. */
  finished: boolean;
  /** History keys that did not join a title (gone from Plex, or no external id). */
  unjoined: number;
  /** `get_metadata` calls that threw. Any throw makes the whole read incomplete. */
  metadataErrors: number;
  error: string | null;
}

/** The grouped household history, plus whether it is complete enough to store a zero. */
export interface HouseholdWatchRead {
  index: WatchIndex;
  complete: boolean;
  instances: HouseholdWatchInstance[];
}

/**
 * DESIGN-008 D-03 — read every configured Tautulli history, one page at a time, and group it by
 * title. Movies join on `rating_key`; episodes join on the show (`grandparent_rating_key`); other
 * rows still advance the oldest/newest instants and the page count. A rating key the plex-match
 * table already resolved skips `get_metadata`.
 */
export async function readHouseholdWatch(
  input: BuildMetadataContextInput,
): Promise<HouseholdWatchRead> {
  const { logger } = input;
  const pageSize = input.tautulliPageSize ?? TAUTULLI_HISTORY_PAGE_SIZE;
  const maxPages = input.tautulliMaxPages ?? TAUTULLI_HISTORY_PAGE_CAP;
  const ratingKeyGuids = input.ratingKeyGuids ?? new Map<string, PlexRatingGuids>();
  const index = emptyWatchIndex();
  const instances: HouseholdWatchInstance[] = [];

  for (const inst of input.sources.tautulli) {
    const report: HouseholdWatchInstance = {
      slug: inst.slug,
      pages: 0,
      rows: 0,
      oldest: null,
      newest: null,
      finished: false,
      unjoined: 0,
      metadataErrors: 0,
      error: null,
    };
    instances.push(report);
    try {
      const groups = new Map<
        string,
        { arrKind: WatchKind; ratingKey: string; plays: number; last: Date | null }
      >();
      // ADR-053 / DESIGN-026 D-07 — the per-user breakdown per title: ratingKey → (plex user id →
      // contribution). Built alongside the household aggregate from the same history pages.
      const perUserGroups = new Map<string, Map<string, UserWatchContribution>>();
      for (let page = 0; page < maxPages; page++) {
        const rows = await inst.client.getHistory({ length: pageSize, start: page * pageSize });
        report.pages += 1;
        report.rows += rows.length;
        if (rows.length === 0) {
          report.finished = true;
          break;
        }
        for (const row of rows) {
          const when = tautulliDate(row.stopped ?? row.date);
          if (when) {
            const iso = when.toISOString();
            if (!report.oldest || iso < report.oldest) report.oldest = iso;
            if (!report.newest || iso > report.newest) report.newest = iso;
          }
          const type = row.media_type ?? '';
          const key =
            type === 'movie'
              ? row.rating_key
              : type === 'episode'
                ? row.grandparent_rating_key
                : undefined;
          if (key === null || key === undefined) continue;
          const arrKind = type === 'movie' ? 'radarr' : 'sonarr';
          const ratingKey = String(key);
          const k = `${arrKind}\0${ratingKey}`;
          const g = groups.get(k) ?? { arrKind, ratingKey, plays: 0, last: null };
          g.plays += 1;
          if (when && (!g.last || when > g.last)) g.last = when;
          groups.set(k, g);
          const userId = plexUserIdString(row.user_id);
          if (userId !== null) {
            let byUser = perUserGroups.get(k);
            if (!byUser) perUserGroups.set(k, (byUser = new Map()));
            const u = byUser.get(userId) ?? {
              playCount: 0,
              lastViewedAt: null,
              watched: false,
              inProgress: false,
            };
            u.playCount += 1;
            if (when && (!u.lastViewedAt || when > u.lastViewedAt)) u.lastViewedAt = when;
            const ws = row.watched_status;
            if (ws === 1) u.watched = true;
            else if (typeof ws === 'number' && ws > 0 && ws < 1) u.inProgress = true;
            byUser.set(userId, u);
          }
        }
        if (rows.length < pageSize) {
          report.finished = true;
          break;
        }
      }
      if (!report.finished) {
        logger.warn('metadata-refresh: tautulli history hit the page cap', {
          instance: inst.slug,
          pages: report.pages,
          pageSize,
        });
      }
      for (const [groupKey, g] of groups) {
        const { ratingKey, arrKind } = g;
        const cached = ratingKeyGuids.get(plexRatingGuidKey(inst.slug, ratingKey));
        let guids: ParsedGuids | null =
          cached?.arrKind === arrKind && identifiableWatchTarget(cached)
            ? usableWatchGuids(cached)
            : null;
        if (!guids) {
          let meta: TautulliMetadata | null;
          try {
            meta = await inst.client.getMetadata(ratingKey);
          } catch (err) {
            report.metadataErrors += 1;
            report.unjoined += 1;
            if (report.metadataErrors === 1) {
              logger.warn('metadata-refresh: tautulli metadata lookup failed', {
                instance: inst.slug,
                error: msg(err),
              });
            }
            continue;
          }
          // Gone from Plex (HTTP 400 / empty data — DESIGN-049 D-09): nothing to join on.
          if (!meta) {
            report.unjoined += 1;
            continue;
          }
          if (meta.media_type && meta.media_type !== (arrKind === 'radarr' ? 'movie' : 'show')) {
            report.unjoined += 1;
            continue;
          }
          guids = usableWatchGuids(guidsFromMetadata(meta));
        }
        if (
          guids.tmdbId === undefined &&
          guids.imdbId === undefined &&
          guids.tvdbId === undefined
        ) {
          report.unjoined += 1;
          continue;
        }
        indexTitle(index, {
          instanceSlug: inst.slug,
          ratingKey,
          arrKind,
          guids,
          playCount: g.plays,
          lastViewedAt: g.last,
          perUser: perUserGroups.get(groupKey) ?? new Map(),
        });
      }
      if (report.metadataErrors > 0) {
        logger.warn('metadata-refresh: tautulli metadata lookups failed', {
          instance: inst.slug,
          metadataErrors: report.metadataErrors,
        });
      }
    } catch (err) {
      report.error = msg(err);
      report.finished = false;
      logger.warn('metadata-refresh: tautulli instance failed', {
        instance: inst.slug,
        error: report.error,
      });
    }
  }

  const complete =
    instances.length > 0 &&
    instances.every((inst) => inst.finished && inst.error === null && inst.metadataErrors === 0);
  logger.info('metadata-refresh: tautulli history read', {
    complete,
    instances: instances.map((inst) => ({
      slug: inst.slug,
      pages: inst.pages,
      rows: inst.rows,
      finished: inst.finished,
      oldest: inst.oldest,
      newest: inst.newest,
      unjoined: inst.unjoined,
    })),
  });
  return { index, complete, instances };
}

/** The household watch signal for a target PLUS the per-user (plex user id → stat) breakdown (ADR-053). */
export interface TargetWatch {
  household: WatchStat;
  perUser: Map<string, UserWatchStat>;
}

export function lookupHouseholdWatch(index: WatchIndex, target: WatchTarget): TargetWatch | null {
  return matchWatch(index, target);
}

function matchWatch(index: WatchIndex, target: WatchTarget): TargetWatch | null {
  if (!identifiableWatchTarget(target)) return null;
  const ids = usableWatchGuids(target);
  const matched = new Set<TitleWatch>();
  const add = (plays: Iterable<TitleWatch>) => {
    for (const tw of plays) if (tw.arrKind === target.arrKind) matched.add(tw);
  };
  if (ids.tmdbId !== undefined) add(index.byTmdb.get(ids.tmdbId) ?? []);
  if (ids.imdbId !== undefined) add(index.byImdb.get(ids.imdbId) ?? []);
  if (ids.tvdbId !== undefined) add(index.byTvdb.get(ids.tvdbId) ?? []);
  if (matched.size === 0) return null;
  const contributions: WatchContribution[] = [...matched].map((tw) => ({
    instanceSlug: tw.instanceSlug,
    playCount: tw.playCount,
    lastViewedAt: tw.lastViewedAt,
  }));
  // ADR-053 / DESIGN-026 D-07 — collect each user's contributions across the matched titles/instances,
  // then merge per user (SUM plays / MAX last-viewed / any-watched). The household signal is untouched.
  const byUser = new Map<string, UserWatchContribution[]>();
  for (const tw of matched) {
    for (const [userId, contrib] of tw.perUser) {
      const list = byUser.get(userId) ?? [];
      list.push(contrib);
      byUser.set(userId, list);
    }
  }
  const perUser = new Map<string, UserWatchStat>();
  for (const [userId, list] of byUser) perUser.set(userId, mergeUserWatchContributions(list));
  return { household: mergeWatchContributions(contributions), perUser };
}

async function harvestMaintainerr(sources: MetadataSourceClients): Promise<Map<number, string[]>> {
  const byTmdb = new Map<number, string[]>();
  const collections = await sources.maintainerr!.getCollections();
  for (const c of collections) {
    const title = c.title ?? undefined;
    if (!title) continue;
    for (const m of c.media ?? []) {
      if (m.tmdbId === null || m.tmdbId === undefined) continue;
      const list = byTmdb.get(m.tmdbId) ?? [];
      if (!list.includes(title)) list.push(title);
      byTmdb.set(m.tmdbId, list);
    }
  }
  return byTmdb;
}
