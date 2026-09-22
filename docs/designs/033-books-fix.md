# DESIGN-033: Books/Audiobooks/Comics Fix — landed-bad-copy remediation

- **Status:** Draft
- **Last updated:** 2026-07-28 (D-11 — the books budget becomes per-role + books Force Search now
  draws the books pool; ADR-080 / PLAN-041 Gap B / PRD R-236)
- **Satisfies:** PRD-001 R-202..R-205; governed by ADR-062 (the books-Fix boundary), ADR-046
  (mirror), ADR-055/056 (confined LL/Kapowarr writes), ADR-028 (feedback), ADR-023/059 (grants),
  ADR-014/015 (confirm/reflow), hard rules 4/6/8/9.
- **Companions:** DESIGN-005 (the *arr Fix this mirrors), DESIGN-024 (books walls), DESIGN-029
  (integrations/wanted force-search), DESIGN-030 (Activity).

## Overview

A landed books/audiobooks/comics tile gains **Fix** — the movies/TV contract ported: reason Modal
(taxonomy + free-text-iff-other), an audited `book_fix_requests` row committed BEFORE any external
call, an acquisition-layer re-grab (LL for book/audiobook, Kapowarr for comic), and live
PhaseChip feedback via the existing Activity read-model. v1 never touches library files; the
stale-copy reality is surfaced honestly (`stale_file_action`) with the owner-side quarantine
guidance, automated later by the deferred Mode 2 (ADR-062 C-03).

## Detailed design

### D-01 — Schema (migration 0052): `book_fix_requests`

`BOOK_FIX_REASONS = ['wrong_language','corrupt_file','wrong_edition','bad_quality','other']`;
`BOOK_FIX_ROUTES = ['lazylibrarian','kapowarr']`; `BOOK_FIX_STATUSES = ['pending',
'search_triggered','failed','completed']`; `BOOK_STALE_FILE_ACTIONS = ['none','owner_quarantine']`
(all text+CHECK). Columns: `id`; `requester_id → users` (set null); `books_item_id → books_items`
(RESTRICT — fix history never vanishes); the identity SNAPSHOT (`source`, `external_id`,
`media_kind`, `title_snapshot` — durable if the mirror row is later tombstoned); `route` (derived
from media_kind); `reason` + `reason_text` (CHECK both directions: text IFF other);
`language_pref` (nullable; set for wrong_language); `stale_file_action` (default `none`);
`status`; `actions_taken` jsonb (ordered steps + RAW sanitized responses; `[0]` = requester
snapshot); `ll_book_id` (LL reconcile key) / `kapowarr_volume_id`; `book_request_id →
book_requests` (set null — optional link when a request row exists); `completed_at`,
`created_at`, `updated_at`. Indexes: (requester, created desc), (books_item_id), (status).
Migration 0052 also adds `role_books_action_grants` (D-03) and rebuilds the
`permission_audit.action` CHECK (`request_book_fix`, `update_book_actions`). Both new tables join
the no-direct-state-writes guard list.

### D-02 — Lifecycle

`pending` (row + audit in ONE tx, before any external call) → external steps (LL:
`addBook → queueBook → searchBook` per format — queueBook mandatory, addBook alone lands Skipped;
Kapowarr: idempotent add/monitor → `auto_search`) → `search_triggered` (raw responses appended) →
async `completed` (the Activity/sync observation of the landed replacement — the LL Open/Have
flip) | `failed` (any step errored; terminal; the user re-raises). No blocklist/actioned step —
LL/Kapowarr have no *arr mark-failed analog (ADR-062 C-02).

### D-03 — Role gate

`role_books_action_grants(role_id FK cascade, action CHECK 'fix_book', PK(role_id, action))` — a
row IS the grant; Admin implies all; ships EMPTY (Admin-only). Single-writer
`setRoleBookActions` (replace-set + same-tx `update_book_actions` audit; Admin immutable). API
gate `bookActionProcedure('fix_book')` composed on the `books` section (read_only floor). Session
carries `bookActions`.

### D-04 — Domain single-writer + orchestration

`createBookFixRequest` (tx: books-scoped hourly rate guard + one-open-per
`(books_item_id, media_kind)` dedupe + insert + audit) then OUTSIDE the tx `runBookFixRequest`
dispatches by route, appending each step via `recordBookFixAction`; terminal errors → `failed`.
Status reconcile uses `getAllBookStatuses()` (no getBook on the deployed LL). All writers in
`packages/domain` (import-guard).

### D-05 — Confined client reuse

No new external package; `@hnet/lazylibrarian/write` + `@hnet/kapowarr/write` reused verbatim.
Governor untouched; Fix cannot bypass it by construction.

### D-06 — API (`bookFix` router)

`create` (`bookActionProcedure('fix_book')`; zod reason↔reasonText refine) · `progress`
(own-or-admin; joins the row + the ADR-059 Activity item status; poll-on-demand, terminal-stop) ·
`myFixes` · `adminList` (adminProcedure, cursor-paged). Domain errors map:
rate → TOO_MANY_REQUESTS, open-dupe → CONFLICT (the fix router idiom).

