# DESIGN-033: Books/Audiobooks/Comics Fix — landed-bad-copy remediation

- **Status:** Draft
- **Last updated:** 2026-07-15
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
Surface: a lightweight book detail SHEET (ADR-058 card family; no heavy per-book page — Q-04)
opened from a landed tile: cover, metadata, deep-link-out, and Fix. The Fix opens a **Modal**
(ADR-014; multi-field): reason radios, free-text on `other`, language pick on `wrong_language`,
and the honest stale-file note ("a replacement will be searched; the current file stays until
quarantined — how"). After submit the modal's done-block is the live feedback: PhaseChip driven
by `bookFix.progress` (searching → fired/downloading/importing → completed | nothing/failed),
reserved-width slot, recolor-never-reflow (ADR-015), tokens only.

### D-08 — Activity integration

A fired Fix's re-grab IS an in-flight book — the existing LL+SAB/Kapowarr adapters surface it;
strands land in `activity_import_failures` as usual. Join key `books:ll:<bookId>:<format>` /
`comics:kapowarr:<volumeId>`. No Activity schema change.

### D-09 — Stale file / Mode 2 (DEFERRED)

v1 records `stale_file_action` + surfaces the OPS-013 quarantine guidance. Mode-2 automation
(cephfs-mounted "book-janitor" move + rescan) is OUT — its own ADR, consuming the D-01 seam.

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
| Q-01 | Role rollout | DEFAULT: ship Admin-only (no grant rows); owner opens per role later. |
| Q-02 | Keep `wrong_content` explicit? | DEFAULT: fold into `other`. |
| Q-03 | Per-Fix language pin / manual result pick | DEFAULT: defer; v1 rides REJECT_WORDS + usenet-first (Matilda-proven). |
| Q-04 | Book detail sheet vs full page | DEFAULT: sheet (ADR-058 card), no heavy page. |
| Q-05 | Comics in v1 | DEFAULT: yes (route branch is near-free via ADR-056). |
| Q-06 | Proactive epub structural QA | DEFAULT: defer to a detection research spike (separate track; Fix's `bad_quality` covers reported cases). |
| Q-07 | Mode-2 quarantine automation | DEFAULT: defer (own ADR; needs a cephfs-mounted surface). |
| Q-08 | Fix budget | DEFAULT: books-scoped hourly sibling counter (don't consume the *arr Fix budget); one open Fix per (books_item, media_kind). |
