# PLAN-074: One Kavita series per book

- **Status:** In progress
- **Satisfies:** issue #825, ADR-105/106; DESIGN-024/028/036/037 amendments dated 2026-10-07
- **Validation:** `.agents/context/2026-10-07-one-kavita-series-per-book.md`, OC-045

### Current completion gates, 2026-10-09 15:23Z

App #866 merged as `68a3ccd9` after five proved adversarial identity/state fixes and the Goodreads
coauthor sibling; v0.110.5 deployment is pending. The current read-only checkpoint is
`.agents/context/2026-10-09-825-completion-preflight.md`; the minimum Pathfinder selection and inverse
are in `2026-10-09-831-pathfinder-preflight.md`. These supersede historical pending statements below.

OC-047 FAILED: three Pathfinder EPUBs became unmapped at the normal nightly scan; series 1448 is PDF only.
Keep #864 open and refresh the expanded corpus. Ransom is already eligible under the original July 27
actual reading / August 26 30-day clock, but its separate exact-folder strip/scan/state proof remains pending.
Signed image/certificate/transparency and all immutable host pins passed; actual native LIVE V2 refused
before Job creation, so V3 typed-inventory/ACK/foreground cleanup still needs actual closure. No next pause
is authorized by this checkpoint. Stage corrected-app deployment, fresh full fenced evidence, the narrow
two-extra Pathfinder move/inverse/scan, optional safe Ransom stage, fresh 104-scope library-only preview,
one existing recipe then at most four per batch, normal acquisition verification and only then hourly gate.
Freeze executable profiles and exact inverse before any pause. Old preview and duration measurements are
not current authority, and current active writers must be freshly admitted.

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
All 48 saved reading-state rows and the saved lock flags, values and references across eight tables were exact afterward. Its verifier
refused the scan-start boundary, so the force scan did not run. Production was restored first through
haynes-ops #3597: all five schedules active, Libretto acquisition normal, and three Flux scopes Ready at 16:05:33Z.
Diagnose this boundary while live; preserve the original backfill's missing observer coverage explicitly.
Do not repeat any of the 16 verified edits. The hourly gate remains off, and duplicate moves, app refresh,
reading-list reconciliation and final force-scan verification remain pending.

### Current verification and narrow pairing hold, 2026-10-08 17:32Z

The scan-start refusal came from comparing clocks across hosts. A unique request, enqueue, start and commit
on the same Kavita server, with the accepted normal-mode request and both notifications, proves the normal
scan completed. This preserves the original historical backfill observer gap rather than manufacturing it.

The force request was accepted at 16:32:57Z and committed at 16:36:01Z. Its notification reader failed before
the final messages; conclusive notification evidence remains pending. Current coverage is 1,949 of 1,956
EPUBs. All seven unmapped files and 13 nonunique paths already existed before the collision stage and force.
No new gap was introduced. Pathfinder and Visitors mappings returned after force. All 48 reading rows,
saved lock flags, values and references across eight tables, and 27 curated tables exactly match the fresh preforce snapshot. Production was
restored through haynes-ops #3599 at 16:36:18Z. Never replay verified metadata to obtain scan evidence.

Native pairing projection then exposed issue #850: selecting a preferred writer discards complete coauthor
credits and can pair different works. Haynes-ops #3603 merged and applied before 17:32Z, suspending only
format pairing. The other four schedules and Libretto acquisition remain active. Its prepared inverse is
haynes-ops #3604. Deploy complete-credit matching and persistent ambiguous-counterpart acquisition
protection, refresh native source attributes, review the conservative cache and restore pairing. The
unapplied repeat-force pair #3601/#3602 was superseded; it never paused production or requested a scan.

### Native refresh and conclusive scan, 2026-10-08 19:48Z

Issue #850 is fixed and closed. App #851, release #852 and haynes-ops #3605 deployed v0.110.4.
The native refresh read all 1,932 Kavita books and all 1,231 expanded Audiobookshelf items with complete credits.
An acquisition-disabled cache pass produced exactly 716 pairs and 35 persistent reservations. Its seven
removed-anchor settlements wrote seven Request Events; all 764 protected wants remained byte-exact. No provider,
LazyLibrarian, mint, push or release write occurred. Haynes-ops #3604 ended the narrow hold and restored pairing at 19:19Z.

