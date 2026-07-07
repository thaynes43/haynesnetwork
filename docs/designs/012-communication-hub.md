# DESIGN-012: Communication hub — Bulletin Feed + Messages

- **Status:** Draft
- **Last updated:** 2026-07-07
- **Satisfies:** PRD-001 R-97..R-104; governed by ADR-026. Reuses ADR-021 (Section Permissions),
  ADR-023 (Trash action grants + the PLAN-006 notification store/receiver), ADR-008 (attribution),
  ADR-014/015 (ConfirmButton/Modal + no-reorient — the UX follow-up).

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
  (author-only; MESSAGE_NOT_OWNED → FORBIDDEN otherwise; sets `edited_at`).
- `moderate` — `messageActionProcedure('moderate')`, `{ messageId, status, note? }` → `moderateMessage`
  (soft transition, preserves content, stamps the trail). UX: ConfirmButton for hide/delete (ADR-014).

### D-07 — Attribution reuse (the single path)

`resolveUserIdByEmail(db, email)` (case-insensitive `lower(email)` match) and `resolveMediaItemId(db,
{mediaType, tmdbId, tvdbId})` (movie→radarr tmdb; tv→sonarr tvdb, fallback tmdb; no hint ⇒ probe) are
**factored out of** `backfillEventAttribution` (`ledger-ingest.ts`) and reused by `recordNotification`
— never a second attribution path (ADR-008 C-05 unattributed fallback preserved).

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

## Alternatives considered

See ADR-026 "Considered options" (notifications-in-ledger; Maintainerr-specific route; Messages
absorb Fix; BC-03 extension). All rejected there.

## Test strategy

- **Vitest (embedded PG16):** `recordNotification` attribution/dedupe/unattributed/null-id-insert
  (`notification-ingest.test.ts`); Messages post/edit-own/moderate soft-status (`messages.test.ts`);
  `setRoleMessageActions` + matrix (`message-permissions.test.ts`); Feed keyset + filters +
  attribution join + disabled FORBIDDEN, message action gating matrix + moderator visibility
  (`communication.test.ts`); widened-CHECK preservation + dedupe index (`migrations.test.ts`);
  parser normalization (`webhook-sources.test.ts`); the no-direct-writes guard extended
  (`messages`, `role_message_action_grants`).
- **e2e (advisory):** `communication.spec.ts` — per-source webhook round-trips.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Per-user read/unread vs a global Feed | Global (household simplicity); `notification_reads` join table is the future extension. |
| Q-02 | Threaded replies / reactions / pinning | Deferred — flat v1 (`messages`, no `parent_message_id`, no reactions). |
| Q-03 | Can a Message **spawn** a Fix (vs link-only)? | Link-only for v1; the UX surfaces the item's Fix affordance. Bidirectional spawn deferred. |
| Q-04 | The *arrs as notification sources | Deferred — they already feed `ledger_events`; adding them is optional/redundant. |
| Q-05 | Full filter-engine port for the Feed | Deferred — simple params (source/eventType/hasMedia) backend-side; the UX may layer the `@hnet/ui` chips later. |
