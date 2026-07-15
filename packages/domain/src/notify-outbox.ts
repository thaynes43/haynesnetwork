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
import { and, asc, eq, inArray, isNull, lt, lte } from 'drizzle-orm';
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

/** A clock time ("11:04 PM") in the owner's timezone — for the final-warning "closes at <time>". */
function formatClockTime(iso: unknown, tz: string): string {
  if (typeof iso !== 'string') return 'soon';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'soon';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  }).format(d);
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const plural = (n: number): string => (n === 1 ? '' : 's');

/** ADR-040 / DESIGN-020 — map a SMART transition reason code to owner-facing copy. */
function smartReasonLabel(reason: unknown): string {
  switch (reason) {
    case 'smart_status':
      return 'SMART status FAILED';
    case 'media_errors':
      return 'media errors climbing';
    case 'available_spare':
      return 'available spare crossed its threshold';
    case 'critical_warning':
      return 'a new critical-warning bit';
    case 'wear_80':
      return 'wear crossed 80%';
    case 'wear_90':
      return 'wear crossed 90%';
    default:
      return typeof reason === 'string' ? reason : 'SMART degradation';
  }
}

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
    case 'batch_final_warning': {
      // DESIGN-015 amendment (2026-07-09) — the configurable last-call ping, N hours before close.
      const items = num(p.pendingCount);
      const time = formatClockTime(p.expiresAt, tz);
      return {
        title: `Last call — ${kindLabel} batch`,
        message: `Last call: the ${kindLabel} batch closes at ${time} — ${items} item${plural(items)} still slated. Save anything you want to keep.`,
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
    // ADR-040 / DESIGN-020 (PLAN-019) — SMART drive-health transitions deep-link to the Hardware tab
    // (NOT Trash), so they render their own title/message/url from the drive payload.
    case 'smart_degraded': {
      const label = typeof p.label === 'string' ? p.label : 'A drive';
      const pool = typeof p.pool === 'string' ? ` (${p.pool})` : '';
      const reasons = Array.isArray(p.reasons)
        ? p.reasons.map(smartReasonLabel).join(', ')
        : 'a critical SMART change';
      return {
        title: `⚠️ Drive health: ${label}${pool}`,
        message: `Critical SMART change — ${reasons}. Check the Hardware tab.`,
        url: 'https://haynesnetwork.com/metrics?tab=hardware',
        urlTitle: 'Open Hardware metrics',
      };
    }
    case 'smart_recovered': {
      const label = typeof p.label === 'string' ? p.label : 'A drive';
      const pool = typeof p.pool === 'string' ? ` (${p.pool})` : '';
      return {
        title: `Drive recovered: ${label}${pool}`,
        message: 'SMART health is back to passing.',
        url: 'https://haynesnetwork.com/metrics?tab=hardware',
        urlTitle: 'Open Hardware metrics',
      };
    }
    // ADR-050 / DESIGN-012 D-13 (PLAN-034) — a member filed a Helpdesk ticket: ping the admins
    // with the who/what/which-title facts and deep-link the ticket's detail page (triage lives
    // there). Enqueued by createTicket in the SAME tx as the ticket insert (ADR-034 C-01).
    case 'ticket_created': {
      const author =
        typeof p.authorName === 'string' && p.authorName !== '' ? p.authorName : 'Someone';
      const title = typeof p.title === 'string' && p.title !== '' ? p.title : 'a new ticket';
      const media =
        typeof p.mediaTitle === 'string' && p.mediaTitle !== '' ? ` · ${p.mediaTitle}` : '';
      const ticketId = typeof p.ticketId === 'string' ? p.ticketId : '';
      return {
        title: 'New Helpdesk ticket',
        message: `${author}: “${title}”${media}`,
        url:
          ticketId !== ''
            ? `https://haynesnetwork.com/bulletin/ticket/${ticketId}`
            : 'https://haynesnetwork.com/bulletin',
        urlTitle: 'Open the ticket',
      };
    }
    // ADR-054 / DESIGN-027 (PLAN-039) — the MAM compliance governor's gate transitions. No in-app surface
    // in v1 (logs + Pushover only — owner ruling Q-03), and the operator UIs (Prowlarr/LazyLibrarian) are
    // LAN-only, so these carry NO url (a dead link from a phone push helps nobody); the message is the fact.
    case 'mam_gate_paused': {
      const u = num(p.unsatisfied);
      const limit = num(p.limit);
      const failed = p.reason === 'count_failed';
      return {
        title: 'MAM grabs paused',
        message: failed
          ? `Couldn't count seeding torrents — paused MAM grabs as a precaution (fail-closed). Usenet keeps flowing.`
          : `${u}/${limit} unsatisfied torrents (threshold ${num(p.threshold)}) — paused the MAM indexer so grabs stay under the cap. Usenet keeps flowing; auto-resumes as torrents pass 72h.`,
      };
    }
    case 'mam_gate_resumed': {
      const u = num(p.unsatisfied);
      const limit = num(p.limit);
      return {
        title: 'MAM grabs resumed',
        message: `Headroom returned (${u}/${limit} unsatisfied) — re-enabled the MAM indexer. Torrent fallback is flowing again.`,
      };
    }
    case 'mam_gate_stuck': {
      const u = num(p.unsatisfied);
      const limit = num(p.limit);
      return {
        title: 'MAM cap pinned for 48h+',
        message: `Unsatisfied torrents have sat at the cap (${u}/${limit}) for over 48h — book demand exceeds the ~${limit}-per-72h throughput. Consider prioritising the wanted list or a MAM rank bump.`,
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
// The email channel (ADR-060 / DESIGN-031 — PLAN-035)
// ---------------------------------------------------------------------------

/** A rendered email-channel delivery: the resolved recipient + plain-text subject/body (D-03). */
export interface OutboxEmail {
  to: string;
  subject: string;
  text: string;
}

export type OutboxEmailSender = (mail: OutboxEmail) => Promise<void>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Render an email-channel row's subject/body from its event type + payload (DESIGN-031 D-03 — the
 * `renderOutboxMessage` sibling; plain text, deep link in the last line). Returns `null` for an event
 * type email does not render OR a row missing its `payload.to` — such a row is a bug (email rows
 * resolve their recipient at ENQUEUE time, ADR-060 C-02) and the drainer fails it loudly rather than
 * sending an empty/misaddressed mail.
 */
export function renderOutboxEmail(row: {
  eventType: NotifyOutboxEventType;
  payload: Record<string, unknown>;
}): OutboxEmail | null {
  const p = row.payload ?? {};
  const to = str(p.to);
  if (to === '') return null;
  const ticketId = str(p.ticketId);
  const ticketUrl =
    ticketId !== ''
      ? `https://haynesnetwork.com/bulletin/ticket/${ticketId}`
      : 'https://haynesnetwork.com/bulletin';
  const title = str(p.title) || 'a ticket';

  switch (row.eventType) {
    // R-195 — the unconditional admin alert on ticket creation.
    case 'ticket_created': {
      const author = str(p.authorName) || 'Someone';
      const media = str(p.mediaTitle) !== '' ? `\nMedia: ${str(p.mediaTitle)}` : '';
      const category = str(p.category) !== '' ? `\nCategory: ${str(p.category)}` : '';
      return {
        to,
        subject: `[haynesnetwork] New ticket: ${title}`,
        text: `${author} filed a new Helpdesk ticket.\n\nTitle: ${title}${category}${media}\n\nOpen it: ${ticketUrl}\n`,
      };
    }
    // R-196 — the author's opt-in reply notification.
    case 'ticket_replied': {
      const replyAuthor = str(p.replyAuthorName) || 'Someone';
      const snippet = str(p.snippet);
      return {
        to,
        subject: `[haynesnetwork] Re: ${title}`,
        text: `${replyAuthor} replied to your ticket “${title}”.\n\n${snippet}${snippet !== '' ? '\n\n' : ''}Open it: ${ticketUrl}\n`,
      };
    }
    // R-196 — the author's opt-in status-transition notification.
    case 'ticket_status_changed': {
      const actor = str(p.actorName) || 'An admin';
      const toStatus = str(p.toStatus) || 'updated';
      const note = str(p.note) !== '' ? `\nNote: ${str(p.note)}` : '';
      return {
        to,
        subject: `[haynesnetwork] ${title} → ${toStatus.replace('_', ' ')}`,
        text: `${actor} moved your ticket “${title}” to ${toStatus.replace('_', ' ')}.${note}\n\nOpen it: ${ticketUrl}\n`,
      };
    }
    default:
      return null;
  }
}

/**
 * Build the SMTP email sender from the F-04 env contract (`SMTP_HOST/PORT/USER/PASS/FROM` — the 1P
 * `smtp` item via the haynesnetwork ExternalSecret). Returns `null` unless ALL five are present — the
 * drainer's per-channel disabled path (R-197): email rows WAIT, no attempts burned. nodemailer SMTP
 * submission with STARTTLS (port 587).
 */
export function smtpSenderFromEnv(env: Record<string, string | undefined> = process.env): OutboxEmailSender | null {
  const host = env.SMTP_HOST;
  const port = env.SMTP_PORT;
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const from = env.SMTP_FROM;
  if (!host || !port || !user || !pass || !from) return null;
  return async (mail) => {
    // Lazy import so the drainer (and every consumer of @hnet/domain) pays for nodemailer only when
    // email is actually configured AND a row is due.
    const { createTransport } = await import('nodemailer');
    const transporter = createTransport({
      host,
      port: Number(port),
      secure: false, // STARTTLS upgrade on 587 (Google submission)
      auth: { user, pass },
    });
    try {
      await transporter.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
    } finally {
      transporter.close();
    }
  };
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
  /** True when NO sender was available for ANY channel (credentials absent) — no row was touched. */
  skipped: boolean;
  reason?: string;
  /**
   * ADR-060 / R-197 — channels excluded from this run because their credentials are absent; their
   * rows WAIT untouched (no attempts burned). Absent when every channel had a sender.
   */
  skippedChannels?: NotifyOutboxChannel[];
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
 * Drain the outbox: deliver every DUE row to its CHANNEL's sender (ADR-060 — pushover and/or email),
 * setting `sent_at` on success or incrementing `attempts` + recording `last_error` + backing off
 * `earliest_send_at` on failure (parked at MAX_ATTEMPTS). A channel whose credentials are absent is
 * EXCLUDED from the due scan — its rows wait untouched (per-channel disabled-safe, R-197); when no
 * channel has a sender the run no-ops entirely. At-least-once (ADR-034 C-05): a crash between a
 * successful send and the `sent_at` write re-sends next run; single job + Forbid concurrency keeps it
 * single-sender.
 */
export async function deliverOutbox(input: {
  db?: DbClient;
  now?: Date;
  /**
   * DEPRECATED alias for `senders.pushover` (pre-ADR-060 tests/callers). `undefined` ⇒ build from
   * env; explicit `null` ⇒ force the pushover no-creds path.
   */
  sender?: OutboxSender | null;
  /** Per-channel injected senders (tests). Per channel: `undefined` ⇒ env; `null` ⇒ disabled. */
  senders?: { pushover?: OutboxSender | null; email?: OutboxEmailSender | null };
  limit?: number;
  logger?: OutboxLogger;
}): Promise<OutboxDeliveryReport> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const limit = input.limit ?? 100;
  const log = input.logger;
  const pushoverSender =
    input.senders?.pushover !== undefined
      ? input.senders.pushover
      : input.sender !== undefined
        ? input.sender
        : pushoverSenderFromEnv();
  const emailSender = input.senders?.email !== undefined ? input.senders.email : smtpSenderFromEnv();

  const availableChannels: NotifyOutboxChannel[] = [];
  const skippedChannels: NotifyOutboxChannel[] = [];
  (pushoverSender ? availableChannels : skippedChannels).push('pushover');
  (emailSender ? availableChannels : skippedChannels).push('email');

  const due: NotificationOutboxRow[] = await db
    .select()
    .from(notificationOutbox)
    .where(
      and(
        isNull(notificationOutbox.sentAt),
        lt(notificationOutbox.attempts, MAX_ATTEMPTS),
        lte(notificationOutbox.earliestSendAt, now),
        availableChannels.length > 0
          ? inArray(notificationOutbox.channel, availableChannels)
          : undefined,
      ),
    )
    .orderBy(asc(notificationOutbox.earliestSendAt))
    .limit(limit);

  if (availableChannels.length === 0) {
    if (due.length > 0) {
      log?.info?.('notify-outbox: no channel credentials — leaving rows queued', {
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
      skippedChannels,
    };
  }

  // The tz for date rendering (a cheap read; the window rarely changes between enqueue and send).
  const window = await getNotifyWindow(input.db);

  let sent = 0;
  let failed = 0;
  let parked = 0;
  for (const row of due) {
    try {
      if (row.channel === 'email') {
        const mail = renderOutboxEmail(row);
        if (mail === null) {
          throw new Error(
            `email row unrenderable (event_type=${row.eventType}, payload.to ${typeof row.payload?.to === 'string' ? 'set' : 'MISSING'})`,
          );
        }
        await emailSender!(mail);
      } else {
        const msg = renderOutboxMessage(row, window.tz);
        await pushoverSender!(msg);
      }
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
    log?.info?.('notify-outbox drained', {
      sent,
      failed,
      parked,
      dueCount: due.length,
      ...(skippedChannels.length > 0 ? { skippedChannels } : {}),
    });
  }
  return {
    dueCount: due.length,
    sent,
    failed,
    parked,
    skipped: false,
    ...(skippedChannels.length > 0 ? { skippedChannels } : {}),
  };
}
