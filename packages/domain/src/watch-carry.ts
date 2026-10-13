// ADR-114 / DESIGN-055 P4 decisions 26-34 (owner ruling on issue #928, 2026-10-13: "Carry marks, then move") — the
// WATCH CARRY. Plex keeps a person's plays and resume point on the episode item (by its guid), not on the file, so a
// staff move (a Season Re-map, a show's Plex ordering switch, the Second-Copy Fix) changes what everyone's marks point
// at. The carry:
//
//   1. SNAPSHOT: reads every account that can see the show on every Plex server that carries it (the owner with the
//      server's token, each friend with the per-server token plex.tv lists for them) and stores each item of the scope
//      with its files, and each account's state on each item (watch_carries, watch_carry_states). A move without a
//      stored snapshot never runs: any failed read refuses it.
//   2. PRE-CLEAR: clears, for each account, the items whose file the move takes away or deletes (their items may vanish
//      with their files, and a guid's mark outlives its item), before the move.
//   3. CARRY: after the move, once Plex shows each moved file on its new item, writes each account's state on each item
//      in scope to the state of the file it now holds (content = the file's byte size). Items whose file did not change
//      are never written; an item the account played after the snapshot is left alone.
//   4. VERIFY: reads every account again and checks the carry per account.
//
// Every write is one audit row in watch_carry_marks, in the same transaction as the carry's counters (CLAUDE.md hard
// rules 4 and 6). Friends' tokens live only inside the clients `WatchCarryPlex` builds; they are never stored, logged or
// printed (ADR-114 C-02). `carry-finish` re-runs step 3 and 4 from the stored snapshot; `carry-revert` restores every
// item the carry wrote to its state before, newest first.
import {
  mediaPlexMatches,
  plexLibraries,
  plexServers,
  watchCarries,
  watchCarryMarks,
  watchCarryStates,
  type DbClient,
  type WatchCarryItem,
  type WatchCarryKind,
  type WatchCarryPart,
  type WatchCarryPhase,
  type WatchCarryReason,
  type WatchCarryRow,
  type WatchCarryStateValue,
  type WatchCarryStatus,
} from '@hnet/db';
import type { PlexLeafFile, PlexReadClient } from '@hnet/plex/read';
import type { PlexWriteClient } from '@hnet/plex/write';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

// ---------------------------------------------------------------------------
// The Plex surface (tests inject stubs; production: watchCarryPlexFromEnv in watch-carry-plex.ts)
// ---------------------------------------------------------------------------

/** One account on one server: reads and writes AS that account (its own token lives inside the clients). */
export interface WatchCarryAccount {
  /** The plex.tv account id. */
  accountId: string;
  owner: boolean;
  read: Pick<PlexReadClient, 'listLeafFiles'>;
  write: Pick<PlexWriteClient, 'scrobble' | 'unscrobble' | 'setProgress'>;
}

/** One Plex server: the owner's reads and library writes, and every account that can see a library section. */
export interface WatchCarryServer {
  slug: string;
  read: Pick<PlexReadClient, 'listLeafFiles' | 'getMetadataItem' | 'getShowOrdering'>;
  write: Pick<PlexWriteClient, 'setShowOrdering' | 'refreshMetadata'>;
  /** The owner first, then each friend whose share includes `librarySectionId` (every friend when null). */
  accounts(librarySectionId: string | null): Promise<WatchCarryAccount[]>;
}

export interface WatchCarryPlex {
  server(slug: string): WatchCarryServer | null;
}

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

/** Plex keeps no resume point of this many ms or less on an unwatched item (read live 2026-10-13). */
export const PLEX_MIN_RESUME_MS = 60_000;
/** Two resume points this close are the same point. */
export const RESUME_TOLERANCE_MS = 5_000;
/** At most this many plays are carried per item (one scrobble each); the snapshot keeps the original count. */
export const MAX_CARRIED_PLAYS = 5;
/** Default pause between accounts' reads and between writes: the carry never hammers Plex. */
export const CARRY_PAUSE_MS = 200;

const EMPTY: WatchCarryStateValue = { viewCount: 0, viewOffset: 0, lastViewedAt: null };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errText = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
};

/**
 * What the carry writes for a resume point: Plex keeps none of 60 s or less on an unwatched item (read live), and the
 * carry treats one that short as no resume point on a watched item too (a point that short means "not started").
 */
function keptOffset(_viewCount: number, offset: number): number {
  return offset > PLEX_MIN_RESUME_MS ? offset : 0;
}

function stateOf(leaf: Pick<PlexLeafFile, 'viewCount' | 'viewOffset' | 'lastViewedAt'>): WatchCarryStateValue {
  return { viewCount: leaf.viewCount, viewOffset: leaf.viewOffset, lastViewedAt: leaf.lastViewedAt };
}

const isEmpty = (s: WatchCarryStateValue) => s.viewCount === 0 && s.viewOffset === 0;

/** The current state already is the target (plays equal, resume points within tolerance). */
export function sameCarryState(current: WatchCarryStateValue, target: WatchCarryStateValue): boolean {
  if (current.viewCount !== target.viewCount) return false;
  return Math.abs(current.viewOffset - target.viewOffset) <= RESUME_TOLERANCE_MS;
}

/**
 * The Plex calls that turn `current` into `target` (ADR-114 C-04): nothing when equal; a lone `progress` when only the
 * resume point differs and the plays already match; otherwise clear (`unscrobble`, when anything is set), one
 * `scrobble` per play, then `progress` for the resume point.
 */
export function carryCalls(current: WatchCarryStateValue, target: WatchCarryStateValue): Array<'unscrobble' | 'scrobble' | 'progress'> {
  if (sameCarryState(current, target)) return [];
  if (current.viewCount === target.viewCount && target.viewOffset > 0) return ['progress'];
  const calls: Array<'unscrobble' | 'scrobble' | 'progress'> = [];
  if (!isEmpty(current)) calls.push('unscrobble');
  for (let i = 0; i < target.viewCount; i += 1) calls.push('scrobble');
  if (target.viewOffset > 0) calls.push('progress');
  return calls;
}

// ---------------------------------------------------------------------------
// The scope and the pure carry plan
// ---------------------------------------------------------------------------

