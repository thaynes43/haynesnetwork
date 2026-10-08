# Issue 825 resume work order, 2026-10-08

Resume haynesnetwork issue #825 (one Kavita series per book) after the previous Codex session ended at 2026-10-08 04:46Z. Work in the isolated worktree `/home/dev/work/haynesnetwork-1008-074255`, branch `agent/haynesnetwork-1008-074255`. Never push main. Commit to the branch, push and create a PR with `gh pr create`. Merge after required checks are green and the Claude advisory review is read and handled. Extra worktrees belong under `/home/dev/work` and are removed after their PR merges. Follow `~/.codex/AGENTS.md` and repo `CLAUDE.md`, GitOps only, no CPU burners, no `cd dir && ...` compound commands. Use absolute paths, `git -C` and `gh --repo`. Refresh stale GH_TOKEN from `/creds/gh_token`. Nobody answers mid-task.

Report: `/home/dev/work/hn-825b-report.md`, short, updated throughout. First line becomes `STATUS: FINAL` only when done. If blocked, final message says BLOCKED and why.

## Inherited state to verify

- Previous checkpoint `/home/dev/work/hn-825-report.md` (04:29Z), huge previous log `/home/dev/work/haynesnetwork-1007-182906.log` (tail and targeted searches only), evidence under `/home/dev/work/hn-825-audit/` and `/home/dev/work/hn-825-recipes/`.
- Check old worktrees `/home/dev/work/haynesnetwork-1007-182906` and `/home/dev/work/hn-825-ops` for uncommitted work first. Commit and push anything worth keeping.
- Merged haynesnetwork #833, #837, #843, releases v0.110.1 through v0.110.3 (v0.110.3 deployed); libretto #36, #37 (sha-716da1f deployed); haynes-ops #3540, #3548, #3553, #3555, #3570.
- PLAN-074 records the work. Ops #3571 is the held restore draft, gated on full verification.
- Prior pause (`cbba409d`): frontend books, books-collections, format-pairing, goodreads CronJobs and downloads EPUB converter, plus Libretto acquisition URL disabled. Coordinator restored all five and Libretto at about 10:12Z via haynes-ops #3573. `STRIP_SERIES_METADATA` stays `0`. After verification, rebase #3571 to change only that flag to `1` and the runbook, then merge.
- Two staged EPUB edits verified; full backfill not done. Previous activity expired 06:13Z.

## Priority 1: never leave production paused

The prior session died with household syncs stopped for ten hours. Pause writers only for the strip, Kavita scan and verification window, briefly, through a GitOps PR shaped like `cbba409d`. Restore through a GitOps PR shaped like #3573 immediately when verification passes or fails. Checkpoint the report BEFORE every pause with exactly what is paused and the single PR that restores it. If errors, long waits or uncertainty may stop work, restore first. Start a 3-hour activity scoped to downloads, media, frontend, Kavita, LazyLibrarian, Libretto and haynesnetwork; end it when done. Nothing may remain suspended at session end without a merged documented reason and a GitHub issue with resume instructions.

## Coordinator rulings, 2026-10-08

- #830: same-title books by different authors receive series tag `<title> (<author>)` and an index so each is its own series. Includes City of Bones, Dead Man's Hand, The Confession and The Face.
- #831: keep the copy LazyLibrarian BookFile points at. Move extra same-title copies to backup outside EBooks, never delete, only after proving no LazyLibrarian pointer, census repair or `.ll_ignore` protection, Kavita reading progress, or app want relies on them. Protected copies remain and are listed for review. Implement both in the converter with tests and stage them like the strip, after priority 1.
- #840: hold the whole Ransom folder with its series tag. No progress migration engineering. Record a rule and owed check to strip a held folder once Kavita reading progress has been idle for 30 days.
- #835, #838, #839, #842: engineering and curation backlog, not owner decisions. No metadata edits beyond the series strip and #830 tag. Recipe sources use existing D-04 rules where verified; refuse unproved membership; acquisition never hides identity gaps. Comment these defaults on each issue, retitle owner-question wording as plain backlog titles and leave open with cold-start context.
- No new owner-decision issues. Only an irreversible choice, spending, or household-visible behavior beyond these rulings needs the owner. Put exact question/options/recommendation atop the report and stop that branch. Decide other engineering work.

## Coordination and completion

A Claude worker on `agent/oc-1008` records OC-040 through OC-044 in `.agents/owed-checks.yaml`. Do not edit those rows; rebase over its PR if touching the file. Save this order in the first docs PR.

OC-045 must describe reality and the next 04:00Z Kavita scan, now 2026-10-09. Update PLAN-074 and DESIGN docs and add a short #825 status bullet to the HANDOFF top block. Docs PRs receive review and merge.

Every commit ends with `Co-Authored-By: Codex GPT-6.1 Sol <noreply@openai.com>`. PR descriptions stay short. Ops and Libretto PRs use links for haynesnetwork doc references. No em-dashes in prose.

Final report: `STATUS: FINAL`, owner question if any, path a/b, kubectl-verified state of all five CronJobs and Libretto acquisition, backfill numbers, PR merge states, review handling and owed-check IDs.
