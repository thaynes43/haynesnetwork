# DESIGN-043: The collection manager — a first-class `/collections` page, direct-add across all media types

- **Status:** Accepted <!-- revised 2026-07-18 to the direct-add model (ADR-072); was Accepted on the propose→approve model (ADR-070) -->
- **Last updated:** 2026-07-18 (REVISED to direct-add + the first-class `/collections` page — ADR-072
  supersedes ADR-070; the propose→approve flow and the Integrations-hub placement are removed. Was
  DESIGN-042 in the H1 by a two-track numbering collision — corrected to DESIGN-043 in this pass.)
- **Realizes:** **ADR-072** (direct-add + capped self-serve add/edit + over-cap cap-ticket-materialize
  + find-missing grant + Kometa auto-merge). Satisfies the amended PRD R-225..R-227 (revised for
  direct-add) + R-228-class first-class-page placement.
- **Companions:** DESIGN-042 (the Kometa provider — the auto-merge write path this page drives for
  Movies/TV), DESIGN-037 / Libretto (the books provider's live API — the direct write target for
  Books/Audiobooks), DESIGN-035 / DESIGN-038 (the Movies/TV and Books/Audiobooks collection MIRRORS
  the manager reads back through), DESIGN-050 / ADR-050 (the helpdesk ticket domain the over-cap
  escalation rides), DESIGN-033 (the books-Fix `/admin` role-grant GRID — "the FLIP" this copies for
  find-missing), DESIGN-029 (the wall/registry idioms), ADR-058 (the shared card system), ADR-014 /
  ADR-015 (ConfirmButton / Modal + reflow-free), hard rules 8/9.

## Overview

A **first-class** management surface for the estate's collections across ALL media types — Movies, TV,
Books, Audiobooks — where any user **adds, edits, and (admins) removes** collections DIRECTLY, capped
at a configurable size, with an easy over-cap escalation and a role-gated find-missing acquisition
knob. This SUPERSEDES the ADR-070 propose→approve manager: there is no suggestion, no admin review
queue, no in-wall "Suggest a collection" affordance — the owner ruled "it's not suggesting, it's
adding, removing and editing collections" (ADR-072).

The manager still reads each provider's collections LIVE and writes a RECIPE (never a collection
directly — mirror-only, ADR-064). The write is provider-shaped: **Libretto** (books/audiobooks) is a
direct API call (instant); **Kometa** (movies/TV) is an auto-merged haynes-ops PR for the safe case
(DESIGN-042). The only durable local state this design adds beyond PR3 is the find-missing grant rows
and the over-cap ticket payload — the recipes live in the providers, the produced collections in the
mirror.

Three constraints shape every decision:

1. **Direct-add, capped (ADR-072).** The cap is the only friction on the safe path. Everyone
   adds/edits ≤ cap; admins are unbounded and are the only deleters; over-cap files a ticket.
2. **Mirror-only survives (ADR-064).** The app writes a Libretto/Kometa recipe; the provider builds
   the collection; DESIGN-035/038 stay the only read paths.
3. **First-class citizen (owner ruling).** A top-level `/collections` nav entry with sub-sections —
   not an Integrations hub card. Fable owns the IA/UX; this design fixes the concrete structure.

## Detailed design

### D-01 — Placement: a first-class top-level `/collections` page (REVISED 2026-07-18)

> **REVISED (ADR-072).** The ADR-070 decision — a Collections sub-section of the Integrations hub at
> `/integrations/collections` — is RETIRED. The manager is now a first-class citizen.

A top-level **Collections** nav entry pushes to `/collections` (its own screen, the DESIGN-004 nav
idiom; label constant `COLLECTIONS_NAME`). The old `/integrations/collections` route MOVES here (a
move, not a duplicate — the Integrations hub Collections card is removed, D-15); `/integrations/collections`
redirects to `/collections` so any deep link survives. The page is gated by the collections section
(visibility floor); every authenticated user with the section sees it and can add/edit within the cap
(no capability grant for the safe path — ADR-072). Admin-only controls (delete, unbounded, Settings,
ticket approve) are role-gated within the page.

### D-09 — Information architecture: sub-navigation (NEW 2026-07-18)

`/collections` renders a sub-navigation (the DESIGN-029 sub-view idiom, tokens-only, reflow-free):

