// ADR-088 / DESIGN-049 D-12..D-15 — Watch Marks: the owner's explicit statements ("I already watched X",
// "stop suggesting X", "that was someone else", "undo that"). The single writer of `watch_marks`, and the
// ONLY code that writes Plex watched state (`scrobble` / `unscrobble`, owner ruling 2026-09-23). Each flow is
// one transaction around its rows with the Plex calls outside it (D-12), and returns exactly the view the
// @hnet/watch spoken formatter takes, so the MCP layer only formats.
//
// Safety properties (PLAN-068 invariants): an ambiguous or unknown title writes nothing; `flipped` records
// EXACTLY the items that went from unwatched to watched, so undo reverses those and nothing the owner (or the
// children, on the shared account) had already watched; dismissals never call Plex.
import {
  watchMarks,
  type DbClient,
  type PlexServerSlug,
  type WatchMarkFlip,
  type WatchMarkPlexResult,
  type WatchMarkRevertResult,
  type WatchMarkRow,
  type WatchMarkScope,
  type WatchOnPlexEntry,
  type WatchTitleRow,
} from '@hnet/db';
import {
  applyEpisodeFlips,
  applyMovieFlips,
  computeMovieProgress,
  computeShowProgress,
  episodeObsFromLeaves,
  eventObs,
  isKidsTitle,
  keysOf,
  movieObsFromItem,
  movieProgressFields,
  orderOnPlex,
  parsePlexItemIds,
  plexGenres,
  selectLedgerFacts,
  selectLedgerHolders,
  selectTitleEvents,
  selectTitleRows,
  selectTitleRowsByIdentity,
  serverEpisodesFromMap,
  showProgressFields,
  storedMovieObs,
  titleKeyFor,
  withServerEpisodes,
  type Dismissal,
  type MarkResultView,
  type PlexItemLike,
  type PoolEntry,
  type ServerEpisodes,
  type ServerMovieObs,
  type UndoView,
  type WatchKind,
} from '@hnet/watch';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from '../db-client';
import { assertWatchOwner } from './accounts';
import {
  isPlexNotFound,
  plexErrorText,
  settleLimited,
  type WatchPlexClients,
} from './plex';
import { resolveWatchTitle, type ResolvedWatchTitle, type WatchTmdbSearch } from './resolve';
import { upsertWatchTitles, type WatchTitleWrite } from './titles';

/** Who a mark is for and who made it (the MCP principal: the owner row, D-03). */
export interface WatchMarkActor {
  plexAccountId: number;
  /** The app user linked to the owner (attribution, `actor_user_id`). */
  appUserId: string | null;
}

/** What a mark/dismiss flow answers. `done` carries the formatter's view. */
export type WatchMarkOutcome<V> =
  | { status: 'done'; view: V; markId: number | null; replayed: boolean }
  | { status: 'ambiguous'; options: PoolEntry[] }
  | { status: 'not_found'; kind: WatchKind | null }
  /** An episode was given without its season (D-05): nothing is written; ask for the season. */
  | { status: 'need_season' };

/**
 * D-06: where a slow call spent its time — filled by the flows when the caller passes one (the MCP layer
 * logs the slowest phase of a call over 2 s). Milliseconds.
 */
export type WatchPhases = Partial<Record<'resolve' | 'revalidate' | 'plex_write', number>>;

/** D-14 step 7: a repeat of the same mark within this window that would flip nothing is a replay. */
export const MARK_REPLAY_SECONDS = 10 * 60;
/** D-15: undo reaches back this far. */
export const UNDO_WINDOW_SECONDS = 24 * 60 * 60;
/** D-14 step 5: at most this many Plex writes in flight. */
export const MARK_WRITE_CONCURRENCY = 6;
const QUERY_MAX = 200;

// ---------------------------------------------------------------------------------------------------
// Shared pieces

