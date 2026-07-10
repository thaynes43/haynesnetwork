import { pgTable, text, integer, bigint, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * ADR-044 / DESIGN-022 (PLAN-021 — AI usage metrics) — the synced MIRROR of Open WebUI chat usage,
 * one row per OWUI chat, the substrate the Metrics → AI sub-tab reads. Populated ONLY by the
 * `ai-usage-sync` sync mode (migration 0035), which polls Open WebUI's admin API
 * (`GET /api/v1/chats/all/db` + `GET /api/v1/users/`, api-key auth — ADR-044 C-01) and UPSERTS one
 * row per chat keyed by the OWUI chat id.
 *
 * Derived, rebuildable READ-MODEL (the ADR-035 `trash_candidates` / ADR-040 `smart_drive_state`
 * class): the data of record lives in Open WebUI; this table is a re-syncable copy carrying the
 * per-chat aggregates the sub-tab needs. Written ONLY by the @hnet/domain `syncAiUsage` single-writer
 * (guard-listed), which upserts each chat's aggregates in one transaction. No per-row audit event —
 * synced usage data, not a role/permission mutation (the documented no-ledger-row exemption).
 *
 * LEVEL-GATED SURFACE (ADR-044 C-03, mirrors ADR-037): the user-identity columns
 * (`owui_user_id`/`user_name`/`user_email`/`user_role`/`title`) are surfaced ONLY to a `full`/admin
 * caller. A `limited` caller gets aggregate counts + trends only — the read model never selects the
 * identity columns into a limited payload (the user-aware-metrics gating rule).
 */
export const aiUsageChats = pgTable(
  'ai_usage_chats',
  {
    /** The OWUI chat id (`chat.id`) — the natural upsert key; stable across re-syncs. */
    owuiChatId: text('owui_chat_id').primaryKey(),
    /** The OWUI user id (`chat.user_id`) — the attribution key; surfaced only at `full`/admin. */
    owuiUserId: text('owui_user_id').notNull(),
    /** Denormalized display name from the OWUI users endpoint (admin-only surface); null if unresolved. */
    userName: text('user_name'),
    /** Denormalized email from the OWUI users endpoint (admin-only surface); null if unresolved. */
    userEmail: text('user_email'),
    /** The OWUI role of the chat owner at sync time ('admin' | 'user' | …); admin-only surface. */
    userRole: text('user_role'),
    /** The chat title (admin-only surface — may describe intent); null when OWUI has none. */
    title: text('title'),
    /** Distinct model names used in the chat (from `chat.models` + per-message `model`). */
    models: jsonb('models').$type<string[]>().notNull().default([]),
    /** The primary (most-used, else first) model — the grouping key for the "for what" breakdown. */
    primaryModel: text('primary_model'),
    /** Total messages in the chat (user + assistant turns). */
    messageCount: integer('message_count').notNull().default(0),
    /** Image generations = assistant-message file entries of type 'image' (ADR-044 image-gen heuristic). */
    imageCount: integer('image_count').notNull().default(0),
    /** Summed assistant `usage.total_tokens` across the chat (0 when OWUI reported none). */
    totalTokens: integer('total_tokens').notNull().default(0),
    /** Summed assistant `usage.total_duration` (OWUI reports ns) converted to ms — the "how long" grain. */
    totalDurationMs: bigint('total_duration_ms', { mode: 'number' }).notNull().default(0),
    /** OWUI `chat.created_at` (epoch seconds) as an instant — the trend time axis. */
    chatCreatedAt: timestamp('chat_created_at', { withTimezone: true }).notNull(),
    /** OWUI `chat.updated_at` (epoch seconds) as an instant — last-activity marker. */
    chatUpdatedAt: timestamp('chat_updated_at', { withTimezone: true }).notNull(),
    /** OWUI `chat.archived`. */
    archived: boolean('archived').notNull().default(false),
    /** When this row was last refreshed from OWUI (freshness footnote). */
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Trend bucketing reads by chat-creation day — index the time axis.
    index('ai_usage_chats_created_idx').on(t.chatCreatedAt),
    // Per-user attribution (admin/full) groups by owner — index the attribution key.
    index('ai_usage_chats_user_idx').on(t.owuiUserId),
  ],
);

export type AiUsageChatRow = typeof aiUsageChats.$inferSelect;
export type AiUsageChatInsert = typeof aiUsageChats.$inferInsert;
