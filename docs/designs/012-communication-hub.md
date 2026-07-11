# DESIGN-012: Communication hub — Bulletin Feed + Helpdesk tickets

- **Status:** Draft
- **Last updated:** 2026-07-11 — **HP-01 amendment (owner-approved):** the Helpdesk wall's state
  chips became MULTI-SELECT toggles (default `{open, in_progress}`; Complete/Rejected opt-in) — see
  D-11's `list` (`statuses` set) and D-12's Filters bullet. **PLAN-034 amendment (D-10..D-13, ADR-050):** the Messages board
  became the **Helpdesk** media-issue ticket system (tickets + state machine + event history +
  reply threads; `messages` dropped). D-01's `messages` model, D-06's API, and D-08's board half
  are RETIRED — kept below as the historical record; D-10..D-13 are current.
- **Satisfies:** PRD-001 R-97..R-104 + R-160..R-164; governed by ADR-026 (Feed + grants) and
  ADR-050 (tickets). Reuses ADR-021 (Section Permissions), ADR-023 (Trash action grants + the
  PLAN-006 notification store/receiver), ADR-008 (attribution), ADR-014/015 (ConfirmButton/Modal +
  no-reorient), ADR-034 (transactional outbox), ADR-019 (poster proxy), DESIGN-004 D-19 (history
  navigation).

## Overview

A top-level **Bulletin** section (`bulletin`) with two sub-tabs: an aggregated third-party
notification **Feed** (durable `notifications` store, fed by Seerr/Tautulli/Maintainerr webhooks) and
a user-driven **Messages** board. This DESIGN specifies the **backend vertical** (data model, generic
secured receiver + per-source adapters, Feed/Messages tRPC surface, permission model, ingest
attribution) that PLAN-009 ships first. The Feed + Messages **UI is a separate Fable UX follow-up**
(the D-05/D-06 wire contracts below are its input).

## Detailed design

### D-01 — Data model (`packages/db`, migration 0018, all additive)

**`notifications` (WIDENED from PLAN-006 — ALTER, no rename).** Shipped columns `id/source/type/
title/body/payload/created_at/read_at` are kept. Added:

| Column | Type | Notes |
|--------|------|-------|
| `media_item_id` | uuid nullable FK → `media_items` (ON DELETE SET NULL) | best-effort ledger link |
| `tmdb_id`, `tvdb_id` | integer nullable | the media-match keys (from the payload) |
| `actor_user_id` | uuid nullable FK → `users` (ON DELETE SET NULL) | attributed requester/viewer |
| `occurred_at` | timestamptz NOT NULL default now() | source event time (existing rows backfilled = `created_at`) |
| `source_event_id` | text nullable | dedupe key |

Indexes: partial-unique **`(source, source_event_id) WHERE source_event_id IS NOT NULL`** (idempotent
re-delivery), `(occurred_at desc)` (Feed sort), `(media_item_id)`, and the kept `(source, created_at
desc)` (Trash Activity). `source` CHECK rebuilt → `['maintainerr','seerr','tautulli']`. Written only
by `recordNotification`.

**`messages`** — `id`, `author_user_id` (NOT NULL FK → users, cascade), `subject` (nullable), `body`
(NOT NULL), `media_item_id` (nullable FK → media_items, SET NULL), `status` (`MESSAGE_STATUSES =
['visible','hidden','deleted']`, default `visible`, CHECK), `created_at`, `edited_at` (author edit),
`moderated_by`/`moderated_at`/`moderation_note` (moderation trail). Indexes on `created_at desc`,
`author_user_id`, `media_item_id`. Flat v1. Written only by the message single-writers.

**`role_message_action_grants`** — `(role_id FK cascade, action)` PK, `action` CHECK from
`MESSAGE_ACTIONS = ['post','moderate']`. A row = the grant. Written only by `setRoleMessageActions`.

