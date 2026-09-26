// ADR-092 / DESIGN-051 D-03 / D-04 (PLAN-071) — Watchlist Changes (T-260): the owner's plex.tv watchlist changed
// through `set_watchlist`, recorded as a Watch Mark (`watchlist_add` / `watchlist_remove`) so it is attributed,
// audited by its row and undone by `undo_last_change`. With `marks.ts`, the single writer of `watch_marks`, and
// the ONLY code that writes the watchlist (`addToWatchlist` / `removeFromWatchlist`, owner ruling 2026-09-25).
//
// Safety properties: only the Server Owner's watchlist is read or written (ADR-092 C-04: a non-owner gets no row
// and no Plex call); an ambiguous, unknown or unconfirmed title writes nothing; a change that would change nothing
// (plex.tv already shows the asked state) writes no row and sends nothing, so a retried call never becomes the
// "last change"; the row is inserted `pending` BEFORE the write and finalized `written` / `failed` after it, and a
// change that could not even be sent is recorded `failed` too, so undo closes it instead of an older change
// (DESIGN-051 D-15); every discover id is validated before it is put in a URL (`@hnet/plex`'s `requireDiscoverId`).
import {
  watchMarks,
  WATCH_WATCHLIST_ACTIONS,
  type DbClient,
  type WatchMarkRevertResult,
  type WatchMarkRow,
} from '@hnet/db';
import {
  DISCOVER_ID_PATTERN,
  PlexError,
  PlexHttpError,
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
  WATCHLIST_OVERLAY_MARGIN_SECONDS,
  type PoolEntry,
  type WatchKind,
  type WatchlistChangeView,
  type WatchlistUndoOutcome,
} from '@hnet/watch';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
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
  /** PR #580 ruling 2: the PUT's outcome is unknown (plex.tv did not answer, before or after). */
  | 'unknown'
  | 'not_owner';

export type ChangeWatchlistOutcome =
  /** ADR-092 C-04: not the Server Owner — no row, no Plex call. */
  | { status: 'not_owner'; result: 'not_owner' }
  | { status: 'ambiguous'; result: 'ambiguous'; options: PoolEntry[] }
  /**
   * DESIGN-051 D-15e / D-15l: the spoken title matched several watchlist titles plex.tv keeps apart (different
   * discover ids) that the resolver cannot (one name, year and kind, or an id linking them). No argument of
   * `set_watchlist` can pick one, so the answer is not a question. Logged as `ambiguous` (D-10).
   */
  | { status: 'duplicate'; result: 'ambiguous'; options: PoolEntry[] }
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
   * DESIGN-049 D-11's ≈ 300 ms per attempt). Absent or without the discover reads ⇒ `plex.read`. The userState
   * re-read after a failed PUT always goes out on `plex.read`, the write budget (DESIGN-051 D-15).
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

/**
 * DESIGN-051 D-15n — a write that may still be applied by plex.tv: an attempt (this one or an earlier one of the
 * client's retries: `PlexError.mayStillLand`, set by `@hnet/plex`) timed out after it went out, lost its connection,
 * or met a gateway timeout. A re-read can confirm such a write landed, never that it did not: the aborted attempt
 * may land a moment after the re-read.
 */
function mayStillLand(error: unknown): boolean {
  return error instanceof PlexError && error.mayStillLand;
}

/** A failure a re-read can settle: the write may have landed (it may still land, or plex.tv answered a 5xx). */
function mayHaveLanded(error: unknown): boolean {
  return mayStillLand(error) || (error instanceof PlexHttpError && error.status >= 500);
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
 * PR #580 review ruling 2 — `plex_error` markers: a change that was never sent to plex.tv (the discover lookup
 * failed, or no Plex client), and one whose outcome plex.tv never confirmed (the PUT's last attempt failed and
 * the re-read could not settle it). Undo reads them: nothing is ever sent for a change that was never sent.
 */
export const WATCHLIST_NOT_SENT = 'not sent: ';
export const WATCHLIST_UNKNOWN = 'unknown: ';
/**
 * DESIGN-051 D-15k — on a WRITTEN remove: it was sent while plex.tv's live state could not be read, over an add
 * plex.tv never settled, so nothing ever showed the title on the watchlist. Its undo makes no call (the inverse, an
 * add, could download a title that was never on the list).
 */
export const WATCHLIST_AFTER_UNSETTLED = 'after unsettled: ';