/** What a move does to content, by file byte size (ADR-114 C-01). */
export interface WatchCarryScope {
  /** Files the move puts on other items (a re-map's moving files). `'all'`: every file (an ordering switch). */
  moved: number[] | 'all';
  /** Files the move deletes (a second copy). Their plays count only through `sameAs`. */
  deleted?: number[];
  /**
   * Files the move deletes, by file name, when a byte size cannot tell them apart (a second copy byte-identical to its
   * original: The Simpsons S38E02 and E01 are both 719,258,375 bytes). Never counted as content where they sit.
   */
  deletedNames?: string[];
  /**
   * `[copy, original]`: plays of the copy are plays of the original's content (staff evidence). A copy that holds the
   * content of two original files (a two-episode copy of two one-episode files) has one pair per original.
   */
  sameAs?: Array<[number, number]>;
  /** Ordering switch: the items (per server, rating keys) the switch is expected to re-match, cleared first. */
  preClear?: Record<string, string[]>;
}

/** One account's snapshot state on one item. */
export interface CarrySnapshotState extends WatchCarryStateValue {
  ratingKey: string;
  parts: WatchCarryPart[];
}

/** The target for one account on one item after the move, and why. */
export interface CarryTarget {
  ratingKey: string;
  season: number | null;
  episode: number | null;
  parts: WatchCarryPart[];
  target: WatchCarryStateValue;
  reason: Exclude<WatchCarryReason, 'pre_clear' | 'restore'>;
}

/**
 * The content keys an item holds that count for the carry: its files' sizes, without deleted ones, each mapped through
 * `sameAs` to the content it is.
 */
function contentsOf(parts: readonly WatchCarryPart[], scope: WatchCarryScope): number[] {
  const deleted = new Set(scope.deleted ?? []);
  const deletedNames = new Set(scope.deletedNames ?? []);
  const same = sameAsMap(scope);
  return [...new Set(parts.filter((p) => !deleted.has(p.size) && !deletedNames.has(p.name)).flatMap((p) => same.get(p.size) ?? [p.size]))];
}

/** copy size → every original size it is the same as. */
function sameAsMap(scope: WatchCarryScope): Map<number, number[]> {
  const same = new Map<number, number[]>();
  for (const [copy, original] of scope.sameAs ?? []) same.set(copy, [...new Set([...(same.get(copy) ?? []), original])]);
  return same;
}

/** Every content key the move touches: what moves, what is deleted, and what a deleted copy is the same as. */
function touchedContents(scope: WatchCarryScope): Set<number> | 'all' {
  if (scope.moved === 'all') return 'all';
  const out = new Set<number>(scope.moved);
  for (const d of scope.deleted ?? []) out.add(d);
  for (const [copy, original] of scope.sameAs ?? []) {
    out.add(copy);
    out.add(original);
  }
  return out;
}

/** An item is in the carry's write scope when it holds (or held) touched content. */
function touchesItem(parts: readonly WatchCarryPart[], touched: Set<number> | 'all'): boolean {
  return touched === 'all' || parts.some((p) => touched.has(p.size));
}

/**
 * ADR-114 C-01, C-04, C-05 — one account's content state from its snapshot: for each content key, the plays summed over
 * every item that played it (a copy's plays go to its original), the resume point of the latest item with one, and the
 * latest watch. Pure.
 */
export function contentStates(
  states: readonly CarrySnapshotState[],
  scope: WatchCarryScope,
): Map<number, WatchCarryStateValue> {
  const same = sameAsMap(scope);
  const out = new Map<number, WatchCarryStateValue & { offsetAt: number }>();
  for (const s of states) {
    // Every file the item played gets the item's state (an item with two files plays them as one).
    const keys = [...new Set(s.parts.flatMap((p) => same.get(p.size) ?? [p.size]))];
    for (const key of keys) {
      const prev = out.get(key) ?? { ...EMPTY, offsetAt: -1 };
      const at = s.lastViewedAt ?? 0;
      const next = {
        viewCount: prev.viewCount + s.viewCount,
        viewOffset: prev.viewOffset,
        offsetAt: prev.offsetAt,
        lastViewedAt: Math.max(prev.lastViewedAt ?? 0, at) || null,
      };
      if (s.viewOffset > 0 && at >= prev.offsetAt) {
        next.viewOffset = s.viewOffset;
        next.offsetAt = at;
      }
      out.set(key, next);
    }
  }
  return new Map([...out].map(([k, v]) => [k, { viewCount: v.viewCount, viewOffset: v.viewOffset, lastViewedAt: v.lastViewedAt }]));
}

/**
 * ADR-114 C-04, C-05 — what one account's state should be on each item of the write scope after the move. An item's
 * target is the state of the content it now holds: plays (at most MAX_CARRIED_PLAYS) and the resume point (when Plex
 * keeps it); an item holding several files counts as watched only when every one was watched (otherwise only a
 * resume point, `partial`); an item whose content the account never played is `stale` (empty). Pure.
 */
export function planCarryTargets(input: {
  after: readonly Pick<PlexLeafFile, 'ratingKey' | 'season' | 'episode' | 'parts'>[];
  /** Rating keys of before-items that held touched content (cleared when they still exist and hold nothing touched). */
  beforeTouched: ReadonlySet<string>;
  content: ReadonlyMap<number, WatchCarryStateValue>;
  scope: WatchCarryScope;
}): CarryTarget[] {
  const touched = touchedContents(input.scope);
  const out: CarryTarget[] = [];
  for (const item of input.after) {
    const keys = contentsOf(item.parts, input.scope);
    const holdsTouched = touchesItem(item.parts, touched);
    if (!holdsTouched && !input.beforeTouched.has(item.ratingKey)) continue;
    const states = keys.map((k) => input.content.get(k) ?? EMPTY);
    let target: WatchCarryStateValue = EMPTY;
    let reason: CarryTarget['reason'] = 'stale';
    if (keys.length > 0 && states.every((s) => s.viewCount > 0)) {
      const plays = Math.min(MAX_CARRIED_PLAYS, Math.min(...states.map((s) => s.viewCount)));
      const offset = states.length === 1 ? keptOffset(plays, states[0]!.viewOffset) : 0;
      target = { viewCount: plays, viewOffset: offset, lastViewedAt: null };
      reason = 'carried';
    } else {
      const withOffset = states.filter((s) => s.viewOffset > 0);
      const offset = withOffset.length === 1 && keys.length === 1 ? keptOffset(0, withOffset[0]!.viewOffset) : 0;
      if (offset > 0 || states.some((s) => s.viewCount > 0 || s.viewOffset > 0)) {
        target = { viewCount: 0, viewOffset: offset, lastViewedAt: null };
        reason = 'partial';
      }
    }
    out.push({ ratingKey: item.ratingKey, season: item.season, episode: item.episode, parts: item.parts.map((p) => ({ ...p })), target, reason });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export class WatchCarryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchCarryError';
  }
}