**Enum/CHECK rebuilds:** `SECTION_IDS += 'bulletin'` (section CHECK rebuilt; default level
`read_only`), `PERMISSION_AUDIT_ACTIONS += 'update_message_actions'` (CHECK rebuilt).

### D-02 — Per-source adapters (the VERIFIED webhook payloads)

Each source's parser lives in `apps/web/lib/webhook-sources.ts` (hand-rolled, zod-free — apps/web
carries no zod) and normalizes to the common `ParsedNotification` (`type`, `title`, `body`,
`occurredAt?`, `sourceEventId?`, `tmdb/tvdbId?`, `mediaType?`, `requesterEmail?`, sanitized
`payload`). All parsers read ONLY known keys (strips arbitrary + `__proto__`/`constructor`), cap
stored strings, coerce templated-number-strings to ints, and map empty strings to null.

**Seerr / Overseerr** — the **default webhook JSON template** (verified against `sct/overseerr`
`develop`: `src/components/Settings/Notifications/NotificationsWebhook/index.tsx` `defaultPayload` +
`server/lib/notifications/agents/webhook.ts` keyMap). At send time Overseerr replaces the `{{media}}`
/ `{{request}}` KEYS with `media` / `request` objects; ids are templated **as strings** (empty when
absent). We configure this default template unchanged:

```json
{
  "notification_type": "{{notification_type}}",
  "event": "{{event}}",
  "subject": "{{subject}}",
  "message": "{{message}}",
  "image": "{{image}}",
  "{{media}}": { "media_type": "{{media_type}}", "tmdbId": "{{media_tmdbid}}", "tvdbId": "{{media_tvdbid}}", "status": "{{media_status}}", "status4k": "{{media_status4k}}" },
  "{{request}}": { "request_id": "{{request_id}}", "requestedBy_email": "{{requestedBy_email}}", "requestedBy_username": "{{requestedBy_username}}" },
  "{{issue}}": { "issue_id": "{{issue_id}}", "reportedBy_email": "{{reportedBy_email}}" },
  "{{comment}}": { "comment_message": "{{comment_message}}", "commentedBy_email": "{{commentedBy_email}}" }
}
```

Mapping: `notification_type → type` (fallback `event`); `subject → title`; `message → body`;
`media.media_type → mediaType` (movie|tv); `media.tmdbId/tvdbId → tmdb/tvdbId`; requester email
`request.requestedBy_email` (fallback issue reporter, then commenter) `→ requesterEmail`;
**`source_event_id = "<notification_type>:<request_id>"`** (each request lifecycle event is one row;
exact re-send dedupes). Empty ids/emails → null (a TEST_NOTIFICATION stays unattributed).

**Tautulli** — the notification-agent body is **fully user-templated**, so we DESIGN the canonical
JSON we configure Tautulli to POST (Data tab), reading our own field names directly:

```json
{
  "event_type": "{action}",
  "subject": "{title}",
  "message": "{user} · {action} · {title}",
  "user": "{user}",
  "user_email": "{user_email}",
  "media_type": "{media_type}",
  "tmdb_id": "{themoviedb_id}",
  "tvdb_id": "{thetvdb_id}",
  "source_event_id": "{action}:{rating_key}:{unix_time}"
}
```

Mapping: `event_type → type`; `subject → title`; `message → body`; `media_type` normalized
(movie→movie; show/season/episode/series→tv); `tmdb_id`/`tvdb_id → tmdb/tvdbId`; `user_email →
requesterEmail` (best-effort — the Plex account email may match an app user, ADR-026 C-05);
`source_event_id` verbatim (best-effort dedupe — Tautulli has no stable upstream id).

**Maintainerr** — the PLAN-006 Overseerr-style template, unchanged (its unit test is the contract);
ADR-026 additionally lifts any `media.tmdbId/tvdbId` it carries so a Maintainerr event can link to a
ledger item too. Deletion-lifecycle events (`MEDIA_DELETED` etc.), no stable id ⇒ `source_event_id`
null ⇒ always inserts.

