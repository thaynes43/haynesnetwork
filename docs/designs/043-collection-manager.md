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
>
> **AMENDED (2026-07-18 evening, owner ruling, coordinator-endorsed).** The `/collections` PAGE stays
> first-class — this amendment changes only the NAV CHROME that reaches it, not the surface, so ADR-072
> is NOT superseded (that ADR decides the surface, `/collections`, and its permission model; it says
> nothing about which chrome links to it). The top-row **Collections** entry the PR4a build added is
> REMOVED: at five entries the row broke the DESIGN-004 D-22 ratified goal of FOUR labels fitting 320px
> with no rail scroll (an edge-fade papered over it). Two changes replace it:
>
> 1. **User-menu entry.** The manager is reached from the user menu as **"Collection settings"** (a
>    D-19 `Link` push to `/collections` that closes the menu), placed in the tooling group directly
>    above "Trash settings" (the settings cluster together). It is UNIVERSAL — shown for everyone, since
>    the page is universal (everyone adds/edits within the cap); the `/collections` route stays gated
>    only against anonymous visitors. The label constant `COLLECTIONS_NAME` ("Collections") still names
>    the page heading + back-link copy; the menu item reads "Collection settings" verbatim.
> 2. **Contextual wall nav-out.** The Library walls gain an **"Edit collection"** link on a collection
>    DRILL header (D-09' below), so a user editing a collection reaches the manager from the collection
>    they are looking at — the contextual path that replaces the standing top-row entry.
>
> The row returns to the ratified FOUR (Portal · Library · Tickets · Trash — DESIGN-004 D-22/D-24). The
> app.css scroll-fade + relaxed spacing stay as an inert safety net (they never engage at four entries).

A top-level **Collections** page lives at `/collections` (its own screen, the DESIGN-004 nav idiom;
label constant `COLLECTIONS_NAME`), reached from the user-menu "Collection settings" entry (amended
above) and the wall drill nav-out (D-09'). The old `/integrations/collections` route MOVES here (a
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

### D-09' — The Library wall drill nav-out + deep-link edit (NEW 2026-07-18, owner-ruled)

The Library walls reach the manager contextually. On a collection DRILL header (the view once a user
has drilled into ONE collection — Books/Audiobooks in `books-browser.tsx`, Movies/TV on the Plex walls
in `library-client.tsx`), a quiet **"Edit collection"** link (the drill header's `.btn.sm` idiom,
tokens-only) deep-links to `/collections?tab=<mediaType>&edit=<recipeId>`. It renders ONLY on the drill
header, never on grid cards (per-card actions are noise + touch misfires — coordinator UX ruling), and
only when the collection has a KNOWN MANAGER IDENTITY:

- **Books / Audiobooks** — the mirror row's `librettoRecipeId` (the D-13 exact join, now surfaced on
  `books.collectionGroups`). A hand-made collection with no recipe (`librettoRecipeId === null`) renders
  NO link — there is nothing to edit in the manager. Only the Books/Audiobooks walls map to a media tab;
  the Comics wall has no Collections media type, so it never shows the link.
- **Movies / TV** — the drill keys by a Plex `ratingKey`, and the Kometa join is by TITLE (no clean
  recipe id client-side), so the link lands on the right media tab (`/collections?tab=movies|tv`) WITHOUT
  an `edit` param. Landing on the correct tab is still correct; an id is never fabricated.

The link is static per screen (the drill is reached by a PUSH), so it never reflows the header on
interaction (ADR-015). On the `/collections` side, the composer opens pre-loaded with the deep-linked
recipe (the existing `openEdit` path) and the page then CLEARS the `edit`/`new` param from the URL (a
`router.replace`, not a push, so refresh + Back land on the plain sub-section). An unknown `recipeId`
just shows the tab, no error modal. An optional `?new=1` opens the create composer.

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

#### D-02 amend (2026-07-18, owner-reported gap) — TWO populations per tab + one search

The owner reported the Movies/TV tabs reading "No movies collections yet" while the estate mirror
carries ~465 Kometa-produced collections (movies 441, TV 24 — confirmed on prod by `created_by`), and
the same blind spot on Books/Audiobooks (7 hand-made Kavita collections, none surfaced). Root cause: the
list rendered ONLY app-managed recipes (`data.recipes`, of which there are approximately zero) and
ignored the mirror rows the server already returns. The fix: **every media tab lists BOTH populations.**

- **Managed here** — the app-authored recipes, with the full controls (Find missing, Force Search
  on Books/Audiobooks — see the D-02 Force Search amend below, Edit, Delete/puck).
- **From the estate's config** (Movies/TV) / **Made in your library apps** (Books/Audiobooks) — the
  mirror collections with NO managed recipe, as **READ-ONLY** rows: title + item count on the left, a
  single muted state chip on the right ("managed in the estate's Kometa config" / "made in Kavita" /
  "made in Audiobookshelf"). No controls — the app does not manage these; it lists them so the tab is
  honest, not empty. The row anatomy stays the shared grid; the chip's slot is reserved by the shared
  actions column, so nothing reflows (ADR-015).

The overview payload gains a `readOnly[]` array beside `recipes[]`. Kometa: the mirror collections
(`created_by='kometa'`, the DESIGN-035 read) whose normalized title does NOT join a managed recipe.
Libretto: the `books_collections` rows with `libretto_recipe_id IS NULL` for the tab's media type
(audiobookshelf ⇒ audiobooks, kavita ⇒ books — the D-13 source→media map). A recipe-JOINED mirror row is
never duplicated into the read-only group.

One `library-search` input sits above both groups and filters both by title substring, client-side (the
config population runs to hundreds of rows, so the tab must stay usable). Filtering re-renders list
CONTENT — a deliberate content change, allowed under ADR-015; the search box itself holds its place and
never reflows. The honest empty state ("No ... collections yet") shows ONLY when both populations are
truly empty; a search that matches nothing shows a quiet "Nothing matches that search" note instead.

#### D-02 amend (2026-07-18, owner ruling) — the row action is FORCE SEARCH; "Run now" is retired

From a live phone review of the Books "Managed here" rows: *"We have standard nomenclature and this
doesn't match any of it. What is 'Run now'? Where is 'Force Search' for missing items?"* The rows
carried a hand-labeled "Run now" `ConfirmButton` (raw Libretto applyScope plumbing) — off the ADR-071
media-action vocabulary entirely. Retired and replaced:

- **Books/Audiobooks rows render the estate-standard Force Search** — `<MediaAction
  action="forceSearch">` off the `MEDIA_ACTIONS` registry (ADR-071; the action-anatomy drift guard
  enforces the anatomy). Semantics are the honest WHOLE action, composed server-side in order by the
  `collections.forceSearchCollection` mutation: (a) re-apply the recipe (the old applyScope — fresh
  membership), (b) refresh the collection's missing-member wants (the D-08/DESIGN-038 D-13 mint),
  (c) force-search the resolved missing members NOW through the confined LazyLibrarian chain — the
  same PR4c leg run on demand: the cron's 12h cooldown is bypassed (the caller asked for it now) but
  the per-call cap still bounds the fan-out. Single-writer + audit: each search stamps
  `last_searched_at` + a `request_book_search` row (`via: 'collection_force_search'`, tagged with the
  collection) in one transaction (hard rule 6).
- **Gate:** the books Force Search grant (`force_search_book`) — the SAME gate as the books detail
  page's Force Search. Ungranted callers do not see the button; a forged call is FORBIDDEN
  server-side. The overview carries `canForceSearch` plus each recipe's `missingCount` (the open
  origin='collection' wants) for the confirm copy.
