# PLAN-034: Helpdesk/Tickets — rebrand Bulletin Messages into a media-issue ticket system

- **Status:** **DISPATCHED 2026-07-11 morning** (Fable builder; owner rulings below resolve
  Q-01..Q-05; probe Fable-green at dispatch).
  **UX calls are DELEGATED TO A FABLE AGENT** (owner-explicit: "let a Fable agent make the UX
  calls here so this is polished into something people would use") — within the constraints
  below; screenshot approval still owner-gated per house rules.
- **Owner verdict:** Bulletin → Messages is "likely our weakest page on the site." Screenshot
  reviewed 2026-07-11 (compose box stacked above the list; worse on mobile).
- **Relates:** ADR-026 (bulletin + post/moderate action grants), ADR-049 / migration 0039
  (Feed/Messages view grants; Default = Messages-only TODAY — reinforces Messages-first),
  DESIGN-012 (communication hub), PLAN-033 (book requests — sibling "user asks, admin acts"
  flow; keep the domains separate but the UX language consistent), PLAN-035 (email follow-up,
  blocked on SMTP F-04).

## Owner requirements (2026-07-11, verbatim-in-intent)

1. **Tab order:** Messages (→ Helpdesk/Tickets) becomes the FIRST tab under Bulletin; Feed second.
2. **Compose UX:** never stack the post form above the list (worst on mobile). Popup or
   in-line expansion like the Admin Settings forms — Fable agent's call.
3. **Rebrand:** "Helpdesk" or "Tickets" (name = Fable proposal, owner sign-off), NOT a general
   message board. **Purpose: report issues with media or playback.** Site issues go to GitHub
   (already linked in the MOTD) — the intake copy should say so.
4. **Replies:** threaded replies on a ticket so an admin can request info and the user can
   answer.
5. **State machine:** `Open → InProgress → Complete | Rejected`, optional reason/comment on
   every transition, full transition history kept. `Rejected` is re-openable (analog of
   today's hide). Today's "Triage" ≈ InProgress (rename/absorb).
6. **Ticket detail page:** clicking a ticket opens rich detail (like clicking a movie/season) —
   history, replies, state timeline, linked media.
7. **Filters:** replace All/Visible/Hidden/Deleted with the states.
8. **Look and feel — explore, Fable's call:** "have fun with the UX or keep it in rows."
   Owner's lean: reuse the **Library poster idiom** — most tickets tie to titles with posters
   (the linked-title search already exists); tickets without media get an intake-driven icon
   set. Bake status info onto the poster tile like Trash/Library walls; rich info on
   click-through. "Keeping the look and feel the same as the Library is worth exploring, I
   think it works for tickets."

## Constraints (non-negotiable, from the estate)

- ADR-015 reflow-free interactions; ConfirmButton two-step for destructive; tokens-only color;
  390px clean in both themes. Role gates ride the existing bulletin action grants (post/
  moderate → create/transition?) — extending the grant model needs the ADR-049 pattern.
- Old messages: migration story required (map hidden/deleted → states? or freeze legacy) — see
  Q-03.

## Owner rulings (2026-07-11 morning — Q-01..Q-05 RESOLVED, dispatch authorized)

- **Q-01 visibility: HOUSEHOLD-VISIBLE.** Everyone with the Messages view grant sees all
  tickets (today's board culture; members see known issues before re-reporting).
- **Q-02 permissions: transitions STAFF-ONLY (moderate grant); replies OPEN TO ANY MEMBER**
  (any household member may chime in on any ticket thread). Create = post grant, as today.
- **Q-03 existing messages: DROP them** — they are test data, not household history. Then,
  during live validation of this change, **file a few realistic example tickets and LEAVE them
  in prod** for people to see (owner-explicit: seeded examples as onboarding).
- **Q-04 notifications: YES** — new-ticket event pings admins via the existing
  `notification_outbox` Pushover path (enqueue in the same tx as ticket creation, house
  invariant). Requester pings wait for email (PLAN-035).
- **Q-05 name:** Fable agent proposes (Helpdesk vs Tickets) with the design; owner ratifies at
  screenshot review.
- **Coordination:** PLAN-036 (history contract) may still be in flight and touches the Bulletin
  tab navigation — rebase over its merge before PR, and the new tab/detail navigation MUST
  implement the 036 contract (screen switches = history entries) either way.

## Out of scope

Email anything (PLAN-035). Book/media REQUESTS (PLAN-033 — different domain: "want new thing"
vs "thing is broken"). Site-issue intake (GitHub).

## As-built (2026-07-11, v0.44.0)

- **Name:** "Helpdesk" (Fable proposal — the *place*; tickets are the artifacts). One display
  constant (`HELPDESK_NAME`); no stored value/route/grant encodes it (ADR-050 C-05).
- **Docs:** ADR-050 (ticket domain: aggregate, state machine, option-H grant mapping, messages
  drop) · DESIGN-012 D-10..D-13 (+ header/test/Q updates; D-01/D-06/D-08's board half marked
  retired) · PRD R-160..R-164 · DDD T-145..T-148 (Ticket / Ticket Status / Ticket Event / Ticket
  Reply).
- **Schema (migration 0040):** `tickets` (+title/category/status/last_activity_at) ·
  `ticket_events` (append-only creation+transition history, household-visible notes) ·
  `ticket_replies` (flat thread) · notification_outbox CHECK += `ticket_created` ·
  **DROP TABLE messages** (Q-03 — rows were test data; Feed + grant tables untouched).
- **Domain:** `createTicket` / `transitionTicket` / `addTicketReply` single-writers; the
  `TICKET_TRANSITIONS` matrix (`open ⇄ in_progress → complete | rejected`; complete TERMINAL,
  rejected → open re-opens); `ticket_created` outbox row enqueued in the SAME tx as creation
  (ADR-034 C-01 — Q-04). Guard list swapped messages → the three ticket tables.
- **API:** `communication.tickets.list/counts/detail/create/reply/transition` — create =
  `post`, transitions = `moderate` ONLY, view/detail/REPLY = the `messages` sub-view grant
  (Q-01/Q-02; zero new grant machinery). `communication.messages.*` removed.
- **UX:** Helpdesk FIRST tab (Feed second; `?tab=messages` aliases); ticket POSTER WALL
  (`.twall` — linked titles' posters via the ADR-019 proxy; non-media tickets get the
  intake-category icon tile; state baked on as a colored corner puck + badge; reply counts +
  compact dates; state filter chips with counts replace All/Visible/Hidden/Deleted); compose =
  "New ticket" **Modal** (title · category icon grid · linked-title picker · details; GitHub
  routing copy — requirement 3); `/bulletin/ticket/[id]` detail (hero + staff transition
  buttons-with-reason Modals + Report + History timeline + reply thread). DESIGN-004 D-19
  contract: tabs/drill-ins push, chips replace. ADR-015 reflow-free; tokens-only.
- **Tests:** domain `tickets.test.ts` (FULL 4×4 matrix const+DB-enforced; history/notes;
  activity bumps; outbox same-tx proof BOTH directions — committed together / rolled back
  together via a hidden-table rollback probe); api `communication.test.ts` (the permission
  matrix incl. author-FORBIDDEN transitions + feed-only FORBIDDEN replies + moderator-needs-post
  create); db `migrations.test.ts` 0040 block (CHECKs + messages drop); e2e `helpdesk.spec.ts`
  (member-files → staff-transitions-with-reasons → member-replies → reject/re-open → wall +
  state filters — green); communication + trash back-link specs migrated to ticket surfaces.
- **Live proof (prod, v0.44.0):** `/api/health` 200; rollout clean (no kyverno signature
  denial); migration 0040 applied — `to_regclass` shows the 3 ticket tables present and
  `messages` NULL; outbox CHECK admits `ticket_created`. **4 example tickets seeded through the
  app's own writers and LEFT as onboarding examples (Q-03):** Top Gun: Maverick (playback,
  open) · Severance (audio, in_progress + staff note + a reply) · Oppenheimer (subtitles,
  complete + resolution note) · a non-media "website bug" example (other, rejected with the
  GitHub-routing note). 7 ticket_events + 1 reply; the 4 same-tx `ticket_created` Pushover
  pings queued for the `*/13` notify-outbox drain (the live Q-04 proof). Unauth gates verified:
  `/bulletin` 307 → login, tickets API 401.
- **e2e seed note:** the hermetic stack seeds NO plex-matches, so a non-admin's `ledger.search`
  is gated EMPTY by THE INVARIANT (ADR-047 cold-start deny) — the pre-existing advisory-e2e
  failure on main. The helpdesk spec routes the linked-title picker through the admin; the
  member path is unit-proven. Backlog: seed `media_plex_matches` in the harness to restore
  member library e2e journeys estate-wide.
- **haynes-ops:** image bump ONLY (`398ce0ff`; no new CronJob/secret — the existing
  notify-outbox drain carries the pings).
