// ADR-044 / DESIGN-022 (PLAN-021 — AI usage metrics) — the AI-usage vertical: a single-writer that
// UPSERTS the synced Open WebUI chat mirror (`ai_usage_chats`), and a LEVEL-GATED read model the
// Metrics → AI sub-tab renders.
//
// TWO surfaces, one table:
//   1. syncAiUsage()  — the sole writer (no-direct-state-writes guard). The `ai-usage-sync` mode fetches
//      OWUI's admin API, the @hnet/sync client normalizes each chat to an AiUsageChatInput (the image-gen
//      heuristic + duration/token sums live there — it knows OWUI's wire shape), and this writer upserts
//      one row per chat keyed by the OWUI chat id. Rebuildable read-model (data of record = Open WebUI),
//      so no per-row audit event.
//   2. getAiUsage()   — the read model, SHAPED by the caller's metrics level (ADR-044 C-03, mirrors
//      ADR-037): `limited` returns aggregate counts + a per-day trend ONLY (no user identity, no model
//      breakdown — the user-aware-metrics gating rule); `full`/admin ADDS the per-model and per-user
//      "who / how long / for what" grain. The identity columns are NEVER selected into a limited payload.
import { aiUsageChats, type DbClient, type MetricsLevel } from '@hnet/db';
import { count, desc, gte, sql, sum } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

// ---------------------------------------------------------------------------------------------------
// Ingestion (single writer)
// ---------------------------------------------------------------------------------------------------

/**
 * One OWUI chat reduced to the aggregates the mirror stores. The @hnet/sync OWUI client produces these
 * from the raw `GET /api/v1/chats/all/db` blobs (parsing + the image-gen heuristic live there).
 */
export interface AiUsageChatInput {
  owuiChatId: string;
  owuiUserId: string;
  title: string | null;
  /** Distinct model names used in the chat. */
  models: string[];
  /** The primary (most-used, else first) model — the "for what" grouping key; null if none. */
  primaryModel: string | null;
  messageCount: number;
  /** Assistant-message image-file entries (the ADR-044 image-generation heuristic). */
  imageCount: number;
  totalTokens: number;
  /** Summed assistant `usage.total_duration`, already converted ns → ms by the client. */
  totalDurationMs: number;
  chatCreatedAt: Date;
  chatUpdatedAt: Date;
  archived: boolean;
}

/** One OWUI user, from `GET /api/v1/users/` — the attribution join surfaced only at `full`/admin. */
export interface AiUsageUserInput {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
}

export interface SyncAiUsageInput {
  db?: DbClient;
  chats: AiUsageChatInput[];
  /** OWUI users, used to denormalize name/email/role onto each chat row (admin-only surface). */
  users?: AiUsageUserInput[];
  now?: Date;
}

export interface SyncAiUsageReport {
  /** Chats seen in this poll. */
  chats: number;
  /** Rows written (upserted) this poll. */
  upserted: number;
  /** Image generations across all synced chats (sum of imageCount). */
  imageGenerations: number;
  /** Chats whose owner resolved to a known OWUI user (attribution coverage). */
  usersResolved: number;
}

const AI_USAGE_UPSERT_CHUNK = 500;

/**
 * ADR-044 C-01 — the SINGLE WRITER for `ai_usage_chats` (the no-direct-state-writes guard forbids any
 * other module from touching the table). Upserts on `owui_chat_id` (ON CONFLICT DO UPDATE): a re-sync
 * REPLACES each row from the freshly-polled aggregates so the mirror tracks Open WebUI (an edited/extended
 * chat updates in place; `synced_at` advances every write — the freshness key). READ-ONLY against OWUI:
 * this writer never calls OWUI, it only persists what the poll already fetched. No per-row audit event —
 * synced usage data, not a role/permission mutation (the documented exemption, like media_metadata).
 */