Fresh read-only retention completed at 19:21:58Z, verifying the 1,956-EPUB, 4,730-file inventory, candidate bytes,
ZIP contents and retained originals. A new Force request was accepted at 19:44:04Z. Continuous same-pod logs
prove the unique server enqueue, accepted request, scan start and commit at 19:47:13Z; both actual completion
notifications were received. All 48 reading rows, saved lock flags, values and references across eight tables,
and 27 curated tables and path mappings were exact afterward. Scanner timestamps and unlocked colors changed
as expected; entire locked Chapter/Series rows are not claimed byte-equal. Coverage remains 1,949 of 1,956, with exactly the seven existing gaps and 13 nonunique paths.
This closes the current Force observation gap; the original historical backfill observer gap remains explicit.
No verified metadata was replayed.

The brief pause in haynes-ops #3606 was restored by its full inverse #3607, merged at 19:47:38Z after current
checks and Claude review. At 19:48:44Z all five CronJobs were unsuspended, Libretto acquisition was normal and
all three Flux scopes were unsuspended and Ready on the exact restore revision. Both task worktrees were removed.
The Assistant to the Villain want from OC-043 names the correct held Hannah Nicole Maehrer ebook and its exact
LazyLibrarian BookFile; the distinct Accomplice audiobook does not satisfy it. No correction or acquisition was run.

Copy consolidation and library-only reading-list reconciliation remain in progress. No duplicate has moved and
no recipe or reading-list write has occurred. Preserve unproved list members and protected copies rather than
using acquisition or unrelated metadata edits to fill an identity gap. The hourly strip flag remains disabled
until the remaining verification is complete. OC-045 remains pending the October 9 nightly scan and pairing run.

## Rollback

Keep hourly stripping disabled and restore verified originals outside the library through the converter's locked,
atomic restore procedure. Rescan Kavita and refresh app/Libretto identities. Preserve Request Events and backups.


### Library-only curation checkpoint, 2026-10-08 21:20Z

The completed source review permits 42 recipe scopes: nine existing repairs, one unchanged recipe and 32 new
manual recipes with acquisition disabled. The preview contains 136 chapter additions and zero removals; no apply
or copy move has happened at this checkpoint. Six newly identified source/credit contradictions join the retained
56 holds, for 62 held scopes. DESIGN-037 records their exact reasons and staged execution contract.

Source and stopped-database readers, strict five-Job ownership and two PostgreSQL lease cleanup are independently
reviewed components. The final publisher-path and copy callback proof remains pending. All six relevant schedules,
LazyLibrarian, Kavita and Libretto acquisition remain live; the hourly gate stays off. Prepare and review the exact
inverse before the short copy window, restore first on every outcome, then refresh any affected native membership.

### Copy refusals and complete restoration, 2026-10-08 23:12Z

Haynes-ops #3608/#3609 restored the first copy refusal in 89 seconds, before any Job was created. The startup
parser and Libretto rollout fence were corrected and independently reviewed. The next pause/inverse pair,
#3611/#3612, created only one read-only Lidarr helper. All eight publisher captures completed in 32.283 seconds,
then the imported mount guard refused before SOURCE/MAIN, PostgreSQL leases, proof delivery or archives.
The exact first runtime refusal was not retained. Offline reproduction identified two already verified SAB
local-XFS mounts rejected again by the final sweep. A live read-only inventory also exposes unrelated system
storage mounts that require explicit normal-write/source classification rather than blanket exemptions.

The second window's first stop was 23:09:08Z and full restoration completed at 23:11:34Z, about 146 seconds.
Kubectl/native checks at 23:12:16Z verify all six relevant schedules unsuspended, LazyLibrarian/Kavita/Libretto
Ready, acquisition normal, all four Flux scopes Ready at `0e6b3c29`, and no owned copy Jobs, Pods or PostgreSQL
sessions. Both inverse PRs passed current checks and Claude review before merging; their worktrees were removed.
No copy moved and no list write occurred. Diagnose while live, with no automatic retry. The detailed cold-start
receipt and remaining obligations are in `.agents/context/2026-10-08-831-copy-refusals.md`.

