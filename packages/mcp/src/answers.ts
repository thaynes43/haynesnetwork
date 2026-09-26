// ADR-087 / DESIGN-049 D-05, D-10, D-11, D-13..D-15, D-20, D-21 (+ ADR-092 / DESIGN-051 D-02..D-05, the
// watchlist) — what each watch tool answers: read
// (@hnet/watch queries), revalidate (D-11) or write (the @hnet/domain flows), then format (@hnet/watch).
// Every answer is plain spoken text; problems a person can act on (not found, ambiguous, nothing
// unfinished) are ordinary answers, never errors.
import type { DbClient, WatchTitleRow } from '@hnet/db';
import {
  changeWatchlist,
  dismissTitle,
  markWatched,
  resolveWatchTitle,
  revalidateTitles,
  undoLastChange,
  type WatchDiscoverReaders,
  type WatchlistChangeResult,
  type WatchPhases,
  type WatchPlexClients,
  type WatchPlexReaders,
  type WatchTmdbSearch,
} from '@hnet/domain';
import {
  formatAmbiguous,
  formatDismissResult,
  formatMarkResult,
  formatNeedSeason,
  formatNotFound,
  formatNotOnWatchlist,
  formatRecentHistory,
  formatRecommendations,
  formatUndoResult,
  formatUnfinished,
  formatWatchlist,
  formatWatchlistChange,
  formatWatchlistDuplicates,
  formatWatchlistIndistinct,
  formatWatchlistNotSetUp,
  formatWatchStatus,
  indexMarks,
  recentEntries,
  recommendations,
  selectLedgerHolders,
  selectLiveMarks,
  selectRecentEvents,
  selectRecommendInputs,
  selectTitleFacts,
  selectTitleRows,
  selectTitleRowsByIdentity,
  selectUnfinishedRows,
  selectWatchlist,
  unfinishedItems,
  watchlistItems,
  watchStatusView,
  type UnfinishedRow,
  type WatchOwner,
} from '@hnet/watch';
import type { z } from 'zod';
import type { McpConsumer } from './auth';
import type { WatchlistChangedLog } from './log';
import type {
  dismissInput,
  markWatchedInput,
  recentHistoryInput,
  recommendInput,
  setWatchlistInput,
  unfinishedInput,
  watchlistInput,
  watchStatusInput,
} from './tools';

/** What the handlers run against (tests inject fakes; production builds these from env — deps.ts). */
export interface McpDeps {
  db: DbClient;
  /**
   * Live reads on the short budget (D-11: 300 ms per request): the revalidation, and the live `userState` read before
   * a Watchlist Change (DESIGN-051 D-03, D-13); null when Plex is not configured.
   */
  revalidatePlex: () => WatchPlexReaders | null;
  /** Watch Mark reads and writes (≈ 800 ms per attempt, D-14's 3 s); null when Plex is not configured. */
  markPlex: () => WatchPlexClients | null;
  /**
   * The plex.tv discover reads a Watchlist Change must not cut short, on their own budget (DESIGN-051 D-15ab: one
   * attempt of about 1.5 s): the catalog lookup and the `userState` re-read after a failed PUT. Absent ⇒ `markPlex`.
   */
  discoverPlex?: () => WatchDiscoverReaders | null;
  /** The resolver's last resort (D-13); null when TMDB is not configured. */
  tmdb: () => WatchTmdbSearch | null;
  /**
   * The same search with a SINGLE attempt: `set_watchlist`'s only one (DESIGN-051 D-15g: its worst case stays inside
   * the 9 s deadline), and every other tool's for a TMDB call made while the pool already has an answer (D-15aa: a
   * named year the pool's title does not have), which `mark_watched`'s Plex work follows. Absent ⇒ `tmdb`.
   */
  tmdbOnce?: () => WatchTmdbSearch | null;
  now: () => Date;
  /** One log line (D-06: never arguments or results). */
  log: (line: string) => void;
  /** Revalidation budget (D-11: 400 ms). */
  revalidateBudgetMs?: number;
}

/**
 * The watch account a call acts for (ADR-091 C-04 / DESIGN-050 D-07): the Server Owner for the hop; the token
 * user's own tracked account for a connector. `appUserId` is the acting app user (mark attribution). Only the
 * owner's account is revalidated live and written to Plex — both use the owner's server tokens.
 */
export interface WatchPrincipal extends WatchOwner {
  isOwner: boolean;
}

