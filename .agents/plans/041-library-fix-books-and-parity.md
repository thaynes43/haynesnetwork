# PLAN-041: Library "Fix" for books/audiobooks/comics — Part 1 (buildable release)

- **Status:** BUILT + LIVE (v0.61.0, 2026-07-15 night; #304) — **ACTIVE for ONE remaining step:
  THE Q-01 FLIP** (owner tests the Fix as Admin, then `setRoleBookActions` opens `fix_book` to all
  roles — DO NOT FORGET). Live-validated in prod: fix c7a0fe19 on Project Hail Mary (controlled
  fire → search_triggered, audit row, ll_book_id seeded from the request row with NO GB call,
  reverted via unqueueBook+rescan). Planned 2026-07-15 (owner-directed, two-Opus planning pass:
  code mapper + architect, synthesized). Part 2 (Fix-everywhere parity) stays a standing goal.
- **Docs-first artifacts:** **ADR-062** (Proposed — the books-Fix boundary) + **DESIGN-033**
  (Draft) — authored this pass; ratify (or Accept per granted authority) before code.
- **Owner intent (2026-07-11, re-affirmed 2026-07-15):** the SAME Fix UX movies/TV have — Fix
  button + REASON modal + live progress + audit — for a LANDED bad book/audiobook/comic.
  Trigger class: German *Matilda*; the 2026-07-15 suspected-bad epub (which turned out to be a
  Kavita reader-mode issue — but the class is real, see F-09).

## The design crux (both planning agents converged)

A landed book is `Open`/satisfied in LL — a plain re-search is a NO-OP. A real Fix =
re-drive to Wanted (`addBook → queueBook`) → `searchBook`; and the stale bad file on disk is NOT
cleaned by the re-grab (LL never removes files it didn't create; Kavita merges series folders).
The app cannot move library files (no cephfs mount). Hence ADR-062's two-mode ruling: **v1
re-acquires + records + guides** (`stale_file_action` seam); **Mode-2 "quarantine assist"**
(a cephfs-mounted book-janitor) is deferred to its own ADR.

## Phases (one release)

1. **Schema + grants (migration 0052):** `book_fix_requests` + `role_books_action_grants` +
   permission_audit CHECK rebuild + guard-list entries.
2. **Domain:** `createBookFixRequest` (tx: rate/dedupe/insert/audit) + `runBookFixRequest`
   (LL route: addBook→queueBook→searchBook, language guard on wrong_language; Kapowarr route:
   idempotent add → auto_search) + `recordBookFixAction` + `setRoleBookActions`.
3. **API:** `bookFix.create/.progress/.myFixes/.adminList` behind `bookActionProcedure('fix_book')`.
4. **UI:** landed-tile Fix → book detail SHEET (ADR-058) → reason Modal (ADR-014) → live
   PhaseChip via the ADR-059 Activity read (reflow-free, ADR-015). Fired fixes visible in Activity.
5. **Rollout (Q-01 RULED):** ships Admin-only for the owner's TEST ONLY — then **FLIP `fix_book`
   TO ALL ROLES** (a tracked, must-not-forget post-validation step: seed the grant for every
   non-admin role via `setRoleBookActions` once the owner validates). e2e advisory.

## Dependencies (all LIVE)

ADR-055/056 confined clients · ADR-059 Activity read-model · PLAN-039 governor · ADR-028/PLAN-015
feedback primitives · ADR-058 cards. No new external write surface. Deployed-LL gotcha: no
`getBook` — reconcile via `getAllBookStatuses()`.

## Owner rulings 2026-07-15 evening (all eight answered — see DESIGN-033 Q table)

Q-01 Admin-only ship (default: yes) · Q-02 fold `wrong_content` into `other` (default: yes) ·
Q-03 defer language pin / manual pick (default: yes) · Q-04 detail SHEET not page (default: yes) ·
Q-05 comics included in v1 (default: yes) · Q-06 epub structural-QA = separate detection spike
(default: defer) · Q-07 Mode-2 quarantine automation deferred (default: yes) · Q-08 books-scoped
Fix budget, one open Fix per (books_item, media_kind) (default: yes).

## Out of scope

Part 2 parity legs (ytdl — PLAN-025 dependency), Mode-2 file moves, proactive epub QA, any
Kavita/ABS write-back, LL provider/config changes (Prowlarr-fullSync-owned).

---

## Historical intake (2026-07-11, superseded by the plan above)

# PLAN-041: Library "Fix" for books/ebooks/audiobooks/comics — and the Fix-everywhere parity goal

- **Status:** Intake (owner 2026-07-11 eve). Needs a scoping session; the north-star section is
  a standing backlog goal, not a single release.
- **The trigger (real defect, owner-hit):** *Matilda* by Roald Dahl is on-disk in Kavita but the
  epub is **not in English** — the FIRST book the owner searched for. There is no in-app
  remediation: books are a read-only mirror (ADR-046; hard rule 4 extended — Kavita/ABS are the
  source of truth, sync flows in, **no write-back**), so a bad copy (wrong language, corrupt
  epub — F-09, wrong edition, bad quality) can only be fixed by driving LazyLibrarian/Kapowarr
  by hand.
- **Trigger root cause CLOSED manually (2026-07-12) — two-part defect, both halves are design
  input:** (1) the on-disk epub was **German** (Rowohlt, `dc:language=de`) — a pre-pipeline file;
  the 2026-07-11 English re-grab worked (MAM ENG pack imported clean: epub/azw3/mobi), **but LL's
  import never removes pre-existing files it didn't create**, so the German epub stayed in the
  series folder. (2) **Kavita merges every file in a series folder into ONE series** (Matilda
  showed `chapterCount: 2`, and the series metadata — releaseYear 2016 — came from the German
  file), so the stale copy is what members kept opening. **Manual remediation (the Q-02
  precedent, proven):** moved the German epub to `/data/cephfs-hdd/data/media/books/quarantine/`
  (outside both the Kavita library roots and LL's scan dirs — reversible, nothing deleted) +
  triggered a Kavita Books scan → the series now has 1 chapter backed by the English epub only.
  **Design implications:** a books Fix that re-grabs WITHOUT clearing the bad copy does not fix
  what the user sees — replace/quarantine of the old file + a Kavita rescan must be part of the
  Fix transaction; the quarantine-folder pattern is now field-proven.
- **Owner intent (2026-07-11):** the same "Fix" buttons TV/Movies have should exist on
  books/ebooks/audiobooks — "and go one step further: a long-term backlog item and goal to have
  it on everything… good UX to have consistent capabilities across all Library items."
- **Relates:** the *arr Fix vertical (detail-page Fix + PLAN-015 live action feedback — the UX
  idiom to mirror), ADR-046 (the no-write-back ruling this plan must supersede/refine for
  ACQUISITION-layer writes), ADR-054 / `@hnet/downloads` (the freshest precedent for a small
  confined external write surface), PLAN-039 (governor — every re-grab this plan triggers is
  governed), PLAN-032 (list automation shares the LL wanted/search machinery), PLAN-025 (the
  ytdl leg of the parity goal), F-09 (bad epubs — same remediation shape).

---

## Part 1 — Books/Audiobooks/Comics Fix (the buildable release)

### Shape (coordinator sketch, to pressure-test at scoping)

1. **The write goes to the ACQUISITION layer, not the library layer.** Kavita/ABS stay
   untouchable (their mirror + no-write-back ruling stands). The remediation writes go to
   **LazyLibrarian** (books + audiobooks: mark the book Wanted again with the right criteria →
   LL re-searches usenet-first → governed MAM fallback → import replaces) and **Kapowarr**
   (comics: re-grab issue/volume). That needs a new **confined write surface** (an
   `@hnet/books-write`-shaped client or an LL/Kapowarr addition to `@hnet/downloads`) —
   import-confined to `packages/domain`, ADR required (the ADR-054 pattern: smallest possible
   verb set, GET-then-PUT discipline, guard-listed).
2. **v1 Fix actions on the books/audiobooks/comics detail pages:** "Re-grab — replace this
   copy" behind the Fix Modal idiom (reason field, ADR-014-compliant), writing an audit row in
   the same tx, with **live action feedback** (the PLAN-015 status idiom: requested → searching
   → grabbed → imported).
3. **The Matilda case is a LANGUAGE defect — investigate LL's language controls** as part of
   the design (LL has per-book/global preferred-language handling around its metadata sources;
   confirm what the deployed build honors on search/import, e.g. its preferred-language config,
   and whether a re-grab can pin `eng`). If LL can't express "English only" reliably, the Fix
   flow must let the admin pick the exact result (a manual-selection escape hatch, like
   Force-Search).
4. **Handling the bad file:** decide quarantine-vs-replace at scoping (the comic-fix loop's
   reversible quarantine directory pattern is the precedent; LL can also replace-on-import).
   Never delete outright — hard rule 8 posture (typed/armed confirm) if any destructive step
   exists.
5. **Compliance-aware by construction:** re-grabs route through LL's normal search — usenet
   first (Prowlarr priority mapping, OPS-013 §5), MAM fallback governed by PLAN-039. A Fix can
   never bypass the governor.

### Open questions (owner, at scoping)

- **Q-01:** who gets books Fix — admin-only v1, or ride a role grant like the *arr Fix does?
- **Q-02:** bad-file semantics — quarantine (reversible, comic-fix precedent) vs LL
  replace-on-import vs leave-both?
- **Q-03:** language preference — global LL setting (all future grabs prefer English) or
  per-Fix choice? (Global likely also fixes the root cause for future grabs.)
- **Q-04:** comics in v1 (Kapowarr write surface) or fast-follow?
- **Q-05:** does Fix live only on detail pages (the *arr idiom) or also as a wall
  quick-action?

## Part 2 — The Fix-everywhere parity goal (long-term backlog, owner-stated)

**Goal:** every Library kind exposes the same remediation affordance — a user viewing ANY item
can flag/fix a bad copy with consistent UX, permissions, audit, and live feedback.

| Library kind | Fix backend | Status |
|---|---|---|
| Movies / TV / Music | Sonarr/Radarr/Lidarr (`@hnet/arr/write`) | **LIVE** (Fix + Force-Search + PLAN-015 feedback) |
| Books / Audiobooks | LazyLibrarian (new confined write) | **Part 1 of this plan** |
| Comics | Kapowarr (new confined write) | Part 1 (Q-04: v1 or fast-follow) |
| YouTube / Peloton | **blocked on the *arr-style ytdl service** — PLAN-025's Q-01 fork | Roadmap; this goal is now an explicit PLAN-025 driver |
| Peloton posters (art drift) | poster-guard (ADR-043) | LIVE (automatic, not user-facing) |

- The ytdl leg is the long pole: a pure config-manager can't re-download/replace one item; the
  "*arr for ytdl content" shape can. This plan registers **Fix parity as a first-class driver**
  for PLAN-025's Q-01 decision (noted there).
- Parity also means consistent **permissions** (per-kind Fix grants), **audit** (same-tx rows),
  and **status feedback** (one idiom everywhere) — whatever ships for books must reuse the *arr
  Fix UX vocabulary, not invent a second one.

## Out of scope until scoped

Everything — especially any LL/Kapowarr write client (ADR first). The immediate Matilda
remediation runs MANUALLY (owner-authorized) as the PLAN-039 governor live test — its friction
becomes scoping input for Part 1.