### D-03 — The receiver `POST /api/webhooks/[source]`

`apps/web/app/api/webhooks/[source]/route.ts` (`runtime='nodejs'`, `dynamic='force-dynamic'`).
Sequence: `[source] ∈ NOTIFICATION_SOURCES` else **404** → resolve the per-source env secret
(`WEBHOOK_SECRET_ENV[source]`), unset ⇒ **503** (fail-closed) → extract the provided secret
(`x-webhook-secret` header, `Authorization` header — raw value OR `Bearer <s>`, or `?token=`) →
**constant-time compare** (SHA-256 + `timingSafeEqual`), mismatch ⇒ **401** → read body, `>64KB` ⇒
**413** (before parse) → `JSON.parse`, failure ⇒ **400** → per-source parser, non-object/invalid ⇒
**400** → `recordNotification({ source, ...parsed })` → **202** `{ ok, id, deduped }`. Never echoes the
secret. In-cluster only (the sources POST the internal service URL). `/api/webhooks/maintainerr`
still resolves here (source='maintainerr') — no breakage.

`recordNotification` (the `@hnet/domain` single writer) resolves `actor_user_id` via
`resolveUserIdByEmail` and `media_item_id` via `resolveMediaItemId` (both factored out of ledger
backfill — D-07), then inserts `ON CONFLICT DO NOTHING`; a conflict returns the existing id with
`deduped: true`.

### D-04 — Permission matrix

| Capability | Gate |
|-----------|------|
| See the Bulletin section (nav + route) | `bulletin` section level ≠ `disabled` (default `read_only`) |
| Read the Feed / browse Messages | `sectionProcedure('bulletin','read_only')` |
| Post / edit own Message | `messageActionProcedure('post')` (own-only enforced in the domain) |
| Hide / delete / restore any Message; see hidden/deleted rows + moderation trail | `messageActionProcedure('moderate')` |
| Set a role's `bulletin` level | `roles.setSectionPermission` (adminProcedure) |
| Set a role's message action grants | `roles.setMessageActions` (adminProcedure → `setRoleMessageActions`, audits `update_message_actions`) |

Admin ⇒ `edit` on every section + every message action (no rows). Grants ride the session
(`SessionRole.messageActions`); `messageActionProcedure` reads them (no per-request query),
server-authoritative (AC-13).

### D-05 — Feed API (`communication.feed`) — the UX wire contract

`sectionProcedure('bulletin','read_only')`, input `{ source?, eventType?, hasMedia?, cursor?,
limit≤200 }`. Keyset over `occurred_at desc, id asc` (reuses `keyset.ts`), joined to `users`
(attributed name) + `media_items` (title/kind). Item: `{ id, source, eventType, title, body,
occurredAt, recordedAt, mediaItemId, mediaTitle, mediaArrKind, tmdbId, tvdbId, attributedUserId,
attributedUserName }` + `nextCursor`. NO full filter-engine port backend-side (Q-05) — simple params.

### D-06 — Messages API (`communication.messages.*`) — the UX wire contract

- `list` — `sectionProcedure('bulletin','read_only')`, input `{ status?, mediaItemId?, cursor?,
  limit≤200 }`, keyset `created_at desc, id asc`. **Non-moderators see only `visible`** (the status
  filter is ignored for them — never leaks); moderators see all + the moderation trail. Item: `{ id,
  authorUserId, authorName, subject, body, mediaItemId, mediaTitle, mediaArrKind, status, createdAt,
  editedAt, moderatedBy?, moderatedAt?, moderationNote? }` (moderation fields null for non-moderators).