/** D-15k: a written remove sent over an unsettled add (see {@link WATCHLIST_AFTER_UNSETTLED}). */
export function watchlistAfterUnsettled(mark: Pick<WatchMarkRow, 'action' | 'plexResult' | 'plexError'>): boolean {
  return (
    mark.action === 'watchlist_remove' &&
    mark.plexResult === 'written' &&
    (mark.plexError ?? '').startsWith(WATCHLIST_AFTER_UNSETTLED)
  );
}

/**
 * DESIGN-051 D-15k — the title's latest Watchlist Change since `since`, when plex.tv never settled it: `pending` (in
 * flight, or its replica died before finalizing it) or `failed` with an `unknown:` outcome, and not cleared by a
 * written undo. The overlaid cache can never show such a change (only written changes overlay, D-05), so when the
 * live state cannot be read the cache must not decide for that title. `since` is the cache's fetch time less the
 * overlay margin: a sync that read plex.tv after the change already shows its real outcome.
 */
export async function selectUnsettledWatchlistChange(
  db: DbClient,
  plexAccountId: number,
  plexGuid: string,
  since: Date,
): Promise<WatchMarkRow | null> {
  const [last] = await db
    .select()
    .from(watchMarks)
    .where(
      and(
        eq(watchMarks.plexAccountId, plexAccountId),
        inArray(watchMarks.action, [...WATCH_WATCHLIST_ACTIONS]),
        eq(watchMarks.plexGuid, plexGuid),
        gt(watchMarks.createdAt, since),
      ),
    )
    .orderBy(desc(watchMarks.createdAt), desc(watchMarks.id))
    .limit(1);
  if (!last || last.revertResult === 'written') return null;
  if (last.plexResult === 'pending') return last;
  return last.plexResult === 'failed' && (last.plexError ?? '').startsWith(WATCHLIST_UNKNOWN) ? last : null;
}

function marked(prefix: string, error: unknown): string {
  return plexErrorText(prefix + (error instanceof Error ? `${error.name}: ${error.message}` : String(error)));
}

/** What one watchlist write came to. `unknown` = it may or may not have landed, and plex.tv did not say. */
export type WatchlistWriteResult = 'written' | 'failed' | 'not_found' | 'unknown';

/**
 * Send one watchlist write (DESIGN-051 D-03 step 6 / D-04; PR #580 rulings 2 and 4). The client retries the
 * idempotent PUT; when the last attempt still fails with a timeout, a dropped connection or a 5xx, plex.tv's
 * userState is re-read ONCE with the WRITE-budget reader (`plex.read`, the ≈ 800 ms-per-attempt bundle — not the
 * 300 ms one): the wanted state ⇒ `written`; no answer ⇒ `unknown`; the old state ⇒ `failed` only when plex.tv
 * answered every attempt (a 5xx other than a gateway timeout), else `unknown` — an attempt that timed out, lost its
 * connection or met a 504 may still land after the re-read (D-15n). A failure after such an attempt is re-read the
 * same way even when it is a 4xx. A 404 is "not in Plex's catalog".
 */
