// ADR-026 / ADR-050 / DESIGN-012 — pure client helpers for the Bulletin section (labels + tones the
// Helpdesk/Feed UI and the /admin/roles grant grid share). Client components never import the
// server packages, so the enum literals mirror @hnet/db (same convention as lib/trash.ts —
// keep in lockstep with NOTIFICATION_SOURCES / MESSAGE_ACTIONS / TICKET_STATUSES / TICKET_CATEGORIES).

/**
 * ADR-050 C-05 (PLAN-034) — THE display name of the ticket system, and (since the owner-ratified
 * nav restructure, 2026-07-14 — DESIGN-004 D-22) the user-visible name of the whole `bulletin`
 * section: the top-nav entry, the section page heading, and the lead sub-tab all read from here.
 * "Helpdesk" was the Fable proposal; the owner RATIFIED "Tickets" at screenshot review — the rename
 * is THIS one constant. No stored value, route, section id, or grant row encodes it (they all stay
 * `bulletin` / `messages`).
 */
export const HELPDESK_NAME = 'Tickets';

/** The Feed's notification sources (mirrors @hnet/db NOTIFICATION_SOURCES). */
export const FEED_SOURCE_NAMES = ['seerr', 'tautulli', 'maintainerr'] as const;
export type FeedSourceName = (typeof FEED_SOURCE_NAMES)[number];

export const FEED_SOURCE_LABELS: Record<FeedSourceName, string> = {
  seerr: 'Seerr',
  tautulli: 'Tautulli',
  maintainerr: 'Maintainerr',
};

/** The fine-grained Bulletin message actions (mirrors @hnet/db MESSAGE_ACTIONS — since PLAN-034
 *  they gate the Helpdesk: `post` = file tickets, `moderate` = drive ticket state transitions). */
export const MESSAGE_ACTION_NAMES = ['post', 'moderate'] as const;
export type MessageActionName = (typeof MESSAGE_ACTION_NAMES)[number];

/** The Bulletin SUB-VIEWS a role's visibility can be scoped to (mirrors @hnet/db BULLETIN_VIEWS —
 *  ADR-049 C-02, PLAN-027). A role with none granted resolves to BOTH (server default); the owner's
 *  Default role is narrowed to `messages` only. The STORED `messages` value now carries the
 *  Helpdesk (ADR-050 option H — no grant row migrates on a rename). */
export const BULLETIN_VIEW_NAMES = ['feed', 'messages'] as const;
export type BulletinViewName = (typeof BULLETIN_VIEW_NAMES)[number];

/** Human labels for the Bulletin-view checkboxes on /admin/roles. */
export const BULLETIN_VIEW_LABELS: Record<BulletinViewName, string> = {
  feed: 'Feed',
  messages: HELPDESK_NAME,
};

/** Human labels for the per-action grant grid (/admin/roles). */
export const MESSAGE_ACTION_LABELS: Record<MessageActionName, string> = {
  // Not `File ${HELPDESK_NAME} tickets` — with HELPDESK_NAME now "Tickets" that would read
  // "File Tickets tickets". The bare verb phrase stays correct under any ratified name.
  post: 'File tickets',
  moderate: 'Triage tickets — drive state transitions (staff)',
};

// ---------------------------------------------------------------------------
// ADR-050 (PLAN-034) — Helpdesk ticket enums (mirror @hnet/db TICKET_STATUSES /
// TICKET_CATEGORIES and the @hnet/domain TICKET_TRANSITIONS matrix).
// ---------------------------------------------------------------------------

export const TICKET_STATUS_NAMES = ['open', 'in_progress', 'complete', 'rejected'] as const;
export type TicketStatusName = (typeof TICKET_STATUS_NAMES)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatusName, string> = {
  open: 'Open',
  in_progress: 'In progress',
  complete: 'Complete',
  rejected: 'Rejected',
};

/** Badge tone per ticket state (tokens-only — maps to the existing .badge--* classes; the accent
 *  green IS the estate's success tone). rejected is muted (dismissed), never danger (nothing is
 *  destroyed — it re-opens). */
export function ticketStatusTone(status: TicketStatusName): 'warn' | 'info' | 'ok' | 'muted' {
  switch (status) {
    case 'open':
      return 'warn';
    case 'in_progress':
      return 'info';
    case 'complete':
      return 'ok';
    case 'rejected':
      return 'muted';
  }
}

/**
 * The CLIENT mirror of @hnet/domain TICKET_TRANSITIONS (the server enforces; this only decides
 * which affordances render — AC-13: never an affordance the server would refuse). open ⇄
 * in_progress; either closes to complete | rejected; complete is terminal; rejected re-opens.
 */
export const TICKET_TRANSITIONS_CLIENT: Record<TicketStatusName, readonly TicketStatusName[]> = {
  open: ['in_progress', 'complete', 'rejected'],
  in_progress: ['open', 'complete', 'rejected'],
  complete: [],
  rejected: ['open'],
};

/** The staff-facing verb for each transition edge (the Modal titles + buttons). */
export function transitionLabel(from: TicketStatusName, to: TicketStatusName): string {
  if (to === 'in_progress') return 'Start progress';
  if (to === 'complete') return 'Mark complete';
  if (to === 'rejected') return 'Reject';
  // → open
  return from === 'rejected' ? 'Re-open' : 'Back to open';
}

export const TICKET_CATEGORY_NAMES = [
  'playback',
  'audio',
  'subtitles',
  'quality',
  'missing',
  'other',
] as const;
export type TicketCategoryName = (typeof TICKET_CATEGORY_NAMES)[number];

export const TICKET_CATEGORY_LABELS: Record<TicketCategoryName, string> = {
  playback: 'Playback',
  audio: 'Audio',
  subtitles: 'Subtitles',
  quality: 'Quality',
  missing: 'Missing',
  other: 'Other',
};

/** The intake form's one-line hints (what belongs under each category). */
export const TICKET_CATEGORY_HINTS: Record<TicketCategoryName, string> = {
  playback: 'Won’t play, buffering, errors mid-stream',
  audio: 'No sound, out of sync, wrong language',
  subtitles: 'Missing, wrong, or out-of-sync subtitles',
  quality: 'Bad quality or the wrong version',
  missing: 'Something that should be in the library isn’t',
  other: 'Anything else about media or playback',
};
