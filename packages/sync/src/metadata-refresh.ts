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
import { parseArrTags, upsertMediaMetadataBatch, type MediaMetadataFields } from '@hnet/domain';
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
} from './adapt-metadata';
import { requireClient, type MetadataSourceClients, type SyncClients } from './clients';
import { selectMetadataTargets, type MetadataTarget } from './db-reads';
import type { SyncLogger } from './logger';

export const METADATA_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // D-03 — 6h
const DEFAULT_BATCH = 500;

/** The cross-kind indices harvested once and shared by every per-kind run. */
export interface MetadataContext {
  watchIndex: WatchIndex;
  maintainerrByTmdb: Map<number, string[]>;
  /** tiers that threw and were degraded-past while building the context. */
  degraded: string[];
}

export interface BuildMetadataContextInput {
  sources: MetadataSourceClients;
  logger: SyncLogger;
  tautulliPageSize?: number;
  tautulliMaxPages?: number;
}

/** Build the shared Tautulli watch-stats + Maintainerr collection indices (degradable). */
export async function buildMetadataContext(
  input: BuildMetadataContextInput,
): Promise<MetadataContext> {
  const degraded: string[] = [];
  let watchIndex = emptyWatchIndex();
  if (input.sources.tautulli.length > 0) {
    try {
      watchIndex = await harvestWatchStats(input);
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
  return { watchIndex, maintainerrByTmdb, degraded };
}

export interface MetadataKindRefreshInput {
  db: DbClient;
  clients: SyncClients;
  sources: MetadataSourceClients;
  context: MetadataContext;
  arrKind: ArrKind;
  arrInstanceId?: string;
  logger: SyncLogger;
  /** rows older than now-threshold (or missing) refresh. Default 6h (D-03). */
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
  degraded: string[];
}

/** Harvest metadata for the stale/missing rows of ONE *arr kind (using the shared context). */
export async function runMetadataRefreshForKind(
  input: MetadataKindRefreshInput,
): Promise<MetadataRefreshStats> {
  const { db, logger, arrKind } = input;
  const staleBefore = new Date(Date.now() - (input.staleThresholdMs ?? METADATA_STALE_THRESHOLD_MS));
  const batchSize = input.batchSize ?? DEFAULT_BATCH;
  const degraded = [...input.context.degraded];

  const targets = await selectMetadataTargets(db, {
    staleBefore,
    arrKind,
    arrInstanceId: input.arrInstanceId,
    limit: input.limit,
  });

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
    if (watch) {
      sourcesFlags.tautulli = true;
      stats.tierTautulli += 1;
      extra.tautulli = watch.perInstance;
    }

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
      playCount: watch?.playCount ?? null,
      lastViewedAt: watch?.lastViewedAt ?? null,
      sources: sourcesFlags,
      extra,
    });
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  logger.info('metadata-refresh: kind done', { ...stats });
  return stats;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

interface TitleWatch {
  instanceSlug: string;
  guids: ParsedGuids;
  playCount: number;
  lastViewedAt: Date | null;
}

interface WatchIndex {
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
  add(index.byTmdb, tw.guids.tmdbId);
  add(index.byImdb, tw.guids.imdbId);
  add(index.byTvdb, tw.guids.tvdbId);
}

async function harvestWatchStats(input: BuildMetadataContextInput): Promise<WatchIndex> {
  const { logger } = input;
  const pageSize = input.tautulliPageSize ?? 500;
  const maxPages = input.tautulliMaxPages ?? 20;
  const index = emptyWatchIndex();

  for (const inst of input.sources.tautulli) {
    try {
      const groups = new Map<string, { plays: number; last: Date | null }>();
      for (let page = 0; page < maxPages; page++) {
        const rows = await inst.client.getHistory({ length: pageSize, start: page * pageSize });
        if (rows.length === 0) break;
        for (const row of rows) {
          const type = row.media_type ?? '';
          const key =
            type === 'movie'
              ? row.rating_key
              : type === 'episode'
                ? row.grandparent_rating_key
                : undefined;
          if (key === null || key === undefined) continue;
          const k = String(key);
          const g = groups.get(k) ?? { plays: 0, last: null };
          g.plays += 1;
          const when = tautulliDate(row.stopped ?? row.date);
          if (when && (!g.last || when > g.last)) g.last = when;
          groups.set(k, g);
        }
        if (rows.length < pageSize) break;
      }
      for (const [ratingKey, g] of groups) {
        let meta: TautulliMetadata;
        try {
          meta = await inst.client.getMetadata(ratingKey);
        } catch {
          continue; // one unresolved title never fails the instance
        }
        const guids = guidsFromMetadata(meta);
        if (guids.tmdbId === undefined && guids.imdbId === undefined && guids.tvdbId === undefined) {
          continue;
        }
        indexTitle(index, { instanceSlug: inst.slug, guids, playCount: g.plays, lastViewedAt: g.last });
      }
    } catch (err) {
      logger.warn('metadata-refresh: tautulli instance failed', {
        instance: inst.slug,
        error: msg(err),
      });
    }
  }
  return index;
}

function matchWatch(
  index: WatchIndex,
  target: MetadataTarget,
): ReturnType<typeof mergeWatchContributions> | null {
  const matched = new Set<TitleWatch>();
  if (target.tmdbId !== null) for (const tw of index.byTmdb.get(target.tmdbId) ?? []) matched.add(tw);
  if (target.imdbId) for (const tw of index.byImdb.get(target.imdbId) ?? []) matched.add(tw);
  if (target.tvdbId !== null) for (const tw of index.byTvdb.get(target.tvdbId) ?? []) matched.add(tw);
  if (matched.size === 0) return null;
  const contributions: WatchContribution[] = [...matched].map((tw) => ({
    instanceSlug: tw.instanceSlug,
    playCount: tw.playCount,
    lastViewedAt: tw.lastViewedAt,
  }));
  return mergeWatchContributions(contributions);
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
