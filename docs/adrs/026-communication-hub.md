# ADR-026: Communication hub — Bulletin Feed + Messages (generic webhook ingestion, durable notification store, user message board, moderation model)

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Tom Haynes (owner), Fable 5 (authoring + ratifying agent)

## Context and problem statement

The Haynes Plex household runs Seerr/Overseerr (requests), Tautulli (playback), and Maintainerr
(retention/deletion). Each emits events the household cares about, but today they scatter into
per-service UIs and phone push spam. PLAN-006 shipped a **minimal generic notification store**
(`notifications`) + a `POST /api/webhooks/[source]` receiver with Maintainerr as source #1, read
back by the Trash **Activity** tab. PLAN-009 (Bulletin — an owner stretch request) promotes this
into a first-class **Bulletin** section with two sub-tabs:

1. **Feed** — an aggregated, filterable browse over the durable notification store, fed by Seerr +
   Tautulli + Maintainerr webhooks, attributed to app users where the payload carries identity.
2. **Messages** — a user-driven durable board: post free-form messages (optionally linked to a
   media item), moderators triage. Complements — never replaces — the structured Fix flow.

The decisions: how to widen the store + receiver without breaking the shipped Maintainerr surface;
whether notifications belong in `ledger_events` or a separate store; how the message board relates
to Fix; the moderation/permission model; and the bounded-context placement.

## Decision drivers

- **Reuse, don't rebuild** — PLAN-006 already shipped the store + receiver + `NOTIFICATION_SOURCES`
  enum; widen them (an ALTER + enum extension), keep `/api/webhooks/maintainerr` working.
- **One attribution brain** — the Seerr requester-email→user auto-link (ADR-008 C-05) already
  exists in the ledger; do not fork a second attribution path.
- **Durable in Postgres 16** — never ephemeral; the Feed is a read-through browse, Messages full
  CRUD with moderation, both auditable.