export interface AnswerContext {
  deps: McpDeps;
  account: WatchPrincipal;
  consumer: McpConsumer;
  /** Where the time went (D-06 `slow_call`). */
  phases: WatchPhases;
  /** Set when D-11 ran out of budget (logged as `revalidate_timeout`). */
  revalidateTimedOut?: boolean;
  /** Set by `set_watchlist` (logged as `watchlist_changed`, DESIGN-051 D-10). */
  watchlistChanged?: WatchlistChangedLog;
}

const NO_PLEX: WatchPlexClients = { read: {}, write: {} };
const nowSec = (ctx: AnswerContext) => Math.floor(ctx.deps.now().getTime() / 1000);

/** D-11 for the titles about to be reported; the fresh rows by id (none when Plex is not configured). */
async function revalidate(ctx: AnswerContext, rows: readonly WatchTitleRow[]): Promise<Map<number, WatchTitleRow>> {
  const out = new Map<number, WatchTitleRow>();
  // Live revalidation reads Plex with the OWNER's tokens, so it describes the owner's state only (ADR-091 C-04).
  if (!ctx.account.isOwner) return out;
  const plex = ctx.deps.revalidatePlex();
  if (!plex || rows.length === 0) return out;
  const started = Date.now();
  const result = await revalidateTitles({
    db: ctx.deps.db,
    plex,
    plexAccountId: ctx.account.plexAccountId,
    rows,
    ...(ctx.deps.revalidateBudgetMs !== undefined ? { budgetMs: ctx.deps.revalidateBudgetMs } : {}),
    now: ctx.deps.now(),
  });
  ctx.phases.revalidate = Date.now() - started;
  if (result.timedOut) ctx.revalidateTimedOut = true;
  for (const r of result.rows) out.set(r.id, r);
  return out;
}

/**
 * {@link revalidate} by row id: the whole rows (episode map, Plex counters, `on_plex`) are loaded only for
 * the titles being revalidated, and only when Plex is configured. The load counts toward the phase.
 */
async function revalidateIds(ctx: AnswerContext, ids: readonly number[]): Promise<Map<number, WatchTitleRow>> {
  if (ids.length === 0 || !ctx.account.isOwner || !ctx.deps.revalidatePlex()) return new Map();
  const started = Date.now();
  const out = await revalidate(ctx, await selectTitleRows(ctx.deps.db, ctx.account.plexAccountId, { ids }));
  ctx.phases.revalidate = Date.now() - started;
  return out;
}

/**
 * `unfinished` (D-05, T-245): the snapshot (narrow candidate rows), the reported titles revalidated live
 * (D-11, whole rows loaded for those only), then formatted.
 */
export async function answerUnfinished(
  ctx: AnswerContext,
  args: z.infer<typeof unfinishedInput>,
): Promise<string> {
  const kind = args.kind ?? 'show';
  const limit = args.limit ?? 5;
  const kids = args.kids ?? false;
  const now = nowSec(ctx);
  const [rows, marks] = await Promise.all([
    selectUnfinishedRows(ctx.deps.db, ctx.account.plexAccountId, { kind }),
    selectLiveMarks(ctx.deps.db, ctx.account.plexAccountId),
  ]);
  const index = indexMarks(marks);
  const first = unfinishedItems(rows, index, { kind, kids, now });
  const fresh = await revalidateIds(
    ctx,
    first.slice(0, limit).map((u) => u.row.id),
  );
  const items = unfinishedItems(
    rows.map((r): UnfinishedRow => fresh.get(r.id) ?? r),
    index,
    { kind, kids, now },
  ).map((u) => u.item);
  return formatUnfinished(items, { now, limit, kind });
}

/** `recommend` (D-16..D-20): no revalidation (ever-watched moves slowly; marks write through). */
export async function answerRecommend(
  ctx: AnswerContext,
  args: z.infer<typeof recommendInput>,
): Promise<string> {
  const kind = args.kind ?? 'any';
  const kids = args.kids ?? false;
  const genre = args.genre ?? null;
  // The live marks come with the inputs: the library query was anti-joined on these very rows.
  const inputs = await selectRecommendInputs(ctx.deps.db, ctx.account.plexAccountId, {
    now: ctx.deps.now(),
    kind,
    genre,
    kids,
  });
  const recs = recommendations(inputs, inputs.marks, { kind, genre, kids, now: nowSec(ctx) });
  return formatRecommendations(recs, {
    limit: args.limit ?? 5,
    offset: args.offset ?? 0,
    genre,
    kids,
    kind,
  });
}

