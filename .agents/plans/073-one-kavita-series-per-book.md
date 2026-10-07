# PLAN-073: One Kavita series per book

- **Status:** In progress
- **Satisfies:** issue #825, ADR-105; DESIGN-024/028/036/037 amendments dated 2026-10-07
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
7. Restore series order through library-only reading lists under existing membership/order rules; file exact questions
   where policy is unsettled. Enable the hourly strip through GitOps after full verification.
8. Merge the evidence and OC-045, update the external report, end activity and remove additional merged worktrees.

## Out of scope

Metadata stripping does not disambiguate unrelated books sharing an identical title. Record remaining grouping
limitations with cold-start evidence rather than declaring the entire library cured.

## Rollback

Keep hourly stripping disabled and restore verified originals outside the library through the converter's locked,
atomic restore procedure. Rescan Kavita and refresh app/Libretto identities. Preserve Request Events and backups.