- **Security** — the receiver is unauthenticated (services can't hold a session) so it must be
  shared-secret-gated, in-cluster-only, and hardened (constant-time compare, size cap, known-shape
  validation), working before the public cutover (R-64).
- **Server-authoritative permissions** — reuse the Section-Permission model + a fine-grained
  per-action grant (mirror PLAN-006's Trash action grants); never client-hidden-only.

## Considered options

- **A. Notifications as more `ledger_events` rows** vs **B. A separate `notifications` store.**
- **C. Maintainerr-specific webhook** vs **D. One parameterized `[source]` receiver + per-source
  adapters.**
- **E. Messages replace/absorb Fix** vs **F. Messages complement Fix (own table, discussion only).**
- **G. New bounded context BC-05 Media Communication** vs **H. Extend BC-03 Media Ledger.**

## Decision outcome

Chosen: **B + D + F + G**.

- **B — separate `notifications` store (widened, not `ledger_events`).** `ledger_events` is BC-03's
  append-only *arr-history / Seerr-request / Fix / Restore ledger with its own dedupe + attribution
  invariants; inbound third-party webhooks are a different write cadence, source set, and carry
  read/seen state. Mixing them bloats the ledger. `notifications` is the sibling table (mirrors the
  ADR-018 "separate `media_metadata`" reasoning). PLAN-009 **WIDENS** the PLAN-006 table (migration
  0018, ALTER): adds `media_item_id` (nullable FK), `tmdb_id`/`tvdb_id`, `actor_user_id` (nullable
  FK), `occurred_at`, and `source_event_id` with a **partial-unique `(source, source_event_id)`
  dedupe index**. The shipped `type`/`title`/`body` columns are **kept stable** (no rename): `type`
  IS the event type, `title`/`body` the display subject/message.
- **D — one parameterized receiver + per-source adapters.** `POST /api/webhooks/[source]` with
  `[source] ∈ NOTIFICATION_SOURCES` (unknown ⇒ 404), a **per-source shared secret**
  (`MAINTAINERR_WEBHOOK_SECRET` reused, `SEERR_WEBHOOK_SECRET`, `TAUTULLI_WEBHOOK_SECRET`), and a
  per-source **payload parser** normalizing to the common `recordNotification` input. The
  Maintainerr-specific route is folded into `[source]` (same URL — no breakage). `NOTIFICATION_SOURCES`
  widens to `['maintainerr','seerr','tautulli']` — **`seerr` is the single canonical name for both
  Overseerr and Seerr** (one deployment, one source name). The Trash Activity tab keeps reading
  `source='maintainerr'` off the same store.
- **F — Messages complement Fix (own `messages` table, discussion only).** The board is free-form
  triage; Fix stays the structured, per-item, audited action. A Message may **link** to a media item
  but **never mutates** it (no *arr write). Flat v1 — no threads/reactions (deferred). Moderation is
  **soft**: `status ∈ {visible, hidden, deleted}` transitions preserve the row + content (the audit
  trail); authors edit their **own** messages, moderators hide/delete/restore **any**.
- **G — new bounded context BC-05 Media Communication.** The Feed + Messages content is a distinct
  concern (inbound third-party events + user discussion) from BC-03's media mirror/repair. It
  **reuses** BC-03's email-only attribution (ADR-008 C-05) and BC-02's Section-Permission + audited
  grant mutation, but owns its own aggregates (Notification, Message). Recorded in DDD 002.

**Permission model.** Reuse `role_section_permissions` (add the `bulletin` section id, **default
`read_only` for members** — the Feed is for everyone; Disabled hides the section) for coarse READ.
Add a fine-grained per-action grant `role_message_action_grants` (`MESSAGE_ACTIONS = ['post',
'moderate']`), modeled exactly on PLAN-006's `role_trash_action_grants`: a row = the grant, Admin
implies all with no rows, the `setRoleMessageActions` single-writer co-writes a
`update_message_actions` `permission_audit` row in the same transaction. `post` unlocks
creating/editing one's OWN messages; `moderate` unlocks hide/delete/restore of ANY message. The
grants ride the session (`SessionRole.messageActions`) so `messageActionProcedure` needs no query.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: ONE notification brain — every third-party event lands in one durable, filterable, attributed Feed; no phone spam; Trash Activity is just a filtered view. |
| C-02 | Good: the Bulletin section is Read-Only for everyone by default (the household reads the Feed + Messages out of the box); posting/moderating stay opt-in per-action grants. |
| C-03 | Good: ingest is idempotent (the `(source, source_event_id)` partial-unique index) — webhook re-delivery is a no-op; the Seerr dedupe key `<notification_type>:<request_id>` keeps each lifecycle event distinct while collapsing re-sends. |
| C-04 | Good: message moderation is a BC-02-audited, server-authoritative, fine-grained grant (`update_message_actions`); soft-status transitions preserve content for audit. |
| C-05 | Good: attribution reuses the single email-only path (`resolveUserIdByEmail`) + the tmdb/tvdb media match (`resolveMediaItemId`) factored out of ledger backfill — no second attribution path. |
| C-06 | Bad: third-party payload drift needs per-source adapter maintenance; the receiver validates to a known shape and rejects the unexpected (never stores unbounded caller JSON). |
| C-07 | Bad: per-source shared-secret rotation is an ops step (three secrets in 1Password/External Secrets); an unset secret fail-closes (503) that source. |
| C-08 | Neutral: Feed is a **global** store (no per-user read/unread state) — household simplicity; a `notification_reads` join table is the future extension if per-user unread is wanted. Tautulli dedupe is best-effort (no stable upstream id). |

## More information

- Satisfies PRD-001 **R-97..R-104**. Governs **DESIGN-012**. Reuses/extends ADR-021 (Section
  Permissions), ADR-023 (Trash action grants + the notification store + Maintainerr webhook), ADR-008
  (ledger/attribution C-05), ADR-014 (ConfirmButton/Modal — the Messages moderation UX), ADR-015
  (no-reorient). Supersedes nothing.
- Open decisions recorded in DESIGN-012 (Q-01 read/unread, Q-02 threads/reactions, Q-03 Message⇄Fix
  spawn, Q-04 *arrs as sources, Q-05 full filter-engine port for the Feed).