export async function sendWatchlistWrite(input: {
  plex: WatchPlexClients;
  id: string;
  add: boolean;
}): Promise<{ result: WatchlistWriteResult; error: unknown }> {
  const writer = watchlistClient(input.plex.write);
  if (!writer) return { result: 'failed', error: new Error('no Plex write client for the watchlist') };
  try {
    await (input.add ? writer.addToWatchlist(input.id) : writer.removeFromWatchlist(input.id));
    return { result: 'written', error: null };
  } catch (error) {
    if (isPlexNotFound(error)) return { result: 'not_found', error };
    if (!mayHaveLanded(error)) return { result: 'failed', error };
    const reader = watchlistClient(input.plex.read);
    const on = reader ? await liveOnWatchlist(reader, input.id) : null;
    if (on === input.add) return { result: 'written', error: null };
    return { result: on === null || mayStillLand(error) ? 'unknown' : 'failed', error };
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
 *    (ruling 1); a remove resolves only among the overlaid watchlist and the titles a change of the last 10
 *    minutes removed or failed to add (ruling 7, D-15), with no TMDB. A same-name group whose watchlist titles
 *    name different discover ids is not a question but a "can't tell them apart" answer (D-15e, D-15l).
 *    Ambiguous and not found write nothing.
 * 3. Discover id: a watchlist row's `plex://` guid (its title and year are already plex.tv's, so no read-back);
 *    else the identity's `plex://` guid, CONFIRMED by the external-id match naming the same id (ruling 6: else
 *    "couldn't confirm", nothing written); else the external-id match itself (same kind, else not in the catalog).
 *    The match's ids fill the identity's missing ones, its title and year are what is said back and stored. A
 *    failed lookup (or no Plex client) records a `failed` mark with no guid and a `not sent:` error (D-15).
 * 4. Live state: plex.tv's userState (the cache decides when it cannot be read, unless the title's latest change
 *    since the cache's fetch is one plex.tv never settled, pending or unknown: then the idempotent write goes out,
 *    and a remove sent so over an unsettled add is marked so its undo never re-adds, D-15k); already in the asked
 *    state ⇒ `unchanged`, no row, no write.
 * 5. The Watch Mark, `pending`, with `plex_guid = plex://<kind>/<id>` and the key recomputed from it.
 * 6. The PUT (idempotent retries; a final timeout / 5xx re-reads userState on the write budget — ruling 4,
 *    D-15), then finalize `written` or `failed` (`plex_error` trimmed, never the token; an outcome the re-read
 *    could not settle, or an attempt that may still land, D-15n, is `failed` with an `unknown:` error and answered
 *    as such), only while the row is still `pending` (D-15o). A 404 is "not in Plex's catalog".
 * 7. The answer, with the D-02 "on Plex" rule for the Seerr sentence (ADR-092 C-03) — also on an "already on" add
 *    and an unconfirmed one (D-15j).
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
  const said0 = { kind, title: identity.title, year: identity.year };
  const plexStart = Date.now();
  const stamp = () => {
    if (input.phases) input.phases.plex_write = Date.now() - plexStart;
  };

  /**
   * PR #580 ruling 1 — the title resolved but the change could not even be sent (the discover lookup failed, or no
   * Plex client): a `failed` Watch Mark all the same, so "undo that" closes THIS change instead of reverting an
   * older one. No plex guid (nothing was confirmed) and a `not sent:` error, so its undo never calls Plex.
   */
  const notSent = async (error: unknown): Promise<ChangeWatchlistOutcome> => {
    stamp();
    const row = { ...identity, plexGuid: null };
    const [mark] = await db
      .insert(watchMarks)
      .values({
        plexAccountId: acct,
        action: add ? 'watchlist_add' : 'watchlist_remove',
        scope: kind,
        titleKey: titleKeyFor(row),
        kind,
        title: row.title,
        year: row.year,
        plexGuid: null,
        tmdbId: row.tmdbId,
        tvdbId: row.tvdbId,
        imdbId: row.imdbId,
        season: null,
        episode: null,
        query: trimQuery(input.query),
        consumer: input.consumer,
        actorUserId: input.actor.appUserId,
        flipped: [],
        plexResult: 'failed',
        plexError: marked(WATCHLIST_NOT_SENT, error),
        createdAt: now,
      })
      .returning({ id: watchMarks.id });
    return done('failed', { status: 'failed' }, { markId: mark?.id ?? null });
  };

  // PR #580 ruling 6 — one spoken title, several watchlist titles (a same-name group whose watchlist members name
  // DIFFERENT discover ids): write nothing (no row, no Plex call — checked before anything else). Not a question:
  // nothing the owner can say picks one of them (D-15l).
  const listedIds = new Map<string, PoolEntry>();
  for (const m of r.members) {
    if (m.source !== 'watchlist' && m.source !== 'watchlist_recent') continue;
    const mid = discoverIdFromGuid(m.ids?.plexGuid, kind);
    if (mid && !listedIds.has(mid)) listedIds.set(mid, m);
  }
  if (listedIds.size > 1) return { status: 'duplicate', result: 'ambiguous', options: [...listedIds.values()] };

  const reader = discoverReader(input.plex, input.reads);
  if (!reader || !watchlistClient(input.plex.write)) {
    return notSent(new Error('no Plex client for the watchlist'));
  }

  // Step 3 — the discover id, and plex.tv's own title and year for the read-back.
  const listedEntry = [...listedIds.entries()][0];
  const listed = listedEntry?.[1];
  const guidId = listedEntry?.[0] ?? discoverIdFromGuid(identity.plexGuid, kind);
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
        (x) => ({ ok: true as const, x, error: null as unknown }),
        (error: unknown) => ({ ok: false as const, x: null, error }),
      ),
      liveOnWatchlist(reader, guidId),
    ]);
    if (!m.ok) return notSent(m.error);
    if (!m.x || m.x.ratingKey !== guidId || m.x.kind !== kind) {
      stamp();
      return done('unconfirmed', { status: 'unconfirmed', ...said0 });
    }
    match = m.x;
    live = on;
  } else if (!guidId) {
    if (!external) {
      stamp();
      return done('not_in_catalog', { status: 'not_in_catalog', ...said0 });
    }
    try {
      match = await reader.matchDiscover({ kind: kind as DiscoverKind, guid: external });
    } catch (error) {
      return notSent(error);
    }
    if (!match || match.kind !== kind || !DISCOVER_ID_PATTERN.test(match.ratingKey)) {
      stamp();
      return done('not_in_catalog', { status: 'not_in_catalog', ...said0 });
    }
    id = match.ratingKey;
  }
  if (!id) return notSent(new Error('no discover id')); // unreachable: every path above set it or returned
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

  // Step 4 — plex.tv's own state; the overlaid cache decides when it cannot be read, unless the title's latest
  // change is one plex.tv never settled (D-15k): the cache cannot show it, so the (idempotent) write goes out.
  let on = live === undefined ? await liveOnWatchlist(reader, id) : live;
  let unsettled: WatchMarkRow | null = null;
  if (on === null) {
    const cached = await selectWatchlist(db, acct, { now });
    const since = new Date(cached.fetchedAt.getTime() - WATCHLIST_OVERLAY_MARGIN_SECONDS * 1000);
    unsettled = await selectUnsettledWatchlistChange(db, acct, plexGuid, since);
    on = unsettled ? !add : isOnWatchlist(cached.entries, identity);
  }
  // D-15k: a remove over an add plex.tv never settled never saw the title on the list; its undo must not re-add it.
  const afterUnsettledAdd = !add && unsettled?.action === 'watchlist_add';
  const onPlex = await titleOnPlex(db, acct, identity);
  if (on === add) {
    stamp();
    // D-15j: an "already on" add of a title not on Plex still says Seerr will request it (a retried add lands here).
    return done('unchanged', { status: 'unchanged', action: input.action, ...said, onPlex }, { onPlex });
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

  // Step 6 — the write, then finalize. An unknown outcome is recorded `failed` with an `unknown:` error. The
  // finalize only touches a row still `pending`: an undo that found it stale has closed it already (D-15o).
  const sent = await sendWatchlistWrite({ plex: input.plex, id, add });
  stamp();
  await db
    .update(watchMarks)
    .set({
      plexResult: sent.result === 'written' ? 'written' : 'failed',
      plexError:
        sent.result === 'written'
          ? afterUnsettledAdd && unsettled
            ? `${WATCHLIST_AFTER_UNSETTLED}mark ${unsettled.id}`
            : null
          : sent.error
            ? sent.result === 'unknown'
              ? marked(WATCHLIST_UNKNOWN, sent.error)
              : plexErrorText(sent.error)
            : null,
    })
    .where(and(eq(watchMarks.id, pending.id), eq(watchMarks.plexResult, 'pending')));
  const extra = { markId: pending.id, onPlex };
  if (sent.result === 'not_found') return done('not_in_catalog', { status: 'not_in_catalog', ...said }, extra);
  if (sent.result === 'unknown') {
    return done('unknown', { status: 'unknown', action: input.action, ...said, onPlex }, extra);
  }
  if (sent.result === 'failed') return done('failed', { status: 'failed' }, extra);
  return done('written', add ? { status: 'added', ...said, onPlex } : { status: 'removed', ...said }, extra);
}

