// ADR-034 / DESIGN-015 (PLAN-016) — the transactional OUTBOX single-writer (enqueue) + the Pushover
// DRAINER (deliver). Batch writers call `enqueueOutbox(tx, …)` in the SAME transaction as their state
// transition, so a push is neither lost nor phantom (ADR-034 C-01). The `notify-outbox` sync mode calls
// `deliverOutbox` to send DUE rows to Pushover; it no-ops cleanly when `PUSHOVER_*` env is absent
// (disabled-safe — C-03). DISTINCT from `notifications` (ADR-026 — that is the inbound in-app feed).
import {
  notificationOutbox,
  type DbClient,
  type NotifyOutboxChannel,
  type NotifyOutboxEventType,
  type NotificationOutboxRow,
} from '@hnet/db';
import { and, asc, eq, isNull, lt, lte } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { getNotifyWindow } from './notify-window';

// ---------------------------------------------------------------------------
// Enqueue — the same-tx single writer
// ---------------------------------------------------------------------------

/** The minimal executor `enqueueOutbox` needs (the tx handed to a batch writer's inTransaction). */
export interface OutboxInsertExecutor {
  insert: DbClient['insert'];
}

export interface EnqueueOutboxInput {
  eventType: NotifyOutboxEventType;
  channel?: NotifyOutboxChannel;
  /** The structured facts the sender renders from (batchId/mediaKind/counts/expiresAt). */
  payload: Record<string, unknown>;
  /** The delivery-window-computed earliest instant this row may be sent (T-101). */
  earliestSendAt: Date;
}

/**
 * Enqueue one outbox row on the passed executor (a transaction — so it commits with the transition it
 * accompanies). A pure INSERT: the window read + `earliestSendAt` computation happen in the caller
 * BEFORE the transaction opens (a stale-by-seconds window read is harmless), keeping this write atomic
 * with the batch transition.
 */
export async function enqueueOutbox(
  executor: OutboxInsertExecutor,
  input: EnqueueOutboxInput,
): Promise<void> {
  await executor.insert(notificationOutbox).values({
    channel: input.channel ?? 'pushover',
    eventType: input.eventType,
    payload: input.payload,
    earliestSendAt: input.earliestSendAt,
  });
}

// ---------------------------------------------------------------------------
// Rendering — event_type + payload → { title, message, url }
// ---------------------------------------------------------------------------

export interface OutboxMessage {
  title: string;
  message: string;
  url?: string;
  urlTitle?: string;
}

/** Compact decimal bytes ("114 GB", "1.4 TB") — owner-facing copy, not exact IEC. */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 GB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  const digits = value >= 10 || i <= 2 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[i]}`;
}

/** A short date ("Sep 4") in the owner's timezone. */
function formatDate(iso: unknown, tz: string): string {
  if (typeof iso !== 'string') return 'soon';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'soon';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(
    d,
  );
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const plural = (n: number): string => (n === 1 ? '' : 's');

/** Render an outbox row's Pushover title/message/url from its event type + payload. */
export function renderOutboxMessage(
  row: { eventType: NotifyOutboxEventType; payload: Record<string, unknown> },
  tz: string,
): OutboxMessage {
  const p = row.payload ?? {};
  const mediaKind = p.mediaKind === 'movie' ? 'movie' : 'tv';
  const kindLabel = mediaKind === 'movie' ? 'Movies' : 'TV';
  // Deep-link into the relevant per-kind Trash tab (ADR-033 — `?tab=movies|tv`).
  const url = `https://haynesnetwork.com/trash?tab=${mediaKind === 'movie' ? 'movies' : 'tv'}`;
  const urlTitle = 'Open Trash';

  switch (row.eventType) {
    case 'batch_created': {
      const items = num(p.itemCount);
      return {
        title: `New ${kindLabel} batch`,
        message: `${items} item${plural(items)}, ${formatBytes(num(p.totalBytes))} — review it`,
        url,
        urlTitle,
      };
    }
    case 'batch_leaving_soon': {
      const items = num(p.pendingCount);
      const date = formatDate(p.expiresAt, tz);
      return {
        title: `${kindLabel} batch is Leaving Soon`,
        message: `Leaves ${date} — ${items} item${plural(items)} still slated; save window open until then`,
        url,
        urlTitle,
      };
    }
    case 'batch_leaving_soon_reminder': {
      const items = num(p.pendingCount);
      const date = formatDate(p.expiresAt, tz);
      return {
        title: `${kindLabel} batch leaves ${date}`,
        message: `Last chance — ${items} item${plural(items)} still slated. Save the ones you want before it sweeps.`,
        url,
        urlTitle,
      };
    }
    case 'batch_swept': {
      const items = num(p.deletedCount);
      return {
        title: `${kindLabel} batch swept`,
        message: `Deleted ${items} item${plural(items)}, freed ${formatBytes(num(p.reclaimedBytes))}.`,
        url,
        urlTitle,
      };
    }
    default:
      return {
        title: 'Trash batch update',
        message: 'A Trash batch changed state.',
        url,
        urlTitle,
      };
  }
}