- **Movies · TV · Books · Audiobooks** — one sub-section per media type, each the provider-backed
  collection list (D-02) with health/counts + add/edit (D-03) + the find-missing knob per collection
  (D-14). Movies/TV bind the Kometa provider (DESIGN-042); Books/Audiobooks bind Libretto.
- **Tickets** — the over-cap requests sub-section (D-11): a user sees their OWN `collection_override`
  ticket state; an admin sees all open ones with a one-click **Approve → materialize** action.
- **Settings** (admin-only) — the configurable size cap value (D-10; `collection_size_cap`) and the
  find-missing role-grant grid (D-14), or a link to `/admin` roles for the grid.

The sub-nav is a D-19 PUSH between sub-sections; within a sub-section, chips/toggles recolor but never
reflow (ADR-015). Empty sub-sections collapse honestly (a provider with no collections shows an empty
state, never a fabricated row).

### D-02 — The per-media-type collection list (monitor)

Per sub-section, the provider's collections compose server-side into one `collections.overview`
payload (per provider): each collection renders a row card with

- builder badge (provider-specific — Libretto: `static_ids`/`hardcover_series`/`nyt_list`/`wikidata_award`;
  Kometa: the DESIGN-042 D-04 allowlist),
- target (server + library label),
- matched / missing counts from the last run (`matchedByTitle` an honest sub-note, never a defect
  flag — the Libretto live-contract lesson),
- the **Find missing ON/OFF** state (D-14; recolor-not-reflow, reserved-slot idiom),
- a run verdict chip (`warn` is NORMAL for a partial library — informational),
- the **size** (member count) against the cap, so a near-cap collection reads honestly.

Libretto is read LIVE (stateless — its API is the read model; a Libretto outage degrades to an
`unreachable` health card, no crash — the surviving ADR-070 C-09). Kometa reads the app's own managed
include back (DESIGN-042 D-01) plus the DESIGN-035 mirror; invalid recipe FILES surface in a "needs
attention" band, never silently dropped.

### D-03 — Direct add / edit (the composer) (REVISED 2026-07-18)

> **REVISED (ADR-072).** The composer now WRITES the collection directly (within the cap) instead of
> filing a suggestion. There is no approval step for a within-cap add.

Add/edit uses a `Modal` (DESIGN-004 D-13 — an explanatory/multi-field confirm, never `window.confirm`):