- **Confirm idiom:** a collection-level force search is a bulk explanatory confirm ⇒ the shared
  `Modal` (hard rule 8, the shipped ForceSearchDialog pattern) — "Search for the N missing books in
  this collection now" plus what the whole action does. After firing, the reserved slot swaps the
  button for the in-place progressing chip (recolor, no reflow — ADR-015); the existing run-counts
  polling keeps informing the row's counts.
- **Kometa (Movies/TV) rows never had Run now and do NOT gain Force Search** — Kometa's own scheduled
  runs do the acquisition (`radarr/sonarr_add_missing` + `_search`, DESIGN-042 D-06); there is no
  app-side on-demand path. Nothing changes on those rows.
- **The label is locked out:** "Run now" (+ its armed "Run it?") joined the drift guard's retired
  labels (R2, `apps/web/lint/action-anatomy-guard.mjs`), so a raw button wearing either string fails
  CI. The dead `collections.applyRecipe` procedure was removed (the new mutation composes applyScope
  server-side through the domain).

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

> **REALIZED (PLAN-052 PR4c, 2026-07-18).** Shipped: the `/admin` "Collections actions" FLIP grid
> (`roles.setCollectionsActions` → `setRoleCollectionActions`, audited same-tx, Admin-only default,
> forbidden-path tested); the per-collection knob `collections.setFindMissing`
> (`collectionActionProcedure('find_missing')` — Libretto sets `variables.acquisitionEnabled` via a direct
> re-PUT, Kometa recompiles + opens a HUMAN-merged PR, both audited `upsert_collection` with a `find_missing`
> detail); the `/collections` puck is a granted user's toggle (Modal confirm on ENABLE, direct click to
> disable; recolor-never-reflow — the puck reserves the widest label's width); and the CRON FORCE-SEARCH leg
> (`forceSearchFindMissingCollections`, in the `books-collections-sync` mode after the wants pass) that drives
> LazyLibrarian over a find-missing collection's origin='collection' wants — single-writer + audit,
> cooldown-idempotent, degrades on a Libretto/LazyLibrarian outage. **Movies/TV need nothing extra: Kometa's
> own `radarr_add_missing`/`sonarr_add_missing` + `_search` flags do the acquisition on its scheduled runs
> (the app only compiles the flag on).** No migration (the `find_missing` grant + the reused
> `upsert_collection`/`request_book_search` audit actions already exist from PR4a).

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
The composer is the standard `Modal`; the row's on-demand acquisition action is the registry-standard
Force Search (`<MediaAction action="forceSearch">` opening the shared explanatory `Modal` — the D-02
Force Search amend, owner ruling 2026-07-18; the retired "Run now" `ConfirmButton` is banned by the
action-anatomy guard); delete opens an explanatory `Modal` carrying the also-delete opt-in (hard rule 8 — a destructive
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
