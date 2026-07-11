# ADR-050: Helpdesk ticket domain — the Bulletin Messages board becomes a media-issue ticket system

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Tom Haynes (owner requirements + rulings Q-01..Q-05, PLAN-034), Fable 5 (delegated
  UX/design authority, owner-explicit)

## Context and problem statement

The Bulletin **Messages** board (ADR-026 option F — a flat, soft-moderated free-form board) is the
owner-declared weakest page on the site: the compose form stacks above the list (worst on mobile),
"moderation" (hide/delete) is the wrong lifecycle for what the household actually posts (broken
media reports), and a report has no state, no thread, and no resolution trail. PLAN-034 rebrands the
board into a **media-issue ticket system** ("Helpdesk"): household members report media/playback
issues, staff triage them through an explicit state machine, and anyone in the household can follow
and chime in. Site bugs are out of scope (they go to GitHub — the MOTD already links it).

The decisions: the ticket data model (state, transition history, threaded replies); the state
machine and who may drive it; how ticket permissions map onto the existing Bulletin grant machinery
(ADR-026 message actions, ADR-049 sub-view grants); what happens to the `messages` table and its
API/UI surface; and how staff get notified of new tickets.

## Decision drivers

- **Owner requirements 1–8 + morning rulings Q-01..Q-05 (PLAN-034)** — normative: tickets first tab,
  state machine `Open → InProgress → Complete | Rejected` with optional reason on EVERY transition
  and full history, threaded replies, household visibility, staff-only transitions, create = post
  grant, replies open to any member with the Messages view, new-ticket Pushover ping, existing
  messages dropped as test data.
- **Reuse the proven grant machinery** — ADR-026 `role_message_action_grants` (post/moderate) and
  ADR-049 `role_bulletin_view_grants` already express exactly the rungs tickets need; a parallel
  grant model would be a second brain.
- **Single-writer + audit-in-same-tx** (hard rule 6) and the **transactional outbox invariant**
  (ADR-034 C-01): a new-ticket ping must commit with the ticket or not at all.
- **The rename must stay a trivial string change** (owner ratifies "Helpdesk" vs "Tickets" at
  screenshot review) — no stored value may encode the display name.
- **Postgres 16, text+CHECK enums, append-only history** (DESIGN-001 D-02, the ledger discipline).

## Considered options

- **A. Evolve `messages` in place** (add state/category columns + `parent_message_id` for replies)
  vs **B. A new ticket aggregate** (`tickets` + `ticket_events` + `ticket_replies`), dropping
  `messages`.
- **C. Reuse `FIX_REASONS` as the ticket intake taxonomy** vs **D. A ticket-specific category set.**
- **E. Track state changes as columns on the ticket row only** (last-transition trail, the old
  moderation shape) vs **F. An append-only `ticket_events` history table** owned by the aggregate.
- **G. New grant kinds** (`ticket_create` / `ticket_triage` tables or actions) vs **H. Map tickets
  onto the EXISTING grants** (create = `post`, transitions = `moderate`, view/reply = the
  `messages` sub-view).

## Decision outcome

Chosen: **B + D + F + H**.