### Third copy refusal and live repair, 2026-10-09 00:01Z

Haynes-ops #3613/#3614 restored all six schedules, LazyLibrarian/Kavita and Libretto acquisition.
Actual checks at 23:57:28Z show four Flux scopes unsuspended/Ready at `1ed0d32de`, all owned
Jobs/Pods absent and primary PostgreSQL 16 owned sessions zero. The watcher completed at
23:57:34Z, 155.566417 seconds after first stop. Current checks and the clean normal Claude review
were read before merge; both extra worktrees were removed.

All eight publisher checks and explicit normal-write profiles passed. SOURCE was created but its
Job validation refused before binding or a census; actual SOURCE UID/transient session history
are unknown. MAIN was never created and zero copies moved. An exact server dry-run reproduced
only the API's omission of `/tmp` mount `readOnly: false`. Correct that semantic comparison
narrowly while live. Also correct hourly cleanup ordering so identity refusal precedes every
cleanup edit. The detailed receipts remain in `.agents/context/2026-10-08-831-copy-refusals.md`.
Lists, guarded consolidation and the hourly gate are still pending; OC-045 remains an overnight check.

### Fourth copy refusal, 2026-10-09 00:24Z

Haynes-ops #3616/#3617 restored all six schedules, services, acquisition and four Flux scopes
within 187.907 seconds of first stop. Fresh native checks at 00:24:22Z verify all owned Jobs,
Pods and PostgreSQL sessions absent. Three read-only Jobs were bound; SOURCE established
its own primary PostgreSQL 16 SHARE fence and captured both complete app tables, but its
whole-library census has no completion receipt. LL refused before Kavita or MAIN creation.
No copy moved. Both reviewed inverse worktrees were removed.

Historical Loki recovers LL's Pod identity and an assertion refusal; an offline reproduction
separately identifies the fractional deadline mismatch. Correct that bound conservatively and
the stale Kavita node literal, retain safe named refusals, and prove a bounded sequence before
another pause. The corpus reader's observed 32.588-second and 132.216-second durations do not
prove a future duration. Production stays live during diagnosis. Hourly cleanup ordering is
fixed by haynes-ops #3615 after both valid advisory findings were resolved and re-reviewed.
Detailed actual receipts and remaining work are in the copy-refusals context.

### Bounded copy proof revision, 2026-10-09

Before the next pause, implement and review the DESIGN-028 amendment for complete
live byte evidence followed by exact complete SOURCE and MAIN fingerprint validation.
Retain device identity for every path; the earlier portable non-EPUB fingerprints
are insufficient. App/vendor dependencies remain fresh inside the held window, and
every selected keeper and extra still receives whole-byte and identity checks before
any move. Preserve all absolute deadlines, original capture clocks and restore-first
behavior. New or changed paths refuse rather than being silently adopted. Production
stays live during implementation and its read-only baseline capture.

### Bounded writer shipped, 2026-10-09 01:08Z

Haynes-ops #3620 merged at `04c611e7` after all current checks and a clean normal Claude
review. Its manual mode retains the SOURCE and MAIN primary PostgreSQL fences, validates
every current library fingerprint and rehashes every selected keeper and extra before
the first move. It verifies the final whole path set against only the actual moved paths
and preserves partial-move receipts on refusal. Normal hourly behavior is unchanged.
Sixteen focused corpus fixtures, five existing guards and eighteen PostgreSQL 16 tests pass.

The separately reviewed collectors retain complete original byte evidence with decimal-string
fingerprints, collect current SOURCE stats without byte reads and measure the full stat
operation plus all 41 selected paths. The prepared clock/node corrections are independently
reviewed. Signed image publication, actual native input delivery and the final consumer
closure remain pending; no actual baseline Job or next copy pause is authorized here.
Use the 170-second restoration trigger and retain the original evidence expiry. Native
checks at 01:05:49Z still show all six schedules, services and acquisition live with no
owned Jobs, Pods or PostgreSQL sessions. Hourly stripping remains disabled.