- `post` — `messageActionProcedure('post')`, `{ subject?, body(1..8000), mediaItemId? }` → `postMessage`.
- `edit` — `messageActionProcedure('post')`, `{ messageId, subject?, body }` → `editMessage`
  (author-only; MESSAGE_NOT_OWNED → FORBIDDEN otherwise; sets `edited_at`). Only a **`visible`**
  message is editable — a moderated (hidden/deleted) message's content is the audit record, so an
  author edit is rejected (MESSAGE_MODERATED → CONFLICT) until a moderator restores it.
- `moderate` — `messageActionProcedure('moderate')`, `{ messageId, status, note? }` → `moderateMessage`
  (soft transition, preserves content, stamps the trail). UX: ConfirmButton for hide/delete (ADR-014).

### D-07 — Attribution reuse (the single path)

`resolveUserIdByEmail(db, email)` (case-insensitive `lower(email)` match) and `resolveMediaItemId(db,
{mediaType, tmdbId, tvdbId})` (movie→radarr tmdb; tv→sonarr tvdb, fallback tmdb; no hint ⇒ probe) are
**factored out of** `backfillEventAttribution` (`ledger-ingest.ts`) and reused by `recordNotification`
— never a second attribution path (ADR-008 C-05 unattributed fallback preserved).

### D-08 — The section UI (`/bulletin`)

- **Nav + gate** — a `Bulletin` primary-nav entry renders when the caller's `bulletin` level ≠
  `disabled` (the no-row default is `read_only`, so it falls OPEN like Ledger); the route is
  additionally server-gated in `app/(app)/bulletin/page.tsx` (Disabled ⇒ a clean "not available"
  card, mirroring `/trash`). The page resolves the caller's effective message actions server-side
  and passes them down — the client only ever renders affordances the server would honor (AC-13).
- **Tabs** — `Feed` and `Messages` (`?tab=`), the shared `/library`-style tablist.
- **Feed** — `communication.feed` infinite keyset pages in a table (When · Source · Event · What ·
  Media · Who); seg filters for source + media-link presence ride the URL (`?src`/`?media`) and
  swap the result set in place (`placeholderData` dims, never reflows — ADR-015). Long titles/bodies
  line-clamp inside the What column. Media cells link to `/library/[id]`; unattributed events say so.
- **Messages** — a composer card (the `post` grant; subject optional, body required, optional Media
  Item link via a small `ledger.search` popover picker — results overlay, nothing reflows) above the
  newest-first board. Cards show author/when/edited, the subject/body, the media link, and (to
  moderators only) the status badge + moderation trail. Author edit and moderator status+note triage
  are multi-field **Modals**; moderator hide/delete are inline two-step **ConfirmButtons** and
  restore is a plain protective button (ADR-014; hard rule 9 width reservation via `.confirm-btn`).
  Without `post` the composer is replaced by a read-only note; without `moderate` no moderation
  affordances render (and the server never sends hidden/deleted rows).
- **Admin** — `/admin/roles` gains a Bulletin column (level select + granted-action count summary,
  the Trash treatment) and a per-action `post`/`moderate` grid in the row editor + Add-role modal,
  writing through `roles.setSectionPermission` / `roles.setMessageActions`.

## Deploy / ops

- **Secrets** (three, all in 1Password `HaynesKube` via External Secrets; never committed):
  `MAINTAINERR_WEBHOOK_SECRET` (reused from PLAN-006), `SEERR_WEBHOOK_SECRET`,
  `TAUTULLI_WEBHOOK_SECRET`. Added to `.env.example` + the e2e runtime env. **haynes-ops (separate
  repo, out of this worktree):** add the two new keys to the app **ExternalSecret** and the Helm
  `env` (`secretKeyRef`, by name only) in
  `kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`, mirroring the existing
  `MAINTAINERR_WEBHOOK_SECRET` wiring. An unset secret fail-closes (503) that source — safe default.