/** A change that never went out to plex.tv (PR #580 ruling 1). */
export function watchlistNotSent(mark: Pick<WatchMarkRow, 'plexResult' | 'plexError' | 'plexGuid' | 'kind'>): boolean {
  if (mark.plexResult !== 'failed') return false;
  return (mark.plexError ?? '').startsWith(WATCHLIST_NOT_SENT) || !discoverIdFromGuid(mark.plexGuid, mark.kind);
}

/**
 * The outcome of undoing a Watchlist Change, as said (DESIGN-051 D-04, PR #580 ruling 2) — reconstructable from
 * the row for a replayed undo: `reverted` (the inverse call landed), `cleared` (a failed add's removal landed),
 * `not_sent` (the change never went out: nothing to undo), `left_as_is` (a failed remove: its inverse, an add,
 * could download, so nothing is sent), `failed` / `unknown` (the inverse call failed, or plex.tv never said; the
 * change stays live for the next undo).
 */
export function watchlistUndoOutcome(
  mark: Pick<WatchMarkRow, 'action' | 'plexResult' | 'plexError' | 'plexGuid' | 'kind'>,
  revertResult: WatchMarkRevertResult,
): WatchlistUndoOutcome {
  if (revertResult === 'written') return mark.plexResult === 'written' ? 'reverted' : 'cleared';
  if (revertResult === 'none') {
    if (watchlistAfterUnsettled(mark)) return 'left_off';
    return mark.action === 'watchlist_remove' && mark.plexResult === 'failed' && !watchlistNotSent(mark)
      ? 'left_as_is'
      : 'not_sent';
  }
  return 'failed'; // a failed revert leaves the change live: it is never replayed, only retried
}