/**
 * The servers that carry a series (`media_plex_matches` in a show library): slug and the show's rating key there. A
 * series matched to two shows on one server cannot be carried (whose marks are whose would be a guess): refused.
 */
export async function carryServersFor(input: { db?: DbClient; mediaItemId: string }): Promise<Array<{ slug: string; showRatingKey: string }>> {
  const rows = await resolveDb(input.db)
    .select({ slug: plexServers.slug, ratingKey: mediaPlexMatches.ratingKey })
    .from(mediaPlexMatches)
    .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(and(eq(mediaPlexMatches.mediaItemId, input.mediaItemId), eq(plexLibraries.mediaType, 'show')));
  const bySlug = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, new Set());
    bySlug.get(r.slug)!.add(r.ratingKey);
  }
  const out: Array<{ slug: string; showRatingKey: string }> = [];
  for (const [slug, keys] of bySlug) {
    if (keys.size > 1) throw new WatchCarryError(`${slug} holds this series as ${keys.size} shows, so its watch state cannot be carried.`);
    out.push({ slug, showRatingKey: [...keys][0]! });
  }
  return out;
}

/** The item map of one server as stored on the carry. */
export interface CarryServerItems {
  showRatingKey: string;
  librarySectionId: string | null;
  /** How many accounts were read (the owner and every friend who can see the library). */
  accountsRead: number;
  items: WatchCarryItem[];
}

export interface WatchCarrySnapshot {
  carryId: string;
  kind: WatchCarryKind;
  takenAt: Date;
  servers: Record<string, CarryServerItems>;
  /** Per server, per account id: the account's states on items of the scope. */
  states: Record<string, Record<string, CarrySnapshotState[]>>;
  scope: WatchCarryScope;
  /** Accounts (any server) with state on an item the move touches. */
  accountsWithState: number;
  /** States on items the move touches. */
  touchedStates: number;
}

/**
 * Statuses that leave a series mid-carry: no new snapshot may be taken, since it would read cleared or not yet carried
 * items as unwatched and those marks would be lost. `mismatch` too: some item did not take its state (carry-finish).
 */
const OPEN_STATUSES: WatchCarryStatus[] = ['cleared', 'waiting', 'mismatch'];

const inScope = (season: number | null, seasons: readonly number[] | null) => seasons === null || (season !== null && seasons.includes(season));

/**
 * ADR-114 C-02 — read every account's state on every server that carries the series and store the Carry Snapshot.
 * Refuses (storing nothing) when a server cannot be read for any account, when no Plex client exists for a server that
 * carries the series, or while an earlier carry of the series is unfinished.
 */
export async function takeWatchCarrySnapshot(input: {
  db?: DbClient;
  plex: WatchCarryPlex;
  kind: WatchCarryKind;
  mediaItemId: string;
  seriesId: number;
  /** Seasons in scope; null = the whole show. */
  seasons: readonly number[] | null;
  scope: WatchCarryScope;
  detail?: Record<string, unknown>;
  pauseMs?: number;
  now?: () => Date;
}): Promise<WatchCarrySnapshot> {
  const db = resolveDb(input.db);
  const open = await db
    .select({ id: watchCarries.id, status: watchCarries.status })
    .from(watchCarries)
    .where(and(eq(watchCarries.seriesId, input.seriesId), inArray(watchCarries.status, OPEN_STATUSES)))
    .limit(1);
  if (open[0]) {
    throw new WatchCarryError(
      `An earlier watch carry for this series is not finished (${open[0].id}, ${open[0].status}). Finish it (carry-finish) or revert it (carry-revert) first.`,
    );
  }
  const pause = input.pauseMs ?? CARRY_PAUSE_MS;
  const takenAt = (input.now ?? (() => new Date()))();
  const servers = await carryServersFor({ db, mediaItemId: input.mediaItemId });
  if (servers.length === 0) throw new WatchCarryError('No Plex server carries this series, so its watch state cannot be read.');
  const touched = touchedContents(input.scope);
  const stored: Record<string, CarryServerItems> = {};
  const states: WatchCarrySnapshot['states'] = {};
  const withState = new Set<string>();
  let touchedStates = 0;
  for (const { slug, showRatingKey } of servers) {
    const server = input.plex.server(slug);
    if (!server) throw new WatchCarryError(`No Plex client for ${slug}, which carries this series.`);
    let section: string | null;
    let items: PlexLeafFile[];
    let accounts: WatchCarryAccount[];
    try {
      section = (await server.read.getMetadataItem(showRatingKey))?.librarySectionId ?? null;
      items = (await server.read.listLeafFiles(showRatingKey)).filter((i) => inScope(i.season, input.seasons));
      accounts = await server.accounts(section);
    } catch (err) {
      throw new WatchCarryError(`${slug}: the show could not be read (${errText(err)}).`);
    }
    const inScopeKeys = new Set(items.map((i) => i.ratingKey));
    states[slug] = {};
    for (const account of accounts) {
      let leaves: PlexLeafFile[];
      try {
        leaves = await account.read.listLeafFiles(showRatingKey);
      } catch (err) {
        throw new WatchCarryError(`${slug}: one account's watch state could not be read (${errText(err)}).`);
      }
      const mine = leaves
        .filter((l) => inScopeKeys.has(l.ratingKey) && (l.viewCount > 0 || l.viewOffset > 0))
        .map((l) => ({ ratingKey: l.ratingKey, parts: l.parts, ...stateOf(l) }));
      if (mine.length > 0) states[slug][account.accountId] = mine;
      const onTouched = mine.filter((m) => touchesItem(m.parts, touched)).length;
      if (onTouched > 0) withState.add(account.accountId);
      touchedStates += onTouched;
      if (pause > 0) await sleep(pause);
    }
    stored[slug] = {
      showRatingKey,
      librarySectionId: section,
      accountsRead: accounts.length,
      items: items.map((i) => ({ ratingKey: i.ratingKey, guid: i.guid, title: i.title, season: i.season, episode: i.episode, parts: i.parts })),
    };
  }

  const carryId = await inTransaction(db, async (tx) => {
    const [row] = await tx
      .insert(watchCarries)
      .values({
        kind: input.kind,
        mediaItemId: input.mediaItemId,
        seriesId: input.seriesId,
        seasonNumbers: input.seasons ? [...input.seasons] : [],
        status: 'snapshot',
        takenAt,
        scope: input.scope as unknown as Record<string, unknown>,
        items: stored,
        detail: input.detail ?? {},
        summary: { accountsWithState: withState.size, touchedStates },
      })
      .returning({ id: watchCarries.id });
    const rows = Object.entries(states).flatMap(([slug, byAccount]) =>
      Object.entries(byAccount).flatMap(([accountId, list]) =>
        list.map((s) => {
          const item = stored[slug]!.items.find((i) => i.ratingKey === s.ratingKey);
          return {
            carryId: row!.id,
            server: slug,
            plexAccountId: accountId,
            ratingKey: s.ratingKey,
            seasonNumber: item?.season ?? null,
            episodeNumber: item?.episode ?? null,
            parts: s.parts,
            viewCount: s.viewCount,
            viewOffsetMs: Math.round(s.viewOffset),
            lastViewedAt: s.lastViewedAt ? new Date(s.lastViewedAt * 1000) : null,
          };
        }),
      ),
    );
    for (let i = 0; i < rows.length; i += 500) await tx.insert(watchCarryStates).values(rows.slice(i, i + 500));
    return row!.id;
  });
  return {
    carryId,
    kind: input.kind,
    takenAt,
    servers: stored,
    states,
    scope: input.scope,
    accountsWithState: withState.size,
    touchedStates,
  };
}