export async function syncAiUsage(input: SyncAiUsageInput): Promise<SyncAiUsageReport> {
  const now = input.now ?? new Date();
  const userById = new Map((input.users ?? []).map((u) => [u.id, u]));
  let usersResolved = 0;

  const values = input.chats.map((c) => {
    const user = userById.get(c.owuiUserId);
    if (user) usersResolved += 1;
    return {
      owuiChatId: c.owuiChatId,
      owuiUserId: c.owuiUserId,
      userName: user?.name ?? null,
      userEmail: user?.email ?? null,
      userRole: user?.role ?? null,
      title: c.title,
      models: c.models,
      primaryModel: c.primaryModel,
      messageCount: c.messageCount,
      imageCount: c.imageCount,
      totalTokens: c.totalTokens,
      totalDurationMs: c.totalDurationMs,
      chatCreatedAt: c.chatCreatedAt,
      chatUpdatedAt: c.chatUpdatedAt,
      archived: c.archived,
      syncedAt: now,
    };
  });

  if (values.length > 0) {
    await inTransaction(input.db, async (tx) => {
      for (let i = 0; i < values.length; i += AI_USAGE_UPSERT_CHUNK) {
        const chunk = values.slice(i, i + AI_USAGE_UPSERT_CHUNK);
        await tx
          .insert(aiUsageChats)
          .values(chunk)
          .onConflictDoUpdate({
            target: aiUsageChats.owuiChatId,
            // Full replace from the just-polled row (excluded.*) — the synced-copy semantics.
            set: {
              owuiUserId: sql`excluded.owui_user_id`,
              userName: sql`excluded.user_name`,
              userEmail: sql`excluded.user_email`,
              userRole: sql`excluded.user_role`,
              title: sql`excluded.title`,
              models: sql`excluded.models`,
              primaryModel: sql`excluded.primary_model`,
              messageCount: sql`excluded.message_count`,
              imageCount: sql`excluded.image_count`,
              totalTokens: sql`excluded.total_tokens`,
              totalDurationMs: sql`excluded.total_duration_ms`,
              chatCreatedAt: sql`excluded.chat_created_at`,
              chatUpdatedAt: sql`excluded.chat_updated_at`,
              archived: sql`excluded.archived`,
              syncedAt: sql`excluded.synced_at`,
            },
          });
      }
    });
  }

  return {
    chats: input.chats.length,
    upserted: values.length,
    imageGenerations: input.chats.reduce((n, c) => n + c.imageCount, 0),
    usersResolved,
  };
}

// ---------------------------------------------------------------------------------------------------
// Read model (level-gated)
// ---------------------------------------------------------------------------------------------------

/** The trailing windows the AI usage report supports (matching the reclaim report idiom). */
export const AI_USAGE_RANGES = ['7d', '30d', '90d', 'all'] as const;
export type AiUsageRange = (typeof AI_USAGE_RANGES)[number];

const RANGE_DAYS: Record<Exclude<AiUsageRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** Resolve a range to its inclusive lower-bound instant (null ⇒ all time). */
export function aiUsageRangeSince(range: AiUsageRange, now: Date = new Date()): Date | null {
  if (range === 'all') return null;
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - RANGE_DAYS[range]);
  return since;
}

/** A point on the per-day usage trend (both levels). */
export interface AiUsageSeriesPoint {
  day: string; // YYYY-MM-DD (UTC)
  chats: number;
  imageGenerations: number;
}

/** FULL-only — one primary-model's usage ("for what"). */
export interface AiUsageModelBreakdown {
  model: string;
  chats: number;
  imageGenerations: number;
  messages: number;
}

/** FULL-only — one user's usage ("who / how long / for what"). */
export interface AiUsageUserBreakdown {
  userId: string;
  name: string | null;
  email: string | null;
  role: string | null;
  chats: number;
  imageGenerations: number;
  messages: number;
  totalDurationMs: number;
  models: string[];
  lastActivityAt: string; // ISO-8601
}

export interface AiUsageMetrics {
  level: MetricsLevel;
  range: AiUsageRange;
  since: string | null; // ISO-8601 lower bound, null for 'all'
  /** Newest `synced_at` across the mirror (freshness footnote); null when the mirror is empty. */
  syncedAt: string | null;
  totals: {
    chats: number;
    imageGenerations: number;
    messages: number;
    /** FULL-only: distinct users who chatted in the window. Null (omitted) at `limited` — no identity. */
    activeUsers: number | null;
  };
  series: AiUsageSeriesPoint[];
  /** FULL/admin only (ADR-044 C-03) — the primary-model breakdown. OMITTED entirely at `limited`. */
  byModel?: AiUsageModelBreakdown[];
  /** FULL/admin only (ADR-044 C-03) — the per-user attribution. OMITTED entirely at `limited`. */
  byUser?: AiUsageUserBreakdown[];
}

const numify = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * ADR-044 C-03 — the AI usage report over a window, SHAPED by the caller's metrics level. Both levels
 * get `totals` (chats + image generations + messages) and the per-day `series` trend. `full` ADDS
 * `byModel` (the "for what") and `byUser` (the "who / how long"), and populates `totals.activeUsers`.
 * A `limited` caller's payload NEVER carries a user id/name/email or a model breakdown — the identity
 * columns are not selected into that branch. Reads only — never writes.
 */