/**
 * DESIGN-051 D-04 (+ PLAN-071 ruling 3, PR #580 ruling 2) — the Plex half of undoing a Watchlist Change:
 *
 * - a WRITTEN change: the inverse call (`removeFromWatchlist` for an add, `addToWatchlist` for a remove),
 *   idempotent, so it is applied even if the owner changed the watchlist in the Plex app meanwhile;
 * - a FAILED add that went out: `removeFromWatchlist` anyway (it may have landed; a removal is idempotent and never
 *   downloads);
 * - a FAILED remove: NO call (its inverse is an add, which could download) — the watchlist is left as it is;
 * - a WRITTEN remove sent over an add plex.tv never settled (D-15k): NO call either — nothing ever showed the title
 *   on the list, and an add could download it — left off;
 * - a change never sent (ruling 1), or a non-owner's row (the owner's token never touches it): no call.
 *
 * Removing a title plex.tv does not know (404) leaves nothing on the watchlist, so it counts as done. An inverse
 * call whose outcome plex.tv never confirms is `failed` with an `unknown:` marker (said as such; the change stays
 * live for the next undo). A failed add's removal that fails is `clear_failed`, never "still on" (D-15m: the add
 * itself never confirmed).
 */
export async function revertWatchlistChange(input: {
  plex: WatchPlexClients;
  mark: Pick<WatchMarkRow, 'action' | 'kind' | 'plexGuid' | 'plexResult' | 'plexError'>;
  isOwner: boolean;
}): Promise<{ revertResult: WatchMarkRevertResult; outcome: WatchlistUndoOutcome; error: unknown }> {
  const { mark } = input;
  const none = () => ({
    revertResult: 'none' as const,
    outcome: watchlistUndoOutcome({ ...mark }, 'none'),
    error: null,
  });
  if (!input.isOwner || mark.plexResult === 'pending') return { ...none(), outcome: 'not_sent' };
  if (mark.plexResult === 'failed' && (mark.action === 'watchlist_remove' || watchlistNotSent(mark))) return none();
  if (watchlistAfterUnsettled(mark)) return none();
  const id = discoverIdFromGuid(mark.plexGuid, mark.kind);
  if (!id) return { ...none(), outcome: 'not_sent' };
  const add = mark.action === 'watchlist_remove'; // the inverse
  const sent = await sendWatchlistWrite({ plex: input.plex, id, add });
  const done = mark.plexResult === 'written' ? 'reverted' : 'cleared';
  if (sent.result === 'written' || (sent.result === 'not_found' && !add)) {
    return { revertResult: 'written', outcome: done, error: null };
  }
  const failed: WatchlistUndoOutcome = mark.plexResult === 'written' ? 'failed' : 'clear_failed';
  return { revertResult: 'failed', outcome: sent.result === 'unknown' ? 'unknown' : failed, error: sent.error };
}

/**
 * DESIGN-051 D-15o — how long a Watchlist Change may stay `pending` before undo treats it as abandoned. The change's
 * own work is bounded (the PUT's 3 attempts and the re-read's, about 5.2 s, each attempt's timer covering its body,
 * D-15p), so a change still pending a minute later lost its replica (a kill, an OOM) or its finalize failed.
 */
export const WATCHLIST_PENDING_STALE_SECONDS = 60;

/**
 * DESIGN-051 D-15o — close an abandoned `pending` Watchlist Change so undo can act on it: finalized `failed` with an
 * `unknown:` marker (it went out, or was about to, and plex.tv never said), only while it is still pending (the
 * change's own finalize, if it ever runs, then leaves it alone). Returns the row as it now stands.
 */
export async function closeAbandonedWatchlistChange(db: DbClient, mark: WatchMarkRow): Promise<WatchMarkRow> {
  const [closed] = await db
    .update(watchMarks)
    .set({ plexResult: 'failed', plexError: marked(WATCHLIST_UNKNOWN, 'never finalized') })
    .where(and(eq(watchMarks.id, mark.id), eq(watchMarks.plexResult, 'pending')))
    .returning();
  if (closed) return closed;
  const [current] = await db.select().from(watchMarks).where(eq(watchMarks.id, mark.id)).limit(1);
  return current ?? mark;
}
