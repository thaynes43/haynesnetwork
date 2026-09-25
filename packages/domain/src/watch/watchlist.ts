// ADR-092 / DESIGN-051 D-03 / D-04 (PLAN-071) — Watchlist Changes (T-260): the owner's plex.tv watchlist changed
// through `set_watchlist`, recorded as a Watch Mark (`watchlist_add` / `watchlist_remove`) so it is attributed,
// audited by its row and undone by `undo_last_change`. With `marks.ts`, the single writer of `watch_marks`, and
// the ONLY code that writes the watchlist (`addToWatchlist` / `removeFromWatchlist`, owner ruling 2026-09-25).
//
// Safety properties: only the Server Owner's watchlist is read or written (ADR-092 C-04: a non-owner gets no row
// and no Plex call); an ambiguous, unknown or unconfirmed title writes nothing; a change that would change nothing
// (plex.tv already shows the asked state) writes no row and sends nothing, so a retried call never becomes the
// "last change"; the row is inserted `pending` BEFORE the write and finalized `written` / `failed` after it; every
// discover id is validated before it is put in a URL (`@hnet/plex`'s `requireDiscoverId`).
import { watchMarks, type DbClient, type WatchMarkRevertResult, type WatchMarkRow } from '@hnet/db';
import {
  DISCOVER_ID_PATTERN,
  PlexHttpError,
  PlexNetworkError,
  PlexTimeoutError,
  discoverIdFromGuid,
  type DiscoverKind,
} from '@hnet/plex';
import type { DiscoverMatch } from '@hnet/plex/read';
import {
  isOnWatchlist,
  onPlexFor,
  selectTitleFacts,
  selectWatchlist,
  titleKeyFor,
  type PoolEntry,
  type WatchKind,
  type WatchlistChangeView,
} from '@hnet/watch';
import { eq } from 'drizzle-orm';
import { resolveDb } from '../db-client';
import { assertTrackedWatchAccount } from './accounts';
import type { WatchMarkActor, WatchPhases } from './marks';
import {
  isPlexNotFound,
  plexErrorText,
  watchlistClient,
  type WatchDiscoverRead,
  type WatchPlexClients,
  type WatchPlexReaders,
} from './plex';
import { resolveWatchTitle, type WatchTmdbSearch } from './resolve';

const QUERY_MAX = 200;

export type WatchlistChangeAction = 'add' | 'remove';

/** The D-10 `result` of a `set_watchlist` call. */
export type WatchlistChangeResult =
  | 'written'
  | 'failed'
  | 'unchanged'
  | 'not_found'
  | 'ambiguous'
  | 'not_in_catalog'
  /** PLAN-071 ruling 6: the plex guid and the external-id match named different discover titles. */
  | 'unconfirmed'
  | 'not_owner';

export type ChangeWatchlistOutcome =
  /** ADR-092 C-04: not the Server Owner — no row, no Plex call. */
  | { status: 'not_owner'; result: 'not_owner' }
  | { status: 'ambiguous'; result: 'ambiguous'; options: PoolEntry[] }
  | { status: 'not_found'; result: 'not_found'; kind: WatchKind | null }
  | {
      status: 'done';
      result: Exclude<WatchlistChangeResult, 'not_owner' | 'ambiguous' | 'not_found'>;
      view: WatchlistChangeView;
      /** The Watch Mark written (null when nothing was recorded). */
      markId: number | null;
      kind: WatchKind;
      /** The D-02 "on Plex" rule for the title (null when the flow stopped before it knew the title). */
      onPlex: boolean | null;
    };

export interface ChangeWatchlistInput {
  db?: DbClient;
  /** The owner's clients sized for a write (DESIGN-049 D-27: ≈ 800 ms per attempt): the watchlist PUTs. */
  plex: WatchPlexClients;
  /**
   * The discover reads (the external-id match, userState) on the SHORT live-read budget (PLAN-071 ruling 8:
   * DESIGN-049 D-11's ≈ 300 ms per attempt). Absent or without the discover reads ⇒ `plex.read`.
   */
  reads?: WatchPlexReaders | null;
  tmdb?: WatchTmdbSearch | null;
  actor: WatchMarkActor;
  /** The MCP consumer name (`hop`, `oauth:<client_id>`). */
  consumer: string;
  /** The spoken title. */
  query: string;
  action: WatchlistChangeAction;
  kind?: WatchKind | null;
  now?: Date;
  phases?: WatchPhases;
}