- **B — a new ticket aggregate; `messages` is dropped.** A ticket is a different aggregate from a
  board message: it has a required title and intake category, a state machine, an event history,
  and a reply thread — retrofitting five columns plus a self-FK onto `messages` would leave every
  row half-shaped and keep the dead moderation trail around. Migration **0040** creates
  `tickets`, `ticket_events`, `ticket_replies` and **DROPS `messages`** — the owner ruled the
  existing rows are test data, not household history (Q-03), and nothing else reads the table. The
  Feed (`notifications`) is untouched. Post-deploy, a few realistic example tickets are filed
  through the app's own writers and left in prod as onboarding examples (Q-03).
  - **`tickets`** — `id`, `author_user_id` (NOT NULL FK → users, cascade), `title` (NOT NULL — the
    issue summary the wall tile shows), `body` (NOT NULL), `category` (CHECK `TICKET_CATEGORIES`),
    `media_item_id` (nullable FK → media_items, SET NULL — the linked title), `status` (CHECK
    `TICKET_STATUSES`, default `open`), `created_at`, `last_activity_at` (NOT NULL — bumped by
    replies and transitions in the same tx; the wall's sort key). Indexes: `(last_activity_at
    desc)`, `(status)`, `(author_user_id)`, `(media_item_id)`.
  - **`ticket_events`** — the append-only transition history (the D-06-era "moderation trail"
    generalized): `id`, `ticket_id` (FK cascade), `actor_user_id` (FK → users, SET NULL — history
    survives account deletion), `from_status` (nullable — null marks the creation event),
    `to_status` (NOT NULL), `note` (nullable — the optional reason/comment carried by EVERY
    transition), `created_at`. Creation writes the first event (`null → open`) in the same tx, so
    the detail timeline always starts at "Filed". Never updated, never deleted.
  - **`ticket_replies`** — the thread: `id`, `ticket_id` (FK cascade), `author_user_id` (NOT NULL
    FK → users, cascade), `body` (NOT NULL), `created_at`. Flat thread (one level, GitHub-issue
    style) — "threaded replies" per the owner means a conversation ON the ticket, not nesting.
  - All three tables are guard-listed — written only by the `@hnet/domain` ticket single-writers
    (`createTicket`, `transitionTicket`, `addTicketReply`).
- **The state machine** (`TICKET_STATUSES = ['open','in_progress','complete','rejected']`):

  | From \ To | open | in_progress | complete | rejected |
  |-----------|------|-------------|----------|----------|
  | **open** | — | ✓ | ✓ | ✓ |
  | **in_progress** | ✓ | — | ✓ | ✓ |
  | **complete** | ✗ | ✗ | — | ✗ |
  | **rejected** | ✓ (re-open) | ✗ | ✗ | ✗ |

  `open ⇄ in_progress` moves freely (staff pick up / put back); either may close to `complete` or
  `rejected` (a duplicate or GitHub-bound report can be rejected without fake triage — the owner's
  arrow `Open → InProgress → Complete | Rejected` is the happy path, not a click tax).
  **`complete` is terminal** — a recurrence is a NEW ticket (the history stays honest);
  **`rejected` re-opens** to `open` (the analog of the old hide/restore, per requirement 5).
  Self-transitions and everything else are rejected by `transitionTicket`
  (`InvalidTicketTransitionError`). Today's "Triage" concept is absorbed by `in_progress`. The
  matrix is the exported `TICKET_TRANSITIONS` const — the domain test proves the full matrix.
- **D — a ticket-specific intake taxonomy** (`TICKET_CATEGORIES = ['playback', 'audio',
  'subtitles', 'quality', 'missing', 'other']`). `FIX_REASONS` is the *repair-path* selector for a
  structured Fix on an on-disk item; ticket intake is broader (buffering, client apps, things not
  in the ledger) and member-facing — the category drives the icon-tile art for non-media tickets
  and a glyph on media tiles. A category never routes an automated action (tickets stay
  discussion + staff action; the Fix flow is unchanged and reachable from the linked item).
- **F — append-only `ticket_events` history.** Requirement 5 demands FULL transition history with
  per-transition notes; last-writer columns (the old `moderated_*` shape) can't express it. The
  events table is the aggregate's own audit record (the BC-03/BC-04 pattern — D-12: domain
  aggregates own their audit rows; `permission_audit` stays for role/grant mutations only).
  Transition notes are **household-visible** (unlike the old moderator-only note): "Rejected —
  that's a site bug, filed on GitHub" is exactly what the reporter needs to read.
- **H — map onto the existing grants; nothing new to administer.**

  | Capability | Gate (unchanged machinery) |
  |-----------|---------------------------|
  | See the Helpdesk tab, browse/read ALL tickets (household visibility, Q-01) | `bulletin` section ≥ read_only AND the `messages` sub-view grant (ADR-049) |
  | Create a ticket | message action `post` (ADR-026) |
  | Reply to ANY ticket | the `messages` sub-view grant — any member who can see the board may chime in (Q-02); NOT gated on `post` |
  | Transition state (any edge, incl. re-open) | message action `moderate` ONLY (Q-02 "staff") |
  | Grant admin | the existing `/admin/roles` Bulletin cell — no new tables, no new audit action |

  The stored enum values **do not change**: `BULLETIN_VIEWS` keeps `'messages'` (now labeled
  "Helpdesk" in the UI), `MESSAGE_ACTIONS` keeps `post`/`moderate` (now labeled "create tickets" /
  "triage & transitions" where displayed). This is what keeps the Helpdesk↔Tickets rename — and any
  future one — a display-string change (decision driver 4).
- **Notifications (Q-04).** `createTicket` enqueues ONE `notification_outbox` row (new event type
  `ticket_created`, CHECK rebuilt in 0040) in the SAME transaction as the ticket + creation-event
  inserts (ADR-034 C-01 — the house invariant, same as the batch writers). The renderer deep-links
  the ticket detail page. Requester-facing pings wait for email (PLAN-035); Pushover reaches the
  admins (single owner key — ADR-034).
- **Dropped with the board (deliberate):** author content-edit (a reply supersedes it — the thread
  is the record; revisit on demand), the moderator hide/delete/restore verbs (absorbed by
  `rejected` + re-open), and the `visible/hidden/deleted` status filters (replaced by the state
  filters, requirement 7). The `communication.messages.*` tRPC surface is REMOVED and replaced by
  `communication.tickets.*` — the messages domain writers and their tests go with it.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: a report now has a lifecycle — state, staff attribution, per-transition reasons, and a full timeline — instead of a moderation trail; the household sees known issues (Q-01) before re-reporting them. |
| C-02 | Good: zero new permission surface — tickets ride the post/moderate actions + messages sub-view grants the owner already administers; Admin implies all with no rows, exactly as before. |
| C-03 | Good: the outbox invariant holds — a new-ticket ping commits with the ticket or not at all (same-tx enqueue, unit-proven); staff hear about tickets without watching the page. |
| C-04 | Good: `ticket_events` is append-only and creation-inclusive — the detail timeline is a total record (who filed, who moved it, why) with no reconstructable gaps. |
| C-05 | Good: the display name is a string constant — "Helpdesk" ⇄ "Tickets" (owner ratifies at screenshot review) touches no stored value, route param, or grant row. |
| C-06 | Bad: the old board's data and surface are gone — `messages` rows (owner-ruled test data), author edit, and hide/delete. Anyone linking `/bulletin?tab=messages` lands on the Helpdesk tab (the `?tab` value is aliased, never 404s). |
| C-07 | Bad: `complete` being terminal means a botched fix needs a new ticket rather than a re-open — accepted for an honest history; `rejected → open` covers the "closed too hastily" case. |
| C-08 | Neutral: replies are immutable v1 (no edit/delete — any member with the view can write one, so the thread is a plain record); a staff redaction verb is a future extension if abuse ever appears in a household app. |

## More information

- Satisfies PLAN-034 (owner requirements 1–8, rulings Q-01..Q-05); PRD R-160..R-164; DESIGN-012
  D-10..D-13 (the amended communication-hub design); glossary T-145..T-148.
- Builds on ADR-026 (Bulletin section, message action grants — the board this supersedes the
  *Messages* half of; the Feed half is untouched), ADR-049 (sub-view grants), ADR-034
  (transactional outbox), ADR-014/015 (ConfirmButton/Modal + no-reorient), ADR-019 (poster proxy —
  the wall tiles), DESIGN-004 D-19 (history-navigation contract: tab/detail = push, state chips =
  replace).
- ADR-026 stays Accepted: its Feed decisions (B, D, G) and grant model (reused here) are live; only
  its option-F *Messages board shape* (flat + soft moderation) is retired by this ADR.
- Migration **0040** (tickets + ticket_events + ticket_replies, outbox event-type CHECK rebuild,
  `DROP TABLE messages`).
