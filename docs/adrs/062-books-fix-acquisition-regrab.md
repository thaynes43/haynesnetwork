# ADR-062: Books/Audiobooks/Comics "Fix" — a confined acquisition-layer re-grab for a LANDED bad copy

- **Status:** Proposed
- **Date:** 2026-07-15
- **Deciders:** Tom Haynes (PLAN-041 owner intent 2026-07-11, re-affirmed 2026-07-15)
- **Builds on / refines:** ADR-046 (books_items pure mirror; no write-back to the LIBRARY layer —
  STANDS, untouched) · ADR-055 (confined `@hnet/lazylibrarian/write`) · ADR-056 (confined
  `@hnet/kapowarr/write`) · ADR-057 (dispatching force-search on Wanted tiles). Mirrors the Fix
  contract of ADR-007 (Fix semantics), ADR-016 (per-reason routing), ADR-028 (live action
  feedback), ADR-023/ADR-059 (fine-grained per-action grants). All the above STAND — supersession
  of ADR-046 was considered and REJECTED: 046 governs the LIBRARY layer (Kavita/ABS), which this
  ADR leaves untouchable; the acquisition-layer write path was already sanctioned by 055/056/057.

## Context and problem statement

Fix is the estate's core self-service remediation (ADR-007) — but only for the *arr walls. A
landed-but-BAD book (wrong language, corrupt epub, bad conversion) has no in-app path: the trigger
class is owner-hit (the German *Matilda*; a suspected-bad epub 2026-07-15). What remains missing
after ADR-055/056/057 is a Fix for a LANDED bad copy: a `books_items` row that is on disk but
wrong, which (a) may have NO `book_requests` row (Matilda predates the pipeline), (b) needs the
ADR-007 contract (mandatory reason taxonomy, audited row, live feedback), and (c) collides with a
physical limit: LL never removes a file it didn't create and Kavita merges every file in a series
folder, so a re-grab alone does not clean what the user SEES — and the app cannot move library
files (it does not mount cephfs — ADR-059).

## Decision drivers

1. The library layer is untouchable (ADR-046, hard rule 4) — Fix writes ONLY to the acquisition
   layer (LazyLibrarian / Kapowarr), never Kavita/ABS.
2. Reuse the confined write surfaces that exist (ADR-055/056; the arr-write-import-guard already
   confines them to `packages/domain`). No new external write package.
3. Match the movies/TV Fix contract (reason taxonomy, audited-row-before-external-call,
   raw responses recorded, live feedback, never-stuck terminals).
4. Compliance by construction (OPS-013/ADR-054): re-grabs ride LL usenet-first with MAM behind the
   PLAN-039 governor; comics ride Kapowarr's GetComics DDL. A Fix can never bypass the governor.
5. Never delete/move library files from the app — it cannot (no mount) and must not (OPS-013:
   quarantine is a reversible MOVE, owner-side). Be honest about what v1 makes the user see.
6. Ship-safe rollout: Admin-only at deploy; the owner opens the action per role after review.

## Considered options

**What "re-grab a landed bad file" means, and who handles the stale file:**
- A — Re-search only, ignore the stale file: rejected alone — the user still opens the bad copy.
- B — Re-search + app-driven quarantine: rejected for v1 — the app has no filesystem surface on
  the book servers (no cephfs mount); building one is its own ADR and failure class.
- **C (CHOSEN) — two modes.** Mode 1 (v1): acquisition-layer re-grab (corrected LL Wanted /
  Kapowarr search), governed, audited, live feedback — and the Fix RECORDS the defect and surfaces
  the proven owner-side quarantine step honestly instead of pretending the disk is clean.
  Mode 2 (DEFERRED, own ADR): a cephfs-mounted confined "book-janitor" automates
  quarantine + rescan, consuming the Mode-1 signal.