interface WatchlistIdentity {
  kind: WatchKind;
  titleKey: string;
  title: string;
  year: number | null;
  plexGuid: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

/** The discover reader: the short-budget readers when they carry the discover reads, else the write bundle's. */
export function discoverReader(
  plex: WatchPlexClients,
  reads?: WatchPlexReaders | null,
): WatchDiscoverRead | null {
  const short = watchlistClient(reads?.read ?? {});
  if (short?.matchDiscover && short.getDiscoverUserState) {
    return { matchDiscover: short.matchDiscover.bind(short), getDiscoverUserState: short.getDiscoverUserState.bind(short) };
  }
  return watchlistClient(plex.read);
}

/** The first external id the identity has, as the provider's match guid: `tmdb://`, then `tvdb://` (shows), then `imdb://`. */
function externalGuid(t: WatchlistIdentity): string | null {
  if (t.tmdbId) return `tmdb://${t.tmdbId}`;
  if (t.kind === 'show' && t.tvdbId) return `tvdb://${t.tvdbId}`;
  if (t.imdbId) return `imdb://${t.imdbId}`;
  return null;
}

/** A failure a re-read can settle: the write may have landed (a timeout, a dropped connection, a 5xx). */
function mayHaveLanded(error: unknown): boolean {
  return (
    error instanceof PlexTimeoutError ||
    error instanceof PlexNetworkError ||
    (error instanceof PlexHttpError && error.status >= 500)
  );
}

/** plex.tv's own state of the title right now: true / false, or null when it could not be read. */
async function liveOnWatchlist(reader: WatchDiscoverRead, id: string): Promise<boolean | null> {
  try {
    return (await reader.getDiscoverUserState(id)).watchlistedAt !== null;
  } catch {
    return null;
  }
}

/**
 * Send one watchlist write (DESIGN-051 D-03 step 6 / D-04; PLAN-071 ruling 4). The client retries the idempotent
 * PUT; when the last attempt still fails with a timeout, a dropped connection or a 5xx, plex.tv's userState is
 * re-read once and decides (the write may have landed). A 404 is "not in Plex's catalog".
 */
export async function sendWatchlistWrite(input: {
  plex: WatchPlexClients;
  reader: WatchDiscoverRead | null;
  id: string;
  add: boolean;
}): Promise<{ result: 'written' | 'failed' | 'not_found'; error: unknown }> {
  const writer = watchlistClient(input.plex.write);
  if (!writer) return { result: 'failed', error: new Error('no Plex write client for the watchlist') };
  try {
    await (input.add ? writer.addToWatchlist(input.id) : writer.removeFromWatchlist(input.id));
    return { result: 'written', error: null };
  } catch (error) {
    if (isPlexNotFound(error)) return { result: 'not_found', error };
    if (mayHaveLanded(error) && input.reader) {
      const on = await liveOnWatchlist(input.reader, input.id);
      if (on === input.add) return { result: 'written', error: null };
    }
    return { result: 'failed', error };
  }
}

function trimQuery(query: string): string {
  const q = query.trim();
  return q.length > QUERY_MAX ? q.slice(0, QUERY_MAX) : q;
}

/** The D-02 "on Plex" rule for one title (ADR-092 C-03's Seerr sentence). */
export async function titleOnPlex(
  db: DbClient,
  plexAccountId: number,
  t: WatchlistIdentity | Pick<WatchMarkRow, 'kind' | 'titleKey' | 'title' | 'year' | 'plexGuid' | 'tmdbId' | 'tvdbId' | 'imdbId'>,
): Promise<boolean> {
  return onPlexFor(t, await selectTitleFacts(db, plexAccountId, [t]));
}

/**
 * `set_watchlist` (DESIGN-051 D-03, as amended by the PLAN-071 design review):
 *
 * 1. Principal: a tracked account (else {@link WatchNotReadyError}); anything but the `owner` answers `not_owner`
 *    with no row and no Plex call (ADR-092 C-04).
 * 2. Resolve (DESIGN-049 D-13): an add uses the full pool, then TMDB — where more than one exact hit is ambiguous
 *    (ruling 1); a remove resolves only among the overlaid watchlist and the titles removed in the last 10 minutes
 *    (ruling 7), with no TMDB. Ambiguous and not found write nothing.
 * 3. Discover id: a watchlist row's `plex://` guid (its title and year are already plex.tv's, so no read-back);
 *    else the identity's `plex://` guid, CONFIRMED by the external-id match naming the same id (ruling 6: else
 *    "couldn't confirm", nothing written); else the external-id match itself (same kind, else not in the catalog).
 *    The match's ids fill the identity's missing ones, its title and year are what is said back and stored.
 * 4. Live state: plex.tv's userState (the cache decides when it cannot be read); already in the asked state ⇒
 *    `unchanged`, no row, no write.
 * 5. The Watch Mark, `pending`, with `plex_guid = plex://<kind>/<id>` and the key recomputed from it.
 * 6. The PUT (idempotent retries; a final timeout / 5xx re-reads userState — ruling 4), then finalize `written`
 *    or `failed` (`plex_error` trimmed, never the token). A 404 is "not in Plex's catalog".
 * 7. The answer, with the D-02 "on Plex" rule for the Seerr sentence (ADR-092 C-03).
 */
export async function changeWatchlist(input: ChangeWatchlistInput): Promise<ChangeWatchlistOutcome> {
  const now = input.now ?? new Date();
  const db = resolveDb(input.db);
  const acct = input.actor.plexAccountId;
  const role = await assertTrackedWatchAccount(db, acct);
  if (role !== 'owner') return { status: 'not_owner', result: 'not_owner' };
  const add = input.action === 'add';

  const resolveStart = Date.now();
  const r = await resolveWatchTitle({
    db,
    plexAccountId: acct,
    query: input.query,
    kind: input.kind ?? null,
    tmdb: add ? (input.tmdb ?? null) : null,
    now,
    pool: add ? 'all' : 'watchlist',
    tmdbAmbiguity: 'ask',
  });
  if (input.phases) input.phases.resolve = Date.now() - resolveStart;
  if (r.status === 'ambiguous') return { status: 'ambiguous', result: 'ambiguous', options: r.options };
  if (r.status === 'not_found') return { status: 'not_found', result: 'not_found', kind: input.kind ?? null };

  const kind = r.kind;
  let identity: WatchlistIdentity = {
    kind,
    titleKey: r.titleKey,
    title: r.title,
    year: r.year,
    plexGuid: r.ids.plexGuid,
    tmdbId: r.ids.tmdbId,
    tvdbId: kind === 'show' ? r.ids.tvdbId : null,
    imdbId: r.ids.imdbId,
  };
  const done = (
    result: Exclude<WatchlistChangeResult, 'not_owner' | 'ambiguous' | 'not_found'>,
    view: WatchlistChangeView,
    extra: { markId?: number | null; onPlex?: boolean | null } = {},
  ): ChangeWatchlistOutcome => ({
    status: 'done',
    result,
    view,
    kind,
    markId: extra.markId ?? null,
    onPlex: extra.onPlex ?? null,
  });
  const failed = () => done('failed', { status: 'failed' });

  const plexStart = Date.now();
  const stamp = () => {
    if (input.phases) input.phases.plex_write = Date.now() - plexStart;
  };
  const reader = discoverReader(input.plex, input.reads);
  if (!reader || !watchlistClient(input.plex.write)) return failed();

  // Step 3 — the discover id, and plex.tv's own title and year for the read-back.
  const listed = r.members.find(
    (m) => (m.source === 'watchlist' || m.source === 'watchlist_removed') && discoverIdFromGuid(m.ids?.plexGuid, kind),
  );
  const guidId = discoverIdFromGuid(listed?.ids?.plexGuid ?? identity.plexGuid, kind);
  const external = externalGuid(identity);
  let id: string | null = guidId;
  let readBack: { title: string; year: number | null } | null = listed
    ? { title: listed.title, year: listed.year }
    : null;
  let match: DiscoverMatch | null = null;
  let live: boolean | null | undefined;
  if (guidId && !listed && external) {
    // The guid names the id; the external-id match must name the SAME one (ruling 6). Both reads at once.
    const [m, on] = await Promise.all([
      reader.matchDiscover({ kind: kind as DiscoverKind, guid: external }).then(
        (x) => ({ ok: true as const, x }),
        () => ({ ok: false as const, x: null }),
      ),
      liveOnWatchlist(reader, guidId),
    ]);
    if (!m.ok) {
      stamp();
      return failed();
    }
    if (!m.x || m.x.ratingKey !== guidId || m.x.kind !== kind) {
      stamp();
      return done('unconfirmed', { status: 'unconfirmed', kind, title: identity.title, year: identity.year });
    }
    match = m.x;
    live = on;
  } else if (!guidId) {
    if (!external) {
      stamp();
      return done('not_in_catalog', { status: 'not_in_catalog', kind, title: identity.title, year: identity.year });
    }
    try {
      match = await reader.matchDiscover({ kind: kind as DiscoverKind, guid: external });
    } catch {
      stamp();
      return failed();
    }
    if (!match || match.kind !== kind || !DISCOVER_ID_PATTERN.test(match.ratingKey)) {
      stamp();
      return done('not_in_catalog', { status: 'not_in_catalog', kind, title: identity.title, year: identity.year });
    }
    id = match.ratingKey;
  }
  if (!id) return failed(); // unreachable: every path above set it or returned
  if (match) {
    readBack = match.title ? { title: match.title, year: match.year ?? identity.year } : readBack;
    identity = {
      ...identity,
      tmdbId: identity.tmdbId ?? match.ids.tmdbId,
      tvdbId: kind === 'show' ? (identity.tvdbId ?? match.ids.tvdbId) : null,
      imdbId: identity.imdbId ?? match.ids.imdbId,
    };
  }
  const plexGuid = `plex://${kind}/${id}`;
  const title = readBack?.title || identity.title;
  const year = readBack ? (readBack.year ?? identity.year) : identity.year;
  identity = { ...identity, plexGuid, title, year };
  identity = { ...identity, titleKey: titleKeyFor(identity) };
  const said = { kind, title: identity.title, year: identity.year };

  // Step 4 — plex.tv's own state; the overlaid cache decides when it cannot be read.
  let on = live === undefined ? await liveOnWatchlist(reader, id) : live;
  if (on === null) on = isOnWatchlist((await selectWatchlist(db, acct, { now })).entries, identity);
  const onPlex = await titleOnPlex(db, acct, identity);
  if (on === add) {
    stamp();
    return done('unchanged', { status: 'unchanged', action: input.action, ...said }, { onPlex });
  }

  // Step 5 — the pending row, BEFORE the write.
  const [pending] = await db
    .insert(watchMarks)
    .values({
      plexAccountId: acct,
      action: add ? 'watchlist_add' : 'watchlist_remove',
      scope: kind,
      titleKey: identity.titleKey,
      kind,
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
      plexResult: 'pending',
      createdAt: now,
    })
    .returning({ id: watchMarks.id });
  if (!pending) throw new Error('watch mark insert returned no row');

  // Step 6 — the write, then finalize.
  const sent = await sendWatchlistWrite({ plex: input.plex, reader, id, add });
  stamp();
  await db
    .update(watchMarks)
    .set({
      plexResult: sent.result === 'written' ? 'written' : 'failed',
      plexError: sent.error ? plexErrorText(sent.error) : null,
    })
    .where(eq(watchMarks.id, pending.id));
  if (sent.result === 'not_found') {
    return done('not_in_catalog', { status: 'not_in_catalog', ...said }, { markId: pending.id, onPlex });
  }
  if (sent.result === 'failed') return done('failed', { status: 'failed' }, { markId: pending.id, onPlex });
  return done(
    'written',
    add ? { status: 'added', ...said, onPlex } : { status: 'removed', ...said },
    { markId: pending.id, onPlex },
  );
}

/**
 * DESIGN-051 D-04 (+ PLAN-071 ruling 3) — the Plex half of undoing a Watchlist Change: the inverse call
 * (`removeFromWatchlist` for an add, `addToWatchlist` for a remove), idempotent, so it is applied even if the owner
 * changed the watchlist in the Plex app meanwhile. A change that never reached Plex (`plex_result` `failed`) — or a
 * non-owner's row, which the owner's token never touches — makes no call and reverts as `none`. Removing a title
 * plex.tv does not know (404) leaves nothing on the watchlist, so it counts as done.
 */
export async function revertWatchlistChange(input: {
  plex: WatchPlexClients;
  reads?: WatchPlexReaders | null;
  mark: Pick<WatchMarkRow, 'action' | 'kind' | 'plexGuid' | 'plexResult'>;
  isOwner: boolean;
}): Promise<{ revertResult: WatchMarkRevertResult; error: unknown }> {
  const { mark } = input;
  if (!input.isOwner || mark.plexResult !== 'written') return { revertResult: 'none', error: null };
  const id = discoverIdFromGuid(mark.plexGuid, mark.kind);
  if (!id) return { revertResult: 'failed', error: new Error('the watchlist change has no discover id') };
  const add = mark.action === 'watchlist_remove'; // the inverse
  const sent = await sendWatchlistWrite({ plex: input.plex, reader: discoverReader(input.plex, input.reads), id, add });
  if (sent.result === 'written' || (sent.result === 'not_found' && !add)) return { revertResult: 'written', error: null };
  return { revertResult: 'failed', error: sent.error };
}