export async function getAiUsage(input: {
  db?: DbClient;
  level: MetricsLevel;
  range?: AiUsageRange;
  now?: Date;
}): Promise<AiUsageMetrics> {
  const executor = resolveDb(input.db);
  const range = input.range ?? '30d';
  const since = aiUsageRangeSince(range, input.now);
  const sinceIso = since ? since.toISOString() : null;
  const windowFilter = since ? gte(aiUsageChats.chatCreatedAt, since) : undefined;

  // Totals (both levels) — chats, image generations, messages.
  const [totalsRow] = await executor
    .select({
      chats: count(),
      imageGenerations: sum(aiUsageChats.imageCount),
      messages: sum(aiUsageChats.messageCount),
    })
    .from(aiUsageChats)
    .where(windowFilter);

  // Per-day trend (both levels), bucketed by chat-creation day (UTC).
  const dayExpr = sql<string>`to_char((${aiUsageChats.chatCreatedAt} at time zone 'UTC')::date, 'YYYY-MM-DD')`;
  const seriesRows = await executor
    .select({
      day: dayExpr,
      chats: count(),
      imageGenerations: sum(aiUsageChats.imageCount),
    })
    .from(aiUsageChats)
    .where(windowFilter)
    .groupBy(dayExpr)
    .orderBy(dayExpr);

  // Freshness footnote — the newest synced_at across the mirror (window-independent).
  const [freshRow] = await executor
    .select({ syncedAt: sql<string | null>`max(${aiUsageChats.syncedAt})` })
    .from(aiUsageChats);

  const metrics: AiUsageMetrics = {
    level: input.level,
    range,
    since: sinceIso,
    syncedAt: freshRow?.syncedAt ? new Date(freshRow.syncedAt).toISOString() : null,
    totals: {
      chats: numify(totalsRow?.chats),
      imageGenerations: numify(totalsRow?.imageGenerations),
      messages: numify(totalsRow?.messages),
      activeUsers: null, // populated for `full` below; stays null (omitted) at `limited` — no identity
    },
    series: seriesRows.map((r) => ({
      day: r.day,
      chats: numify(r.chats),
      imageGenerations: numify(r.imageGenerations),
    })),
  };

  // `limited` stops here — no user identity, no model breakdown (the user-aware-metrics gating rule).
  if (input.level !== 'full') return metrics;

  // FULL/admin — the "for what" (primary-model) breakdown.
  const modelExpr = sql<string>`coalesce(${aiUsageChats.primaryModel}, 'unknown')`;
  const modelRows = await executor
    .select({
      model: modelExpr,
      chats: count(),
      imageGenerations: sum(aiUsageChats.imageCount),
      messages: sum(aiUsageChats.messageCount),
    })
    .from(aiUsageChats)
    .where(windowFilter)
    .groupBy(modelExpr)
    .orderBy(desc(count()));

  // FULL/admin — the "who / how long" per-user attribution (same window as the totals).
  const userRows = await executor
    .select({
      userId: aiUsageChats.owuiUserId,
      name: sql<string | null>`max(${aiUsageChats.userName})`,
      email: sql<string | null>`max(${aiUsageChats.userEmail})`,
      role: sql<string | null>`max(${aiUsageChats.userRole})`,
      chats: count(),
      imageGenerations: sum(aiUsageChats.imageCount),
      messages: sum(aiUsageChats.messageCount),
      totalDurationMs: sum(aiUsageChats.totalDurationMs),
      models: sql<string[]>`array_agg(distinct coalesce(${aiUsageChats.primaryModel}, 'unknown'))`,
      lastActivityAt: sql<string>`max(${aiUsageChats.chatUpdatedAt})`,
    })
    .from(aiUsageChats)
    .where(windowFilter)
    .groupBy(aiUsageChats.owuiUserId)
    .orderBy(desc(count()));

  metrics.totals.activeUsers = userRows.length;
  metrics.byModel = modelRows.map((r) => ({
    model: r.model,
    chats: numify(r.chats),
    imageGenerations: numify(r.imageGenerations),
    messages: numify(r.messages),
  }));
  metrics.byUser = userRows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    role: r.role,
    chats: numify(r.chats),
    imageGenerations: numify(r.imageGenerations),
    messages: numify(r.messages),
    totalDurationMs: numify(r.totalDurationMs),
    models: (r.models ?? []).filter((m): m is string => typeof m === 'string').sort(),
    lastActivityAt: new Date(r.lastActivityAt).toISOString(),
  }));

  return metrics;
}