**Role gate:** section-edit on `books` (rejected — viewing ≠ mutating); the ADR-057
ownership gate (rejected — a landed bad book often wasn't requested by the fixer); **CHOSEN**: a
fine-grained `fix_book` action grant (`role_books_action_grants`, the ADR-023/059 idiom), shipping
with no rows ⇒ Admin-only.

## Decision outcome

- **C-01** Fix writes ONLY to the acquisition layer via the existing confined clients:
  books/audiobooks → `@hnet/lazylibrarian/write` (`addBook → queueBook → searchBook`; queueBook is
  MANDATORY — addBook alone lands `Skipped`); comics → `@hnet/kapowarr/write` (idempotent
  add/monitor → `auto_search`). No write to Kavita/ABS, ever.
- **C-02** LL has no *arr-style blocklist/mark-failed — a books Fix is re-acquire-with-corrected-
  criteria, not blocklist+delete. `wrong_language` leans on the proven usenet-first + OPS-013
  §11.4 REJECT_WORDS guard (the exact path that fixed Matilda); a per-Fix language pin / manual
  result pick is a follow-on (DESIGN-033 Q-03).
- **C-03** v1 does NOT move library files (Option C Mode 1). The Fix row carries
  `stale_file_action ∈ none | owner_quarantine` so the UI can surface the honest guidance and the
  deferred Mode 2 has its signal. Never a delete (OPS-013).
- **C-04** A dedicated **`book_fix_requests`** table — NOT a `fix_requests` overload
  (`fix_requests` is *arr-shaped: media_items FK, arr child ids, blocklist paths, *arr reasons).
  The row is the first-class audit aggregate: requester, identity snapshot (source/external_id/
  media_kind/title), reason, route, ordered raw responses, async outcome.
- **C-05** Audit (hard rule 6): the row + a same-tx `permission_audit` `request_book_fix` entry
  commit BEFORE any external call (fix-flow crash-safety); the writer joins the
  no-direct-state-writes guard list.
- **C-06** Reason taxonomy: `wrong_language · corrupt_file · wrong_edition · bad_quality · other`
  (`reason_text` required IFF `other`). `bad_quality` covers bad conversions (one-giant-HTML
  epubs, the F-09 class).
- **C-07** Role gate: `role_books_action_grants` action `fix_book` (a row IS the grant; Admin
  implies all; `setRoleBookActions` single-writer co-writes `update_book_actions` audit). Ships
  with NO rows ⇒ Admin-only. Ownership NOT required.
- **C-08** Feedback + compliance reuse: live status via the ADR-059 Activity read-model (the book
  stage machine exists) + the ADR-028/PLAN-015 idiom in a reserved reflow-free slot; a fired Fix
  appears in the Activity tab. Re-grabs are governed (PLAN-039) by construction.

### Consequences

| ID | Consequence |
|----|-------------|
| C-a | Good: books get the SAME Fix contract as movies/TV with no new external write surface. |
| C-b | Good: Kavita/ABS stay untouchable — ADR-046 holds unedited. |
| C-c | Bad/accepted: v1 re-acquires but does not clean the on-disk view for a stale file — surfaced honestly (`stale_file_action`), automated by the deferred Mode 2. |
| C-d | Bad/accepted: no blocklist ⇒ a re-grab can re-find the same bad release; mitigated by REJECT_WORDS + usenet-first (proven) and the deferred manual-pick escape hatch. |
| C-e | Neutral: completion is async (`search_triggered` rests until the import is observed — the ADR-007 C-06 projection pattern). |

## More information

PRD R-202..R-205 (authored with DESIGN-033). Glossary T-176..T-178 (Book Fix / Book Fix Reason /
Quarantine Assist). Realized by DESIGN-033; PLAN-041 Part 1. OPS-013 §5/§6/§11 (LL vocabulary,
never-delete, usenet-first). The deployed LL has NO `getBook` — status reconciles use
`getAllBookStatuses()` (ADR-060-era finding, DESIGN-028 amendment).