- **Endpoint first, then wire the agents** (mirrors the PLAN-006 sequencing). Each source POSTs the
  **in-cluster** service URL `http://haynesnetwork.frontend.svc.cluster.local/api/webhooks/<source>`
  (NOT the public URL — works before the R-64 cutover):
  - **Seerr/Overseerr** (has a REST API — Fable can automate): Settings → Notifications → Webhook →
    enable, Webhook URL = the in-cluster `/api/webhooks/seerr`, **Authorization Header** =
    `Bearer <SEERR_WEBHOOK_SECRET>`, JSON payload = the default template (D-02). Select the desired
    notification types (Request Pending/Approved/Available, Issues).
  - **Tautulli** (manual UI): Settings → Notification Agents → add **Webhook** → Webhook URL = the
    in-cluster `/api/webhooks/tautulli`, Method = POST, add a JSON header `{"x-webhook-secret":
    "<TAUTULLI_WEBHOOK_SECRET>"}`, and on the **Data** tab paste the D-02 template for each triggered
    event (Playback Start/Stop, Recently Added).
  - **Maintainerr** (its API — PLAN-006 already wires it): unchanged; keep pointing at
    `/api/webhooks/maintainerr` (or the moved `[source]` URL — identical).
- **e2e** — the stack seeds `SEERR_WEBHOOK_SECRET` + `TAUTULLI_WEBHOOK_SECRET`, seeds **Bulletin
  Poster** + **Bulletin Moderator** roles + two Feed notifications, and `communication.spec.ts` POSTs
  per-source fixtures asserting rows land (attribution/dedupe) + secret gating.

### D-09 — Amendment 2026-07-11 (PLAN-027, ADR-049) — Bulletin sub-view visibility grants

The Bulletin section splits into two SEPARATELY GRANTABLE sub-views: the **Feed** and the
**Messages** board.

- **Model.** New `role_bulletin_view_grants` table — one row per granted view (`feed`, `messages`),
  a clone of `role_message_action_grants` in SHAPE (composite PK, FK cascade, CHECK, guard-listed).
  Written only by the `@hnet/domain` `setRoleBulletinViews` single-writer, which co-writes an
  `update_bulletin_views` permission_audit row in the same tx (hard rule 6). Migration **0039**.
- **Resolution (default-ON — the key divergence from message-actions).** A role with **NO** view
  rows resolves to **BOTH** views (ADR-026 C-02 "Bulletin is for everyone" — the section-default
  pattern, since these gate VISIBILITY, not an opt-in power). **Present** rows are the exact
  narrowing allowlist. Admin implies both (no rows). Writing an empty set RE-OPENS both — to hide
  Bulletin entirely, set the section level Disabled. The session carries the resolved views.
- **Enforcement (server-side — the correctness bar).** `communication.feed` gates on the `feed`
  grant, `communication.messages.list/post/edit/moderate` on the `messages` grant
  (`bulletinViewProcedure`, composed on top of the coarse `('bulletin','read_only')` gate; the
  message-action rung now builds on the messages-view gate). A role without a view gets **FORBIDDEN**
  — never a client-only hide. The `/bulletin` client renders only granted sub-tabs (a messages-only
  role has NO Feed tab and lands on Messages).
- **Admin UI (amends D-04).** The `/admin/roles` Bulletin cell becomes an **Enabled/Disabled**
  dropdown (ADR-049 — Bulletin has no meaningful Edit) with **[Feed] [Messages] checkboxes** under
  it (greyed/disabled when Bulletin is Disabled — the views are moot then; rendered, never removed,
  so no reflow — ADR-015), alongside the existing message-action count badge. Applied on change via
  `roles.setBulletinViews`; the boxes reflect the role's RESOLVED views (a no-row role shows both
  checked).
- **Seed / backfill.** Only the **Default** role is narrowed — migration 0039 seeds its
  `messages`-only row (the owner: the Feed is Family/Friends-oriented). Family/Friends/custom roles
  keep both via the no-row default (no backfill, no silent loss); Admin implies both.

### D-10 — Amendment 2026-07-11 (PLAN-034, ADR-050) — the Helpdesk ticket data model