// ---------------------------------------------------------------------------
// Pushover transport
// ---------------------------------------------------------------------------

/** The delivery function the drainer calls per row. Tests inject a stub; prod builds one from env. */
export type OutboxSender = (msg: OutboxMessage) => Promise<void>;

/** POST one message to the Pushover API (form-encoded). Non-2xx throws with the response body. */
export async function postPushover(input: {
  token: string;
  user: string;
  title: string;
  message: string;
  url?: string;
  urlTitle?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams();
  body.set('token', input.token);
  body.set('user', input.user);
  body.set('title', input.title);
  body.set('message', input.message);
  if (input.url) body.set('url', input.url);
  if (input.urlTitle) body.set('url_title', input.urlTitle);
  const res = await fetchImpl('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`pushover ${res.status}: ${text.slice(0, 300)}`);
  }
}

/**
 * Build the Pushover sender from `PUSHOVER_APP_TOKEN` + `PUSHOVER_USER_KEY`. Returns `null` when either
 * is absent — the drainer treats that as "disabled", no-ops, and leaves the rows queued (ADR-034 C-03).
 */
export function pushoverSenderFromEnv(fetchImpl: typeof fetch = fetch): OutboxSender | null {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return null;
  return (msg) => postPushover({ token, user, ...msg, fetchImpl });
}

// ---------------------------------------------------------------------------
// deliverOutbox — the `notify-outbox` sync mode's body
// ---------------------------------------------------------------------------

export interface OutboxDeliveryReport {
  /** Rows selected as due this run (sent_at null, attempts < MAX, earliest_send_at <= now). */
  dueCount: number;
  sent: number;
  failed: number;
  /** Rows that reached MAX_ATTEMPTS this run (now parked out of the due scan). */
  parked: number;
  /** True when no sender was available (credentials absent) — no row was touched. */
  skipped: boolean;
  reason?: string;
}

const MAX_ATTEMPTS = 5;
/** Backoff after attempt 1/2/3/4+ (a failed row's next earliest_send_at = now + this). */
const BACKOFF_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000];

interface OutboxLogger {
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Drain the outbox: deliver every DUE row to Pushover (or the injected `sender`), setting `sent_at` on
 * success or incrementing `attempts` + recording `last_error` + backing off `earliest_send_at` on
 * failure (parked at MAX_ATTEMPTS). When no sender is available (`PUSHOVER_*` absent) it no-ops and
 * leaves rows queued. At-least-once (ADR-034 C-05): a crash between a successful POST and the `sent_at`
 * write re-sends next run; single job + Forbid concurrency keeps it single-sender.
 */
export async function deliverOutbox(input: {
  db?: DbClient;
  now?: Date;
  /** Injected sender (tests). `undefined` ⇒ build from env; explicit `null` ⇒ force the no-creds path. */
  sender?: OutboxSender | null;
  limit?: number;
  logger?: OutboxLogger;
}): Promise<OutboxDeliveryReport> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const limit = input.limit ?? 100;
  const log = input.logger;
  const sender = input.sender === undefined ? pushoverSenderFromEnv() : input.sender;

  const due: NotificationOutboxRow[] = await db
    .select()
    .from(notificationOutbox)
    .where(
      and(
        isNull(notificationOutbox.sentAt),
        lt(notificationOutbox.attempts, MAX_ATTEMPTS),
        lte(notificationOutbox.earliestSendAt, now),
      ),
    )
    .orderBy(asc(notificationOutbox.earliestSendAt))
    .limit(limit);

  if (sender === null) {
    if (due.length > 0) {
      log?.info?.('notify-outbox: pushover credentials absent — leaving rows queued', {
        dueCount: due.length,
      });
    }
    return {
      dueCount: due.length,
      sent: 0,
      failed: 0,
      parked: 0,
      skipped: true,
      reason: 'no_credentials',
    };
  }

  // The tz for date rendering (a cheap read; the window rarely changes between enqueue and send).
  const window = await getNotifyWindow(input.db);

  let sent = 0;
  let failed = 0;
  let parked = 0;
  for (const row of due) {
    const msg = renderOutboxMessage(row, window.tz);
    try {
      await sender(msg);
      await db
        .update(notificationOutbox)
        .set({ sentAt: new Date() })
        .where(eq(notificationOutbox.id, row.id));
      sent += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      const backoff = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
      await db
        .update(notificationOutbox)
        .set({ attempts, lastError: message, earliestSendAt: new Date(now.getTime() + backoff) })
        .where(eq(notificationOutbox.id, row.id));
      failed += 1;
      if (attempts >= MAX_ATTEMPTS) parked += 1;
      log?.warn?.('notify-outbox: delivery failed', { id: row.id, attempts, error: message });
    }
  }
  if (sent > 0 || failed > 0) {
    log?.info?.('notify-outbox drained', { sent, failed, parked, dueCount: due.length });
  }
  return { dueCount: due.length, sent, failed, parked, skipped: false };
}
