// ADR-093 / DESIGN-052 D-01..D-07, D-19 (PLAN-072) — the WATCHLIST REGISTRY (T-261) and the REGISTRY GATE (T-262).
//
// `refreshWatchlistRegistry` is the SINGLE WRITER of the registry tables (watchlist_registry_runs / _accounts /
// _sources / _items and plex_discover_ids; the no-direct-state-writes guard enforces it). It reads every watchlist the
// app can reach — the owner's own discover list, friends' and full Home members' through community.plex.tv GraphQL,
// and every Seerr user's through Seerr (their own stored tokens, private lists included) — and keeps the state PER
// (ACCOUNT, SOURCE), because failures are per source. The rule that makes it fail closed: a failed read never removes
// a title, and an empty answer after a list with titles is a failed read (Seerr answers every failed plex.tv read as
// an HTTP 200 empty list; community.plex.tv answers a hidden list as an empty one).
//
// `evaluateRegistryGate` turns the newest ok refresh into the typed WatchlistSnapshot the Trash guard evaluates
// (D-06): `delete` refuses unless the refresh is ≤ 30 minutes old and no readable source is unverified; `propose`
// never refuses; `display` (walls, previews) uses the newest ok run of any age.
//
// PRIVACY (ADR-093 C-06): other people's lists are guard input only. Nothing here returns, stores or logs a name, an
// email, a token or which account lists a title; logs carry classes, counts and `acct:<hash>` tags only (D-21).
import {
  plexDiscoverIds,
  watchlistRegistryAccounts,
  watchlistRegistryItems,
  watchlistRegistryRuns,
  watchlistRegistrySources,
  watchMarks,
  type DbClient,
  type WatchlistAccountClass,
  type WatchlistAccountStatus,
  type WatchlistItemKind,
  type WatchlistRegistryRunFailure,
  type WatchlistRegistryTrigger,
  type WatchlistSource,
  type WatchlistSourceOutcome,
  type WatchlistSourceStatus,
} from '@hnet/db';
import { and, desc, eq, gte, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import {
  discoverExternalIds,
  discoverIdFromGuid,
  isDiscoverId,
  type DiscoverExternalIds,
  type DiscoverKind,
  type PlexSectionItem,
} from '@hnet/plex';
import type {
  CommunityWatchlistAnswer,
  DiscoverMetadata,
  HomeUser,
  PlexPagedListing,
  RosterOwner,
  RosterUser,
} from '@hnet/plex/read';
import type { SeerrUserSummary } from '@hnet/arr';
import type { SeerrWatchlistAnswer } from '@hnet/arr/read';
import { inTransaction, resolveDb } from './db-client';
import { accountTag, consoleDomainLogger, type DomainLogger } from './domain-logger';
import { WatchlistRegistryUnverifiedError, type RegistryGateRefusal } from './errors';

// ---------------------------------------------------------------------------
// Constants (D-07: in code, not settings)
// ---------------------------------------------------------------------------

/** G1 — a delete needs an ok refresh that finished at most this long ago (two missed CronJob runs refuse). */
export const REGISTRY_MAX_AGE_MIN = 30;
/** G3 — a carried source blocks once its last ok read is older than this. */
export const ACCOUNT_CARRY_MAX_H = 24;
/** D-04 — a source failing continuously this long turns `unreadable` (frozen, counted, no longer blocking). */
export const ACCOUNT_UNREADABLE_AFTER_H = 72;
/** D-01 — an account missing from the roster keeps protecting its titles this long before it is deleted. */
export const ACCOUNT_LEFT_GRACE_H = 24;
/** D-07 — `propose` filters with the newest ok run only when it finished within this window. */
export const PROPOSE_MAX_AGE_H = 24;
/** D-03 — at most this many new discover-id lookups per refresh … */
export const DISCOVER_MAP_BATCH = 200;
/** … this far apart … */
export const DISCOVER_MAP_SPACING_MS = 100;
/** … and a 404'd id is tried again after this many days. */
export const DISCOVER_NOT_FOUND_RETRY_DAYS = 7;
/** D-04 — runs older than this are pruned (the newest ok run is always kept). */
export const REGISTRY_RUN_RETENTION_DAYS = 7;
/** D-04 — how long the sweep waits for a refresh another process holds. */
export const REGISTRY_LOCK_WAIT_MS = 120_000;
/** The poll interval while waiting for the lock. */
export const REGISTRY_LOCK_POLL_MS = 2_000;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;
/** The advisory lock key (`hashtext('watchlist-registry')`). */
const LOCK_SQL = sql`hashtext('watchlist-registry')`;

// ---------------------------------------------------------------------------
// The read seams (D-02). Production: `watchlistRegistrySourcesFromEnv` (watchlist-registry-sources.ts) adapts the
// @hnet/plex PlexRegistryClient and the @hnet/arr SeerrClient; tests pass in-memory fakes.
// ---------------------------------------------------------------------------

/** The owner-token plex.tv reads (roster, the owner's list, community GraphQL, the discover-id map). */
export interface WatchlistPlexReader {
  /** Which server's owner token (for logs): `haynesops` / `haynestower`. */
  readonly label: string;
  getOwner(): Promise<RosterOwner>;
  listUsers(): Promise<RosterUser[]>;
  listHomeUsers(): Promise<HomeUser[]>;
  getOwnerWatchlist(): Promise<PlexPagedListing<PlexSectionItem>>;
  communityWatchlist(uuid: string): Promise<CommunityWatchlistAnswer>;
  discoverMetadata(id: string): Promise<DiscoverMetadata | null>;
}

/** The Seerr reads (the API key; each user's list is read with that user's own stored token). */
export interface WatchlistSeerrReader {
  listUsers(): Promise<SeerrUserSummary[]>;
  readUserWatchlist(userId: number): Promise<SeerrWatchlistAnswer>;
}

export interface WatchlistRegistrySources {
  /** Owner-token readers in fallback order: HaynesOps, then HaynesTower (the `sync-watch` order, D-01). */
  plex: readonly WatchlistPlexReader[];
  /** Null when Seerr is not configured: every Seerr source then reads as failed (fail closed). */
  seerr: WatchlistSeerrReader | null;
}

// ---------------------------------------------------------------------------
// The per-source state machine (D-04) — pure, so every transition is unit-tested.
// ---------------------------------------------------------------------------

/** One title as the registry stores it. */
export interface RegistryItemInput {
  discoverId: string;
  kind: WatchlistItemKind;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

/** A source's answer this run, normalized from the D-02 answer classes. */
export type SourceAnswer =
  /** An ok read listing at least one title. */
  | { kind: 'titles'; items: RegistryItemInput[] }
  /** An answer listing nothing: community empty (possibly hidden), Seerr `totalResults: 0` (possibly an error). */
  | { kind: 'empty'; unverified: boolean }
  /** community `User not found:` (a managed user, a made-up uuid, a private list). */
  | { kind: 'not_found' }
  | { kind: 'failed'; errorClass: string }
  /** The source cannot read this account (no uuid, the switch while disabled, a source no longer linked). */
  | { kind: 'not_applicable'; errorClass: string };

/** The stored state of one (account, source) — null for a source new this run. */
export interface SourceState {
  status: WatchlistSourceStatus;
  lastOkAt: Date | null;
  failingSince: Date | null;
  lastOkCount: number | null;
  emptyUnverified: boolean;
  hiddenLoggedAt: Date | null;
}

export interface SourceDecision {
  outcome: WatchlistSourceOutcome;
  status: WatchlistSourceStatus;
  errorClass: string | null;
  lastOkAt: Date | null;
  failingSince: Date | null;
  lastOkCount: number | null;
  emptyUnverified: boolean;
  hiddenLoggedAt: Date | null;
  /** The ok read's titles, which REPLACE the source's items; null keeps the stored items exactly as they were. */
  replaceItems: RegistryItemInput[] | null;
  /** A source that had titles answered empty or not found this run (logged `account_hidden` once). */
  hiddenTransition: boolean;
  /** Log `account_hidden` now (the first run of this transition). */
  logHidden: boolean;
  /** The source turned `unreadable` this run (logged `account_unreadable` once). */
  becameUnreadable: boolean;
}

/**
 * D-04 — decide one source's outcome and next state from its answer and its stored state.
 *
 * | answer | had titles? | outcome |
 * | titles | any | ok |
 * | empty | no | ok, `empty_unverified` (a hidden community list and a failed Seerr read look like this) |
 * | empty / not found | yes | failed (carried forward), `account_hidden` once — unless the exception below |
 * | not found | no | not_applicable |
 * | failed | any | failed |
 *
 * Exception: a COMMUNITY source that had titles and now answers empty or not found, on an account whose SEERR source
 * read ok with titles THIS run, turns `unreadable` at once (frozen, not blocking): Seerr reads that account's whole
 * list, private titles included. Only a Seerr read settles a community transition, never the reverse.
 *
 * A failed source is `carried` (it had an ok read) or `never_read` (it never had one) until it has failed
 * continuously for 72 hours, then `unreadable`; an `unreadable` source stays so until an ok read. A failed,
 * not-applicable or unreadable source NEVER loses its stored items.
 */
export function decideSource(input: {
  source: WatchlistSource;
  prev: SourceState | null;
  answer: SourceAnswer;
  now: Date;
  /** This account's Seerr source read ok WITH titles in this same run (the community exception). */
  seerrOkWithTitles: boolean;
}): SourceDecision {
  const { prev, answer, now } = input;
  const hadTitles = (prev?.lastOkCount ?? 0) > 0;
  const keep = {
    lastOkAt: prev?.lastOkAt ?? null,
    lastOkCount: prev?.lastOkCount ?? null,
    emptyUnverified: prev?.emptyUnverified ?? false,
  };
  const base = { hiddenTransition: false, logHidden: false, becameUnreadable: false };

  if (answer.kind === 'titles') {
    return {
      ...base,
      outcome: 'ok',
      status: 'read',
      errorClass: null,
      lastOkAt: now,
      failingSince: null,
      lastOkCount: answer.items.length,
      emptyUnverified: false,
      hiddenLoggedAt: null,
      replaceItems: answer.items,
    };
  }

  if (answer.kind === 'not_applicable') {
    return {
      ...base,
      ...keep,
      outcome: 'not_applicable',
      status: 'not_applicable',
      errorClass: answer.errorClass,
      failingSince: null,
      hiddenLoggedAt: prev?.hiddenLoggedAt ?? null,
      replaceItems: null,
    };
  }

  if ((answer.kind === 'empty' || answer.kind === 'not_found') && !hadTitles) {
    if (answer.kind === 'not_found') {
      // Nothing was ever read: the source cannot read this account (a managed user, a made-up uuid) — no block.
      return {
        ...base,
        ...keep,
        outcome: 'not_applicable',
        status: 'not_applicable',
        errorClass: 'not_found',
        failingSince: null,
        hiddenLoggedAt: prev?.hiddenLoggedAt ?? null,
        replaceItems: null,
      };
    }
    // An ok empty read lists nothing, so it removes nothing (a title leaves only when an ok read no longer lists it
    // while still listing something).
    return {
      ...base,
      outcome: 'ok',
      status: 'read',
      errorClass: null,
      lastOkAt: now,
      failingSince: null,
      lastOkCount: 0,
      emptyUnverified: answer.unverified,
      hiddenLoggedAt: null,
      replaceItems: null,
    };
  }

  // Failed: a failed read, or an empty / not-found answer after a list with titles (a hidden list, a failed Seerr
  // read, or a list truly emptied — indistinguishable, so carried and frozen: ADR-093 C-05's accepted cost).
  const hiddenTransition = answer.kind === 'empty' || answer.kind === 'not_found';
  const errorClass =
    answer.kind === 'failed'
      ? answer.errorClass
      : answer.kind === 'not_found'
        ? 'not_found_after_titles'
        : 'empty_after_titles';
  const failingSince = prev?.failingSince ?? now;
  const settledBySeerr =
    hiddenTransition && input.source === 'community' && input.seerrOkWithTitles;
  let status: WatchlistSourceStatus;
  if (
    prev?.status === 'unreadable' ||
    settledBySeerr ||
    now.getTime() - failingSince.getTime() >= ACCOUNT_UNREADABLE_AFTER_H * HOUR_MS
  ) {
    status = 'unreadable';
  } else {
    status = prev?.lastOkAt ? 'carried' : 'never_read';
  }
  const logHidden = hiddenTransition && !prev?.hiddenLoggedAt;
  return {
    outcome: 'failed',
    status,
    errorClass,
    lastOkAt: keep.lastOkAt,
    failingSince,
    lastOkCount: keep.lastOkCount,
    emptyUnverified: keep.emptyUnverified,
    hiddenLoggedAt: logHidden ? now : (prev?.hiddenLoggedAt ?? null),
    replaceItems: null,
    hiddenTransition,
    logHidden,
    becameUnreadable: status === 'unreadable' && prev?.status !== 'unreadable',
  };
}

/**
 * D-04 — the account's status, derived from its sources: never_read if any source is never_read; else carried if any
 * is carried; else unreadable if any is unreadable; else unresolvable if every source is not_applicable; else read.
 */
export function deriveAccountStatus(
  statuses: readonly WatchlistSourceStatus[],
): WatchlistAccountStatus {
  if (statuses.includes('never_read')) return 'never_read';
  if (statuses.includes('carried')) return 'carried';
  if (statuses.includes('unreadable')) return 'unreadable';
  if (statuses.length === 0 || statuses.every((s) => s === 'not_applicable')) return 'unresolvable';
  return 'read';
}

/** The Watchlists card's headline split: an account is READ when one of its sources holds a verified list. */
export function accountIsRead(
  sources: ReadonlyArray<{ status: WatchlistSourceStatus; emptyUnverified: boolean }>,
): boolean {
  return sources.some((s) => (s.status === 'read' || s.status === 'carried') && !s.emptyUnverified);
}

// ---------------------------------------------------------------------------
// Answer normalization (D-02 → SourceAnswer)
// ---------------------------------------------------------------------------

function fromCommunity(answer: CommunityWatchlistAnswer): SourceAnswer {
  if (answer.kind === 'not_found') return { kind: 'not_found' };
  if (answer.kind === 'failed') return { kind: 'failed', errorClass: answer.errorClass };
  if (answer.nodes.length === 0) return { kind: 'empty', unverified: true };
  return {
    kind: 'titles',
    items: answer.nodes.map((n) => ({
      discoverId: n.discoverId,
      kind: n.kind,
      tmdbId: null,
      tvdbId: null,
      imdbId: null,
    })),
  };
}

function fromSeerr(answer: SeerrWatchlistAnswer): SourceAnswer {
  if (answer.kind === 'failed') return { kind: 'failed', errorClass: answer.errorClass };
  // An ok read whose every item Seerr dropped lists nothing: it is empty for the D-04 rules.
  if (answer.kind === 'empty' || answer.items.length === 0)
    return { kind: 'empty', unverified: true };
  return {
    kind: 'titles',
    items: answer.items.map((i) => ({
      discoverId: i.discoverId,
      kind: i.kind,
      tmdbId: i.tmdbId,
      tvdbId: null,
      imdbId: null,
    })),
  };
}

/** The owner's discover rows → registry items (the discover id from the `plex://` guid, else the ratingKey). */
export function ownerItemsFromListing(items: readonly PlexSectionItem[]): {
  items: RegistryItemInput[];
  skipped: number;
} {
  const out: RegistryItemInput[] = [];
  let skipped = 0;
  for (const item of items) {
    const kind: DiscoverKind | null =
      item.type === 'movie' ? 'movie' : item.type === 'show' ? 'show' : null;
    if (kind === null) {
      skipped += 1;
      continue;
    }
    const fromGuid = discoverIdFromGuid(item.guid, kind);
    const key = item.ratingKey.trim().toLowerCase();
    const discoverId = fromGuid ?? (isDiscoverId(key) ? key : null);
    if (discoverId === null) {
      skipped += 1;
      continue;
    }
    const ids: DiscoverExternalIds = discoverExternalIds(item.Guid);
    out.push({
      discoverId,
      kind,
      tmdbId: ids.tmdbId,
      tvdbId: kind === 'show' ? ids.tvdbId : null,
      imdbId: ids.imdbId,
    });
  }
  return { items: out, skipped };
}

// ---------------------------------------------------------------------------
// The refresh (the single writer)
// ---------------------------------------------------------------------------

export interface WatchlistRegistryCounts {
  roster: number;
  left: number;
  byClass: Record<string, number>;
  byStatus: Record<string, number>;
  bySourceOutcome: Record<string, number>;
  emptyUnverified: number;
  accountHidden: number;
  accountsRead: number;
  accountsUnreadable: number;
  communityWithTitles: number;
  ownerSkipped: number;
  entries: number;
  distinctTitles: number;
  mapped: number;
  unmapped: number;
  lookups: { resolved: number; notFound: number; failed: number };
}

export interface WatchlistRegistryRefreshReport {
  /** `ok` / `failed`: this call ran a refresh. `reused`: another refresh finished ok while the sweep waited.
   *  `busy`: another refresh held the lock (the CronJob skips; the sweep gave up after 120 s). */
  status: 'ok' | 'failed' | 'reused' | 'busy';
  runId: string | null;
  failure: WatchlistRegistryRunFailure | null;
  durationMs: number;
  counts: WatchlistRegistryCounts | null;
}

export interface RefreshWatchlistRegistryInput {
  db?: DbClient;
  sources: WatchlistRegistrySources;
  trigger: WatchlistRegistryTrigger;
  logger?: DomainLogger;
  /** Clock seam (tests). Every timestamp of one run reads it. */
  now?: () => Date;
  /** Sleep seam (the discover-map spacing and the lock poll; tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** When another process holds the lock: `skip` (the CronJob) or `wait` up to `lockWaitMs` (the sweep). */
  onBusy?: 'skip' | 'wait';
  lockWaitMs?: number;
}

class RegistryRunFailed extends Error {
  constructor(readonly failure: WatchlistRegistryRunFailure) {
    super(failure);
  }
}

const defaultSleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

interface RosterEntry {
  plexAccountId: string;
  cls: WatchlistAccountClass;
  uuid: string | null;
}

async function readRoster(
  readers: readonly WatchlistPlexReader[],
  logger: DomainLogger,
): Promise<{ reader: WatchlistPlexReader; owner: RosterOwner; entries: RosterEntry[] }> {
  for (const reader of readers) {
    try {
      const owner = await reader.getOwner();
      const [users, home] = await Promise.all([reader.listUsers(), reader.listHomeUsers()]);
      const entries = new Map<string, RosterEntry>();
      entries.set(owner.id, { plexAccountId: owner.id, cls: 'owner', uuid: owner.uuid });
      const homeById = new Map(home.map((h) => [h.id, h] as const));
      for (const u of users) {
        if (u.id === owner.id) continue;
        const h = homeById.get(u.id);
        const inHome = h !== undefined || u.home;
        const restricted = h !== undefined ? h.restricted : u.restricted;
        entries.set(u.id, {
          plexAccountId: u.id,
          cls: inHome ? (restricted ? 'home_managed' : 'home_full') : 'friend',
          uuid: u.uuid ?? h?.uuid ?? null,
        });
      }
      for (const h of home) {
        if (h.id === owner.id || entries.has(h.id)) continue;
        entries.set(h.id, {
          plexAccountId: h.id,
          cls: h.restricted ? 'home_managed' : 'home_full',
          uuid: h.uuid,
        });
      }
      return { reader, owner, entries: [...entries.values()] };
    } catch (error) {
      logger.warn('[watchlist-registry] roster_read_failed', {
        server: reader.label,
        errorClass: error instanceof Error ? error.name : 'error',
      });
    }
  }
  throw new RegistryRunFailed('roster');
}

/** Replace one source's items with an ok read's titles (deduped; inserted ON CONFLICT DO NOTHING). */
async function replaceSourceItems(
  tx: DbClient,
  plexAccountId: string,
  source: WatchlistSource,
  items: readonly RegistryItemInput[],
  at: Date,
): Promise<void> {
  const unique = new Map<string, RegistryItemInput>();
  for (const item of items) if (!unique.has(item.discoverId)) unique.set(item.discoverId, item);
  const ids = [...unique.keys()];
  const scope = and(
    eq(watchlistRegistryItems.plexAccountId, plexAccountId),
    eq(watchlistRegistryItems.source, source),
  );
  // Titles no longer listed by this ok read leave the registry (it still lists something — D-04).
  await tx
    .delete(watchlistRegistryItems)
    .where(ids.length > 0 ? and(scope, notInArray(watchlistRegistryItems.discoverId, ids)) : scope);
  if (ids.length === 0) return;
  await tx
    .update(watchlistRegistryItems)
    .set({ lastSeenAt: at })
    .where(and(scope, inArray(watchlistRegistryItems.discoverId, ids)));
  const rows = [...unique.values()].map((i) => ({
    plexAccountId,
    discoverId: i.discoverId,
    kind: i.kind,
    source,
    tmdbId: i.tmdbId,
    tvdbId: i.tvdbId,
    imdbId: i.imdbId,
    firstSeenAt: at,
    lastSeenAt: at,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await tx
      .insert(watchlistRegistryItems)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing();
  }
}

/** Write one source's decided state (and its items, on an ok read with titles). */
async function writeSource(
  tx: DbClient,
  plexAccountId: string,
  source: WatchlistSource,
  d: SourceDecision,
  at: Date,
): Promise<void> {
  const values = {
    status: d.status,
    lastOutcome: d.outcome,
    lastErrorClass: d.errorClass,
    lastAttemptAt: at,
    lastOkAt: d.lastOkAt,
    failingSince: d.failingSince,
    lastOkCount: d.lastOkCount,
    emptyUnverified: d.emptyUnverified,
    hiddenLoggedAt: d.hiddenLoggedAt,
    updatedAt: at,
  };
  await tx
    .insert(watchlistRegistrySources)
    .values({ plexAccountId, source, ...values })
    .onConflictDoUpdate({
      target: [watchlistRegistrySources.plexAccountId, watchlistRegistrySources.source],
      set: values,
    });
  if (d.replaceItems !== null)
    await replaceSourceItems(tx, plexAccountId, source, d.replaceItems, at);
}

/** Recompute an account's derived status and item count from its stored sources and items. */
async function settleAccount(
  tx: DbClient,
  plexAccountId: string,
  at: Date,
): Promise<WatchlistAccountStatus> {
  const sources = await tx
    .select({ status: watchlistRegistrySources.status })
    .from(watchlistRegistrySources)
    .where(eq(watchlistRegistrySources.plexAccountId, plexAccountId));
  const status = deriveAccountStatus(sources.map((s) => s.status));
  const [count] = await tx
    .select({ n: sql<number>`count(DISTINCT ${watchlistRegistryItems.discoverId})::int` })
    .from(watchlistRegistryItems)
    .where(eq(watchlistRegistryItems.plexAccountId, plexAccountId));
  await tx
    .update(watchlistRegistryAccounts)
    .set({ status, itemCount: count?.n ?? 0, updatedAt: at })
    .where(eq(watchlistRegistryAccounts.plexAccountId, plexAccountId));
  return status;
}

type SourceStateRow = SourceState & { source: WatchlistSource };

async function loadSourceStates(
  db: DbClient,
  plexAccountId: string,
): Promise<Map<WatchlistSource, SourceStateRow>> {
  const rows = await resolveDb(db)
    .select({
      source: watchlistRegistrySources.source,
      status: watchlistRegistrySources.status,
      lastOkAt: watchlistRegistrySources.lastOkAt,
      failingSince: watchlistRegistrySources.failingSince,
      lastOkCount: watchlistRegistrySources.lastOkCount,
      emptyUnverified: watchlistRegistrySources.emptyUnverified,
      hiddenLoggedAt: watchlistRegistrySources.hiddenLoggedAt,
    })
    .from(watchlistRegistrySources)
    .where(eq(watchlistRegistrySources.plexAccountId, plexAccountId));
  return new Map(rows.map((r) => [r.source, r] as const));
}

/**
 * ADR-093 C-01 / DESIGN-052 D-04 — one refresh of the Watchlist Registry, under the `watchlist-registry` advisory lock:
 * roster → accounts (left / deleted after 24 h) → the owner's whole list (failure fails the run) → every other
 * account, sequentially, one transaction each, Seerr first → the discover-id map → prune → the run row. Returns a
 * report; throws only on an unexpected error (the run row is then `failed` / `error`).
 */
export async function refreshWatchlistRegistry(
  input: RefreshWatchlistRegistryInput,
): Promise<WatchlistRegistryRefreshReport> {
  const db = resolveDb(input.db);
  const logger = input.logger ?? consoleDomainLogger;
  const clock = input.now ?? (() => new Date());
  const sleep = input.sleep ?? defaultSleep;
  const started = Date.now();
  const waitStart = clock();
  const waitDeadline =
    Date.now() + (input.onBusy === 'wait' ? (input.lockWaitMs ?? REGISTRY_LOCK_WAIT_MS) : 0);

  for (;;) {
    // The lock is transaction-scoped, held by a transaction that stays open for the whole refresh (network I/O runs
    // inside it; it holds no row lock and writes nothing — every registry write runs in its own transaction).
    const outcome = await inTransaction(input.db, async (lockTx) => {
      const [got] = await lockTx
        .execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${LOCK_SQL}) AS locked`)
        .then((r) => r.rows);
      if (!got?.locked) return null;
      return runRefresh(db, input, logger, clock, sleep, started);
    });
    if (outcome !== null) return outcome;
    // Busy: another process is refreshing.
    if (input.onBusy === 'wait') {
      const [finished] = await db
        .select({ id: watchlistRegistryRuns.id })
        .from(watchlistRegistryRuns)
        .where(
          and(
            eq(watchlistRegistryRuns.status, 'ok'),
            gte(watchlistRegistryRuns.finishedAt, waitStart),
          ),
        )
        .orderBy(desc(watchlistRegistryRuns.finishedAt))
        .limit(1);
      if (finished) {
        return {
          status: 'reused',
          runId: finished.id,
          failure: null,
          durationMs: Date.now() - started,
          counts: null,
        };
      }
      if (Date.now() < waitDeadline) {
        await sleep(REGISTRY_LOCK_POLL_MS);
        continue;
      }
    }
    logger.info('[watchlist-registry] busy', {
      trigger: input.trigger,
      onBusy: input.onBusy ?? 'skip',
    });
    return {
      status: 'busy',
      runId: null,
      failure: null,
      durationMs: Date.now() - started,
      counts: null,
    };
  }
}

async function runRefresh(
  db: ReturnType<typeof resolveDb>,
  input: RefreshWatchlistRegistryInput,
  logger: DomainLogger,
  clock: () => Date,
  sleep: (ms: number) => Promise<void>,
  started: number,
): Promise<WatchlistRegistryRefreshReport> {
  const at = clock();
  const [run] = await db
    .insert(watchlistRegistryRuns)
    .values({ trigger: input.trigger, status: 'running', startedAt: at })
    .returning({ id: watchlistRegistryRuns.id });
  if (!run) throw new Error('watchlist_registry_runs insert returned no row');

  const fail = async (
    failure: WatchlistRegistryRunFailure,
  ): Promise<WatchlistRegistryRefreshReport> => {
    await db
      .update(watchlistRegistryRuns)
      .set({ status: 'failed', failure, finishedAt: clock() })
      .where(eq(watchlistRegistryRuns.id, run.id));
    logger.warn('[watchlist-registry] run_failed', { trigger: input.trigger, failure });
    return {
      status: 'failed',
      runId: run.id,
      failure,
      durationMs: Date.now() - started,
      counts: null,
    };
  };

  try {
    const counts = await refreshBody(db, input, logger, at, sleep);
    await db
      .update(watchlistRegistryRuns)
      .set({
        status: 'ok',
        finishedAt: clock(),
        counts: counts as unknown as Record<string, unknown>,
      })
      .where(eq(watchlistRegistryRuns.id, run.id));
    const durationMs = Date.now() - started;
    logger.info('[watchlist-registry] run_complete', {
      trigger: input.trigger,
      status: 'ok',
      durationMs,
      roster: counts.roster,
      byClass: counts.byClass,
      byStatus: counts.byStatus,
      bySourceOutcome: counts.bySourceOutcome,
      emptyUnverified: counts.emptyUnverified,
      accountHidden: counts.accountHidden,
      entries: counts.entries,
      distinctTitles: counts.distinctTitles,
      mapped: counts.mapped,
      unmapped: counts.unmapped,
    });
    return { status: 'ok', runId: run.id, failure: null, durationMs, counts };
  } catch (error) {
    if (error instanceof RegistryRunFailed) return fail(error.failure);
    await fail('error');
    throw error;
  }
}

async function refreshBody(
  db: ReturnType<typeof resolveDb>,
  input: RefreshWatchlistRegistryInput,
  logger: DomainLogger,
  at: Date,
  sleep: (ms: number) => Promise<void>,
): Promise<WatchlistRegistryCounts> {
  // 1 — the roster (D-01); a failure fails the whole run.
  const roster = await readRoster(input.sources.plex, logger);
  const ownerId = roster.owner.id;

  // 2 — Seerr users: the link from a plex.tv account to its Seerr user (Plex users only — a local Seerr user has no
  //     Plex watchlist). A failed user list keeps every stored link and reads every Seerr source as failed.
  let seerrUsers: SeerrUserSummary[] | null = null;
  if (input.sources.seerr) {
    try {
      seerrUsers = await input.sources.seerr.listUsers();
    } catch (error) {
      logger.warn('[watchlist-registry] seerr_users_failed', {
        errorClass: error instanceof Error ? error.name : 'error',
      });
    }
  }
  const seerrByPlexId = new Map<string, number>();
  for (const u of seerrUsers ?? []) if (u.plexId !== null) seerrByPlexId.set(u.plexId, u.id);

  const rosterIds = new Set(roster.entries.map((e) => e.plexAccountId));
  const current: RosterEntry[] = [...roster.entries];
  for (const [plexId] of seerrByPlexId) {
    if (!rosterIds.has(plexId))
      current.push({ plexAccountId: plexId, cls: 'seerr_only', uuid: null });
  }
  const currentIds = new Set(current.map((e) => e.plexAccountId));

  // 3 — accounts: upsert the current ones; stamp the missing ones `left_at`; delete those gone for 24 h (cascade).
  const stored = await db
    .select({
      plexAccountId: watchlistRegistryAccounts.plexAccountId,
      class: watchlistRegistryAccounts.class,
      seerrUserId: watchlistRegistryAccounts.seerrUserId,
      leftAt: watchlistRegistryAccounts.leftAt,
    })
    .from(watchlistRegistryAccounts);
  const storedById = new Map(stored.map((s) => [s.plexAccountId, s] as const));
  const seerrIdFor = (id: string): number | null =>
    seerrUsers !== null
      ? (seerrByPlexId.get(id) ?? null)
      : (storedById.get(id)?.seerrUserId ?? null);

  await inTransaction(db, async (tx) => {
    for (const e of current) {
      const values = {
        class: e.cls,
        plexUuid: e.uuid,
        seerrUserId: seerrIdFor(e.plexAccountId),
        leftAt: null,
        updatedAt: at,
      };
      await tx
        .insert(watchlistRegistryAccounts)
        .values({ plexAccountId: e.plexAccountId, ...values, firstSeenAt: at })
        .onConflictDoUpdate({ target: watchlistRegistryAccounts.plexAccountId, set: values });
    }
    for (const s of stored) {
      if (currentIds.has(s.plexAccountId) || s.leftAt !== null) continue;
      // A seerr_only account is only "gone" when a successful Seerr user list no longer has it.
      if (s.class === 'seerr_only' && seerrUsers === null) continue;
      await tx
        .update(watchlistRegistryAccounts)
        .set({ leftAt: at, updatedAt: at })
        .where(eq(watchlistRegistryAccounts.plexAccountId, s.plexAccountId));
    }
    await tx
      .delete(watchlistRegistryAccounts)
      .where(
        lte(
          watchlistRegistryAccounts.leftAt,
          new Date(at.getTime() - ACCOUNT_LEFT_GRACE_H * HOUR_MS),
        ),
      );
  });

  // 4 — the owner's whole list (discover); a failed or truncated read fails the run.
  let ownerListing: PlexPagedListing<PlexSectionItem> | null = null;
  let ownerFailure: WatchlistRegistryRunFailure = 'owner';
  const ownerReaders = [roster.reader, ...input.sources.plex.filter((r) => r !== roster.reader)];
  for (const reader of ownerReaders) {
    try {
      const listing = await reader.getOwnerWatchlist();
      if (listing.truncated) {
        ownerFailure = 'owner_truncated';
        continue;
      }
      ownerListing = listing;
      break;
    } catch (error) {
      logger.warn('[watchlist-registry] owner_read_failed', {
        server: reader.label,
        errorClass: error instanceof Error ? error.name : 'error',
      });
    }
  }
  if (ownerListing === null) throw new RegistryRunFailed(ownerFailure);
  const owner = ownerItemsFromListing(ownerListing.items);
  const bySourceOutcome: Record<string, number> = {};
  const bump = (key: string) => (bySourceOutcome[key] = (bySourceOutcome[key] ?? 0) + 1);
  await inTransaction(db, async (tx) => {
    const d: SourceDecision = {
      outcome: 'ok',
      status: 'read',
      errorClass: null,
      lastOkAt: at,
      failingSince: null,
      lastOkCount: owner.items.length,
      emptyUnverified: false, // the owner's own list is authoritative (discover reports its failures)
      hiddenLoggedAt: null,
      replaceItems: owner.items,
      hiddenTransition: false,
      logHidden: false,
      becameUnreadable: false,
    };
    // The owner's list replaces even when it is empty: discover answers the owner's whole list, never a hidden one.
    await writeSource(tx, ownerId, 'discover', d, at);
    if (owner.items.length === 0) {
      await tx
        .delete(watchlistRegistryItems)
        .where(
          and(
            eq(watchlistRegistryItems.plexAccountId, ownerId),
            eq(watchlistRegistryItems.source, 'discover'),
          ),
        );
    }
    await settleAccount(tx, ownerId, at);
  });
  bump('discover:ok');

  // 5 — every other current account, sequentially, one transaction each; Seerr first (D-04).
  let accountHidden = 0;
  for (const entry of current) {
    if (entry.plexAccountId === ownerId) continue;
    const prev = await loadSourceStates(db, entry.plexAccountId);
    const seerrUserId = seerrIdFor(entry.plexAccountId);
    const answers: Array<{ source: WatchlistSource; answer: SourceAnswer }> = [];

    if (seerrUserId !== null) {
      let answer: SourceAnswer;
      if (!input.sources.seerr) answer = { kind: 'failed', errorClass: 'seerr_unconfigured' };
      else if (seerrUsers === null) answer = { kind: 'failed', errorClass: 'seerr_users' };
      else answer = fromSeerr(await input.sources.seerr.readUserWatchlist(seerrUserId));
      answers.push({ source: 'seerr', answer });
    }
    if (entry.cls === 'friend' || entry.cls === 'home_full') {
      const answer: SourceAnswer =
        entry.uuid === null
          ? { kind: 'not_applicable', errorClass: 'no_uuid' }
          : fromCommunity(await roster.reader.communityWatchlist(entry.uuid));
      answers.push({ source: 'community', answer });
    }
    if (entry.cls === 'home_managed') {
      // The Home switch is disabled until Q-01 is answered (PRD Q-15): a managed user is unresolvable, never blocking.
      answers.push({
        source: 'switch',
        answer: { kind: 'not_applicable', errorClass: 'switch_disabled' },
      });
    }
    // A stored source this account no longer reads (a Seerr link gone, a class change) keeps its items, not blocking.
    for (const [source] of prev) {
      if (!answers.some((a) => a.source === source)) {
        answers.push({ source, answer: { kind: 'not_applicable', errorClass: 'not_linked' } });
      }
    }
    const seerrOkWithTitles = answers.some(
      (a) => a.source === 'seerr' && a.answer.kind === 'titles',
    );

    const decisions = answers.map(({ source, answer }) => ({
      source,
      d: decideSource({
        source,
        prev: prev.get(source) ?? null,
        answer,
        now: at,
        seerrOkWithTitles,
      }),
    }));
    await inTransaction(db, async (tx) => {
      for (const { source, d } of decisions)
        await writeSource(tx, entry.plexAccountId, source, d, at);
      await settleAccount(tx, entry.plexAccountId, at);
    });

    const acct = accountTag(entry.plexAccountId);
    for (const { source, d } of decisions) {
      bump(`${source}:${d.outcome}`);
      if (d.hiddenTransition) accountHidden += 1;
      if (d.logHidden)
        logger.warn('[watchlist-registry] account_hidden', { class: entry.cls, source, acct });
      if (d.outcome === 'failed' && !(d.status === 'unreadable' && !d.becameUnreadable)) {
        logger.warn('[watchlist-registry] account_failed', {
          class: entry.cls,
          source,
          errorClass: d.errorClass,
          acct,
        });
      }
      if (d.becameUnreadable) {
        const since = d.failingSince ?? at;
        logger.warn('[watchlist-registry] account_unreadable', {
          class: entry.cls,
          source,
          acct,
          failingSinceH: Math.round((at.getTime() - since.getTime()) / HOUR_MS),
        });
      }
    }
  }

  // 6 — map up to 200 unmapped discover ids (D-03).
  const lookups = await mapDiscoverIds(db, roster.reader, at, sleep);

  // 7 — prune runs older than 7 days (the newest ok run is always kept, so the card can say when it last checked).
  const [newestOk] = await db
    .select({ id: watchlistRegistryRuns.id })
    .from(watchlistRegistryRuns)
    .where(eq(watchlistRegistryRuns.status, 'ok'))
    .orderBy(desc(watchlistRegistryRuns.finishedAt))
    .limit(1);
  const cutoff = new Date(at.getTime() - REGISTRY_RUN_RETENTION_DAYS * DAY_MS);
  await db
    .delete(watchlistRegistryRuns)
    .where(
      newestOk
        ? and(
            lt(watchlistRegistryRuns.startedAt, cutoff),
            sql`${watchlistRegistryRuns.id} <> ${newestOk.id}`,
          )
        : lt(watchlistRegistryRuns.startedAt, cutoff),
    );

  // 8 — the counts (never a name or a title).
  const counts = await computeCounts(db, {
    bySourceOutcome,
    accountHidden,
    ownerSkipped: owner.skipped,
    lookups,
  });

  // community_mass_empty (D-04: logged, not a run failure): community sources with titles halved against the
  // previous ok run.
  const [previous] = await db
    .select({ counts: watchlistRegistryRuns.counts })
    .from(watchlistRegistryRuns)
    .where(eq(watchlistRegistryRuns.status, 'ok'))
    .orderBy(desc(watchlistRegistryRuns.finishedAt))
    .limit(1);
  const before = Number(
    (previous?.counts as { communityWithTitles?: unknown } | undefined)?.communityWithTitles,
  );
  if (Number.isFinite(before) && before >= 2 && counts.communityWithTitles * 2 <= before) {
    logger.warn('[watchlist-registry] community_mass_empty', {
      before,
      now: counts.communityWithTitles,
    });
  }
  return counts;
}

/** D-03 — resolve up to DISCOVER_MAP_BATCH discover ids that have no external id of their own and no mapping yet. */
async function mapDiscoverIds(
  db: ReturnType<typeof resolveDb>,
  reader: WatchlistPlexReader,
  at: Date,
  sleep: (ms: number) => Promise<void>,
): Promise<{ resolved: number; notFound: number; failed: number }> {
  const retryBefore = new Date(at.getTime() - DISCOVER_NOT_FOUND_RETRY_DAYS * DAY_MS);
  const rows = await db
    .selectDistinct({
      discoverId: watchlistRegistryItems.discoverId,
      kind: watchlistRegistryItems.kind,
    })
    .from(watchlistRegistryItems)
    .leftJoin(plexDiscoverIds, eq(plexDiscoverIds.discoverId, watchlistRegistryItems.discoverId))
    .where(
      and(
        isNull(watchlistRegistryItems.tmdbId),
        isNull(watchlistRegistryItems.tvdbId),
        or(
          isNull(plexDiscoverIds.discoverId),
          and(
            isNull(plexDiscoverIds.resolvedAt),
            or(isNull(plexDiscoverIds.notFoundAt), lt(plexDiscoverIds.notFoundAt, retryBefore)),
          ),
        ),
      ),
    )
    .limit(DISCOVER_MAP_BATCH);
  const seen = new Set<string>();
  const out = { resolved: 0, notFound: 0, failed: 0 };
  for (const [i, row] of rows.entries()) {
    if (seen.has(row.discoverId)) continue;
    seen.add(row.discoverId);
    if (i > 0) await sleep(DISCOVER_MAP_SPACING_MS);
    let values: Partial<typeof plexDiscoverIds.$inferInsert>;
    try {
      const meta = await reader.discoverMetadata(row.discoverId);
      if (meta === null) {
        values = { notFoundAt: at };
        out.notFound += 1;
      } else {
        values = {
          kind: meta.kind ?? row.kind,
          tmdbId: meta.ids.tmdbId,
          tvdbId: meta.ids.tvdbId,
          imdbId: meta.ids.imdbId,
          resolvedAt: at,
          notFoundAt: null,
        };
        out.resolved += 1;
      }
    } catch {
      values = {};
      out.failed += 1;
    }
    await db
      .insert(plexDiscoverIds)
      .values({ discoverId: row.discoverId, kind: row.kind, attempts: 1, ...values })
      .onConflictDoUpdate({
        target: plexDiscoverIds.discoverId,
        set: { ...values, attempts: sql`${plexDiscoverIds.attempts} + 1` },
      });
  }
  return out;
}

async function computeCounts(
  db: ReturnType<typeof resolveDb>,
  extra: {
    bySourceOutcome: Record<string, number>;
    accountHidden: number;
    ownerSkipped: number;
    lookups: { resolved: number; notFound: number; failed: number };
  },
): Promise<WatchlistRegistryCounts> {
  const accounts = await db
    .select({
      plexAccountId: watchlistRegistryAccounts.plexAccountId,
      class: watchlistRegistryAccounts.class,
      status: watchlistRegistryAccounts.status,
      leftAt: watchlistRegistryAccounts.leftAt,
    })
    .from(watchlistRegistryAccounts);
  const sources = await db
    .select({
      plexAccountId: watchlistRegistrySources.plexAccountId,
      source: watchlistRegistrySources.source,
      status: watchlistRegistrySources.status,
      emptyUnverified: watchlistRegistrySources.emptyUnverified,
      lastOkCount: watchlistRegistrySources.lastOkCount,
      lastOutcome: watchlistRegistrySources.lastOutcome,
    })
    .from(watchlistRegistrySources);
  const sourcesByAccount = new Map<string, typeof sources>();
  for (const s of sources) {
    const list = sourcesByAccount.get(s.plexAccountId) ?? [];
    list.push(s);
    sourcesByAccount.set(s.plexAccountId, list);
  }
  const byClass: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let roster = 0;
  let left = 0;
  let accountsRead = 0;
  let emptyUnverified = 0;
  let communityWithTitles = 0;
  for (const a of accounts) {
    if (a.leftAt !== null) {
      left += 1;
      continue;
    }
    roster += 1;
    byClass[a.class] = (byClass[a.class] ?? 0) + 1;
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const own = sourcesByAccount.get(a.plexAccountId) ?? [];
    if (accountIsRead(own)) accountsRead += 1;
    for (const s of own) {
      if (s.emptyUnverified && (s.status === 'read' || s.status === 'carried'))
        emptyUnverified += 1;
      if (
        s.source === 'community' &&
        s.status === 'read' &&
        s.lastOutcome === 'ok' &&
        (s.lastOkCount ?? 0) > 0
      ) {
        communityWithTitles += 1;
      }
    }
  }
  const [items] = await db
    .select({
      entries: sql<number>`count(*)::int`,
      distinct: sql<number>`count(DISTINCT ${watchlistRegistryItems.discoverId})::int`,
    })
    .from(watchlistRegistryItems);
  const keys = await loadRegistryKeys(db, null);
  const unmapped = keys.movie.unmapped + keys.show.unmapped;
  return {
    roster,
    left,
    byClass,
    byStatus,
    bySourceOutcome: extra.bySourceOutcome,
    emptyUnverified,
    accountHidden: extra.accountHidden,
    accountsRead,
    accountsUnreadable: roster - accountsRead,
    communityWithTitles,
    ownerSkipped: extra.ownerSkipped,
    entries: items?.entries ?? 0,
    distinctTitles: items?.distinct ?? 0,
    mapped: (items?.distinct ?? 0) - unmapped,
    unmapped,
    lookups: extra.lookups,
  };
}

// ---------------------------------------------------------------------------
// The typed snapshot (D-06) and the Registry Gate (D-07)
// ---------------------------------------------------------------------------

/** One kind's registry keys: discover ids, and external ids (own or mapped). */
export interface WatchlistKindKeys {
  discover: ReadonlySet<string>;
  tmdb: ReadonlySet<number>;
  tvdb: ReadonlySet<number>;
  /** Distinct titles of this kind with no usable external id (movie: tmdb; show: tvdb), DESIGN-052 D-25. */
  unmapped: number;
}

export interface WatchlistKeys {
  movie: WatchlistKindKeys;
  show: WatchlistKindKeys;
}

/**
 * D-06 — the snapshot a Trash read evaluates watchlists against, carrying its PURPOSE. A `delete` snapshot exists only
 * when the Registry Gate verified the registry; `propose` may be unfiltered (no ok run within 24 h), and then
 * evaluates nothing; `display` is the newest ok run of any age (walls, previews).
 */
export type WatchlistSnapshot =
  | { purpose: 'delete'; verified: true; keys: WatchlistKeys; runId: string }
  | { purpose: 'propose'; filtered: boolean; keys: WatchlistKeys; runId: string | null }
  | { purpose: 'display'; keys: WatchlistKeys; runId: string };

export type DeleteWatchlistSnapshot = Extract<WatchlistSnapshot, { purpose: 'delete' }>;
export type ProposeWatchlistSnapshot = Extract<WatchlistSnapshot, { purpose: 'propose' }>;
export type DisplayWatchlistSnapshot = Extract<WatchlistSnapshot, { purpose: 'display' }>;

const emptyKindKeys = (): WatchlistKindKeys => ({
  discover: new Set(),
  tmdb: new Set(),
  tvdb: new Set(),
  unmapped: 0,
});
export const EMPTY_WATCHLIST_KEYS: WatchlistKeys = Object.freeze({
  movie: emptyKindKeys(),
  show: emptyKindKeys(),
}) as WatchlistKeys;

/**
 * Every registry item (every source and status: carried, unreadable, not_applicable and left-in-grace accounts
 * included) with its own or mapped external ids, plus — when `overlaySince` is set — the owner's live `watchlist_add`
 * Watchlist Changes made since then (D-19: a change counts at once; a `watchlist_remove` never subtracts).
 */
export async function loadRegistryKeys(
  db: DbClient | undefined,
  overlaySince: Date | null,
): Promise<WatchlistKeys> {
  const exec = resolveDb(db);
  const rows = await exec
    .select({
      discoverId: watchlistRegistryItems.discoverId,
      kind: watchlistRegistryItems.kind,
      tmdbId: sql<
        number | null
      >`coalesce(${watchlistRegistryItems.tmdbId}, ${plexDiscoverIds.tmdbId})`,
      tvdbId: sql<
        number | null
      >`coalesce(${watchlistRegistryItems.tvdbId}, ${plexDiscoverIds.tvdbId})`,
    })
    .from(watchlistRegistryItems)
    .leftJoin(plexDiscoverIds, eq(plexDiscoverIds.discoverId, watchlistRegistryItems.discoverId));
  const build = { movie: emptyMutable(), show: emptyMutable() };
  const mappedIds = { movie: new Set<string>(), show: new Set<string>() };
  const allIds = { movie: new Set<string>(), show: new Set<string>() };
  const add = (
    kind: WatchlistItemKind,
    discoverId: string | null,
    tmdb: number | null,
    tvdb: number | null,
  ) => {
    const k = build[kind];
    if (discoverId !== null) {
      k.discover.add(discoverId);
      allIds[kind].add(discoverId);
    }
    if (tmdb !== null) k.tmdb.add(Number(tmdb));
    if (tvdb !== null) k.tvdb.add(Number(tvdb));
    const mapped = kind === 'movie' ? tmdb !== null : tvdb !== null;
    if (mapped && discoverId !== null) mappedIds[kind].add(discoverId);
  };
  for (const r of rows) add(r.kind, r.discoverId, r.tmdbId, r.tvdbId);

  if (overlaySince !== null) {
    const marks = await exec
      .select({
        kind: watchMarks.kind,
        plexGuid: watchMarks.plexGuid,
        tmdbId: watchMarks.tmdbId,
        tvdbId: watchMarks.tvdbId,
      })
      .from(watchMarks)
      .where(
        and(
          eq(watchMarks.action, 'watchlist_add'),
          inArray(watchMarks.plexResult, ['written', 'pending']),
          isNull(watchMarks.revertedAt),
          gte(watchMarks.createdAt, overlaySince),
        ),
      );
    for (const m of marks) {
      const kind: WatchlistItemKind = m.kind === 'show' ? 'show' : 'movie';
      const discoverId = discoverIdFromGuid(m.plexGuid, kind);
      add(kind, discoverId, m.tmdbId, kind === 'show' ? m.tvdbId : null);
    }
  }
  const finish = (kind: WatchlistItemKind): WatchlistKindKeys => ({
    ...build[kind],
    unmapped: [...allIds[kind]].filter((id) => !mappedIds[kind].has(id)).length,
  });
  return { movie: finish('movie'), show: finish('show') };
}

function emptyMutable(): { discover: Set<string>; tmdb: Set<number>; tvdb: Set<number> } {
  return { discover: new Set(), tmdb: new Set(), tvdb: new Set() };
}

async function newestOkRun(
  db: DbClient | undefined,
): Promise<{ id: string; startedAt: Date; finishedAt: Date } | null> {
  const [run] = await resolveDb(db)
    .select({
      id: watchlistRegistryRuns.id,
      startedAt: watchlistRegistryRuns.startedAt,
      finishedAt: watchlistRegistryRuns.finishedAt,
    })
    .from(watchlistRegistryRuns)
    .where(
      and(
        eq(watchlistRegistryRuns.status, 'ok'),
        sql`${watchlistRegistryRuns.finishedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(watchlistRegistryRuns.finishedAt))
    .limit(1);
  return run && run.finishedAt
    ? { id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt }
    : null;
}

/** G3 — sources of CURRENT accounts that block: never_read, or carried with its last ok read older than 24 h. */
async function countBlockingSources(db: DbClient | undefined, now: Date): Promise<number> {
  const carryCutoff = new Date(now.getTime() - ACCOUNT_CARRY_MAX_H * HOUR_MS);
  const [row] = await resolveDb(db)
    .select({ n: sql<number>`count(*)::int` })
    .from(watchlistRegistrySources)
    .innerJoin(
      watchlistRegistryAccounts,
      eq(watchlistRegistryAccounts.plexAccountId, watchlistRegistrySources.plexAccountId),
    )
    .where(
      and(
        isNull(watchlistRegistryAccounts.leftAt),
        or(
          eq(watchlistRegistrySources.status, 'never_read'),
          and(
            eq(watchlistRegistrySources.status, 'carried'),
            or(
              isNull(watchlistRegistrySources.lastOkAt),
              lt(watchlistRegistrySources.lastOkAt, carryCutoff),
            ),
          ),
        ),
      ),
    );
  return row?.n ?? 0;
}

export interface RegistryGateInput {
  db?: DbClient;
  now?: Date;
  logger?: DomainLogger;
}

/**
 * ADR-093 C-04 / DESIGN-052 D-07 — THE Registry Gate.
 *
 * purpose `delete` (the batch sweep, the manual Expire now, Expedite item and all):
 *   G1 an ok run finished at most REGISTRY_MAX_AGE_MIN ago, else refuse `stale`;
 *   G2 (implied by `ok`) the roster was read and the owner's whole list was read;
 *   G3 no source of a current account is never_read, or carried past ACCOUNT_CARRY_MAX_H, else refuse
 *      `account_unverified`.
 *   Refusal throws WatchlistRegistryUnverifiedError; nothing may be deleted.
 * purpose `propose` (space policy, manual batch creation): never refuses — filtered with the newest ok run when it
 *   finished within PROPOSE_MAX_AGE_H, otherwise unfiltered (the sweep is where deletion is enforced).
 *
 * The snapshot is every registry item plus the owner's live `watchlist_add` changes since the run started (D-19).
 */
export async function evaluateRegistryGate<P extends 'delete' | 'propose'>(
  input: RegistryGateInput & { purpose: P },
): Promise<P extends 'delete' ? DeleteWatchlistSnapshot : ProposeWatchlistSnapshot> {
  type Out = P extends 'delete' ? DeleteWatchlistSnapshot : ProposeWatchlistSnapshot;
  return (await gateSnapshot(input)) as Out;
}

async function gateSnapshot(
  input: RegistryGateInput & { purpose: 'delete' | 'propose' },
): Promise<DeleteWatchlistSnapshot | ProposeWatchlistSnapshot> {
  const now = input.now ?? new Date();
  const logger = input.logger ?? consoleDomainLogger;
  const run = await newestOkRun(input.db);
  const ageMin =
    run === null ? null : Math.floor((now.getTime() - run.finishedAt.getTime()) / MINUTE_MS);

  if (input.purpose === 'propose') {
    const filtered =
      run !== null && now.getTime() - run.finishedAt.getTime() <= PROPOSE_MAX_AGE_H * HOUR_MS;
    logger.info('[watchlist-registry] gate', {
      purpose: 'propose',
      verified: filtered,
      reason: null,
      ageMin,
      blocking: 0,
      filtered,
    });
    if (!filtered || run === null)
      return { purpose: 'propose', filtered: false, keys: EMPTY_WATCHLIST_KEYS, runId: null };
    return {
      purpose: 'propose',
      filtered: true,
      keys: await loadRegistryKeys(input.db, run.startedAt),
      runId: run.id,
    };
  }

  let refusal: RegistryGateRefusal | null = null;
  let blocking = 0;
  if (run === null || now.getTime() - run.finishedAt.getTime() > REGISTRY_MAX_AGE_MIN * MINUTE_MS) {
    refusal = 'stale';
  } else {
    blocking = await countBlockingSources(input.db, now);
    if (blocking > 0) refusal = 'account_unverified';
  }
  logger.info('[watchlist-registry] gate', {
    purpose: 'delete',
    verified: refusal === null,
    reason: refusal,
    ageMin,
    blocking,
    filtered: refusal === null,
  });
  if (refusal !== null || run === null) {
    throw new WatchlistRegistryUnverifiedError(refusal ?? 'stale', { ageMin, blocking });
  }
  return {
    purpose: 'delete',
    verified: true,
    keys: await loadRegistryKeys(input.db, run.startedAt),
    runId: run.id,
  };
}

/** D-06 — the `display` snapshot: the newest ok run of any age (null when there has never been one). */
export async function readDisplayWatchlistSnapshot(input: {
  db?: DbClient;
}): Promise<DisplayWatchlistSnapshot | null> {
  const run = await newestOkRun(input.db);
  if (run === null) return null;
  return {
    purpose: 'display',
    keys: await loadRegistryKeys(input.db, run.startedAt),
    runId: run.id,
  };
}

// ---------------------------------------------------------------------------
// Matching one pending item (D-06)
// ---------------------------------------------------------------------------

export interface WatchlistMatchInput {
  /** The Trash media kind: movie ↔ registry `movie`, tv ↔ registry `show`. */
  media: 'movie' | 'tv';
  /** Maintainerr's `mediaData.guid`. */
  plexGuid: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
}

export interface WatchlistVerdict {
  onWatchlist: boolean;
  watchlistEvaluable: boolean;
}

/** The discover id of a pool item's `plex://movie|show/<24 hex>` guid, when its type matches the item's kind. */
export function poolDiscoverId(plexGuid: string | null, media: 'movie' | 'tv'): string | null {
  const m = /^plex:\/\/(movie|show)\/([0-9a-f]{24})$/.exec(plexGuid?.trim() ?? '');
  if (!m) return null;
  return m[1] === (media === 'movie' ? 'movie' : 'show') ? (m[2] ?? null) : null;
}

/**
 * D-06 — is this pending item on a watchlist, and can that be evaluated at all?
 * - `onWatchlist`: any of the item's keys (its discover id; a movie's tmdb id; a show's tvdb and tmdb ids) is in the
 *   registry for the item's kind.
 * - `watchlistEvaluable`: the item has a discover id, or no registry title of its kind is unmapped (so an external-id
 *   miss proves absence).
 * FAIL CLOSED: no snapshot, a `delete` snapshot that is not verified, or an unfiltered `propose` snapshot evaluates
 * nothing — every item is not evaluable, so the guardian keeps it as `unevaluable`.
 */
export function evaluateWatchlist(
  snapshot: WatchlistSnapshot | null | undefined,
  item: WatchlistMatchInput,
): WatchlistVerdict {
  const blind: WatchlistVerdict = { onWatchlist: false, watchlistEvaluable: false };
  if (!snapshot) return blind;
  if (snapshot.purpose === 'delete' && (snapshot as { verified?: unknown }).verified !== true)
    return blind;
  if (snapshot.purpose === 'propose' && !snapshot.filtered) return blind;
  const keys = item.media === 'movie' ? snapshot.keys.movie : snapshot.keys.show;
  const d = poolDiscoverId(item.plexGuid, item.media);
  const onWatchlist =
    (d !== null && keys.discover.has(d)) ||
    (item.tmdbId !== null && keys.tmdb.has(item.tmdbId)) ||
    (item.media === 'tv' && item.tvdbId !== null && keys.tvdb.has(item.tvdbId));
  return { onWatchlist, watchlistEvaluable: d !== null || keys.unmapped === 0 };
}

// ---------------------------------------------------------------------------
// The Watchlists card's read (D-10) — counts only, never a name or a title
// ---------------------------------------------------------------------------

export interface WatchlistRegistrySummary {
  /** When the newest ok refresh finished (null: never). */
  checkedAt: string | null;
  accountsRead: number;
  accountsUnreadable: number;
  byClass: Record<string, number>;
  byStatus: Record<string, number>;
  emptyUnverified: number;
  /** The newest run of any status, for "the last check failed" (null: none). */
  lastRun: { status: string; failure: string | null; finishedAt: string | null } | null;
}

export async function getWatchlistRegistrySummary(input: {
  db?: DbClient;
}): Promise<WatchlistRegistrySummary> {
  const db = resolveDb(input.db);
  const run = await newestOkRun(input.db);
  let counts: Partial<WatchlistRegistryCounts> = {};
  if (run !== null) {
    const [row] = await db
      .select({ counts: watchlistRegistryRuns.counts })
      .from(watchlistRegistryRuns)
      .where(eq(watchlistRegistryRuns.id, run.id));
    counts = (row?.counts ?? {}) as Partial<WatchlistRegistryCounts>;
  }
  const [last] = await db
    .select({
      status: watchlistRegistryRuns.status,
      failure: watchlistRegistryRuns.failure,
      finishedAt: watchlistRegistryRuns.finishedAt,
    })
    .from(watchlistRegistryRuns)
    .orderBy(desc(watchlistRegistryRuns.startedAt))
    .limit(1);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const record = (v: unknown): Record<string, number> =>
    v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, n]) => [k, num(n)]),
        )
      : {};
  return {
    checkedAt: run?.finishedAt.toISOString() ?? null,
    accountsRead: num(counts.accountsRead),
    accountsUnreadable: num(counts.accountsUnreadable),
    byClass: record(counts.byClass),
    byStatus: record(counts.byStatus),
    emptyUnverified: num(counts.emptyUnverified),
    lastRun: last
      ? {
          status: last.status,
          failure: last.failure ?? null,
          finishedAt: last.finishedAt?.toISOString() ?? null,
        }
      : null,
  };
}