interface MarkIdentity {
  kind: WatchKind;
  titleKey: string;
  title: string;
  year: number | null;
  plexGuid: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

function identityOf(t: ResolvedWatchTitle, row: WatchTitleRow | null): MarkIdentity {
  return {
    kind: t.kind,
    titleKey: row?.titleKey ?? t.titleKey,
    title: row?.title ?? t.title,
    year: row?.year ?? t.year,
    plexGuid: row?.plexGuid ?? t.ids.plexGuid,
    tmdbId: row?.tmdbId ?? t.ids.tmdbId,
    tvdbId: row?.tvdbId ?? t.ids.tvdbId,
    imdbId: row?.imdbId ?? t.ids.imdbId,
  };
}

function sameTitle(a: MarkIdentity, b: MarkIdentity): boolean {
  if (a.kind !== b.kind) return false;
  const keys = new Set(keysOf(a));
  return keysOf(b).some((k) => keys.has(k));
}

function markIdentity(m: WatchMarkRow): MarkIdentity {
  return {
    kind: m.kind,
    titleKey: m.titleKey,
    title: m.title,
    year: m.year,
    plexGuid: m.plexGuid,
    tmdbId: m.tmdbId,
    tvdbId: m.tvdbId,
    imdbId: m.imdbId,
  };
}

function trimQuery(query: string): string {
  const q = query.trim();
  return q.length > QUERY_MAX ? q.slice(0, QUERY_MAX) : q;
}

/** The newest live mark of the same statement within the replay window (D-14 step 7), if any. */
async function findReplay(
  db: DbClient,
  plexAccountId: number,
  spec: {
    action: WatchMarkRow['action'];
    scope: WatchMarkScope;
    season: number | null;
    episode: number | null;
    identity: MarkIdentity;
  },
  now: Date,
): Promise<WatchMarkRow | null> {
  const since = new Date(now.getTime() - MARK_REPLAY_SECONDS * 1000);
  const recent = await db
    .select()
    .from(watchMarks)
    .where(
      and(
        eq(watchMarks.plexAccountId, plexAccountId),
        eq(watchMarks.action, spec.action),
        eq(watchMarks.scope, spec.scope),
        isNull(watchMarks.revertedAt),
        gt(watchMarks.createdAt, since),
        sql`${watchMarks.season} IS NOT DISTINCT FROM ${spec.season}`,
        sql`${watchMarks.episode} IS NOT DISTINCT FROM ${spec.episode}`,
      ),
    )
    .orderBy(desc(watchMarks.createdAt), desc(watchMarks.id))
    .limit(20);
  return recent.find((m) => sameTitle(markIdentity(m), spec.identity)) ?? null;
}

// ---------------------------------------------------------------------------------------------------
// mark_watched (D-14)

export interface MarkWatchedInput {
  db?: DbClient;
  plex: WatchPlexClients;
  tmdb?: WatchTmdbSearch | null;
  actor: WatchMarkActor;
  /** The MCP consumer name (`hop`). */
  consumer: string;
  /** The spoken title. */
  query: string;
  kind?: WatchKind | null;
  season?: number | null;
  episode?: number | null;
  through?: boolean | null;
  now?: Date;
  /** Filled with the time spent resolving and talking to Plex (D-06). */
  phases?: WatchPhases;
}

type ScopeSpec = { scope: WatchMarkScope; season: number | null; episode: number | null };

/** D-14 step 1: the scope from the kind and the season/episode/through parameters. */
export function markScopeOf(
  kind: WatchKind,
  p: { season?: number | null; episode?: number | null; through?: boolean | null },
): ScopeSpec | 'need_season' {
  if (kind === 'movie') return { scope: 'movie', season: null, episode: null };
  const season = p.season ?? null;
  const episode = p.episode ?? null;
  if (episode !== null && season === null) return 'need_season';
  if (season === null) return { scope: 'show', season: null, episode: null };
  if (episode === null) return { scope: 'season', season, episode: null };
  return { scope: p.through ? 'through' : 'episode', season, episode };
}

/** One Plex write and the items it flips. */
interface PlannedWrite {
  server: PlexServerSlug;
  ratingKey: string;
  flips: WatchMarkFlip[];
}

/** The before-state of one target server and what the mark would do there. */
interface TargetPlan {
  holder: WatchOnPlexEntry;
  /** The scope exists on this server (a season/episode Plex does not have does not). */
  hasScope: boolean;
  writes: PlannedWrite[];
  /** Episodes the scope covers (seasons ≥ 1), for the read-back ("all 19 episodes"). */
  covered: number;
  leaves: PlexItemLike[];
  movie: ServerMovieObs | null;
  /** The show/movie item itself when it was read (a title new to history needs its identity). */
  item: PlexItemLike | null;
}

function isWatched(item: PlexItemLike): boolean {
  return (item.viewCount ?? 0) > 0;
}

function flipOf(server: PlexServerSlug, item: PlexItemLike): WatchMarkFlip {
  return { server, ratingKey: item.ratingKey };
}

/**
 * D-14 step 5 for a show on one server, from its live `allLeaves`: whole show ⇒ the show key once; season
 * ⇒ the season key; episode ⇒ the episode key; through (S, E) ⇒ the season key of each earlier season
 * (1…S−1) that has unwatched episodes plus each unwatched episode ≤ E of season S. Only writes that flip
 * something are planned; `flips` are exactly the leaves that were unwatched (specials included for a whole
 * show, whose scrobble marks them too).
 */
export function planShowWrites(
  server: PlexServerSlug,
  showKey: string,
  leaves: readonly PlexItemLike[],
  spec: ScopeSpec,
): Pick<TargetPlan, 'hasScope' | 'writes' | 'covered'> {
  const regular = leaves.filter((l) => (l.parentIndex ?? 0) >= 1);
  const inSeason = (s: number) => leaves.filter((l) => l.parentIndex === s);
  const seasonWrite = (items: readonly PlexItemLike[]): PlannedWrite[] => {
    const unwatched = items.filter((l) => !isWatched(l));
    if (unwatched.length === 0) return [];
    const seasonKey = items[0]?.parentRatingKey;
    if (seasonKey && items.every((l) => l.parentRatingKey === seasonKey)) {
      return [{ server, ratingKey: seasonKey, flips: unwatched.map((l) => flipOf(server, l)) }];
    }
    return unwatched.map((l) => ({ server, ratingKey: l.ratingKey, flips: [flipOf(server, l)] }));
  };
  switch (spec.scope) {
    case 'show': {
      const unwatched = leaves.filter((l) => !isWatched(l));
      return {
        hasScope: leaves.length > 0,
        covered: regular.length,
        writes:
          unwatched.length === 0
            ? []
            : [{ server, ratingKey: showKey, flips: unwatched.map((l) => flipOf(server, l)) }],
      };
    }
    case 'season': {
      const items = inSeason(spec.season ?? -1);
      return { hasScope: items.length > 0, covered: items.length, writes: seasonWrite(items) };
    }
    case 'episode': {
      const leaf = leaves.find((l) => l.parentIndex === spec.season && l.index === spec.episode);
      return {
        hasScope: leaf !== undefined,
        covered: leaf ? 1 : 0,
        writes:
          leaf && !isWatched(leaf) ? [{ server, ratingKey: leaf.ratingKey, flips: [flipOf(server, leaf)] }] : [],
      };
    }
    case 'through': {
      const s = spec.season ?? 0;
      const e = spec.episode ?? 0;
      const writes: PlannedWrite[] = [];
      let covered = 0;
      const earlier = [...new Set(regular.map((l) => l.parentIndex as number))]
        .filter((n) => n < s)
        .sort((a, b) => a - b);
      for (const n of earlier) {
        const items = inSeason(n);
        covered += items.length;
        writes.push(...seasonWrite(items));
      }
      const upTo = inSeason(s).filter((l) => (l.index ?? 0) <= e);
      covered += upTo.length;
      for (const l of upTo) {
        if (!isWatched(l)) writes.push({ server, ratingKey: l.ratingKey, flips: [flipOf(server, l)] });
      }
      return { hasScope: covered > 0, covered, writes };
    }
    default:
      return { hasScope: false, covered: 0, writes: [] };
  }
}

/**
 * D-14 steps 2–3 / ADR-088: which servers get a write. View-state sync carries a MATCHED item's state to
 * the other servers, so the most preferred matched holder is written; an unmatched `local://` copy is not
 * synced, so every local holder is written too.
 */
export function markTargets(holders: readonly WatchOnPlexEntry[]): WatchOnPlexEntry[] {
  const ordered = orderOnPlex(holders);
  const matched = ordered.find((h) => !h.local);
  return ordered.filter((h) => h.local || h === matched);
}

async function holdingServers(
  db: DbClient,
  plex: WatchPlexClients,
  t: ResolvedWatchTitle,
  row: WatchTitleRow | null,
): Promise<WatchOnPlexEntry[]> {
  if (row && row.onPlex.length > 0) return orderOnPlex(row.onPlex);
  if (t.mediaItemIds.length > 0) {
    const ledger = await selectLedgerHolders(db, t.mediaItemIds);
    if (ledger.length > 0) {
      return orderOnPlex(ledger.map((h) => ({ server: h.server, ratingKey: h.ratingKey, local: false })));
    }
  }
  const guid = t.ids.plexGuid;
  if (!guid) return [];
  const found = await Promise.all(
    (Object.entries(plex.read) as Array<[PlexServerSlug, NonNullable<WatchPlexClients['read'][PlexServerSlug]>]>).map(
      async ([server, client]) => {
        try {
          const items = await client.findByGuid(guid);
          const hit = items.find((i) => i.type === t.kind);
          return hit ? [{ server, ratingKey: hit.ratingKey, local: false }] : [];
        } catch {
          return [];
        }
      },
    ),
  );
  return orderOnPlex(found.flat());
}

type BeforeRead =
  | { holder: WatchOnPlexEntry; status: 'ok'; leaves: PlexItemLike[]; item: PlexItemLike | null }
  | { holder: WatchOnPlexEntry; status: 'gone' }
  | { holder: WatchOnPlexEntry; status: 'error'; error: unknown };

async function readBefore(
  plex: WatchPlexClients,
  kind: WatchKind,
  holder: WatchOnPlexEntry,
  wantShowItem: boolean,
): Promise<BeforeRead> {
  const client = plex.read[holder.server];
  if (!client) return { holder, status: 'error', error: new Error(`no Plex client for ${holder.server}`) };
  try {
    if (kind === 'movie') {
      const meta = await client.getMetadataItem(holder.ratingKey);
      if (!meta) return { holder, status: 'gone' };
      return { holder, status: 'ok', leaves: [], item: meta.item };
    }
    const [listing, meta] = await Promise.all([
      client.listAllLeaves(holder.ratingKey),
      wantShowItem ? client.getMetadataItem(holder.ratingKey) : Promise.resolve(null),
    ]);
    // A truncated listing is a partial before-state: a show scrobble would flip leaves it never saw, so
    // `flipped` (and the undo) would miss them. It is a failed read: no write on this server.
    if (listing.truncated) {
      return { holder, status: 'error', error: new Error(`allLeaves ${holder.ratingKey} was truncated`) };
    }
    return { holder, status: 'ok', leaves: listing.items, item: meta?.item ?? null };
  } catch (error) {
    return isPlexNotFound(error) ? { holder, status: 'gone' } : { holder, status: 'error', error };
  }
}

/** The mark's identity, completed from the show/movie item Plex just returned (a title new to history). */
function withPlexIdentity(identity: MarkIdentity, item: PlexItemLike | null): MarkIdentity {
  if (!item) return identity;
  const ids = parsePlexItemIds(item);
  const merged = {
    ...identity,
    plexGuid: identity.plexGuid ?? (ids.plexGuid?.startsWith(`plex://${identity.kind}/`) ? ids.plexGuid : null),
    tmdbId: identity.tmdbId ?? ids.tmdbId,
    tvdbId: identity.kind === 'show' ? (identity.tvdbId ?? ids.tvdbId) : null,
    imdbId: identity.imdbId ?? ids.imdbId,
  };
  return { ...merged, titleKey: titleKeyFor(merged) };
}

/**
 * `mark_watched` (D-14). Resolve (ambiguous / not found / episode-without-season write nothing), find the
 * holding servers, read the before-state live, record the mark as `pending` with the planned flips, write
 * Plex (≤ 6 concurrent), then finalize the mark with exactly what flipped and write the Title State
 * through. A repeat within 10 minutes that would flip nothing answers like the first and inserts no row.
 * The actor must be the current owner (D-03): anything else throws {@link WatchNotReadyError} first.
 */
export async function markWatched(input: MarkWatchedInput): Promise<WatchMarkOutcome<MarkResultView>> {
  const now = input.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const db = resolveDb(input.db);
  const acct = input.actor.plexAccountId;
  await assertWatchOwner(db, acct);

  const resolveStart = Date.now();
  const resolution = await resolveWatchTitle({
    db,
    plexAccountId: acct,
    query: input.query,
    kind: input.kind ?? null,
    tmdb: input.tmdb ?? null,
  });
  if (input.phases) input.phases.resolve = Date.now() - resolveStart;
  if (resolution.status === 'ambiguous') return { status: 'ambiguous', options: resolution.options };
  if (resolution.status === 'not_found') return { status: 'not_found', kind: input.kind ?? null };
  const t = resolution;
  const spec = markScopeOf(t.kind, input);
  if (spec === 'need_season') return { status: 'need_season' };

  const [row = null] =
    t.titleRowId !== null ? await selectTitleRows(db, acct, { ids: [t.titleRowId] }) : [];
  let identity = identityOf(t, row);

  // D-14 steps 2–3: holders, targets, live before-state.
  const plexStart = Date.now();
  const holders = t.source === 'tmdb' ? [] : await holdingServers(db, input.plex, t, row);
  const targets = markTargets(holders);
  const reads = await Promise.all(
    targets.map((h) => readBefore(input.plex, t.kind, h, row === null)),
  );
  const plans: TargetPlan[] = [];
  const readErrors: unknown[] = [];
  for (const r of reads) {
    if (r.status === 'error') {
      readErrors.push(r.error);
      continue;
    }
    if (r.status === 'gone') continue;
    if (row === null) identity = withPlexIdentity(identity, r.item);
    if (t.kind === 'movie') {
      const item = r.item;
      if (!item) continue;
      const movie = movieObsFromItem(r.holder.server, item);
      plans.push({
        holder: r.holder,
        hasScope: true,
        covered: 1,
        leaves: [],
        movie,
        item,
        writes: isWatched(item)
          ? []
          : [{ server: r.holder.server, ratingKey: item.ratingKey, flips: [flipOf(r.holder.server, item)] }],
      });
    } else {
      plans.push({
        holder: r.holder,
        leaves: r.leaves,
        movie: null,
        item: r.item,
        ...planShowWrites(r.holder.server, r.holder.ratingKey, r.leaves, spec),
      });
    }
  }
  const scoped = plans.filter((p) => p.hasScope);
  const writes = scoped.flatMap((p) => p.writes);
  const planned = writes.flatMap((w) => w.flips);
  const covered = scoped[0]?.covered ?? null;
  const notOnPlex = scoped.length === 0 && readErrors.length === 0;

  const view = (plexResult: WatchMarkPlexResult, flipped: number): MarkResultView => ({
    kind: identity.kind,
    title: identity.title,
    year: identity.year,
    scope: spec.scope,
    season: spec.season,
    episode: spec.episode,
    plexResult: plexResult === 'pending' ? 'failed' : plexResult,
    episodes: plexResult === 'not_on_plex' ? null : covered,
    flipped,
  });

  // D-14 step 7: a retried call that would flip nothing answers like the first and inserts no row.
  if (planned.length === 0 && readErrors.length === 0) {
    const first = await findReplay(db, acct, { action: 'watched', ...spec, identity }, now);
    if (first) {
      return {
        status: 'done',
        view: view(first.plexResult, first.flipped.length),
        markId: first.id,
        replayed: true,
      };
    }
  }

  const base = {
    plexAccountId: acct,
    action: 'watched' as const,
    scope: spec.scope,
    titleKey: identity.titleKey,
    kind: identity.kind,
    title: identity.title,
    year: identity.year,
    plexGuid: identity.plexGuid,
    tmdbId: identity.tmdbId,
    tvdbId: identity.tvdbId,
    imdbId: identity.imdbId,
    season: spec.season,
    episode: spec.episode,
    query: trimQuery(input.query),
    consumer: input.consumer,
    actorUserId: input.actor.appUserId,
    createdAt: now,
  };

  if (notOnPlex) {
    const [mark] = await db
      .insert(watchMarks)
      .values({ ...base, flipped: [], plexResult: 'not_on_plex' })
      .returning({ id: watchMarks.id });
    return { status: 'done', view: view('not_on_plex', 0), markId: mark?.id ?? null, replayed: false };
  }

  // D-14 step 4: the pending row with the planned keys, BEFORE any Plex write.
  const [pending] = await db
    .insert(watchMarks)
    .values({ ...base, flipped: planned, plexResult: 'pending' })
    .returning({ id: watchMarks.id });
  if (!pending) throw new Error('watch mark insert returned no row');

  // D-14 step 5: the writes, at most 6 in flight.
  const settled = await settleLimited(
    writes.map((w) => () => {
      const client = input.plex.write[w.server];
      if (!client) return Promise.reject(new Error(`no Plex write client for ${w.server}`));
      return client.scrobble(w.ratingKey);
    }),
    MARK_WRITE_CONCURRENCY,
  );
  const flipped: WatchMarkFlip[] = [];
  const errors: unknown[] = [...readErrors];
  settled.forEach((s, i) => {
    const w = writes[i];
    if (!w) return;
    if (s.status === 'fulfilled') flipped.push(...w.flips);
    else errors.push(s.reason);
  });
  if (input.phases) input.phases.plex_write = Date.now() - plexStart;
  const attempts = writes.length + readErrors.length;
  const failures = errors.length;
  const plexResult: WatchMarkPlexResult =
    failures === 0 ? 'written' : failures < attempts ? 'partial' : 'failed';

  // D-14 step 6: finalize + write the Title State through (the flips applied to the fresh before-state,
  // no second read), in one transaction.
  const title = await prepareWriteThrough(db, {
    plexAccountId: acct,
    identity,
    row,
    resolution: t,
    holders,
    plans: scoped,
    flips: flipped,
    watched: true,
    at: nowSec,
  });
  await inTransaction(db, async (tx) => {
    await tx
      .update(watchMarks)
      .set({
        plexResult,
        flipped,
        plexError: errors.length > 0 ? plexErrorText(errors[0]) : null,
      })
      .where(eq(watchMarks.id, pending.id));
    await upsertWatchTitles({ db: tx, plexAccountId: acct, titles: [title], now });
  });
  return { status: 'done', view: view(plexResult, flipped.length), markId: pending.id, replayed: false };
}

// ---------------------------------------------------------------------------------------------------
// Title State write-through (D-14 step 6, D-15)

/**
 * The Title State after a mark or its undo, computed without a second Plex read: the fresh before-state
 * reads (per server) over the stored snapshot, with the flips applied, recomputed with the title's events.
 */
async function prepareWriteThrough(
  db: DbClient,
  w: {
    plexAccountId: number;
    identity: MarkIdentity;
    row: WatchTitleRow | null;
    resolution: ResolvedWatchTitle | null;
    holders: readonly WatchOnPlexEntry[];
    /** Fresh reads to use instead of the stored snapshot, per server. */
    plans: ReadonlyArray<Pick<TargetPlan, 'holder' | 'leaves' | 'movie' | 'item'>>;
    flips: readonly WatchMarkFlip[];
    watched: boolean;
    at: number;
  },
): Promise<WatchTitleWrite> {
  const { row, identity } = w;
  const events = (
    await selectTitleEvents(db, w.plexAccountId, {
      kind: identity.kind,
      plexGuid: identity.plexGuid,
      title: identity.title,
      year: identity.year,
    })
  ).map(eventObs);

  let progress;
  if (identity.kind === 'show') {
    const fresh: ServerEpisodes[] = w.plans.map((p) => ({
      server: p.holder.server,
      episodes: episodeObsFromLeaves(p.leaves),
    }));
    const servers = withServerEpisodes(serverEpisodesFromMap(row?.episodeMap), fresh);
    const after = applyEpisodeFlips(servers, w.flips, w.watched, w.watched ? w.at : null);
    progress = showProgressFields(
      computeShowProgress(after, events),
      row ? { season: row.nextSeason, episode: row.nextEpisode, title: row.nextTitle } : null,
    );
  } else {
    const fresh = w.plans.flatMap((p) => (p.movie ? [p.movie] : []));
    const stored = row ? storedMovieObs(row).filter((o) => !fresh.some((f) => f.server === o.server)) : [];
    const after = applyMovieFlips([...fresh, ...stored], w.flips, w.watched, w.watched ? w.at : null);
    progress = movieProgressFields(computeMovieProgress(after, events), after);
  }

  if (row) {
    return {
      id: row.id,
      kind: row.kind,
      titleKey: row.titleKey,
      plexGuid: row.plexGuid,
      tmdbId: row.tmdbId,
      tvdbId: row.tvdbId,
      imdbId: row.imdbId,
      mediaItemId: row.mediaItemId,
      title: row.title,
      year: row.year,
      genres: row.genres,
      contentRating: row.contentRating,
      isKids: row.isKids,
      onPlex: row.onPlex,
      // The stored counters stay: they no longer match Plex, so the next sync re-reads this title fully.
      plexCounts: row.plexCounts,
      showStatus: row.showStatus,
      ...progress,
    };
  }
  // A title new to the owner's history: identity from the resolution + the Plex item, genres (ledger
  // first, D-16) and status from the ledger. No counters yet, so the next sync reads it fully.
  const facts = w.resolution ? await selectLedgerFacts(db, w.resolution.mediaItemIds) : [];
  const item = w.plans.find((p) => p.item !== null)?.item ?? null;
  const genres = facts.find((f) => f.genres.length > 0)?.genres ?? (item ? plexGenres(item) : []);
  const contentRating = item?.contentRating ?? null;
  return {
    kind: identity.kind,
    titleKey: identity.titleKey,
    plexGuid: identity.plexGuid,
    tmdbId: identity.tmdbId,
    tvdbId: identity.tvdbId,
    imdbId: identity.imdbId,
    mediaItemId: w.resolution?.mediaItemIds[0] ?? null,
    title: identity.title,
    year: identity.year ?? item?.year ?? null,
    genres,
    contentRating,
    isKids: isKidsTitle({ kind: identity.kind, contentRating, genres }),
    onPlex: orderOnPlex(w.holders),
    plexCounts: {},
    showStatus: facts.find((f) => f.showStatus !== null)?.showStatus ?? null,
    ...progress,
  };
}

// ---------------------------------------------------------------------------------------------------
// dismiss (D-15)

export interface DismissTitleInput {
  db?: DbClient;
  tmdb?: WatchTmdbSearch | null;
  actor: WatchMarkActor;
  consumer: string;
  query: string;
  kind?: WatchKind | null;
  /** Default `not_interested`. */
  reason?: Dismissal | null;
  now?: Date;
  phases?: WatchPhases;
}

export interface DismissView {
  kind: WatchKind;
  title: string;
  year: number | null;
  reason: Dismissal;
}

/**
 * `dismiss` (D-15): record `not_interested` (never suggested again, dropped from Unfinished) or `not_mine`
 * (out of Ever Watched, the Taste Profile and Unfinished). NEVER calls Plex — there is no Plex parameter.
 * A repeat within 10 minutes answers like the first without a new row (so it never becomes the "last change").
 * The actor must be the current owner (D-03): anything else throws {@link WatchNotReadyError} first.
 */
export async function dismissTitle(input: DismissTitleInput): Promise<WatchMarkOutcome<DismissView>> {
  const now = input.now ?? new Date();
  const db = resolveDb(input.db);
  const acct = input.actor.plexAccountId;
  await assertWatchOwner(db, acct);
  const reason: Dismissal = input.reason ?? 'not_interested';
  const resolveStart = Date.now();
  const resolution = await resolveWatchTitle({
    db,
    plexAccountId: acct,
    query: input.query,
    kind: input.kind ?? null,
    tmdb: input.tmdb ?? null,
  });
  if (input.phases) input.phases.resolve = Date.now() - resolveStart;
  if (resolution.status === 'ambiguous') return { status: 'ambiguous', options: resolution.options };
  if (resolution.status === 'not_found') return { status: 'not_found', kind: input.kind ?? null };
  const [row = null] =
    resolution.titleRowId !== null ? await selectTitleRows(db, acct, { ids: [resolution.titleRowId] }) : [];
  const identity = identityOf(resolution, row);
  const scope: WatchMarkScope = identity.kind === 'movie' ? 'movie' : 'show';
  const view: DismissView = { kind: identity.kind, title: identity.title, year: identity.year, reason };

  const first = await findReplay(db, acct, { action: reason, scope, season: null, episode: null, identity }, now);
  if (first) return { status: 'done', view, markId: first.id, replayed: true };

  const [mark] = await db
    .insert(watchMarks)
    .values({
      plexAccountId: acct,
      action: reason,
      scope,
      titleKey: identity.titleKey,
      kind: identity.kind,
      title: identity.title,
      year: identity.year,
      plexGuid: identity.plexGuid,
      tmdbId: identity.tmdbId,
      tvdbId: identity.tvdbId,
      imdbId: identity.imdbId,
      season: null,
      episode: null,
      query: trimQuery(input.query),
      consumer: input.consumer,
      actorUserId: input.actor.appUserId,
      flipped: [],
      plexResult: 'none',
      createdAt: now,
    })
    .returning({ id: watchMarks.id });
  return { status: 'done', view, markId: mark?.id ?? null, replayed: false };
}

// ---------------------------------------------------------------------------------------------------
// undo_last_change (D-15)

export interface UndoLastChangeInput {
  db?: DbClient;
  plex: WatchPlexClients;
  actor: WatchMarkActor;
  now?: Date;
  phases?: WatchPhases;
}

interface PlannedRevert {
  server: PlexServerSlug;
  ratingKey: string;
  /** The flipped items this unscrobble puts back. */
  flips: WatchMarkFlip[];
}

/**
 * D-15's collapse on one server: unscrobble the SHOW key when `flipped` covers every leaf the show has
 * now, else each SEASON key whose every leaf is in `flipped`, else the episode keys — so an undo never
 * touches an item the mark did not flip. `leaves` must be the COMPLETE live listing: null (the read failed
 * or was truncated) ⇒ one call per flipped key, and so does a listing with a leaf that names no season
 * (its season's membership is unknown, so no show or season key can be proven exact).
 */
export function planReverts(
  server: PlexServerSlug,
  showKey: string | null,
  flips: readonly WatchMarkFlip[],
  leaves: readonly PlexItemLike[] | null,
): PlannedRevert[] {
  const own = flips.filter((f) => f.server === server);
  const one = (f: WatchMarkFlip): PlannedRevert => ({ server, ratingKey: f.ratingKey, flips: [f] });
  if (!leaves || leaves.length === 0 || leaves.some((l) => !l.parentRatingKey)) return own.map(one);
  const keys = new Set(own.map((f) => f.ratingKey));
  if (showKey && leaves.every((l) => keys.has(l.ratingKey))) {
    return [{ server, ratingKey: showKey, flips: [...own] }];
  }
  const out: PlannedRevert[] = [];
  const done = new Set<string>();
  const seasons = new Map<string, PlexItemLike[]>();
  for (const l of leaves) {
    const seasonKey = l.parentRatingKey as string;
    const list = seasons.get(seasonKey) ?? [];
    list.push(l);
    seasons.set(seasonKey, list);
  }
  for (const [seasonKey, items] of seasons) {
    if (items.length > 0 && items.every((l) => keys.has(l.ratingKey))) {
      out.push({
        server,
        ratingKey: seasonKey,
        flips: own.filter((f) => items.some((l) => l.ratingKey === f.ratingKey)),
      });
      for (const l of items) done.add(l.ratingKey);
    }
  }
  for (const f of own) if (!done.has(f.ratingKey)) out.push(one(f));
  return out;
}

/**
 * `undo_last_change` (D-15): revert the owner's newest unreverted, COMPLETED mark of the last 24 hours (a
 * `pending` mark is in flight or crashed: its `flipped` is only the plan, so it is never picked). A
 * `watched` mark unscrobbles exactly `flipped` (collapsed to show/season keys where `flipped` covers all of
 * it) and writes the Title State through; a dismissal is simply reverted (no Plex call). Plex's unscrobble
 * clears resume points (ADR-088 C-04). The mark is stamped reverted only when the unscrobbles all landed
 * (`written`, or `none` with nothing to put back): a `failed` / `partial` undo records its result and
 * leaves the mark live, so the next undo retries THE SAME mark (unscrobble is idempotent) instead of
 * reaching an older one. Nothing to undo ⇒ `{ undone: false }`. The actor must be the current owner (D-03):
 * anything else throws {@link WatchNotReadyError} first.
 */
export async function undoLastChange(input: UndoLastChangeInput): Promise<WatchMarkOutcome<UndoView>> {
  const now = input.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const db = resolveDb(input.db);
  const acct = input.actor.plexAccountId;
  await assertWatchOwner(db, acct);
  const since = new Date(now.getTime() - UNDO_WINDOW_SECONDS * 1000);
  const [mark] = await db
    .select()
    .from(watchMarks)
    .where(
      and(
        eq(watchMarks.plexAccountId, acct),
        isNull(watchMarks.revertedAt),
        ne(watchMarks.plexResult, 'pending'),
        gt(watchMarks.createdAt, since),
      ),
    )
    .orderBy(desc(watchMarks.createdAt), desc(watchMarks.id))
    .limit(1);
  if (!mark) return { status: 'done', view: { undone: false }, markId: null, replayed: false };

  const identity = markIdentity(mark);
  const flips = mark.action === 'watched' ? mark.flipped : [];
  let revertResult: WatchMarkRevertResult = 'none';
  const reverted: WatchMarkFlip[] = [];
  let rows: WatchTitleRow[] = [];
  const liveLeaves = new Map<PlexServerSlug, PlexItemLike[]>();

  if (flips.length > 0) {
    const plexStart = Date.now();
    // The Title State tells us the show key on each server (the flips are episode keys).
    rows = await selectTitleRowsByIdentity(db, acct, identity);
    const row = rows[0] ?? null;
    const servers = [...new Set(flips.map((f) => f.server))];
    const plans: PlannedRevert[] = [];
    for (const server of servers) {
      const showKey =
        identity.kind === 'show' ? (row?.onPlex.find((e) => e.server === server)?.ratingKey ?? null) : null;
      let leaves: PlexItemLike[] | null = null;
      const client = input.plex.read[server];
      if (showKey && client) {
        try {
          const listing = await client.listAllLeaves(showKey);
          // A truncated listing could make a partial season (or show) look fully flipped and collapse onto
          // leaves the mark never flipped: treat it like a failed read (one unscrobble per flipped key).
          if (!listing.truncated) {
            leaves = listing.items;
            liveLeaves.set(server, leaves);
          }
        } catch {
          leaves = null;
        }
      }
      plans.push(...planReverts(server, showKey, flips, leaves));
    }
    const settled = await settleLimited(
      plans.map((p) => async () => {
        const client = input.plex.write[p.server];
        if (!client) throw new Error(`no Plex write client for ${p.server}`);
        try {
          await client.unscrobble(p.ratingKey);
        } catch (error) {
          // Gone from Plex: nothing is left to put back.
          if (!isPlexNotFound(error)) throw error;
        }
      }),
      MARK_WRITE_CONCURRENCY,
    );
    let ok = 0;
    settled.forEach((s, i) => {
      const p = plans[i];
      if (!p || s.status !== 'fulfilled') return;
      ok += 1;
      reverted.push(...p.flips);
    });
    revertResult = ok === plans.length ? 'written' : ok > 0 ? 'partial' : 'failed';
    if (input.phases) input.phases.plex_write = Date.now() - plexStart;
  }

  const row = rows[0] ?? null;
  const title =
    reverted.length > 0 && row
      ? await prepareWriteThrough(db, {
          plexAccountId: acct,
          identity,
          row,
          resolution: null,
          holders: row.onPlex,
          plans: [...liveLeaves.entries()].map(([server, leaves]) => ({
            holder: row.onPlex.find((e) => e.server === server) ?? { server, ratingKey: '', local: false },
            leaves,
            movie: null,
            item: null,
          })),
          flips: reverted,
          watched: false,
          at: nowSec,
        })
      : null;
  // Only a complete revert closes the mark; a failed or partial one stays live for the retry.
  const complete = revertResult === 'written' || revertResult === 'none';
  await inTransaction(db, async (tx) => {
    await tx
      .update(watchMarks)
      .set(complete ? { revertedAt: now, revertResult } : { revertResult })
      .where(and(eq(watchMarks.id, mark.id), isNull(watchMarks.revertedAt)));
    if (title) await upsertWatchTitles({ db: tx, plexAccountId: acct, titles: [title], now });
  });

  return {
    status: 'done',
    view: {
      undone: true,
      action: mark.action,
      kind: mark.kind,
      title: mark.title,
      year: mark.year,
      scope: mark.scope,
      season: mark.season,
      episode: mark.episode,
      revertResult: mark.action === 'watched' ? revertResult : null,
      episodes: reverted.length,
    },
    markId: mark.id,
    replayed: false,
  };
}
