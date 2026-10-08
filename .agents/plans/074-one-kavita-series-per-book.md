# PLAN-074: One Kavita series per book

- **Status:** In progress
- **Satisfies:** issue #825, ADR-105/106; DESIGN-024/028/036/037 amendments dated 2026-10-07
- **Validation:** `.agents/context/2026-10-07-one-kavita-series-per-book.md`, OC-045

## Preconditions

Owner authorized the library metadata change on 2026-10-07. No library edit before safeguards are deployed, the
projected census is checked and the merged code has an adversarial review. Work stays in task worktrees. No CPU
burners, stress or wide parallel/looped tests; use low parallelism under nice 19.

## Steps

1. Analyze sync, pairing, census and Libretto reading-list transitions. Record findings before code.
2. Ship app safeguards and Libretto chapter reconciliation as needed, with targeted tests, green required checks and
   handled Claude advisory reviews. Release and deploy through haynes-ops.
3. Ship the converter strip disabled: validated atomic edits, outside-library originals, dry run, targeted mode,
   idempotence and restore. Verify its unit and calibre-image tests.
4. Review merged changes for corrupt/lost files, stale identities, releases and unintended acquisition.
5. Declare activity; run the targeted Hunger Games/Mockingjay batch Job, scan, refresh mirrors and verify requests.
6. Backfill all eligible tagged EPUBs; scan and verify file coverage, census, pairs, Request Events and LL pushes.
7. Restore series order through library-only reading lists under existing verified membership/order rules; refuse
   unproved identities without acquiring replacements. Enable the hourly strip through GitOps after full verification.
8. Merge the evidence and OC-045, update the external report, end activity and remove additional merged worktrees.

## Resume and expanded owner rulings, 2026-10-08

The previous session ended before collecting the full Job's completion. Runtime logs now prove that the two
staged edits and 272 full edits completed, with zero edit failures, one Night Shift cross-author collision hold
and one whole-folder Ransom hold. The completed Job must not be reapplied using the stale 04:29Z report.

Coordinator restored all five paused CronJobs and Libretto acquisition through haynes-ops #3573 at 10:13Z.
Every further pause has a checkpoint and a concrete inverse restore PR prepared first. Pause only during the
strip/scan/file-and-reading-state verification window, and restore immediately on success, failure or uncertainty.
The hourly flag remains off until full verification. New arrivals require fresh inventory rather than reuse of
the original 1,930-file approval.

After the bulk verification, implement and stage #830's `<title> (<author>)` series tag plus index for unrelated
same-title works, and #831's guarded consolidation retaining the LazyLibrarian BookFile copy. Originals and moved
extras remain outside EBooks indefinitely. Protected extras stay and receive a review list. Ransom remains held;
its separate owed check evaluates the latest actual reading activity against the 30-day idle rule without progress
migration engineering. The original July 27 timestamp is already older than 30 days and must not be reset.

Issues #835, #838, #839 and #842 remain technical backlog under the conservative defaults in DESIGN-037.
OC-045 is pending the October 9 04:00Z scan and subsequent pairing run; a successful manual scan cannot satisfy it.

### Verified collision stage, 2026-10-08 16:05Z

The resumed run completed two Night Shift edits and 14 remaining edits, including all ten author-qualified
collision peers and six ordinary strips. Every source and candidate ZIP member, retained original, and unchanged
library fingerprint passed verification against the fresh 1,956-EPUB, 4,730-file inventory. Together with the
historical 274 operations this is 290 operations; 289 current paths match verified candidates because
LazyLibrarian replaced one historical Dungeon Crawler Carl edition before this stage.

The normal Books scan was accepted at 16:02:47Z and emitted both completion notifications at 16:03:02/03Z.
All 48 saved reading-state rows and all eight discovered saved-lock tables were exact afterward. Its verifier
refused the scan-start boundary, so the force scan did not run. Production was restored first through
haynes-ops #3597: all five schedules active, Libretto acquisition normal, and three Flux scopes Ready at 16:05:33Z.
Diagnose this boundary while live; preserve the original backfill's missing observer coverage explicitly.
Do not repeat any of the 16 verified edits. The hourly gate remains off, and duplicate moves, app refresh,
reading-list reconciliation and final force-scan verification remain pending.

## Rollback

Keep hourly stripping disabled and restore verified originals outside the library through the converter's locked,
atomic restore procedure. Rescan Kavita and refresh app/Libretto identities. Preserve Request Events and backups.