The Messages board (D-01 `messages`, D-06 API, D-08 board UI) is **RETIRED**, replaced by a
household media-issue **ticket** system ("**Helpdesk**" — the display name is one constant,
`HELPDESK_NAME` in `apps/web/lib/bulletin.ts`; owner ratifies Helpdesk vs Tickets at screenshot
review). Migration **0040**:

- **Model.** `tickets` (author FK cascade, required `title` + `body`, `category` CHECK
  `TICKET_CATEGORIES = ['playback','audio','subtitles','quality','missing','other']`, nullable
  `media_item_id` SET NULL, `status` CHECK `TICKET_STATUSES = ['open','in_progress','complete',
  'rejected']` default open, `created_at`, `last_activity_at` — the wall's sort key, bumped by
  every reply/transition in the same tx). `ticket_events` — the APPEND-ONLY history: creation
  (`from_status` NULL → open) + every transition, optional household-visible `note`, actor SET
  NULL (history outlives accounts). `ticket_replies` — the flat thread (GitHub-issue style),
  immutable v1. All three guard-listed; single-writers `createTicket` / `transitionTicket` /
  `addTicketReply` in `packages/domain/src/tickets.ts`.
- **State machine** (`TICKET_TRANSITIONS`, requirement 5): `open ⇄ in_progress`; either →
  `complete` (TERMINAL — a recurrence is a new ticket) | `rejected` (RE-OPENS to open — the old
  hide/restore analog). Illegal edges throw `InvalidTicketTransitionError` → CONFLICT
  (`TICKET_INVALID_TRANSITION`) under the row lock, BEFORE any write.
- **Drop.** `DROP TABLE messages` — its rows were owner-ruled TEST DATA (PLAN-034 Q-03). The
  Feed store and both grant tables are untouched. Post-deploy, 3–4 realistic example tickets are
  filed through the app's own writers and LEFT in prod as onboarding examples.

### D-11 — Amendment 2026-07-11 (PLAN-034, ADR-050) — the tickets API + permission matrix (retires D-06)

`communication.tickets.*` replaces `communication.messages.*`:

- `list` — `bulletinViewProcedure('messages')`, `{ statuses?, category?, cursor?, limit≤200 }`
  (`statuses` = a validated state SET — HP-01 multi-select; absent = every state, explicit `[]` =
  nothing),
  keyset `last_activity_at desc, id asc`. **Household visibility (Q-01)**: everyone with the view
  sees ALL tickets — no hidden rows, no moderator-only fields. Items carry the wall-tile facts:
  title/category/status/author, linked-media `{ mediaItemId, mediaTitle, mediaArrKind, mediaYear,
  mediaPosterUrl (ADR-019 proxy, null ⇒ category icon) }`, `replyCount` (batched grouped pass),
  `createdAt`/`lastActivityAt`.
- `counts` — same gate; per-state totals for the filter chips (absent states 0).
- `detail` — same gate, `{ ticketId }` → `{ found:false }` on an unknown id, else the ticket +
  the FULL `events[]` timeline (actor names + notes) + `replies[]` + the static repair cue
  (`openFix`/`fixCount` off `fix_requests` — the D-06-era hint pattern kept).
- `create` — `messageActionProcedure('post')`, `{ title(1..200), body(1..8000), category,
  mediaItemId? }` → `createTicket` (which also enqueues the D-13 ping in the same tx).
- `reply` — **`bulletinViewProcedure('messages')` deliberately, NOT an action grant** (Q-02: any
  member who can see the board may chime in), `{ ticketId, body(1..8000) }` → `addTicketReply`.
- `transition` — `messageActionProcedure('moderate')` ONLY (Q-02 staff), `{ ticketId, toStatus,
  note?≤1000 }` → `transitionTicket`.

