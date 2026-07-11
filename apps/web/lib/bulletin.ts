// ADR-026 / DESIGN-012 D-08 — pure client helpers for the Bulletin section (labels + tones the
// Feed/Messages UI and the /admin/roles grant grid share). Client components never import the
// server packages, so the enum literals mirror @hnet/db (same convention as lib/trash.ts —
// keep in lockstep with NOTIFICATION_SOURCES / MESSAGE_ACTIONS / MESSAGE_STATUSES).

/** The Feed's notification sources (mirrors @hnet/db NOTIFICATION_SOURCES). */
export const FEED_SOURCE_NAMES = ['seerr', 'tautulli', 'maintainerr'] as const;
export type FeedSourceName = (typeof FEED_SOURCE_NAMES)[number];

export const FEED_SOURCE_LABELS: Record<FeedSourceName, string> = {
  seerr: 'Seerr',
  tautulli: 'Tautulli',
  maintainerr: 'Maintainerr',
};

/** The fine-grained Bulletin message actions (mirrors @hnet/db MESSAGE_ACTIONS — ADR-026 C-04). */
export const MESSAGE_ACTION_NAMES = ['post', 'moderate'] as const;
export type MessageActionName = (typeof MESSAGE_ACTION_NAMES)[number];

/** The Bulletin SUB-VIEWS a role's visibility can be scoped to (mirrors @hnet/db BULLETIN_VIEWS —
 *  ADR-049 C-02, PLAN-027). A role with none granted resolves to BOTH (server default); the owner's
 *  Default role is narrowed to `messages` only. */
export const BULLETIN_VIEW_NAMES = ['feed', 'messages'] as const;
export type BulletinViewName = (typeof BULLETIN_VIEW_NAMES)[number];

/** Human labels for the Bulletin-view checkboxes on /admin/roles. */
export const BULLETIN_VIEW_LABELS: Record<BulletinViewName, string> = {
  feed: 'Feed',
  messages: 'Messages',
};

/** Human labels for the per-action grant grid (/admin/roles) — destructive ones say so. */
export const MESSAGE_ACTION_LABELS: Record<MessageActionName, string> = {
  post: 'Post messages (and edit their own)',
  moderate: 'Moderate any message — hide / delete / restore',
};

/** A Message's moderation status (mirrors @hnet/db MESSAGE_STATUSES). */
export type MessageStatusName = 'visible' | 'hidden' | 'deleted';

export const MESSAGE_STATUS_LABELS: Record<MessageStatusName, string> = {
  visible: 'Visible',
  hidden: 'Hidden',
  deleted: 'Deleted',
};

/** Badge tone per status (visible is the unremarkable default — no badge shown). */
export function messageStatusTone(status: MessageStatusName): 'muted' | 'warn' | 'danger' {
  return status === 'deleted' ? 'danger' : status === 'hidden' ? 'warn' : 'muted';
}