- builder type picker (from the provider's set), ref field, target library select, `ordered` toggle,
  `syncMode` (`append` | `sync`), and the member set / ref that defines the collection,
- **ref PREVIEW** (the top composer win, the surviving ADR-070 C-07): a "Preview" action resolves the
  ref (Libretto `POST /api/validate`; Kometa's resolve, DESIGN-042 D-04) and shows the resolved
  name + resolved member count + any issues BEFORE save — a 0-work container slug shows honestly, no
  fabrication.
- **VALIDATE-before-save** — save is refused on blocking issues; per-path strings render inline.
- **Cap check.** On save the domain asserts `assertWithinCollectionSizeCap` (PR3, migration 0067;
  configurable, default 25). Within the cap → the write goes straight to the provider:
  - **Books/Audiobooks (Libretto):** `PUT /api/recipes/:id` through the confined `@hnet/libretto`
    writer — instant (D-06).
  - **Movies/TV (Kometa):** regenerate the managed include + open an auto-merged haynes-ops PR
    (DESIGN-042 D-02/D-10) — the row shows "Applying" until the next run + mirror; the UI states the
    batch cadence plainly (owner tone, no time-grounding).
  - **Over the cap → the ticket path (D-11)**, not a save error. The Modal offers "This collection is
    larger than the limit — request it" which opens a `collection_override` ticket carrying the full
    definition.
- `id` global uniqueness enforced (the Libretto "recipe id is global" lesson; Kometa per-target
  variants need distinct ids). Every write is audited (hard rule 6).

**Delete** is admin-only (ADR-072), a `ConfirmButton` (ADR-014; reserves the armed-label width — no
row shift) with the explicit orphaned-collection warning (the surviving ADR-070 C-08 / ADR-069 C-08):
the default removes the recipe; an "also delete the produced collection" opt-in cascades where the
provider supports it. A non-admin never sees the delete control (server-enforced).

### D-10 — The size cap (PR3 backbone) (NEW 2026-07-18)

The cap is `collection_size_cap` — an app_setting (migration 0067, PR3; configurable; default 25),
read by the domain `assertWithinCollectionSizeCap` on every add/edit. Admin Settings (D-09) surfaces
and edits the value (an audited `setAppSetting`, the existing idiom). An `is_admin` role bypasses the
cap entirely (ADR-072). The cap is a COUNT of collection members (the resolved member set for a
static builder; the resolved ref count for a list builder — surfaced by the ref preview D-03).

### D-11 — Over-cap: the `collection_override` ticket that materializes on approve (NEW 2026-07-18)

An add/edit that would exceed the cap escalates to a **ticket**, not an admin queue:

1. **File (any user).** `collections.requestOverride` (PR3 seam) opens an ADR-050 ticket of category
   `collection_override` FROM the manager, carrying the FULL requested collection definition as a
   payload (`collection_override_payload` jsonb on `tickets`, migration 0069 — builder, ref,
   variables, target library, requested size, provider). The ticket + its creation event + the audit
   row commit in ONE transaction (hard rule 6; the ADR-050 ticket writer idiom).
2. **Track (requester).** The `/collections` Tickets sub-section (D-09) shows the requester their own
   `collection_override` ticket state (open / in_progress / complete / rejected) — the ADR-050
   household-visible ticket read, filtered to the caller's own for this category. No outbox/notify
   machinery (rare path, ADR-072 ruling 5 — the requester checks their ticket).
3. **Approve → materialize (admin, one click).** An admin's Approve transitions the ticket to
   `complete` AND materializes the collection unbounded — the SAME confined provider writer as a
   direct add (D-03), cap-bypassed, driven from the ticket payload. Materialization + the
   `complete` transition + the transition audit commit in ONE transaction (hard rule 6). For Kometa
   the materialization opens a haynes-ops PR that is **human-merged** (over-cap is one of the two
   non-auto-merge cases, DESIGN-042 D-10) — the ticket stays `in_progress` with the PR URL recorded
   until merged + run + mirrored, then reconciles to `complete`. Reject materializes nothing.

The ticket row is the durable spine across the async gap (the ADR-050 `ticket_events` idiom + the
DESIGN-033 `book_fix_requests` precedent — a row that outlives the round-trip and records each step).

### D-04 — Run history + counts

The detail shows the collection's recent runs with per-run counts: matched, missing, and — when find
missing is on (D-14) — acquired. Libretto keeps the last 50 (surfaced honestly with a "recent runs
only" note); Kometa's honest run surface is Job status + `meta.log` (DESIGN-042 D-08 — no
per-collection result API). Acquisition counts make the content-pull visible so the owner can watch
what a find-missing collection drives in.

### D-06 — Server-side + confinement

All provider calls go through tRPC procedures; the confined `@hnet/libretto` client (and the Kometa
git-write client, DESIGN-042) are reached ONLY via the `@hnet/domain` collections orchestrator (the
ADR-055 discipline — arr-write-import-guard extended). NEVER a browser call. A provider outage
degrades to an `unreachable` health state (D-02) — no crash; the mirror walls are unaffected.

- **Add/edit** (within cap): `collections.upsert` → domain `assertWithinCollectionSizeCap` →
  provider writer. No grant on the safe path (ADR-072).
- **Delete** (admin): `collections.delete` → admin check → provider writer.
- **Over-cap:** `collections.requestOverride` → ADR-050 ticket (D-11).
- **Approve ticket** (admin): `collections.approveOverride` → materialize + transition (D-11).
- **Find missing enable** (granted role): `collections.setFindMissing` →
  `collectionActionProcedure('find_missing')` → provider writer with the acquisition flag (D-14).
- **Grant admin:** `roles.setCollectionsActions` → `setRoleCollectionActions` single-writer (D-14).

### D-14 — Find missing: a per-collection knob behind a role grant (NEW 2026-07-18)

The content-pull knob, re-gated from the retired `acquire` grant (ADR-070) to a per-collection choice:

- **The knob.** A collection may opt into "find missing" — Kometa sets
  `radarr_add_missing`/`sonarr_add_missing`; Libretto sets `variables.acquisitionEnabled` — so the
  provider force-searches the collection's MISSING members on its cron runs (Kometa `collections`
  CronJob; Libretto's apply/cron). Default OFF.
- **The gate.** Default users CANNOT enable it. A `find_missing`-granted role chooses it per
  collection. `role_collection_action_grants` SURVIVES (migration 0059) but its action set is rebuilt
  from `suggest`/`manage`/`acquire` to a single **`find_missing`** action (migration 0069 rebuilds the
  `COLLECTION_ACTIONS` CHECK and clears the old rows). Admin implies it.
- **The rollout.** Ships behind a self-serve `/admin` role-grant GRID — the DESIGN-033 "Books actions"
  FLIP idiom: a "Collections actions" grid, `roles.setCollectionsActions` delegating to the existing
  `setRoleCollectionActions` single-writer (co-writes an `update_collection_actions` `permission_audit`
  row same-tx, hard rule 6; guard-listed). Ships Admin-only (empty grant table).
- **The confirm.** Enabling it is confirmed through an explanatory `Modal` (the surviving warning:
  "This makes the estate acquire the collection's missing titles on the next run"). A non-granted
  caller sees the knob disabled with an honest "needs the find-missing grant"; the server re-checks
  (a forged flag ⇒ FORBIDDEN).
- **Kometa merge:** enabling find missing on a Kometa collection is one of the two NON-auto-merge
  cases — its haynes-ops PR is human-merged (DESIGN-042 D-10), because it is the acquisition lever.

### D-07 — Cards + tokens

The manager reuses existing card/badge tokens and the `hub-card` / `badge` families (ADR-058 — no
hand-rolled wall cards). New color goes through `--color-*` tokens in `tokens.css` only (hard rule 2).
The composer is the standard `Modal`; apply is a `ConfirmButton` (reserved armed-label width);
delete opens an explanatory `Modal` carrying the also-delete opt-in (hard rule 8 — a destructive
confirm with an option is a multi-field confirm, so no inline checkbox rides the row; Fable UX
pass 2026-07-18). New gallery entries capture the collection row (with the find-missing state), the composer,
the cap/over-cap Modal, the Tickets sub-section (requester view + admin approve), and the Settings
grid — dark/light × desktop/390 (the standing screenshot-review rule).

### D-08 — Libretto member-level missing + the resolve broker (Libretto M3, unchanged)

Two Libretto capabilities extend the read surface (Libretto PR #9; DESIGN-037 is Libretto's design of
record) — unchanged by this revision:

- **`GET /api/collections/:recipeId/missing`** → the missing member identities
  (`{ label, title, authors, isbn, identifiers }[]` + `total`/`heldCount`/`missingCount`) — enough to
  drive the books Wanted-tiles (the collections leg; migration 0068 reserved).
- **`POST /api/resolve`** → the ISBN-first resolve broker owned Libretto-side (`isbn:` then a guarded
  `intitle:+inauthor:` fallback) — Libretto uses it to drive `addBook(<volumeId>)` for M3 acquisition.

Auth: `Authorization: Bearer <LIBRETTO_API_KEY>`, provisioned from the same 1Password `libretto` item
Libretto reads (the values match by construction).

### D-15 — Teardown of the suggest machinery (NEW 2026-07-18)

The full teardown the build agents execute (PLAN-052 PR4a). "Move, don't duplicate" the manager:

- **Drop `collection_suggestions`** — migration 0069 `DROP TABLE collection_suggestions` + drop the
  `COLLECTION_SUGGESTION_STATUSES` enum; remove the guard-list entry for the table.
- **Remove the suggest domain writers** — `createCollectionSuggestion` / `approveCollectionSuggestion`
  / `declineCollectionSuggestion` / `listCollectionSuggestions` (`@hnet/domain` collection-suggestions)
  and their tests.
- **Remove the suggest routers/grants** — the `collections.createSuggestion` / `approve` / `decline` /
  `listSuggestions` tRPC procedures; rebuild `COLLECTION_ACTIONS` from `suggest`/`manage`/`acquire` to
  `find_missing` (migration 0069), clearing the old grant rows.
- **Remove the in-wall affordance** — `apps/web/app/(app)/library/suggest-collection.tsx` and its mount
  in `books-browser.tsx` (UI-only; being removed tonight by another agent — PR4a folds in the
  domain/API/DB teardown behind it and the manager MOVE).
- **Move the manager** — `/integrations/collections` → `/collections` (D-01); remove the Integrations
  hub Collections card; add the `/integrations/collections` → `/collections` redirect.

## Alternatives considered

- **Keep propose→approve** (ADR-070). REJECTED by the owner — the affordance is being torn out.
- **A dedicated over-cap admin queue.** REJECTED — the helpdesk (ADR-050) already is the estate's
  escalation surface; a `collection_override` ticket that materializes on approve reuses it.
- **A blanket "can edit collections" grant.** REJECTED — the owner ruled everyone edits within the
  cap; only the content-pull (find missing) is gated, per collection.
- **App-native collection authoring (write the collection directly).** REJECTED permanently by
  ADR-064 — the app writes a recipe, the provider owns the collection.

## Test strategy

- **Domain:** `assertWithinCollectionSizeCap` (within/over the configurable cap; admin bypass); the
  direct upsert writer (row + audit before any provider call; the atomicity test); the over-cap →
  ticket path (a `collection_override` ticket with the full payload, created in one tx); the
  approve → materialize path (ticket transition + unbounded materialize + audit in ONE tx); the
  find-missing grant matrix (`collectionActionsForRole`, admin implies, no-row deny;
  `setRoleCollectionActions` audit-in-same-tx); the confined orchestrator's validate/upsert/delete
  pass-through against a stub client. **Teardown:** the suggestion writers/tables are GONE (a guard
  test asserting the table is dropped + the router surface removed).
- **API:** the matrix INCLUDING forbidden paths — a default user CAN upsert within the cap but CANNOT
  delete (FORBIDDEN), CANNOT enable find missing (FORBIDDEN), CANNOT approve a ticket (FORBIDDEN); an
  over-cap upsert routes to the ticket, never a silent truncation.
- **DB:** migration 0069 (drop `collection_suggestions`, rebuild `COLLECTION_ACTIONS` → `find_missing`,
  add `collection_override_payload`, extend the `TICKET_CATEGORIES` CHECK for `collection_override` if
  PR3 has not already); the guard-list updates (table removed; the payload column write-confined).
- **Guards:** arr-write-import-guard (`@hnet/libretto/write` + the Kometa git-write client domain-only)
  + no-direct-state-writes (the tickets payload + grant tables).
- **UI:** gallery entries + a hermetic screenshot capture driving stub providers at 390/desktop,
  dark/light; the first-class `/collections` sub-nav; the over-cap Modal → ticket; the admin
  approve→materialize; no-grant ⇒ no find-missing/delete control (server-enforced); ADR-015 no-reflow
  across every state flip.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | **Cap unit** — is the cap a count of RESOLVED members (list builders resolve a live count) or of the STATIC id set the user typed? A list ref can drift over/under the cap between runs. | OPEN. Design leans: the cap is checked at write against the ref-preview resolved count (D-03/D-10); a list that later drifts over the cap is not retroactively ticketed (the mirror shows honest size). Owner confirm. |
| Q-02 | **Over-cap ticket payload storage** — a nullable `collection_override_payload` jsonb column on `tickets` (chosen, D-11) vs a side `collection_override_requests` table keyed to the ticket. The column keeps it in the ADR-050 aggregate; a side table is cleaner if the payload grows a lifecycle of its own. | OPEN. Design leans the jsonb column (simplest, one aggregate). Owner/coordinator confirm at build. |
| Q-03 | **Kometa auto-merge trust** — the app auto-merges within-cap grouping-only config PRs after `--validate-file` green (DESIGN-042 D-10). Is the CI gate + the machine-owned file enough, or does the owner want a canary window (auto-merge behind a flag) first? | OPEN — owner ruling. ADR-072 rules auto-merge for the safe case; a first-N-runs canary flag is a safe rollout option. |
| Q-04 | **Find-missing grant rollout** — which roles get `find_missing`, and when? | OPEN — owner ruling. Ships Admin-only (empty grants, the DESIGN-033 default); the owner opens per role at `/admin` roles. |
| Q-05 | **Tickets sub-section vs the Helpdesk** — a `collection_override` ticket is an ADR-050 ticket. Does it ALSO appear in the main Helpdesk `/bulletin` tab, or only under `/collections` → Tickets? | OPEN. Design leans: it is one ticket, visible in both — the `/collections` Tickets view is a category-filtered lens on the same aggregate. Owner confirm. |
</content>