/**
 * `watch_status` (D-13, D-21): resolve, revalidate the title (D-11), answer — with DESIGN-051 D-02's availability
 * sentence: on the owner's watchlist when the resolver's matched entries include an overlaid watchlist entry
 * (DESIGN-051 D-02). A principal that is not the Server Owner keeps DESIGN-049's sentence.
 */
export async function answerWatchStatus(
  ctx: AnswerContext,
  args: z.infer<typeof watchStatusInput>,
): Promise<string> {
  const started = Date.now();
  const r = await resolveWatchTitle({
    db: ctx.deps.db,
    plexAccountId: ctx.account.plexAccountId,
    query: args.title,
    kind: args.kind ?? null,
    tmdb: ctx.deps.tmdb(),
    tmdbOnce: ctx.deps.tmdbOnce?.() ?? null,
    now: ctx.deps.now(),
  });
  ctx.phases.resolve = Date.now() - started;
  if (r.status === 'ambiguous') return formatAmbiguous(args.title, r.options);
  if (r.status === 'not_found') return formatNotFound(args.title, { kind: args.kind ?? null });
  const ids = { kind: r.kind, title: r.title, year: r.year, titleKey: r.titleKey, ...r.ids };
  const [rows, marks, holders] = await Promise.all([
    selectTitleRowsByIdentity(ctx.deps.db, ctx.account.plexAccountId, ids),
    selectLiveMarks(ctx.deps.db, ctx.account.plexAccountId),
    selectLedgerHolders(ctx.deps.db, r.mediaItemIds),
  ]);
  let row = rows[0] ?? null;
  if (row) row = (await revalidate(ctx, [row])).get(row.id) ?? row;
  const view = watchStatusView({
    title: ids,
    row,
    marks: indexMarks(marks),
    onPlexElsewhere: holders.length > 0,
    now: nowSec(ctx),
    onWatchlist: ctx.account.isOwner ? r.members.some((m) => m.source === 'watchlist') : null,
  });
  return formatWatchStatus(view, { now: nowSec(ctx) });
}

/**
 * `watchlist` (DESIGN-051 D-02 / D-05): the overlaid watchlist of the asked kind, newest first; the page's titles
 * with the D-02 "on Plex" rule and started / watched from the owner's Title States. The watchlist is the Server
 * Owner's only (ADR-092 C-04): anyone else is told it isn't set up for their account.
 */
export async function answerWatchlist(
  ctx: AnswerContext,
  args: z.infer<typeof watchlistInput>,
): Promise<string> {
  if (!ctx.account.isOwner) return formatWatchlistNotSetUp();
  const kind = args.kind ?? 'any';
  const limit = args.limit ?? 5;
  const offset = args.offset ?? 0;
  const acct = ctx.account.plexAccountId;
  const { entries } = await selectWatchlist(ctx.deps.db, acct, { now: ctx.deps.now() });
  const list = kind === 'any' ? entries : entries.filter((e) => e.kind === kind);
  const page = list.slice(offset, offset + limit);
  const [facts, marks] = await Promise.all([
    selectTitleFacts(ctx.deps.db, acct, page),
    selectLiveMarks(ctx.deps.db, acct),
  ]);
  const items = watchlistItems(page, facts, indexMarks(marks), nowSec(ctx));
  return formatWatchlist(items, { total: list.length, offset, kind });
}

/**
 * `set_watchlist` (DESIGN-051 D-03): the domain flow resolves, confirms, writes and records; this formats what it
 * returns and leaves the D-10 line for the runner to log (once, with the call's `tool_called` line).
 */
export async function answerSetWatchlist(
  ctx: AnswerContext,
  args: z.infer<typeof setWatchlistInput>,
): Promise<string> {
  const out = await changeWatchlist({
    db: ctx.deps.db,
    plex: ctx.deps.markPlex() ?? NO_PLEX,
    reads: ctx.deps.revalidatePlex(),
    discover: ctx.deps.discoverPlex?.() ?? null,
    tmdb: (ctx.deps.tmdbOnce ?? ctx.deps.tmdb)(),
    actor: { plexAccountId: ctx.account.plexAccountId, appUserId: ctx.account.appUserId },
    consumer: ctx.consumer.name,
    query: args.title,
    action: args.action,
    kind: args.kind ?? null,
    now: ctx.deps.now(),
    phases: ctx.phases,
  });
  const result: WatchlistChangeResult = out.result;
  ctx.watchlistChanged = {
    consumer: ctx.consumer.name,
    action: args.action,
    kind: out.status === 'done' ? out.kind : (args.kind ?? null),
    result,
    onPlex: out.status === 'done' ? out.onPlex : null,
  };
  switch (out.status) {
    case 'not_owner':
      return formatWatchlistNotSetUp();
    case 'ambiguous':
      return formatAmbiguous(args.title, out.options);
    case 'duplicate':
      // DESIGN-051 D-15l: never a question — no argument of set_watchlist can pick one of these titles.
      return formatWatchlistDuplicates(out.options);
    case 'indistinct':
      // DESIGN-051 D-15w: TMDB lists titles that read the same; no argument of set_watchlist can pick one either.
      return formatWatchlistIndistinct(out.options);
    case 'not_found':
      return args.action === 'remove'
        ? formatNotOnWatchlist(args.title, { kind: args.kind ?? null })
        : formatNotFound(args.title, { kind: args.kind ?? null });
    default:
      return formatWatchlistChange(out.view);
  }
}