### D-07 — UI anatomy

On-disk tile ⇒ **Fix**; Wanted overlay ⇒ existing Force Search (the DESIGN-005 D-15 rule ported).
Surface (Q-04 owner ruling: consistency with the Library's existing pages): the EXISTING
`/library/books/[id]` landed-detail page (`books-detail.tsx` — until now read-only) gains the Fix
action in the item-detail `.action-slot` idiom; the wall tile keeps linking through to it. No new
sheet, no new page. The Fix opens a **Modal**
(ADR-014; multi-field): reason radios, free-text on `other`, language pick on `wrong_language`,
and the honest stale-file note ("a replacement will be searched; the current file stays until
quarantined — how"). After submit the modal's done-block is the live feedback: PhaseChip driven
by `bookFix.progress` (searching → fired/downloading/importing → completed | nothing/failed),
reserved-width slot, recolor-never-reflow (ADR-015), tokens only.

**Amendment 2026-07-17 (DESIGN-025 D-08 — detail-page parity):** the same page now also RENDERS this
item's audited fix TRAIL as a "Fixes on this item" History section (the movie-detail `.fix-list` idiom):
each `book_fix_requests` row shows its reason + status + requester + when, newest first, via the extended
`books.detail` (`fixes[]`). Read-only display of the existing audit aggregate — no new write path; the
section collapses when the item has no fixes. So the fixes tested here are visible in-context on the item.

### D-08 — Activity integration

A fired Fix's re-grab IS an in-flight book — the existing LL+SAB/Kapowarr adapters surface it;
strands land in `activity_import_failures` as usual. Join key `books:ll:<bookId>:<format>` /
`comics:kapowarr:<volumeId>`. No Activity schema change.

### D-09 — Stale file / Mode 2 (DEFERRED)

v1 records `stale_file_action` + surfaces the OPS-013 quarantine guidance. Mode-2 automation
(cephfs-mounted "book-janitor" move + rescan) is OUT — its own ADR, consuming the D-01 seam.

### D-10 — Amendment 2026-07-18 (ADR-071) — Force Search joins Fix; the unified media-action grant

The media-action UX unification (ADR-071 / DESIGN-004 D-24) closes the owner-cited asymmetry: a
books detail page (always an ON-DISK title) now shows **Fix + Force Search**, the movie treatment,
through the shared `@hnet/ui` components (`MediaHero` / `MediaAction` / `ConsumeLink` /
`ReservedActionSlot`). Fix is the **green primary** `<MediaAction action="fix">` (was the neutral
"Fix this" outline); Force Search is the **outline** `<MediaAction action="forceSearch">`.

- **Force Search semantics (owner-ratified).** A ONE-CLICK quick re-search that re-runs the
  acquisition search for the current title and grabs the best result (a fresh/better copy) — NO
  reason prompt. DISTINCT from Fix (the reasoned, durable `book_fix_requests` repair): it writes
  **NO durable row** (the movies "no durable row" idiom), only a `request_book_search` audit,
  committed before the external call. Domain `runBookItemForceSearch` (`@hnet/domain`) resolves the
  acquisition identity from the linked `book_requests` seed and re-grabs regardless of landed state
  (LL `addBook→queueBook→searchBook` / Kapowarr `setMonitored→searchVolume`); a title with no
  identity fires nothing (honest `no_ll_id`/`no_kapowarr_id`). API: `books.forceSearch`.

- **Gating — the unified role grant (THE FLIP).** `BOOK_ACTIONS` grows `force_search_book` beside
  `fix_book` (migration 0066 rebuilds the CHECK). The books detail computes **both** `canFix` and
  `canForceSearch` off the ONE `bookActionsForRole` helper (admin implies both; else the fine-grained
  grants), superseding the D-03 Admin-only Fix gate AND the #375 `owns||isAdmin` force-search stopgap
  for this surface. The owner opens each per role at **/admin → roles** (the new "Books actions"
  grant grid — `roles.setBooksActions`, delegating to the existing `setRoleBookActions` single-writer
  with its `update_book_actions` audit-in-tx). No new audit action — Force Search reuses
  `request_book_search`. Movies keep their existing gating this pass (a documented fast-follow folds
  them onto the same grant with a no-regression seed).

### D-11 — Amendment 2026-07-28 (ADR-080, PLAN-041 Gap B) — the budget goes per-role; Force Search draws it

Two changes to how the books pool is governed, unifying it with the arr pool onto ONE per-role budget
(DESIGN-005 D-23) while keeping the pools SEPARATE (a books binge can never starve a movie Fix).

- **Per-role budget replaces the env constant.** The flat `BOOK_FIX_RATE_LIMIT_PER_HOUR` (env-tunable,
  default 25) is **retired from the read path** (ADR-080 C-03 — a stale env var must never shadow an
  owner edit). `createBookFixRequest` now resolves the requester's ROLE budget through the shared
  `effectiveMediaActionBudget` (admin ⇒ bypass → the role's `role_media_action_budgets` row → fallback
  25 — the SAME number the arr pool uses, applied to the books pool independently). A budget of 0 blocks
  the role's non-admin books actions (C-05). The books grant grid (ADR-071) is UNTOUCHED — it stays the
  books-specific WHO-may lever; the budget is the HOW-MUCH lever, orthogonal.
- **Books Force Search now draws the books pool (closes the unbudgeted hole).** `runBookItemForceSearch`
  previously drew NO hourly budget (grant-gated only). It now counts against the books pool BEFORE its
  audit + external call, admins bypass. Force Search leaves no durable row, so `countRecentBooksBudget`
  counts book Fix rows PLUS the `request_book_search` audit rows this path stamps `via: 'force_search'`
  (only it writes that marker) — the pool = book Fix + book-item Force Search, one shared per-role number.
  The grant gate is unchanged. The "limit reached" copy states the role's number (C-07; owner copy rules).

### D-12 — Amendment 2026-09-22 (the LL push guard) — Force Search declines a format LazyLibrarian already holds

**What changed.** D-10's books Force Search fired the confined LL chain "regardless of landed state" —
that was its whole stated point, since the title is on disk by definition. It no longer can. Per
DESIGN-028's 2026-09-22 amendment, `runBookItemForceSearch` reads LL's own per-format state first
(one `getAllBooks`, already bounded by the D-11 media-action budget enforced before it) and returns a
new honest outcome `{ searched: false, reason: 'already_held' }` when `llFormatAlreadyHeld` is true.
Nothing is written. The click is **still audited** — the `request_book_search` row commits before the
read, exactly as it always did.

**Why there is no third option — this is LazyLibrarian's shape, not a policy choice.** Two facts from
the deployed build, verified 2026-09-22:

- `api.py::_queuebook` is an unguarded `UPDATE books SET Status='Wanted' WHERE BookID=?`. Queuing a held
  format strands an imported book in LL's daily search backlog permanently (292 rows were in that state).
- `searchbook.py::search_book` only enqueues a book whose `Status`/`AudioStatus` is literally `'Wanted'`.
  So dropping `queueBook` and calling `searchBook` alone is **a silent no-op** on an `Open` book.

LL therefore offers no way to re-search a format it already holds without damaging its state, and the
damaged state is precisely the defect. An honest decline beats a write that harms LL and achieves
nothing.

**The user-facing copy** (the one noop surface, the books detail head): the chip reads
**"Already have this copy"**, titled _"LazyLibrarian already has this copy filed, so it won't search for
another. If the file itself is wrong — bad quality, wrong edition, won't open — use Fix instead."_ That
is not a consolation: **Fix is the correct path here and is deliberately left unguarded** (D-05), because
a Fix is the user asserting the copy is defective, and it carries a durable reason row and the quarantine
flow that make re-acquisition intentional rather than a daily accident.

**The Kapowarr (comic) leg is untouched** — `searchVolume` carries no status clobber, so a comic Force
Search still fires unconditionally.

## Alternatives considered

Reusing `fix_requests` (rejected — *arr-shaped, ADR-062 C-04); app-driven file quarantine in v1
(rejected — no filesystem surface; ADR-062 Option B); section-edit or ownership gating
(rejected — ADR-062 role-gate discussion).

## Test strategy

Domain: tx atomicity (row+audit before external; rollback leaves nothing), reason CHECK both
directions, rate/dedupe, LL step order (queueBook mandatory), Kapowarr idempotent add,
raw-response capture, failure paths. API: gate matrix (no grant ⇒ FORBIDDEN; admin bypass),
create/progress roundtrip. e2e (advisory): landed tile → Fix modal → reason → submit → PhaseChip
progression against the extended stub-lazylibrarian/stub-kapowarr; bounding-box equality across a
phase flip (ADR-015); no-grant ⇒ no affordance (server-enforced).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Role rollout | RULED 2026-07-15: Admin-only for the TEST window, then FLIP TO ALL ROLES — tracked post-validation step, must not be forgotten. |
| Q-02 | Keep `wrong_content` explicit? | RULED: fold into `other`. |
| Q-03 | Per-Fix language pin / manual result pick | RULED: defer (v1 rides REJECT_WORDS + usenet-first). |
| Q-04 | Book detail sheet vs full page | RULED: neither — use the EXISTING /library/books/[id] detail page (Library consistency). |
| Q-05 | Comics in v1 | RULED: yes. |
| Q-06 | Proactive epub structural QA | RULED: defer (separate detection spike). |
| Q-07 | Mode-2 quarantine automation | RULED: defer — detail session later; v1 lets users fix. |
| Q-08 | Fix budget | RULED: books-scoped counter, generous (owner: never lock the small user group out) — 25/user/hour env-tunable (`BOOK_FIX_RATE_LIMIT_PER_HOUR`; owner ruling 2026-07-15 — parity with the *arr Fix budget, raised the same evening), admins exempt, one open Fix per (books_item, media_kind) is the real spam guard. |
