# PLAN-009: Bulletin — aggregated notification Feed + user Messages board

- **Status:** Completed (2026-07-07) — shipped v0.13.0; live-validated 7/7 on staging: Feed renders
  Maintainerr+Seerr+Tautulli events with distinct badges + attribution + media links; per-source
  webhook receiver verified live (202/401/413/404, dedupe idempotent, oversize capped); Feed filters
  URL-synced; Messages post/edit + moderation with content-preserving hide/restore; section +
  message-action role gating audited. Seam review found+fixed two real bugs pre-ship (streamed 64KB
  body cap; author can't rewrite moderated content). <!-- Fable 5 flips Draft → Executing → Completed -->
  <!-- 2026-07-07 (Fable 5): BACKEND vertical landed on branch `feat/bulletin` — ADR-026 (Accepted),
       DESIGN-012, PRD R-97..R-104, glossary T-81..T-88, BC-05; enums + migration 0018 (widen
       notifications + messages + role_message_action_grants); recordNotification attribution/dedupe;
       message writers + setRoleMessageActions; generic `POST /api/webhooks/[source]` receiver +
       Seerr/Tautulli/Maintainerr adapters; communication tRPC router (feed + messages);
       session.messageActions + messageActionProcedure; guard-list + e2e stubs + seed roles. The
       Feed/Messages **UI is the remaining Fable UX follow-up** (DESIGN-012 D-05/D-06 are its contract);
       ID numbering differs from the tentative plan values (re-grepped). -->
  <!-- 2026-07-07 (Fable 5, follow-up): SEAM REVIEW hardened the backend (streamed 64KB webhook
       body cap; author edits of moderated messages rejected MESSAGE_MODERATED→CONFLICT; new
       route-level secret-isolation/404-before-secret/proto-strip tests + status-filter-injection
       probes — all green). SECTION UX landed (DESIGN-012 D-08): nav entry + server-gated
       /bulletin (Feed table w/ source+media segs, keyset load-more; Messages board w/ composer +
       ledger.search media picker, author-edit Modal, moderator ConfirmButton hide/delete +
       restore + Triage Modal) + /admin/roles Bulletin column/action grid; e2e journeys pass
       (communication.spec.ts 7/7). REMAINING: deploy (haynes-ops secrets/env), wire the real
       Seerr/Tautulli/Maintainerr agents, LIVE validation, then mark Completed. -->
- **Satisfies:** PRD-001 new **R-89..R-96** (Bulletin — Feed + Messages); new **ADR-020**
  (communication hub: generic webhook ingestion + durable notification store + user message board +
  moderation/permission model + relationship to Fix and to BC-03 attribution); new **DESIGN-010**
  (Feed/Messages UI + the `notifications` model + per-source adapters + permission matrix). Relates
  ADR-008 (ledger/one-way sync + attribution C-05), ADR-014 (ConfirmButton/Modal), ADR-015
  (no-reorient), ADR-012 (unified Role), and the PLAN-005 Section-Permission ADR + the PLAN-006
  generic-webhook addendum (see Cross-plan coordination).
- **Depends on:** **PLAN-004** (the ported `@hnet/ui` filter/table engine + the `ledger.search`
  filter DSL — the Feed reuses it), **PLAN-005/006** (the `role_section_permissions` section-permission
  model + `sectionProcedure` middleware — this plan adds the Bulletin section id and, for
  Messages, a per-action grant table modeled on PLAN-006's `role_trash_action_grants`), **PLAN-006**
  (the generic notifications/webhook receiver — **006 introduces the store + `POST /api/webhooks/<source>`
  receiver with Maintainerr as source #1; 009 WIDENS it to Seerr + Tautulli and promotes the feed to a
  top-level section** — see Cross-plan coordination for the reuse-not-rebuild contract).
- **TODO source:** owner stretch request 2026-07-05.

> **ID reconciliation (Fable 5, do first):** the concrete numbers below (ADR-020, DESIGN-010,
> R-89.., migration 0011.., glossary T-56.., D-01..) are *tentative* — v0.4.0 ceilings are ADR-015,
> DESIGN-006, migration 0008, R-66, T-49, and **plans 002–008 execute before this one and consume
> IDs first**. Before authoring, grep the live ceilings (`grep -oE 'R-[0-9]+' docs/prds/001-haynesnetwork.md
> | sort -t- -k2 -n | tail`; ADR/DESIGN filenames; `T-` in the glossary; `packages/db/migrations/`) and
> take the next free block. IDs are stable once chosen (CLAUDE.md).

---

> ## ⚠️ STRETCH GOAL — not part of the core queue commitment
>
> This is a **stretch feature**. Build it **only after PLAN-002…008 are Completed + validated** and
> budget/time remains; the owner may also pick it up when home. It **MAY optionally land before
> PLAN-008 (public cutover)** if the owner wants it to launch with the public site — owner's call. It
> is **not** a queue commitment: if time runs out, this plan stays Draft with no partial build left
> behind. It also has a **hard prerequisite** that PLAN-006 shipped the generic notification store +
> `POST /api/webhooks/<source>` receiver; if 006 built that surface Maintainerr-specific, this plan's
> **first executable step is the refactor to the generic shape** (see Cross-plan coordination).

---

## Goal

A new **top-level section named "Bulletin"** (owner-chosen 2026-07-05; keep the nav label + route
slug in one place so it stays a trivial string swap) in the primary nav
(`apps/web/components/top-bar.tsx:195-198`, DESIGN-004 D-11) with
**two sub-tabs**:

1. **Feed** — an aggregated, filterable **notification feed**. Inbound webhooks from
   **Seerr/Overseerr, Tautulli, and Maintainerr** (optionally the *arrs later) are normalized into ONE
   durable `notifications` table and browsed through the **ported `@hnet/ui` filter engine** (PLAN-004,
   the same engine Library/Ledger/Trash use). Events are **attributed to app users** where the payload
   carries requester info — Seerr `request.requestedBy_email` → `users` — reusing the email-only
   auto-link that Seerr sync attribution already does (`packages/domain/src/ledger-ingest.ts:156-172`,
   `packages/sync/src/seerr.ts:84`; ADR-008 C-05 "unattributed" fallback). **Role-gated read.**

2. **Messages** — a user-driven, durable **message board**: users post messages about broken media /
   requests / general issues; optionally link a message to a `media_items` row; admins triage. This
   **COMPLEMENTS (does not replace) the structured Fix flow** — Fix is a targeted, audited action on
   one item (`packages/domain/src/fix-flow.ts`, `packages/api/src/routers/fix.ts`,
   `apps/web/app/(app)/library/[id]/fix-dialog.tsx`); Messages is free-form discussion/triage.
   **Role-gated: post / read / moderate.**

Both stores are **durable in Postgres 16** (never ephemeral). The Feed is a read-through browse over a
durable table; Messages is full CRUD with moderation. The section's whole visibility, plus each
sub-tab and the post/moderate actions, are gated by the shared Section-Permission model (PLAN-005/006).

---

## Docs-first artifacts to author (same PR as behavior)

### PRD-001 edits (`docs/prds/001-haynesnetwork.md`)
New subsection **### Bulletin (Phase 2.5 / stretch)** under Requirements:
- **R-89** A top-level Bulletin section (name TBD) with **Feed** + **Messages** sub-tabs;
  role-gated visibility per the Section-Permission model. *(Should — stretch)*
- **R-90** Inbound webhooks from **Seerr/Overseerr, Tautulli, Maintainerr** are ingested into ONE
  durable `notifications` store and shown in the Feed. *(Should)*
- **R-91** The Feed is **filterable** via the shared filter engine (source, event type, date, media,
  attributed user). *(Should)*
- **R-92** Notification events are **attributed to app users** where the payload carries requester
  identity (Seerr requester email → user), else shown unattributed. *(Should)*
- **R-93** Users can **post durable Messages** (subject optional, body required), optionally **linked
  to a media item**; a Message may reference/complement a Fix but does not replace it. *(Should)*
- **R-94** Admins/moderators can **triage Messages** (status transitions, hide/delete); destructive
  moderation is confirmed and audited. *(Should)*
- **R-95** Access is per-role: **read** the section, **post** Messages, **moderate** Messages — a
  Disabled section is hidden from nav and route-gated server-side. *(Should)*
- **R-96** The webhook receiver is **session-unauthenticated but per-source shared-secret-gated** and
  reachable only in-cluster (no public exposure; works before the R-64 public cutover). *(Must,
  security)*

### New ADR-020 (`docs/adrs/020-communication-hub.md`, MADR 3.0 — Fable 5 authors AND ratifies to Accepted)
Decides, in one ADR:
- **Generic webhook ingestion**: ONE `notifications` table + ONE parameterized route handler
  `POST /api/webhooks/[source]` with a **per-source shared secret** and a **per-source adapter** that
  normalizes each payload into the common model. **Generalizes** the PLAN-006 Maintainerr webhook
  addendum (`.agents/plans/006-trash-section.md:501-515`) — Maintainerr is source #1, Seerr + Tautulli
  are added here; the Trash "Activity" tab becomes a **filtered view of the same store** (see
  Cross-plan coordination for the reuse contract + the refactor path if 006 built it
  Maintainerr-specific).
- **`notifications` vs `ledger_events`**: notifications are a **separate durable store**, NOT more
  `ledger_events` rows. Rationale (record it): `ledger_events` is BC-03's append-only *arr-history /
  Seerr-request / Fix / Restore ledger written by the sync/domain writers
  (`packages/db/src/schema/ledger-events.ts`); inbound third-party webhooks are a different write
  cadence, a different source set, and carry read/seen state — mixing them bloats the ledger and its
  dedupe/attribution invariants. A sibling table isolates them (mirrors the ADR-016 "separate
  media_metadata" reasoning in PLAN-004).
- **Messages complement Fix, not replace it**: the message board is free-form discussion/triage; Fix
  stays the structured, per-item, audited action. Whether a Message can **spawn** a Fix or link
  bidirectionally is an Open Decision recorded here.
- **Moderation + permission model**: reuse `role_section_permissions` (add the Bulletin section
  id) for coarse read; add a fine-grained **per-action** grant (post / moderate) modeled on PLAN-006's
  `role_trash_action_grants` (a `role_message_action_grants` table). The permission mutation is a
  **BC-02 Entitlements** audited change; the Feed/Messages content is **BC-03 (or a new BC) Media
  Communication** — decide the bounded-context question below.
- **Bounded context**: decide + record whether this is a **new bounded context (BC-05 Media
  Communication)** or an **extension of BC-03 Media Ledger**
  (`docs/domain-driven-design/002-bounded-contexts.md:69` BC-03 owns Fix/Restore + attribution). Note
  the attribution reuse of BC-03's email-only Seerr auto-link (ADR-008 C-05).
- Consequences C-01.. (good: one notification brain, no phone spam, durable audit; bad: third-party
  payload drift needs adapter maintenance; shared-secret rotation is an ops step).

### DDD (`docs/domain-driven-design/001-ubiquitous-language.md` — glossary is normative)
New terms (tentative T-56..): **Notification** (T-56, a normalized inbound third-party event),
**Notification Source** (T-57, Seerr/Overseerr/Tautulli/Maintainerr[/*arrs]), **Feed** (T-58, the
filterable notification browse), **Message** (T-59, a user-posted durable board entry), **Message
Status** (T-60, its triage lifecycle), **Message Action Permission** (T-61, per-action post/moderate
grant), **Webhook Receiver** (T-62, the secret-gated in-cluster ingress). Add the Communication
**Section** name to the Section-Permission entry (T-51/T-54 per PLAN-005/006). Update
`002-bounded-contexts.md` per the ADR bounded-context decision (new BC-05 or a BC-03 extension), noting
attribution reuse. All added in the SAME change (glossary is normative).

### New DESIGN-010 (`docs/designs/010-communication-hub.md`, copy `docs/designs/000-template.md`)
- **D-01** `notifications` + `messages` (+ `role_message_action_grants`) schema; enums; dedupe +
  read/seen model.
- **D-02** Per-source adapter table: **Seerr/Overseerr**, **Tautulli**, **Maintainerr** payload →
  `notifications` columns (filled from each service's real webhook template — see Client below). Seerr
  fields to map: `notification_type`, `event`, `subject`, `message`,
  `media{media_type,tmdbId,tvdbId,status}`, `request{request_id,requestedBy_email,requestedBy_username}`.
- **D-03** The `POST /api/webhooks/[source]` route handler: per-source secret check, adapter dispatch,
  single-writer ingest, idempotent dedupe. In-cluster only.
- **D-04** Permission matrix: section read/post/moderate × role; how the nav/route gate + each tRPC
  procedure read it (extends the PLAN-005/006 `sectionProcedure`).
- **D-05** Feed UI: the ported filter table over `notifications` (attributed-user column, media link),
  no layout reorientation (ADR-015).
- **D-06** Messages UI: composer + durable list; ConfirmButton for destructive moderation, Modal for
  multi-field triage; optional media-item link + Fix cross-link.
- **D-07** Attribution reuse: Seerr requester-email → user via the existing email-only match
  (`ledger-ingest.ts:156-172`); Tautulli/Maintainerr attribution best-effort/none.

---

## Data model (`packages/db`)

### Enums — single source of truth (`packages/db/src/schema/enums.ts`; follow the `ARR_KINDS` pattern @ `enums.ts:26`)
- `NOTIFICATION_SOURCES = ['maintainerr','seerr','overseerr','tautulli'] as const` — the webhook
  sources (the *arrs are a later addition, an Open Decision). **Coordinate with PLAN-006:** if 006
  already created this enum (Maintainerr-only), **extend it**, don't duplicate.
- `MESSAGE_STATUSES = ['open','triaged','resolved','hidden'] as const` — the Messages triage
  lifecycle (exact set is an Open Decision).
- `MESSAGE_ACTIONS = ['post','moderate'] as const` — the fine-grained per-action grants (mirrors
  PLAN-006 `TRASH_ACTIONS`).
- Add `'communication'` (or the final section slug) to `SECTION_IDS` / `PERMISSION_SECTIONS` (created
  by PLAN-005/006 — reuse, add the one value).
- Extend `PERMISSION_AUDIT_ACTIONS` (`enums.ts:10-18`) with `'update_message'` /
  `'moderate_message'` (message moderation is a BC-02-audited-style change; or route message audit
  through the notifications/message store's own audit column — decide in D-01).
- Each new enum gets its CHECK constraint built from the const list in the migration, exactly like
  `ledger-events.ts:21-22,56-63` / `media-items.ts:17,73-84`.

### Tables (`packages/db/src/schema/`)
- **`notifications`** (`packages/db/src/schema/notifications.ts`) — mirror the `ledger_events`
  pgTable+CHECK shape (`ledger-events.ts:36-71`):
  - `id` uuid pk defaultRandom
  - `source` text NOT NULL — CHECK `NOTIFICATION_SOURCES`
  - `event_type` text NOT NULL — the source's notification/event type (kept as text, not a global
    enum — sources define their own; validate per-adapter)
  - `subject` text; `message` text
  - `media_item_id` uuid **nullable** FK → `media_items.id` on delete set null (the FK is best-effort,
    like `ledger_events.media_item_id`, `ledger-events.ts:40`); plus `tmdb_id`/`tvdb_id` integer for
    backfill matching (mirror the ledger's nullable-FK + external-id-in-payload pattern)
  - `actor_user_id` uuid **nullable** FK → `users.id` on delete set null (the attributed requester)
  - `occurred_at` timestamptz NOT NULL (source timestamp); `recorded_at` timestamptz default now
  - `source_event_id` text — dedupe key; partial unique index on `(source, source_event_id)` where
    not null (copy `ledger-events.ts:64-67` for idempotent re-delivery)
  - `payload` jsonb NOT NULL (sanitized raw webhook body)
  - **read/seen tracking** — an Open Decision (D-01): default a **global** feed with no per-user read
    state (simplest, matches a household); if per-user unread is wanted, a sibling
    `notification_reads(notification_id, user_id, read_at)` join table instead of a column.
  - indexes: `(source, occurred_at desc)`, `(event_type, occurred_at desc)`, `(media_item_id,
    occurred_at desc)` — mirror `ledger-events.ts:68-69`.
- **`messages`** (`packages/db/src/schema/messages.ts`):
  - `id` uuid pk; `author_user_id` uuid NOT NULL FK → `users.id`; `subject` text nullable; `body`
    text NOT NULL; `media_item_id` uuid nullable FK → `media_items.id` on delete set null; `status`
    text NOT NULL default `'open'` — CHECK `MESSAGE_STATUSES`; `created_at`/`updated_at` timestamptz;
    optional `moderated_by`/`moderated_at`.
  - **Threaded replies / reactions** — an Open Decision: default **flat** (no `parent_message_id`, no
    reactions) for v1; if threading is wanted, add `parent_message_id` self-FK; if reactions, a
    `message_reactions` table. Ship flat, note the extension.
- **`role_message_action_grants`** (`packages/db/src/schema/role-message-action-grants.ts`) —
  `role_id` FK → roles cascade, `action` text+CHECK (`MESSAGE_ACTIONS`), `enabled` boolean, PK
  `(role_id, action)`. Fine-grained post/moderate. Absent row ⇒ derived from the section level (edit ⇒
  post+moderate, read_only ⇒ read-only/no post, disabled ⇒ none). **Modeled on PLAN-006's
  `role_trash_action_grants`.**
- Export all from `packages/db/src/schema/index.ts`; add `NotificationRow`/`Insert`,
  `MessageRow`/`Insert`, grant types.

### Guard-list updates (HARD RULE — same change)
- **`packages/domain/__tests__/no-direct-state-writes.test.ts`** — add `notifications`/`notifications`,
  `messages`/`messages`, `role_message_action_grants`/`roleMessageActionGrants` to **every**
  `FORBIDDEN_PATTERNS` branch (`no-direct-state-writes.test.ts:33-68`): the `INSERT/UPDATE/DELETE` SQL
  forms and the `.insert()/.update()/.delete()` Drizzle forms. These tables may be written **only** by
  `@hnet/domain`. (`notification_reads` too, if that variant is chosen.)

### Migrations (`packages/db/migrations/` — next free after 002–008 consume 0009/0010)
- `00NN_notifications.sql`, `00NN_messages.sql`, `00NN_role_message_action_grants.sql` (+ the
  `PERMISSION_AUDIT_ACTIONS` / `SECTION_IDS` CHECK rebuilds). `drizzle-kit generate` from the schema;
  hand-verify the CHECKs render from the enum arrays. **Coordinate with PLAN-006:** if 006 already
  created `notifications`, this is an **ALTER** (widen the source CHECK, add columns) not a CREATE —
  see Cross-plan coordination.

---

## Domain (`packages/domain`) — single-writers, audit in the same tx

Mirror the ledger-ingest + Fix vertical: each guarded-state mutation wrapped in `inTransaction`, with
its durable/audit row written in the **same tx** (CLAUDE.md hard rule 6; pattern:
`ingestLedgerEvents` `packages/domain/src/ledger-ingest.ts:50-89`, `createRole`/`updateRole` audit-in-tx
`roles.ts:79,130` co-writing `permissionAudit` at `roles.ts:102,202`).

- **`recordNotification({ db, source, event })`** (new `packages/domain/src/notification-ingest.ts`)
  — the single writer for webhook ingest: insert into `notifications` with `ON CONFLICT DO NOTHING` on
  the `(source, source_event_id)` dedupe index (copy the `ingestLedgerEvents` idempotency
  `ledger-ingest.ts:56-71`). Resolve `actor_user_id` from the payload's requester email via the same
  case-insensitive email match Seerr attribution uses (`ledger-ingest.ts:156-172`; factor
  `resolveUserIdByEmail` for reuse), and `media_item_id` from `tmdb/tvdb` id like
  `backfillEventAttribution` (`ledger-ingest.ts:135-153`). Best-effort — unmatched stays null
  ("unattributed", ADR-008 C-05). **No mutating third-party call** — ingest is inbound-only, so no
  write-client confinement is needed here (unlike Fix/Restore/Maintainerr).
- **Message writers** (new `packages/domain/src/messages.ts`):
  - `postMessage({ db, authorId, subject?, body, mediaItemId?, actorId })` — insert a `messages` row
    in one tx; validate the optional `media_items` FK exists; permission (`post`) checked at the API
    gate + defence-in-depth here.
  - `updateMessageStatus` / `moderateMessage` / `deleteMessage` — status transition or hide/delete +
    an audit trail row (message store's own `moderated_by/at` and/or a `permission_audit`
    `moderate_message` row) in the same tx; reject moderating without the `moderate` grant.
- **Permission writers** — reuse PLAN-005/006's `setSectionPermission` for the coarse Communication
  section level; add `updateRoleMessageActions({ roleId, actions[], actorId })` (replace the
  fine-grained set + audit in one tx — clone PLAN-006's `updateRoleTrashActions`). **Read helper**
  `messagePermissionsForRole(roleId)` resolving `{ sectionLevel, actions:Set }` for gating (à la
  PLAN-006 `trashPermissionsForRole` / `effective-apps.ts`).
- **Invariants:** Admin implies read+post+moderate and cannot be disabled (mirror
  `SystemRoleImmutableError` guard, `roles.ts:145`); notification ingest is idempotent and never
  double-attributes; a Message linked to a media item never mutates that item (no *arr write —
  Messages are discussion only).

---

## Client / integration — the generic secured webhook receiver

- **Route handler** `apps/web/app/api/webhooks/[source]/route.ts` — a Next.js route handler
  (App Router, same class as `apps/web/app/api/health/route.ts` and the existing handlers under
  `apps/web/app/api/*`; `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`). External **POST**,
  **session-unauthenticated** but **per-source shared-secret-gated**:
  - `[source]` ∈ `NOTIFICATION_SOURCES`; unknown source ⇒ 404.
  - The secret is checked from a header/query per the source's webhook capability, against a
    per-source env secret: `SEERR_WEBHOOK_SECRET`, `TAUTULLI_WEBHOOK_SECRET`, and **reuse**
    `MAINTAINERR_WEBHOOK_SECRET` (introduced by PLAN-006). Constant-time compare; 401 on mismatch;
    never echo the secret.
  - Dispatch to a **per-source adapter** (`packages/domain/src/notification-adapters/*` or a small
    `@hnet/*` module — Fable decides the home) that Zod-parses the source payload and maps it to the
    `recordNotification` input. Writes go **THROUGH `recordNotification`** (the `@hnet/domain`
    single-writer) so the no-direct-state-writes guard passes.
  - **In-cluster only:** Seerr/Tautulli/Maintainerr all POST the internal service URL
    (`http://haynesnetwork.frontend.svc.cluster.local`), NOT the public URL — no public exposure, and
    it works **before** the R-64 public cutover (same posture as the PLAN-006 addendum,
    `006-trash-section.md:506-507`).
- **Per-source adapters (DESIGN-010 D-02):**
  - **Seerr / Overseerr** — configurable webhook JSON template; map `notification_type`, `event`,
    `subject`, `message`, `media{media_type,tmdbId,tvdbId,status}`,
    `request{request_id,requestedBy_email,requestedBy_username}`. `request_id` → `source_event_id`
    (dedupe); `requestedBy_email` → `actor_user_id` (email match); `tmdbId/tvdbId` → `media_item_id`.
  - **Tautulli** — configurable notification-agent JSON payload (the agent's body is fully
    user-templated); pick a canonical template (title/event/user/media ids) and map it. Attribution
    is best-effort (Tautulli usernames aren't app emails — Open Decision whether to attempt a join).
  - **Maintainerr** — reuse the PLAN-006 adapter/shape; deletion-lifecycle events
    (flagged/leaving-soon/excluded/deleted). If 006 stored these Maintainerr-specifically, migrate them
    into `notifications` (see Cross-plan coordination).
- **Research task (Fable 5, live) — fill DESIGN-010 D-02 from the real services.** Confirm each
  service's exact webhook template + how the shared secret rides (header vs templated field vs query),
  against the running Seerr/Overseerr, Tautulli, and Maintainerr instances (the same estate PLAN-004/006
  integrate). Record the adapter map in D-02.

---

## API (`packages/api`) — `communication` tRPC router (the webhook receiver is the route handler, NOT tRPC)

- **New `packages/api/src/routers/communication.ts`**, registered in
  `packages/api/src/routers/index.ts:11-25` (alongside `ledger`, `fix`, `restore`).
- **Gating** — reuse the PLAN-005 `sectionProcedure(sectionId, minLevel)` middleware (composed from
  `authedProcedure` like `adminProcedure`, `packages/api/src/middleware/role.ts`) plus a
  `messageAction('post'|'moderate')` factory (clone PLAN-006's `trashAction`) reading
  `messagePermissionsForRole`. All domain calls wrapped in `mapDomainErrors` (pattern:
  `restore.ts`, `fix.ts:64`).
- **Procedures:**
  - `communication.feed` (`{ filter, cursor }`) — `sectionProcedure('communication','read_only')`
    query: the PLAN-004 filter DSL over `notifications` (source, event_type, date range, media,
    attributed user), keyset-paginated (reuse `cursor.ts` + the `ledger.ts`/`fix.ts:170-174` keyset
    shape); joins `media_items`/`users` for the media link + attributed-user label.
  - `communication.messages.list` (`{ filter, cursor }`) — `sectionProcedure('communication','read_only')`.
  - `communication.messages.post` — `messageAction('post')` mutation → `postMessage`.
  - `communication.messages.moderate` / `.delete` — `messageAction('moderate')` mutation →
    `updateMessageStatus`/`moderateMessage`/`deleteMessage`.
  - `roles.setSectionGrant` (Bulletin section) + `roles.setMessageActions` — `adminProcedure`
    (extend the existing `roles` router) → the domain permission writers.

---

## UI (`apps/web`)

- **Top-level nav** — add the section `<Link>` to `components/top-bar.tsx:195-198` (Primary nav, after
  Library/Ledger/Trash). **Visible only** when the role's Bulletin section level ≠ `disabled`
  (server-gated route + client-hidden nav; thread the level through the session as PLAN-005 does with
  `sectionPermissions`).
- **`app/(app)/<section>/layout.tsx`** — server-side gate: redirect to `/` if the section is disabled
  (pattern: `admin/layout.tsx:11-14` `protectedRouteRedirect`). Sub-nav landmark: **Feed · Messages**,
  each shown per the role's grants (Messages composer hidden without `post`; moderation controls hidden
  without `moderate`).
- **Feed page** (`'use client'`) — the **ported `@hnet/ui` filter table** (PLAN-004) over
  `communication.feed`; columns: source, event type, subject/message, media (link to the Library item
  when `media_item_id` set), attributed user, occurred_at. **No layout reorientation** (ADR-015):
  filter/sort swaps the result set; interactions change color/emphasis, never reflow neighbors.
- **Messages page** (`'use client'`) — a **composer** (subject optional, body required, optional
  media-item picker + optional "relates to a Fix" cross-link) + a **durable list**. Destructive
  moderation (hide/delete) uses the **`@hnet/ui` ConfirmButton** inline two-step
  (`packages/ui/src/controls/ConfirmButton.tsx`; ADR-014, never `window.confirm`); a multi-field triage
  (status + note) uses a **Modal** (`components/modal.tsx`, like `admin/restore/page.tsx:273`). Armed
  confirm reserves the widest label width so the row can't shift (ADR-015 / hard rule 9).
- **Fix cross-link** — a Message linked to a media item surfaces a link to that item's Fix affordance
  (`library/[id]/fix-dialog.tsx`) and to the caller's fix history (`my-fixes/page.tsx`); admins see the
  admin fix queue (`admin/fixes/page.tsx`). Whether posting a Message can **spawn** a Fix is an Open
  Decision (default: link only, no auto-spawn).

---

## Ops

- **Env / secrets** — add `SEERR_WEBHOOK_SECRET` and `TAUTULLI_WEBHOOK_SECRET` (secrets) to
  `.env.example`, the app ExternalSecret, and the Helm env in
  `haynes-ops kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml` (reference the
  1Password `HaynesKube` item **by name only** — never commit the value; `secretKeyRef` pattern used by
  the *arr HelmReleases). **Reuse** `MAINTAINERR_WEBHOOK_SECRET` from PLAN-006. No new non-secret URLs
  (webhook targets are the source services pointing AT us).
- **Configure each source's webhook agent to POST the in-cluster endpoint** — note which Fable can do
  via API vs manual UI:
  - **Seerr/Overseerr** — has a REST API; Fable can create/enable the webhook notification agent via
    API (endpoint URL + JSON template + secret) once the receiver ships.
  - **Maintainerr** — configurable via its API (PLAN-006 already wires the Maintainerr webhook agent —
    reuse it, just widen the target/store).
  - **Tautulli** — its notification agent is **manual UI** (add a Webhook agent, paste the endpoint +
    the JSON template); document the exact steps in DESIGN-010 D-03.
  - **Endpoint first, then wire the agents** (mirror the PLAN-006 addendum sequencing,
    `006-trash-section.md:512-514`).
- **e2e stub** — a stub that POSTs each source's **sample payload** to the receiver
  (`apps/web/e2e/support/`), asserting a `notifications` row lands per source; wire into
  `global-setup`/`harness`/`env` so e2e stays hermetic (pattern: the PLAN-006 `stub-maintainerr.ts` +
  PLAN-004 stub Tautulli/Seerr).
- **Deploy** — bump the image tag in the haynes-ops HelmRelease + `flux reconcile`
  (`docs/ops/004-deploy-runbook.md`).

---

## Open decisions for Fable 5 (authorized to decide + record as ADR-020 / DESIGN-010 Q-NN)

1. **Final section name** — RESOLVED: **Bulletin** (owner, 2026-07-05); sub-tabs **Feed** + **Messages**.
2. **Message board scope** — flat vs **threaded replies** (`parent_message_id`); **reactions**
   (`message_reactions`); **admin announcements / pinning**. Default: flat, no reactions, no pinning
   for v1; note the extensions.
3. **Moderation + per-action granularity** — the exact `MESSAGE_STATUSES` set and whether post/moderate
   is the full `MESSAGE_ACTIONS` union or finer (e.g. `delete` split from `hide`).
4. **Which sources in v1** — Seerr + Overseerr + Maintainerr + Tautulli now, the ***arrs later** (the
   *arrs already feed `ledger_events`; adding them as notification sources is optional and may be
   redundant — decide).
5. **Message ⇄ Fix relationship** — link-only vs a Message can **spawn** a Fix vs bidirectional
   back-reference.
6. **Per-user read/unread tracking vs a global feed** — default **global** (household simplicity); add
   `notification_reads` only if per-user unread is wanted.
7. **Bounded context** — new **BC-05 Media Communication** vs an extension of **BC-03 Media Ledger**.
8. **Notification store ownership with PLAN-006** — who creates `notifications` + the `[source]`
   receiver + `NOTIFICATION_SOURCES` (see Cross-plan coordination; 006 lands first as Maintainerr #1).

---

## Cross-plan coordination

- **PLAN-006 (CRITICAL — reuse, do NOT rebuild).** PLAN-006's addendum
  (`.agents/plans/006-trash-section.md:501-515`) introduces a **Maintainerr Webhook → secured
  in-cluster endpoint → a Trash "Activity" tab**. PLAN-009 **generalizes** that same surface:
  - The generic `notifications` table + `POST /api/webhooks/<source>` receiver (per-source shared
    secret) is **introduced in 006 with Maintainerr as source #1**; 009 **WIDENS** it to Seerr +
    Tautulli and **promotes** the feed to this top-level section. The Trash "Activity" tab becomes a
    **filtered view (`source='maintainerr'`) of the same store**.
  - **If 006 built it Maintainerr-specific** (e.g. stored events in `ledger_events source:'maintainerr'`
    or a `trash_notifications` table, per 006's stated "or" options): 009's **first executable step is
    the refactor** to the generic shape — create/rename to `notifications`, generalize the route to
    `[source]`, add `NOTIFICATION_SOURCES`, and migrate the existing Maintainerr rows into
    `notifications` (a data migration). Keep the Trash Activity tab working against the new store.
  - **If 006 already built the generic shape** (recommended, and this plan should *say so to 006* if it
    executes first): 009 only ADDs the Seerr/Tautulli adapters + secrets, widens the source enum CHECK
    (an ALTER, not a CREATE), and adds the top-level section + Messages board.
- **PLAN-004** — the Feed's filter table reuses the **ported `@hnet/ui` filter/table engine** and the
  filter DSL. Hard dependency; do not reimplement filtering.
- **PLAN-005/006** — reuse `role_section_permissions` + `sectionProcedure` for the coarse section
  read-gate, and the `role_trash_action_grants` shape for the fine-grained `role_message_action_grants`
  (post/moderate). Add only the Bulletin section id + the message-action table; don't fork the
  model.
- **Attribution (BC-03)** — reuse the email-only Seerr requester→user auto-link
  (`ledger-ingest.ts:156-172`, ADR-008 C-05 unattributed fallback); do not invent a second attribution
  path.

---

## Verification

### Unit / integration (Vitest, embedded PG16 — `@hnet/test-utils`)
- **Per-source payload normalization** — Seerr, Overseerr, Tautulli, Maintainerr fixture payloads →
  `recordNotification` input → correct `notifications` columns; Seerr `requestedBy_email` attributes to
  a seeded user; unknown email stays unattributed; `tmdb/tvdb` id links `media_item_id`.
- **Ingest idempotency** — re-POSTing the same `(source, source_event_id)` is a no-op (dedupe index).
- **Message writers** — `postMessage` inserts + validates the optional media FK; `moderateMessage`
  writes the moderation/audit row in the same tx and rejects without the `moderate` grant.
- **Feed filters** — the PLAN-004 filter DSL over `notifications` returns the right rows; keyset
  pagination stable with ties.
- **Permission gating** — `messagePermissionsForRole` matrix (edit ⇒ post+moderate, read_only ⇒
  read-only, disabled ⇒ none; Admin ⇒ all, cannot be disabled); `sectionProcedure` +
  `messageAction` return FORBIDDEN below grant.
- **Guard tests stay green** — the extended `no-direct-state-writes.test.ts` (notifications, messages,
  role_message_action_grants).
- **Webhook receiver auth** — wrong/missing per-source secret ⇒ 401; unknown source ⇒ 404; valid
  secret ⇒ row written.
- **Merge gate:** `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build` all green.

### e2e (Playwright, hermetic — stub webhook POSTs)
- New `apps/web/e2e/communication.spec.ts`: a stub POSTs each source's sample payload to
  `/api/webhooks/<source>` → the rows appear in the Feed (filterable); nav visibility per role
  (disabled ⇒ no section link); post a Message → it persists and shows in the list; moderate a Message
  shows the ConfirmButton (destructive) / Modal (multi-field); a read-only role sees the Feed but no
  composer.

### LIVE Playwright against real staging (`https://haynesnetwork.haynesops.com`) + real backing servers
- Configure a **real** Seerr/Overseerr, Tautulli, and Maintainerr webhook to the in-cluster endpoint;
  **trigger an event** on each (e.g. a Seerr request, a Tautulli playback, a Maintainerr flag) and
  confirm each **appears in the Feed** with the right source/attribution.
- **Post a Message** and confirm it **persists** (durable across reload); moderate it and confirm the
  status transition + audit.
- **Confirm role gating** hides the whole section when the role's Communication level is Disabled, and
  hides the composer under read-only.

---

## Definition of Done

- Docs-first artifacts authored **in the same PR** (PRD R-89..R-96; ADR-020 authored **and ratified to
  Accepted**; glossary T-56..T-62 + the BC decision; DESIGN-010 with D-02 filled from the real webhook
  templates).
- Merge gate green; branch `feat/communication-hub` → PR → required checks (`lint-and-typecheck`,
  `test`, `build`) green → squash-merge (conventional commit `feat:`).
- Deployed to staging (image tag bumped in `haynes-ops .../helmrelease.yaml` + `flux reconcile`); the
  three source webhook agents wired to the in-cluster endpoint (Seerr + Maintainerr via API, Tautulli
  via UI).
- The LIVE journeys pass: a real event from each source lands in the Feed; a Message persists +
  moderates; role gating hides the section when Disabled.
- Plan marked **Completed** + `git mv .agents/plans/009-communication-hub.md
  .agents/plans/completed/`.

---

## Out of scope

- **Replacing the Fix flow** — Messages complement it; Fix stays the structured per-item action
  (PLAN-002/DESIGN-005).
- **Outbound notification routing** (Pushover/phone forwarding) — the in-app Feed is the sink; the
  PLAN-006 addendum's optional Pushover-forward for high-signal Trash events stays in PLAN-006's scope,
  not re-litigated here (a later plan may add a general router).
- **The *arrs as notification sources** — deferred (Open Decision #4); they already feed
  `ledger_events`.
- **The filter engine + `role_section_permissions` model + Maintainerr webhook receiver themselves** —
  delivered by PLAN-004 / PLAN-005 / PLAN-006; this plan reuses/extends them.
- **Public `haynesnetwork.com` cutover** — PLAN-008 (though this plan MAY land alongside it — owner's
  call).

---

## Rollback

- **Feature-flag / nav:** setting every role's Bulletin section to `disabled` hides the section
  and gates every `communication.*` procedure — an instant kill switch without a deploy. The webhook
  receiver can be neutralized by rotating/removing the per-source secrets (401s all inbound).
- **Deploy:** revert the haynes-ops image tag to the prior release + `flux reconcile`.
- **Data:** the migrations are additive (new tables/enums; a widened `notifications` source CHECK if
  006 pre-created it) — a down path drops `notifications`/`messages`/`role_message_action_grants` (and,
  if 009 refactored 006's Maintainerr store into `notifications`, the reverse data migration restores
  the 006 shape). Project convention is forward-only migrations (PLAN-004/005 rollback = image-revert,
  not schema-revert), so rollback is the image revert; the additive tables sit inert.
- **Safety:** the receiver is inbound-only and writes nothing outside `notifications`; Messages never
  mutate media/*arr state, so a rollback of this app leaves the media estate and the source services
  untouched.