/** `recent_history` (D-21): the event log of the last `days` days. */
export async function answerRecentHistory(
  ctx: AnswerContext,
  args: z.infer<typeof recentHistoryInput>,
): Promise<string> {
  const days = args.days ?? 14;
  const now = nowSec(ctx);
  const since = new Date((now - days * 86_400) * 1000);
  const [events, marks] = await Promise.all([
    selectRecentEvents(ctx.deps.db, ctx.account.plexAccountId, since),
    selectLiveMarks(ctx.deps.db, ctx.account.plexAccountId),
  ]);
  return formatRecentHistory(recentEntries(events, indexMarks(marks)), {
    now,
    days,
    limit: args.limit ?? 8,
  });
}

/** `mark_watched` (D-14): the domain flow writes; this only formats what it returns. */
export async function answerMarkWatched(
  ctx: AnswerContext,
  args: z.infer<typeof markWatchedInput>,
): Promise<string> {
  const out = await markWatched({
    db: ctx.deps.db,
    plex: ctx.deps.markPlex() ?? NO_PLEX,
    tmdb: ctx.deps.tmdb(),
    // DESIGN-051 D-15aa: a TMDB call made with the pool's answer in hand is one attempt, since Plex work follows.
    tmdbOnce: ctx.deps.tmdbOnce?.() ?? null,
    actor: { plexAccountId: ctx.account.plexAccountId, appUserId: ctx.account.appUserId },
    consumer: ctx.consumer.name,
    query: args.title,
    kind: args.kind ?? null,
    season: args.season ?? null,
    episode: args.episode ?? null,
    through: args.through ?? null,
    now: ctx.deps.now(),
    phases: ctx.phases,
  });
  switch (out.status) {
    case 'ambiguous':
      return formatAmbiguous(args.title, out.options);
    case 'not_found':
      return formatNotFound(args.title, { kind: args.kind ?? null });
    case 'need_season':
      return formatNeedSeason(args.title, args.episode ?? null);
    default:
      return formatMarkResult(out.view);
  }
}

/** `dismiss` (D-15): never touches Plex (the flow takes no Plex client at all). */
export async function answerDismiss(
  ctx: AnswerContext,
  args: z.infer<typeof dismissInput>,
): Promise<string> {
  const out = await dismissTitle({
    db: ctx.deps.db,
    tmdb: ctx.deps.tmdb(),
    tmdbOnce: ctx.deps.tmdbOnce?.() ?? null,
    actor: { plexAccountId: ctx.account.plexAccountId, appUserId: ctx.account.appUserId },
    consumer: ctx.consumer.name,
    query: args.title,
    reason: args.reason ?? 'not_interested',
    now: ctx.deps.now(),
    phases: ctx.phases,
  });
  if (out.status === 'ambiguous') return formatAmbiguous(args.title, out.options);
  if (out.status === 'done') return formatDismissResult(out.view);
  return formatNotFound(args.title);
}

/** `undo_last_change` (D-15; a Watchlist Change: DESIGN-051 D-04). */
export async function answerUndo(ctx: AnswerContext): Promise<string> {
  const out = await undoLastChange({
    db: ctx.deps.db,
    plex: ctx.deps.markPlex() ?? NO_PLEX,
    reads: ctx.deps.revalidatePlex(),
    discover: ctx.deps.discoverPlex?.() ?? null,
    actor: { plexAccountId: ctx.account.plexAccountId, appUserId: ctx.account.appUserId },
    now: ctx.deps.now(),
    phases: ctx.phases,
  });
  return out.status === 'done' ? formatUndoResult(out.view) : formatUndoResult({ undone: false });
}
