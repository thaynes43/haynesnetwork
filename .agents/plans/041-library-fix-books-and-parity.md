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