/** Load a stored carry with its snapshot states. */
export async function loadWatchCarry(input: { db?: DbClient; carryId: string }): Promise<{ row: WatchCarryRow; snapshot: WatchCarrySnapshot }> {
  const db = resolveDb(input.db);
  const [row] = await db.select().from(watchCarries).where(eq(watchCarries.id, input.carryId));
  if (!row) throw new WatchCarryError(`No watch carry ${input.carryId}.`);
  const rows = await db.select().from(watchCarryStates).where(eq(watchCarryStates.carryId, input.carryId));
  const states: WatchCarrySnapshot['states'] = {};
  for (const r of rows) {
    const byAccount = (states[r.server] ??= {});
    (byAccount[r.plexAccountId] ??= []).push({
      ratingKey: r.ratingKey,
      parts: r.parts,
      viewCount: r.viewCount,
      viewOffset: r.viewOffsetMs,
      lastViewedAt: r.lastViewedAt ? Math.floor(r.lastViewedAt.getTime() / 1000) : null,
    });
  }
  const summary = row.summary as { accountsWithState?: number; touchedStates?: number };
  return {
    row,
    snapshot: {
      carryId: row.id,
      kind: row.kind,
      takenAt: row.takenAt,
      servers: row.items as Record<string, CarryServerItems>,
      states,
      scope: row.scope as unknown as WatchCarryScope,
      accountsWithState: summary.accountsWithState ?? 0,
      touchedStates: summary.touchedStates ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// The single writers: status, and one audit row per mark (with the counters, in one transaction)
// ---------------------------------------------------------------------------

async function setCarryStatus(input: { db?: DbClient; carryId: string; status: WatchCarryStatus; patch?: { summary?: Record<string, unknown>; detail?: Record<string, unknown> } }) {
  await resolveDb(input.db)
    .update(watchCarries)
    .set({
      status: input.status,
      updatedAt: new Date(),
      ...(input.patch?.summary ? { summary: sql`${watchCarries.summary} || ${JSON.stringify(input.patch.summary)}::jsonb` } : {}),
      ...(input.patch?.detail ? { detail: sql`${watchCarries.detail} || ${JSON.stringify(input.patch.detail)}::jsonb` } : {}),
    })
    .where(eq(watchCarries.id, input.carryId));
}

interface MarkRecord {
  server: string;
  accountId: string;
  ratingKey: string;
  season: number | null;
  episode: number | null;
  phase: WatchCarryPhase;
  reason: WatchCarryReason;
  parts: WatchCarryPart[];
  before: WatchCarryStateValue;
  target: WatchCarryStateValue;
  calls: string[];
  ok: boolean;
  error: string | null;
}

/** ADR-114 C-07 — one mark's audit row and the carry's counter, in one transaction. */
async function recordCarryMark(db: DbClient | undefined, carryId: string, m: MarkRecord): Promise<void> {
  await inTransaction(db, async (tx) => {
    await tx.insert(watchCarryMarks).values({
      carryId,
      server: m.server,
      plexAccountId: m.accountId,
      ratingKey: m.ratingKey,
      seasonNumber: m.season,
      episodeNumber: m.episode,
      phase: m.phase,
      reason: m.reason,
      parts: m.parts,
      beforeState: m.before,
      targetState: m.target,
      calls: m.calls,
      ok: m.ok,
      error: m.error,
    });
    const counter = `${m.phase}_${m.ok ? 'ok' : 'failed'}`;
    await tx
      .update(watchCarries)
      .set({
        updatedAt: new Date(),
        summary: sql`jsonb_set(${watchCarries.summary}, ${`{writes,${counter}}`}::text[], to_jsonb(coalesce((${watchCarries.summary} #>> ${`{writes,${counter}}`}::text[])::int, 0) + 1), true)`,
      })
      .where(eq(watchCarries.id, carryId));
  });
}

/** Send the calls that turn `before` into `target` as one account, one at a time. Returns the calls sent and any error. */
async function applyCalls(
  account: WatchCarryAccount,
  ratingKey: string,
  before: WatchCarryStateValue,
  target: WatchCarryStateValue,
  pauseMs: number,
): Promise<{ calls: string[]; error: string | null }> {
  const plan = carryCalls(before, target);
  const sent: string[] = [];
  for (const call of plan) {
    try {
      if (call === 'unscrobble') await account.write.unscrobble(ratingKey);
      else if (call === 'scrobble') await account.write.scrobble(ratingKey);
      else await account.write.setProgress(ratingKey, target.viewOffset);
      sent.push(call);
    } catch (err) {
      sent.push(`${call}:failed`);
      return { calls: sent, error: errText(err) };
    }
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return { calls: sent, error: null };
}

/** The accounts of one server by id, built once per phase (the owner and every friend who can see the library). */
async function accountsOf(server: WatchCarryServer, section: string | null): Promise<Map<string, WatchCarryAccount>> {
  const list = await server.accounts(section);
  return new Map(list.map((a) => [a.accountId, a] as const));
}

// ---------------------------------------------------------------------------
// Pre-clear
// ---------------------------------------------------------------------------

/** The before-items a move takes content away from (moved or deleted files), plus an ordering switch's predicted ones. */
function preClearKeys(slug: string, snapshot: WatchCarrySnapshot): Set<string> {
  const scope = snapshot.scope;
  const away = new Set<number>([...(scope.moved === 'all' ? [] : scope.moved), ...(scope.deleted ?? [])]);
  const awayNames = new Set(scope.deletedNames ?? []);
  const keys = new Set<string>(scope.preClear?.[slug] ?? []);
  for (const item of snapshot.servers[slug]?.items ?? []) {
    if (item.parts.some((p) => away.has(p.size) || awayNames.has(p.name))) keys.add(item.ratingKey);
  }
  return keys;
}

export interface PreClearResult {
  cleared: number;
}

/**
 * ADR-114 C-03 — before the move: clear each account's state on the items the move takes content away from. The carry
 * is marked `cleared` before the first write, so a run that dies part-way leaves the series blocked for a new snapshot
 * until `carry-finish` or `carry-revert` (a new snapshot would read the cleared items as unwatched). Any failure (a
 * write, a read, the audit) puts back every item already cleared, from its state now, and refuses (`refused`): the move
 * must not run. The error names the carry.
 */
export async function preClearWatchCarry(input: {
  db?: DbClient;
  plex: WatchCarryPlex;
  snapshot: WatchCarrySnapshot;
  pauseMs?: number;
}): Promise<PreClearResult> {
  const pause = input.pauseMs ?? CARRY_PAUSE_MS;
  const carryId = input.snapshot.carryId;
  /** Every item a clear was sent for (even one whose answer failed: it may have landed). */
  const touchedItems: Array<{ account: WatchCarryAccount; mark: MarkRecord; showRatingKey: string }> = [];
  let failure: string | null = null;
  await setCarryStatus({ db: input.db, carryId, status: 'cleared' });
  try {
    outer: for (const [slug, server] of Object.entries(input.snapshot.servers)) {
      const keys = preClearKeys(slug, input.snapshot);
      const byAccount = input.snapshot.states[slug] ?? {};
      const targets = Object.entries(byAccount).flatMap(([accountId, list]) => list.filter((s) => keys.has(s.ratingKey)).map((s) => ({ accountId, s })));
      if (targets.length === 0) continue;
      const client = input.plex.server(slug);
      if (!client) {
        failure = `No Plex client for ${slug}.`;
        break;
      }
      const accounts = await accountsOf(client, server.librarySectionId);
      for (const { accountId, s } of targets) {
        const account = accounts.get(accountId);
        const item = server.items.find((i) => i.ratingKey === s.ratingKey);
        const before: WatchCarryStateValue = { viewCount: s.viewCount, viewOffset: s.viewOffset, lastViewedAt: s.lastViewedAt };
        const mark: MarkRecord = {
          server: slug,
          accountId,
          ratingKey: s.ratingKey,
          season: item?.season ?? null,
          episode: item?.episode ?? null,
          phase: 'pre_clear',
          reason: 'pre_clear',
          parts: s.parts,
          before,
          target: EMPTY,
          calls: [],
          ok: false,
          error: null,
        };
        if (!account) {
          mark.error = 'the account can no longer be reached on this server';
          await recordCarryMark(input.db, carryId, mark);
          failure = mark.error;
          break outer;
        }
        touchedItems.push({ account, mark, showRatingKey: server.showRatingKey });
        const sent = await applyCalls(account, s.ratingKey, before, EMPTY, pause);
        mark.calls = sent.calls;
        mark.ok = sent.error === null;
        mark.error = sent.error;
        await recordCarryMark(input.db, carryId, mark);
        if (!mark.ok) {
          failure = sent.error;
          break outer;
        }
      }
    }
  } catch (err) {
    failure = errText(err);
  }
  if (failure !== null) {
    // Put back what was cleared, newest first, from each item's state now (a clear whose answer failed may have
    // landed, or not), then refuse the move.
    const now = new Map<string, Map<string, PlexLeafFile> | null>();
    let restoreFailed = 0;
    for (const { account, mark, showRatingKey } of touchedItems.reverse()) {
      const target: WatchCarryStateValue = { ...mark.before, viewCount: Math.min(mark.before.viewCount, MAX_CARRIED_PLAYS) };
      const cacheKey = `${mark.server}/${mark.accountId}`;
      let error: string | null = null;
      let calls: string[] = [];
      let current: WatchCarryStateValue = EMPTY;
      try {
        if (!now.has(cacheKey)) {
          now.set(cacheKey, new Map((await account.read.listLeafFiles(showRatingKey)).map((l) => [l.ratingKey, l] as const)));
        }
        const leaf = now.get(cacheKey)?.get(mark.ratingKey);
        if (!leaf) error = 'the item no longer exists';
        else {
          current = stateOf(leaf);
          const sent = await applyCalls(account, mark.ratingKey, current, target, pause);
          calls = sent.calls;
          error = sent.error;
        }
      } catch (err) {
        error = errText(err);
      }
      if (error) restoreFailed += 1;
      await recordCarryMark(input.db, carryId, { ...mark, phase: 'revert', reason: 'restore', before: current, target, calls, ok: error === null, error }).catch(() => {});
    }
    await setCarryStatus({ db: input.db, carryId, status: restoreFailed === 0 ? 'refused' : 'cleared', patch: { detail: { refused: failure, restoreFailed } } }).catch(() => {});
    throw new WatchCarryError(
      restoreFailed === 0
        ? `Clearing the watched marks before the move failed (${failure}); they were put back (carry ${carryId}) and nothing moved.`
        : `Clearing the watched marks before the move failed (${failure}), and ${restoreFailed} could not be put back: run carry-revert --carry ${carryId}. Nothing moved.`,
    );
  }
  await setCarryStatus({ db: input.db, carryId, status: 'cleared', patch: { summary: { preCleared: touchedItems.length } } });
  return { cleared: touchedItems.length };
}

/** ADR-114 C-02 — the move did not run after a snapshot: put back any pre-clear and mark the carry `refused`. */
export async function abandonWatchCarry(input: { db?: DbClient; plex: WatchCarryPlex; carryId: string; reason: string; pauseMs?: number }): Promise<void> {
  await revertWatchCarry({ db: input.db, plex: input.plex, carryId: input.carryId, pauseMs: input.pauseMs, finalStatus: 'refused', note: input.reason });
}

// ---------------------------------------------------------------------------
// Waiting for Plex
// ---------------------------------------------------------------------------

/** Where Sonarr has a file after the move: its season and first episode (a two-episode file is one Plex item there). */
export interface CarryExpectedPlace {
  size: number;
  season: number;
  episode: number;
}

export interface CarryWaitResult {
  ready: boolean;
  /** Files not yet on their item, per server (file names only). */
  missing: Array<{ server: string; size: number; expected: string; seen: string | null }>;
  polls: number;
}

/**
 * ADR-114 C-04 — wait (bounded, paced) until every server shows each expected file on exactly the item of its Sonarr
 * season and first episode. Reads with the owner token only.
 */
export async function waitForCarryPlaces(input: {
  plex: WatchCarryPlex;
  snapshot: Pick<WatchCarrySnapshot, 'servers'>;
  expected: readonly CarryExpectedPlace[];
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<CarryWaitResult> {
  const deadline = Date.now() + (input.timeoutMs ?? 15 * 60_000);
  const interval = input.intervalMs ?? 30_000;
  let polls = 0;
  for (;;) {
    polls += 1;
    const missing: CarryWaitResult['missing'] = [];
    for (const [slug, server] of Object.entries(input.snapshot.servers)) {
      const client = input.plex.server(slug);
      if (!client) continue;
      let leaves: PlexLeafFile[];
      try {
        leaves = await client.read.listLeafFiles(server.showRatingKey);
      } catch {
        missing.push({ server: slug, size: 0, expected: 'the show', seen: null });
        continue;
      }
      // Files of one byte size (a byte-identical copy) are checked together: their items must sit exactly where Sonarr
      // has them, one item each.
      const bySize = new Map<number, string[]>();
      for (const e of input.expected) bySize.set(e.size, [...(bySize.get(e.size) ?? []), `S${e.season}E${e.episode}`]);
      for (const [size, places] of bySize) {
        const seen = leaves.filter((l) => l.parts.some((p) => p.size === size)).map((h) => `S${h.season}E${h.episode}`);
        const ok = seen.length === places.length && [...seen].sort().join(',') === [...places].sort().join(',');
        if (!ok) missing.push({ server: slug, size, expected: places.join(','), seen: seen.join(',') || null });
      }
    }
    if (missing.length === 0) return { ready: true, missing, polls };
    if (Date.now() + interval > deadline) return { ready: false, missing, polls };
    await sleep(interval);
  }
}

// ---------------------------------------------------------------------------
// Carry and verify
// ---------------------------------------------------------------------------

export interface CarryAccountSummary {
  /** Items written for the account. */
  written: number;
  failed: number;
  /** Files the account had watched, now watched on the item that plays them. */
  watchedCarried: number;
  /** Resume points that sit on the item holding their file. */
  resumesCarried: number;
  /** Items whose file the account never played, left (or made) unwatched. */
  cleanItems: number;
  /** Items left alone because the account played them after the snapshot. */
  newViews: number;
  /** Files the account had watched or started that no Plex item plays any more (deleted, with no copy elsewhere): dropped. */
  lost: number;
  /** Items whose read-back differs from the target. */
  mismatches: number;
}

export interface WatchCarryResult {
  carryId: string;
  status: WatchCarryStatus;
  /** Per server, per account index (1..n in account-id order; never a name). */
  accounts: Record<string, Record<string, CarryAccountSummary>>;
  totals: { accounts: number; written: number; failed: number; mismatches: number; watchedCarried: number; resumesCarried: number; newViews: number; lost: number };
  mismatchDetail: Array<{ server: string; account: string; ratingKey: string; episode: string; want: WatchCarryStateValue; got: WatchCarryStateValue }>;
  /**
   * P4 decision 38: each dropped state, a file the account had watched or started that no item plays now (the wrong
   * content was deleted and lives nowhere else). The account is named by index, the file by its byte size.
   */
  droppedDetail: Array<{ server: string; account: string; size: number; state: WatchCarryStateValue }>;
}

const blankSummary = (): CarryAccountSummary => ({ written: 0, failed: 0, watchedCarried: 0, resumesCarried: 0, cleanItems: 0, newViews: 0, lost: 0, mismatches: 0 });

/**
 * ADR-114 C-04..C-06 — after the move (or as `carry-finish`): for every account on every server, write each item of the
 * write scope to the state of the file it now holds, then read every account back and verify. Status `verified` or
 * `mismatch`.
 */
export async function carryWatchState(input: {
  db?: DbClient;
  plex: WatchCarryPlex;
  carryId: string;
  pauseMs?: number;
  /** Verify only (no writes): the tool's read-only check of a finished carry. */
  verifyOnly?: boolean;
}): Promise<WatchCarryResult> {
  const pause = input.pauseMs ?? CARRY_PAUSE_MS;
  const { snapshot } = await loadWatchCarry({ db: input.db, carryId: input.carryId });
  const db = resolveDb(input.db);
  const ourMarks = await db
    .select({ server: watchCarryMarks.server, account: watchCarryMarks.plexAccountId, ratingKey: watchCarryMarks.ratingKey })
    .from(watchCarryMarks)
    .where(and(eq(watchCarryMarks.carryId, input.carryId), eq(watchCarryMarks.phase, 'carry')));
  const wroteBefore = new Set(ourMarks.map((m) => `${m.server}/${m.account}/${m.ratingKey}`));
  const takenAtSec = Math.floor(snapshot.takenAt.getTime() / 1000);
  const touched = touchedContents(snapshot.scope);
  const result: WatchCarryResult = {
    carryId: input.carryId,
    status: 'verified',
    accounts: {},
    totals: { accounts: 0, written: 0, failed: 0, mismatches: 0, watchedCarried: 0, resumesCarried: 0, newViews: 0, lost: 0 },
    mismatchDetail: [],
    droppedDetail: [],
  };

  for (const [slug, server] of Object.entries(snapshot.servers)) {
    const client = input.plex.server(slug);
    if (!client) throw new WatchCarryError(`No Plex client for ${slug}.`);
    const beforeTouched = new Set(server.items.filter((i) => touchesItem(i.parts, touched)).map((i) => i.ratingKey));
    const accounts = await accountsOf(client, server.librarySectionId);
    const snapshotAccounts = Object.keys(snapshot.states[slug] ?? {});
    const ids = [...new Set([...snapshotAccounts, ...accounts.keys()])].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    const perServer: Record<string, CarryAccountSummary> = {};
    for (const [index, accountId] of ids.entries()) {
      const summary = blankSummary();
      const label = `account ${index + 1}`;
      const account = accounts.get(accountId);
      const states = snapshot.states[slug]?.[accountId] ?? [];
      const content = contentStates(states, snapshot.scope);
      if (!account) {
        // An account with state that can no longer be reached: every state it had on touched content is a mismatch.
        const missed = states.filter((s) => touchesItem(s.parts, touched)).length;
        if (missed > 0) {
          summary.mismatches += missed;
          result.mismatchDetail.push({ server: slug, account: label, ratingKey: '-', episode: 'unreachable account', want: EMPTY, got: EMPTY });
          perServer[label] = summary;
        }
        continue;
      }
      let after: PlexLeafFile[];
      try {
        after = await account.read.listLeafFiles(server.showRatingKey);
      } catch (err) {
        throw new WatchCarryError(`${slug}: one account's watch state could not be read after the move (${errText(err)}).`);
      }
      const targets = planCarryTargets({ after, beforeTouched, content, scope: snapshot.scope });
      const byKey = new Map(after.map((l) => [l.ratingKey, l] as const));
      const newViewKeys = new Set<string>();
      let wroteAny = false;
      if (!input.verifyOnly) {
        for (const t of targets) {
          const leaf = byKey.get(t.ratingKey);
          if (!leaf) continue;
          const current = stateOf(leaf);
          if (sameCarryState(current, t.target)) continue;
          // A view after the snapshot that the carry did not write is a real new view: leave it.
          if ((leaf.lastViewedAt ?? 0) > takenAtSec && !wroteBefore.has(`${slug}/${accountId}/${t.ratingKey}`)) {
            summary.newViews += 1;
            newViewKeys.add(t.ratingKey);
            continue;
          }
          const sent = await applyCalls(account, t.ratingKey, current, t.target, pause);
          wroteAny = true;
          summary.written += 1;
          if (sent.error) summary.failed += 1;
          await recordCarryMark(input.db, input.carryId, {
            server: slug,
            accountId,
            ratingKey: t.ratingKey,
            season: t.season,
            episode: t.episode,
            phase: 'carry',
            reason: t.reason,
            parts: t.parts,
            before: current,
            target: t.target,
            calls: sent.calls,
            ok: sent.error === null,
            error: sent.error,
          });
        }
      }
      // Verify: read the account again (only when something was written) and compare every target.
      const check = wroteAny ? await account.read.listLeafFiles(server.showRatingKey) : after;
      const checkByKey = new Map(check.map((l) => [l.ratingKey, l] as const));
      for (const t of targets) {
        const leaf = checkByKey.get(t.ratingKey);
        if (!leaf) continue;
        const got = stateOf(leaf);
        if (newViewKeys.has(t.ratingKey)) continue;
        if (sameCarryState(got, t.target)) {
          if (t.target.viewCount > 0) summary.watchedCarried += 1;
          else if (t.target.viewOffset > 0) summary.resumesCarried += 1;
          else summary.cleanItems += 1;
          if (t.target.viewCount > 0 && t.target.viewOffset > 0) summary.resumesCarried += 1;
        } else {
          summary.mismatches += 1;
          result.mismatchDetail.push({ server: slug, account: label, ratingKey: t.ratingKey, episode: `S${t.season}E${t.episode}`, want: t.target, got });
        }
      }
      // Watched content no item plays any more.
      const playing = new Set(check.flatMap((l) => contentsOf(l.parts, snapshot.scope)));
      for (const [key, s] of content) {
        if ((s.viewCount > 0 || s.viewOffset > 0) && (touched === 'all' || touched.has(key)) && !playing.has(key)) {
          summary.lost += 1;
          result.droppedDetail.push({ server: slug, account: label, size: key, state: s });
        }
      }
      if (states.length > 0 || summary.written > 0 || summary.mismatches > 0 || summary.newViews > 0) perServer[label] = summary;
      if (pause > 0) await sleep(pause);
    }
    result.accounts[slug] = perServer;
  }
  for (const byAccount of Object.values(result.accounts)) {
    for (const s of Object.values(byAccount)) {
      result.totals.accounts += 1;
      result.totals.written += s.written;
      result.totals.failed += s.failed;
      result.totals.mismatches += s.mismatches;
      result.totals.watchedCarried += s.watchedCarried;
      result.totals.resumesCarried += s.resumesCarried;
      result.totals.newViews += s.newViews;
      result.totals.lost += s.lost;
    }
  }
  result.status = result.totals.mismatches === 0 && result.totals.failed === 0 ? 'verified' : 'mismatch';
  await setCarryStatus({
    db: input.db,
    carryId: input.carryId,
    status: result.status,
    patch: {
      summary: {
        verification: {
          at: new Date().toISOString(),
          totals: result.totals,
          accounts: result.accounts,
          mismatches: result.mismatchDetail.slice(0, 50),
          dropped: result.droppedDetail.slice(0, 200),
        },
      },
    },
  });
  return result;
}

/** Mark a carry as waiting for Plex (the move ran; `carry-finish` completes it). */
export async function markWatchCarryWaiting(input: { db?: DbClient; carryId: string; wait: CarryWaitResult; detail?: Record<string, unknown> }): Promise<void> {
  await setCarryStatus({ db: input.db, carryId: input.carryId, status: 'waiting', patch: { detail: { wait: { polls: input.wait.polls, missing: input.wait.missing.slice(0, 50) }, ...(input.detail ?? {}) } } });
}

/** Record a link or fact on the carry (the Repair Request it belongs to, the ordering read back). */
export async function noteWatchCarry(input: { db?: DbClient; carryId: string; detail: Record<string, unknown> }): Promise<void> {
  await resolveDb(input.db)
    .update(watchCarries)
    .set({ updatedAt: new Date(), detail: sql`${watchCarries.detail} || ${JSON.stringify(input.detail)}::jsonb` })
    .where(eq(watchCarries.id, input.carryId));
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

export interface WatchCarryRevertResult {
  carryId: string;
  restored: number;
  failed: number;
}

/**
 * ADR-114 C-07 — `carry-revert`: every item the carry wrote goes back to the state it had before the carry first wrote it
 * (the earliest audit row's `before_state` per account and item), newest item first. Status `reverted` (or `refused`
 * when called because the move never ran).
 */
export async function revertWatchCarry(input: {
  db?: DbClient;
  plex: WatchCarryPlex;
  carryId: string;
  pauseMs?: number;
  finalStatus?: 'reverted' | 'refused';
  note?: string;
}): Promise<WatchCarryRevertResult> {
  const pause = input.pauseMs ?? CARRY_PAUSE_MS;
  const { snapshot } = await loadWatchCarry({ db: input.db, carryId: input.carryId });
  const marks = await resolveDb(input.db)
    .select()
    .from(watchCarryMarks)
    .where(and(eq(watchCarryMarks.carryId, input.carryId), inArray(watchCarryMarks.phase, ['pre_clear', 'carry'])))
    .orderBy(asc(watchCarryMarks.createdAt));
  // The first write per account and item holds the state before the carry touched it.
  const original = new Map<string, (typeof marks)[number]>();
  const lastAt = new Map<string, number>();
  for (const m of marks) {
    const key = `${m.server}/${m.plexAccountId}/${m.ratingKey}`;
    if (!original.has(key)) original.set(key, m);
    lastAt.set(key, m.createdAt.getTime());
  }
  const order = [...original.keys()].sort((a, b) => (lastAt.get(b) ?? 0) - (lastAt.get(a) ?? 0));
  let restored = 0;
  let failed = 0;
  const clients = new Map<string, Map<string, WatchCarryAccount>>();
  const leavesOf = new Map<string, Map<string, PlexLeafFile> | Error>();
  for (const key of order) {
    const m = original.get(key)!;
    const server = snapshot.servers[m.server];
    const client = input.plex.server(m.server);
    if (!server || !client) {
      failed += 1;
      continue;
    }
    if (!clients.has(m.server)) clients.set(m.server, await accountsOf(client, server.librarySectionId));
    const account = clients.get(m.server)!.get(m.plexAccountId);
    const target: WatchCarryStateValue = { ...m.beforeState, viewCount: Math.min(m.beforeState.viewCount, MAX_CARRIED_PLAYS) };
    let current: WatchCarryStateValue | null = null;
    let error: string | null = null;
    let calls: string[] = [];
    if (!account) error = 'the account can no longer be reached on this server';
    else {
      const cacheKey = `${m.server}/${m.plexAccountId}`;
      if (!leavesOf.has(cacheKey)) {
        try {
          leavesOf.set(cacheKey, new Map((await account.read.listLeafFiles(server.showRatingKey)).map((l) => [l.ratingKey, l] as const)));
        } catch (err) {
          leavesOf.set(cacheKey, err instanceof Error ? err : new Error(String(err)));
        }
      }
      const leaves = leavesOf.get(cacheKey)!;
      if (leaves instanceof Error) error = errText(leaves);
      else {
        const leaf = leaves.get(m.ratingKey);
        if (!leaf) error = 'the item no longer exists';
        else current = stateOf(leaf);
      }
      if (current && !sameCarryState(current, target)) {
        const sent = await applyCalls(account, m.ratingKey, current, target, pause);
        calls = sent.calls;
        error = sent.error;
      }
    }
    if (error) failed += 1;
    else restored += 1;
    await recordCarryMark(input.db, input.carryId, {
      server: m.server,
      accountId: m.plexAccountId,
      ratingKey: m.ratingKey,
      season: m.seasonNumber,
      episode: m.episodeNumber,
      phase: 'revert',
      reason: 'restore',
      parts: m.parts,
      before: current ?? EMPTY,
      target,
      calls,
      ok: error === null,
      error,
    });
  }
  await setCarryStatus({
    db: input.db,
    carryId: input.carryId,
    status: input.finalStatus ?? 'reverted',
    patch: { detail: { revert: { at: new Date().toISOString(), restored, failed, ...(input.note ? { note: input.note } : {}) } } },
  });
  return { carryId: input.carryId, restored, failed };
}

// ---------------------------------------------------------------------------
// Reads for the staff tool
// ---------------------------------------------------------------------------

export interface WatchCarryView {
  id: string;
  kind: WatchCarryKind;
  status: WatchCarryStatus;
  seriesId: number;
  seasons: number[];
  takenAt: string;
  summary: Record<string, unknown>;
  detail: Record<string, unknown>;
  marks: { pre_clear: number; carry: number; revert: number; failed: number };
}

/** The latest carries of a series, or one carry, as the tool prints them (counts only; no names). */
export async function listWatchCarries(input: { db?: DbClient; seriesId?: number; carryId?: string; limit?: number }): Promise<WatchCarryView[]> {
  const db = resolveDb(input.db);
  const rows = await db
    .select()
    .from(watchCarries)
    .where(input.carryId ? eq(watchCarries.id, input.carryId) : input.seriesId !== undefined ? eq(watchCarries.seriesId, input.seriesId) : sql`true`)
    .orderBy(desc(watchCarries.createdAt))
    .limit(input.limit ?? 10);
  const out: WatchCarryView[] = [];
  for (const r of rows) {
    const counts = await db
      .select({ phase: watchCarryMarks.phase, ok: watchCarryMarks.ok, n: sql<number>`count(*)::int` })
      .from(watchCarryMarks)
      .where(eq(watchCarryMarks.carryId, r.id))
      .groupBy(watchCarryMarks.phase, watchCarryMarks.ok);
    const marks = { pre_clear: 0, carry: 0, revert: 0, failed: 0 };
    for (const c of counts) {
      marks[c.phase] += c.n;
      if (!c.ok) marks.failed += c.n;
    }
    out.push({
      id: r.id,
      kind: r.kind,
      status: r.status,
      seriesId: r.seriesId,
      seasons: r.seasonNumbers,
      takenAt: r.takenAt.toISOString(),
      summary: r.summary,
      detail: r.detail,
      marks,
    });
  }
  return out;
}