**The permission matrix (ADR-050 option H — zero new grant machinery):** view/browse/detail/
reply = the `messages` sub-view grant (D-09); create = message action `post`; transitions =
message action `moderate`; Admin implies all with no rows. Stored enum values are UNCHANGED —
only display labels moved to Helpdesk language (D-04's admin grid included).

### D-12 — Amendment 2026-07-11 (PLAN-034, ADR-050) — the Helpdesk UX (retires D-08's board half)

- **Tab order (requirement 1).** `/bulletin` tabs are **Helpdesk** (tab key `helpdesk`; rides the
  `messages` view grant) then **Feed**. `?tab=messages` deep-links alias to the Helpdesk (C-06 —
  never a 404). The Feed tab (D-08) is unchanged.
- **The wall (requirement 8 — the owner's Library-poster lean).** Tickets render as a
  poster-grid (`.twall`, the `.bwall`/`.poster-grid` grammar: auto-fill 132px 2:3 tiles, 3-up
  under 480px) sorted by `last_activity_at`. A linked ticket shows its title's poster
  (`MediaPoster`, ADR-019 authed proxy); a non-media ticket shows its intake-CATEGORY icon large
  in the same tinted 2:3 box (`ticket-glyphs.tsx` — the intake-driven icon set). Every tile bakes
  the STATE on: a colored corner puck (the Trash `bwall-overlay` idiom — open=warning
  issue-dot, in_progress=info half-ring, complete=accent check, rejected=muted slashed ring +
  grayscale poster) plus a `badge--{tone}` status label, the reply count, and the last-activity
  time in fixed-height caption rows (grid never staggers). The whole tile links to the detail.
- **Filters (requirement 7; MULTI-SELECT amended 2026-07-11, HP-01 — owner-approved).** The state
  chips (All · Open · In progress · Complete · Rejected, live per-chip counts baked in) replaced
  All/Visible/Hidden/Deleted. **They are MULTI-SELECT toggles, not single-select sub-sections** (the
  Library filter-chip idiom): each chip adds/removes that state from the ONE wall, "All" selects
  every state, and the visible set is the union of the selected states. **The DEFAULT selection is
  `{open, in_progress}`** — the wall leads with actionable work; Complete/Rejected are opt-in
  historical views (re-openable from there — the reject→open edge already exists). The selection is
  a D-09 refinement carried as **repeated `?state=` params** via `router.replace` (D-19 — shareable,
  no history entry, no per-user persistence: a fresh visit with no `?state` param ALWAYS resolves to
  the default). The canonical default writes NO param; a deliberately empty selection (every chip
  toggled off) writes the `state=none` sentinel and shows the "no states selected" empty state.
  Chips carry `aria-pressed`; toggling recolors in place — the bar never reflows (ADR-015). The
  `tickets.list` procedure takes a validated state SET (`statuses: TICKET_STATUSES[]`; absent = every
  state, an explicit empty array = nothing) — the caller-authoritative visible set.
- **Compose (requirement 2).** NEVER stacks above the wall: a "New ticket" button (the `post`
  grant) opens a multi-field **Modal** (ADR-014) — title ("What's wrong?"), the category icon
  grid (single-select, recolor-only), the optional linked-title search (the D-08 popover picker),
  details. Intake copy routes SITE bugs to GitHub (requirement 3 — the MOTD already links it).
  Success PUSHES the new ticket's detail page (the "it's filed" confirmation).
- **Detail (requirement 6).** `/bulletin/ticket/[id]` — the `/library/[id]` drill-in grammar:
  BackLink (`from=helpdesk`), the `.detail-head` hero (poster/category tile · title · state +
  category badges · repair cue · filed-by meta · "open in Library" deep link · the STAFF
  transition buttons the current state allows, each opening a Modal that carries the optional
  household-visible reason), the report body, the **History timeline** (`.timeline` — Filed +
  every transition with actor/when/note), and the reply thread with its composer BELOW the
  thread. Server-gated like `/bulletin` (section level + `messages` view; staff affordances ride
  the resolved `moderate` grant — AC-13).
- **Navigation (DESIGN-004 D-19).** Tab switches + ticket drill-ins PUSH history entries; the
  state chips and the Feed's `?src`/`?media` segs REPLACE. ADR-015 throughout: refetches dim in
  place, modals overlay, pickers popover, armed states recolor.

### D-13 — Amendment 2026-07-11 (PLAN-034, ADR-050) — the new-ticket admin ping (Q-04)

`createTicket` enqueues ONE `notification_outbox` row — new event type **`ticket_created`**
(CHECK rebuilt in 0040) — in the SAME transaction as the ticket + creation-event inserts
(ADR-034 C-01; window read + `computeEarliestSend` BEFORE the tx, the batch-writer pattern).
Payload `{ ticketId, title, category, authorName, mediaTitle }`; the renderer emits
"New Helpdesk ticket / <author>: "<title>" · <media>" deep-linking
`https://haynesnetwork.com/bulletin/ticket/<id>`. The existing `notify-outbox` CronJob drains it —
no new infra. Requester-facing pings wait for email (PLAN-035).

## Alternatives considered

See ADR-026 "Considered options" (notifications-in-ledger; Maintainerr-specific route; Messages
absorb Fix; BC-03 extension). All rejected there. The sub-view grant model + the deny-by-default
alternative are weighed in ADR-049 (Consequences C-02/C-04).

## Test strategy

- **Vitest (embedded PG16):** `recordNotification` attribution/dedupe/unattributed/null-id-insert
  (`notification-ingest.test.ts`); the FULL 4×4 ticket state-machine matrix (const AND
  DB-enforced), event-history append/notes, activity bumps, and the ticket_created outbox
  SAME-TX proof in both directions — committed together, rolled back together
  (`tickets.test.ts`); `setRoleMessageActions` + matrix (`message-permissions.test.ts`); Feed
  keyset + filters + attribution join + disabled FORBIDDEN, the PLAN-034 permission matrix —
  non-staff FORBIDDEN from every transition (author included), reply open to any messages-view
  holder / FORBIDDEN to feed-only, create needs `post` even for moderators, illegal edges
  CONFLICT, household-visible detail timeline (`communication.test.ts`); 0040 table CHECKs +
  outbox CHECK preservation + the messages-table DROP (`migrations.test.ts`); parser
  normalization (`webhook-sources.test.ts`); the no-direct-writes guard extended
  (`tickets`/`ticket_events`/`ticket_replies`; `messages` removed).
- **e2e (advisory):** `communication.spec.ts` — per-source webhook round-trips;
  `helpdesk.spec.ts` — member-files-ticket → staff-transitions-with-reason → member-replies →
  state filters, against the hermetic stack.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Per-user read/unread vs a global Feed | Global (household simplicity); `notification_reads` join table is the future extension. |
| Q-02 | Threaded replies / reactions / pinning | ~~Deferred~~ **Resolved by PLAN-034/ADR-050**: flat reply THREADS shipped on tickets (`ticket_replies`); reactions/pinning still out. |
| Q-03 | Can a Message **spawn** a Fix (vs link-only)? | Link-only (unchanged for tickets): the detail surfaces the linked item's repair cue + deep link; bidirectional spawn deferred. |
| Q-04 | The *arrs as notification sources | Deferred — they already feed `ledger_events`; adding them is optional/redundant. |
| Q-05 | Full filter-engine port for the Feed | Deferred — simple params (source/eventType/hasMedia) backend-side; the UX may layer the `@hnet/ui` chips later. |
| Q-06 | Ticket reply edit/delete (staff redaction) | Deferred (ADR-050 C-08) — replies are immutable v1; a redaction verb is the extension if ever needed. |
| Q-07 | Requester notifications on transition/reply | Blocked on email (PLAN-035); Pushover reaches admins only (single owner key — ADR-034). |
