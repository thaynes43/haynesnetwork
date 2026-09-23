// ADR-087 / DESIGN-049 D-05, D-10, D-11, D-13..D-15, D-20, D-21 — what each watch tool answers: read
// (@hnet/watch queries), revalidate (D-11) or write (the @hnet/domain flows), then format (@hnet/watch).
// Every answer is plain spoken text; problems a person can act on (not found, ambiguous, nothing
// unfinished) are ordinary answers, never errors.
import type { DbClient, WatchTitleRow } from '@hnet/db';
import {
  dismissTitle,
  markWatched,
  resolveWatchTitle,
  revalidateTitles,
  undoLastChange,
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
  formatRecentHistory,
  formatRecommendations,
  formatUndoResult,
  formatUnfinished,
  formatWatchStatus,
  indexMarks,
  recentEntries,
  recommendations,
  selectLedgerHolders,
  selectLiveMarks,
  selectRecentEvents,
  selectRecommendInputs,
  selectTitleRows,
  selectTitleRowsByIdentity,
  selectUnfinishedRows,
  unfinishedItems,
  watchStatusView,
  type UnfinishedRow,
  type WatchOwner,
} from '@hnet/watch';
import type { z } from 'zod';
import type { McpConsumer } from './auth';
import type {
  dismissInput,
  markWatchedInput,
  recentHistoryInput,
  recommendInput,
  unfinishedInput,
  watchStatusInput,
} from './tools';

/** What the handlers run against (tests inject fakes; production builds these from env — deps.ts). */
export interface McpDeps {
  db: DbClient;
  /** Live revalidation reads (D-11: 300 ms per request); null when Plex is not configured. */
  revalidatePlex: () => WatchPlexReaders | null;
  /** Watch Mark reads and writes (≈ 800 ms per attempt, D-14's 3 s); null when Plex is not configured. */
  markPlex: () => WatchPlexClients | null;
  /** The resolver's last resort (D-13); null when TMDB is not configured. */
  tmdb: () => WatchTmdbSearch | null;
  now: () => Date;
  /** One log line (D-06: never arguments or results). */
  log: (line: string) => void;
  /** Revalidation budget (D-11: 400 ms). */
  revalidateBudgetMs?: number;
}

export interface AnswerContext {
  deps: McpDeps;
  owner: WatchOwner;
  consumer: McpConsumer;
  /** Where the time went (D-06 `slow_call`). */
  phases: WatchPhases;
  /** Set when D-11 ran out of budget (logged as `revalidate_timeout`). */
  revalidateTimedOut?: boolean;
}

const NO_PLEX: WatchPlexClients = { read: {}, write: {} };
const nowSec = (ctx: AnswerContext) => Math.floor(ctx.deps.now().getTime() / 1000);

/** D-11 for the titles about to be reported; the fresh rows by id (none when Plex is not configured). */
async function revalidate(ctx: AnswerContext, rows: readonly WatchTitleRow[]): Promise<Map<number, WatchTitleRow>> {
  const plex = ctx.deps.revalidatePlex();
  const out = new Map<number, WatchTitleRow>();
  if (!plex || rows.length === 0) return out;
  const started = Date.now();
  const result = await revalidateTitles({
    db: ctx.deps.db,
    plex,
    plexAccountId: ctx.owner.plexAccountId,
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
  if (ids.length === 0 || !ctx.deps.revalidatePlex()) return new Map();
  const started = Date.now();
  const out = await revalidate(ctx, await selectTitleRows(ctx.deps.db, ctx.owner.plexAccountId, { ids }));
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
    selectUnfinishedRows(ctx.deps.db, ctx.owner.plexAccountId, { kind }),
    selectLiveMarks(ctx.deps.db, ctx.owner.plexAccountId),
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
  const inputs = await selectRecommendInputs(ctx.deps.db, ctx.owner.plexAccountId, { kind, genre, kids });
  const recs = recommendations(inputs, inputs.marks, { kind, genre, kids, now: nowSec(ctx) });
  return formatRecommendations(recs, {
    limit: args.limit ?? 5,
    offset: args.offset ?? 0,
    genre,
    kids,
    kind,
  });
}

/** `watch_status` (D-13, D-21): resolve, revalidate the title (D-11), answer. */
export async function answerWatchStatus(
  ctx: AnswerContext,
  args: z.infer<typeof watchStatusInput>,
): Promise<string> {
  const started = Date.now();
  const r = await resolveWatchTitle({
    db: ctx.deps.db,
    plexAccountId: ctx.owner.plexAccountId,
    query: args.title,
    kind: args.kind ?? null,
    tmdb: ctx.deps.tmdb(),
  });
  ctx.phases.resolve = Date.now() - started;
  if (r.status === 'ambiguous') return formatAmbiguous(args.title, r.options);
  if (r.status === 'not_found') return formatNotFound(args.title, { kind: args.kind ?? null });
  const ids = { kind: r.kind, title: r.title, year: r.year, titleKey: r.titleKey, ...r.ids };
  const [rows, marks, holders] = await Promise.all([
    selectTitleRowsByIdentity(ctx.deps.db, ctx.owner.plexAccountId, ids),
    selectLiveMarks(ctx.deps.db, ctx.owner.plexAccountId),
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
  });
  return formatWatchStatus(view, { now: nowSec(ctx) });
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
    selectRecentEvents(ctx.deps.db, ctx.owner.plexAccountId, since),
    selectLiveMarks(ctx.deps.db, ctx.owner.plexAccountId),
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
    actor: { plexAccountId: ctx.owner.plexAccountId, appUserId: ctx.owner.appUserId },
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
    actor: { plexAccountId: ctx.owner.plexAccountId, appUserId: ctx.owner.appUserId },
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

/** `undo_last_change` (D-15). */
export async function answerUndo(ctx: AnswerContext): Promise<string> {
  const out = await undoLastChange({
    db: ctx.deps.db,
    plex: ctx.deps.markPlex() ?? NO_PLEX,
    actor: { plexAccountId: ctx.owner.plexAccountId, appUserId: ctx.owner.appUserId },
    now: ctx.deps.now(),
    phases: ctx.phases,
  });
  return out.status === 'done' ? formatUndoResult(out.view) : formatUndoResult({ undone: false });
}
