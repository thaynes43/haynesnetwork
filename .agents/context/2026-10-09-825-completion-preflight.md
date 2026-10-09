# #825 completion preflight, 2026-10-09

Read-only checkpoint following the adversarial books review. App PR
[#866](https://github.com/thaynes43/haynesnetwork/pull/866) merged at 15:23:46Z as
`68a3ccd9ce59c69983b7f2d3962a0d00fce0ab41`; its exact tested head was
`0f4940a0a1390747d86021c736d61a756c450f0e`. Required lint/typecheck, test, build and
e2e-gate passed; production e2e passed in 7m6s and the current Claude advisory had
no findings. The review and its real counterexamples are recorded in
`2026-10-09-adversarial-books-review.md`. The v0.110.5 release/deployment is still
in progress at this checkpoint. This packet authorizes no library or list write.

**15:34Z update.** Release PR #868 merged as `8374aeca2456ec7aba035530be4755fd89216cf1`;
image publication and haynes-ops #3639 three-tag deployment verification remain in progress.
The actual V3 whole-corpus LIVE attempt expired its original 180-second deadline without
a baseline artifact or ACK. Independent cleanup at 15:33:33.916Z proved the union of all
owned Jobs and Pods absent. Production stayed live. The child-kind cleanup correction,
real typed-list regression and cap-preserving corpus-performance diagnosis are in progress;
no fresh GO or increased CPU/deadline is inferred. The earlier V2 refusal remains history,
not the latest closure state.

## Current gates and historical corrections

The original #825 rulings remain: one Kavita series per book; #830 author-qualified
grouping for distinct same-title works; #831 unique LazyLibrarian BookFile keeper,
unprotected extras retained outside EBooks indefinitely; #835/#838/#839/#842
conservative complete-identity defaults. Acquisition cannot fill an identity gap.
No new author, title, progress migration or blanket duplicate policy is inferred.

Prepared conditional profiles are `.agents/plans/074-pathfinder-two-extra-profile.json`
and `074-ransom-series-only-profile.json`. They freeze exact scope, supported inverse argv
and deterministic retained-manifest names, with `runtime_authorization=false`. Fresh
inputs, native admission, current pause/inverse and ROOT's exact phase ratification are
explicitly unbound. They are not approved writer selections or submitted Jobs.

The October 9 14:30Z OC-047 file audit supersedes the earlier series-only conclusion.
Of the original 1,956 EPUBs, 1,946 map, with ten gaps rather than seven. All three
Pathfinder EPUBs lost their mapping after the normal 04:00Z scan removed series
2268; original series 1448 holds only the PDF. The 1,946 mapped baseline paths kept
their prior series IDs and the 13 nonunique paths are unchanged. Seven later EPUB
arrivals expand the current corpus to 1,963 EPUBs / 4,816 EBooks files in that audit;
the wider historical 4,730-file corpus was not re-derived. A fresh complete corpus
is mandatory. #864 remains open; #867 fixes the unrelated owed-check issue closure
controller. A manual Force result cannot satisfy the unchanged-folder nightly guard.

All five earlier copy windows moved zero copies and wrote no reading lists. COPY05
merged pause/inverse #3618/#3619 under Flux holds, but never stopped a service or
created a baseline Job. Drafts haynes-ops #3622/#3623 are unused preparations and
require current bases, exact resource validation and reviewed inverse checks. The
prior measured 32s/132s collectors are not a future duration guarantee.

The signed manual image is now verified at its exact digest:

`ghcr.io/thaynes43/book-copy-writer:sha-04c611e7ccf6d057f5b6b466dc4d52f5bb5672c8@sha256:fe12dd95f77cbdf33f2bd57cbe8ecb752e9d730a7de6b26b329beca474954d5f`

The independent image audit checked workflow identity, GitHub issuer, repository,
source SHA, trusted certificate chain and offline transparency inclusion with the
official cosign v3.1.3 binary. All 14 immutable host packet pins passed; the later
02:02:39Z independent PASS supersedes the stale 01:59Z resume block. A six-second
read-only image/module/mount smoke on talosw01 completed and foreground deletion
proved zero owned Jobs/Pods. Actual full LIVE V2 lifecycle refused **before Job
creation** on kubectl's synthetic `kind: List` inventory. The narrowly typed raw API
inventory V3 correction is under independent review in haynes-ops; no complete
corpus/ACK/foreground cleanup receipt is claimed yet.

That frozen LIVE producer is Python + read-only NFS: it has no app/PG capture or
source-app version binding. A live lifecycle measurement may precede v0.110.5, but
cannot authorize a later COPY, refresh expired clocks or replace the required
post-deployment app/vendor capture. Evidence expiry, original device fingerprints,
native Job/Pod UIDs, the 170s restoration trigger and SOURCE/MAIN PG16 fences remain.

## Read-only vendor and Ransom checkpoint

Stable Kavita DB capture: 14:47:39.420090Z, unchanged source stat before/after,
no source WAL/SHM/journal. Queries used a private read-only copy; raw database/user
payloads are not committed. All five saved-state tables exactly match the prior
retained baseline: 17 progress, zero bookmarks, zero annotations, 11 sessions and
20 activity rows, 48 total. No saved-state write occurred.

Ransom's current file is `Daniel Silva/Ransom/Ransom - Daniel Silva.epub`, 1,081,949
bytes, SHA-256 `e4969ea19b51a3d65efbb0cdce7bea08a0a8434c98ff123a772a2f59a8733e7a`.
Its OPF remains title `Ransom`, creator `Daniel Silva`, collection `Gabriel Allon`.
The folder also retains AZW3, MOBI, OPF and JPG; all five are regular single-link
files. No folder/author `.ll_ignore` was found. The EPUB alone maps to MangaFile
3570 / chapter 3358 / volume 1800 / series 1650; that series contains only this
chapter/file. No separate current Ransom series was found.

The latest actual reading ended **2026-07-27T03:37:35.1269016Z** in activity 22 /
session 11. Progress 19 retains the same chapter and saved XPath
`//body/section[1]/div[1]`. Session LastModified at 03:47:35 is housekeeping; daily
history preserves the same actual end, not newer reading. The 30-day rule was
satisfied **2026-08-26T03:37:35.1269016Z**, about 74 days idle at this capture.
No additional waiting period starts on October 8. Target bookmarks, annotations,
curated list/remap relations and saved locks are absent in this capture.

OC-046 is still pending because eligibility is only one prerequisite: the configured
whole-folder hold remains in git. A separate exact-folder, series-only strip needs
fresh activity/identity proof, original-byte retention and exact scan/state verification.
No Kavita state writer or progress migration is authorized. Because the current series
contains just the retained Ransom chapter, its post-strip scan must establish preserved
saved IDs/XPath rather than assuming a metadata restore restores database IDs. Keep
this as an explicit execution gate, not an invented new retention wait. Set the next
overnight verification from the actual successful scan date, not from this capture.

Preparation validation checked both profile scopes, deterministic retained-manifest
names/inverse argv and Ransom's exact-folder strip-only/dry-run/state preservation
flags. The current production `epub_copies.load_selection` refused the conditional
Pathfinder profile, as required: it is not an approved SHA-bound writer selection.
The owed-check parser admits all 47 rows and preserves OC-046's pending status/due.

## Reading lists and conservative identity decisions

Credential-safe GET-only Libretto capture at 15:18:27.360Z found 75 recipes, all valid,
zero issues and no active queued/running run. Full parsed recipe payload hash was
`35b6c2d4d0b12cf9c368924bb61e791989e3b41b586930d15ec205a7a477498a`, stable before/after
and equal to the retained baseline. There are 39 ordered_books recipes. Sixty recipes
across all targets permit acquisition; 27 ordered_books recipes do. The proposal's new
Bobiverse, Heroes of Olympus and Pathfinder IDs are absent. Latest completed run was
`20261009090000-9820006c`, status ok.

Deployed Libretto image is `sha-716da1f`; relevant module hashes:

- `target/kavita-chapters.js`: `e28c2c3a7762779e2c5f227ce9eecd1c71f81607d0c3b2722119187826aff258`
- `core/reconciler.js`: `2754b7e0603c67334377e389a08d7e7bf93827d96cbb3c57a881eef7237a34e8`
- `recipes/schema.js`: `8bcf1f4601c5c3872dd492ce14b9e93f8eb040d01e6a9d8c0066c18c89c564b1`

Kavita has 45 ReadingLists / 259 items, zero remaps, 49 AppUserCollectionSeries
relations and zero CollectionTagSeriesMetadata relations in this capture. Target
Pathfinder/Visitors/Ransom curated dependencies are absent; the whole tables and
every existing item ID still require exact capture/preservation before each write.

The old 104-scope preview (39 existing + 65 proposals) selected 42 positive scopes
and held 62, with 136 additions and zero removals. It grants no current write authority.
Refresh that preview after the corrected app deployment and library stages, using
actual full chapter titles and complete contributor arrays, native module/Pod/run-store
proofs and fresh raw-source evidence. Preserve all 75 existing recipe payloads. The
Hunger Games change may append only the approved Books target; keep its ABS target and
every unrelated field. New manual recipes retain acquisition=false. Membership/order
and the retained holds follow #835/#838/#839/#842; unknown metadata is a conservative
hold with tracked reasons, never primary-author guessing or replacement acquisition.

The retained `hn-825-recipes/worker-template.mjs` and `worker-seed-false-template.mjs`
are also stale execution preparations: both permit `ReadingList/delete-item`; existing
repair invokes full sync reconciliation; neither enforces the current 180-second worker,
300-second evidence/native-run-store/scheduler admission or at-most-four scope. Their
global empty LL URL prerequisite also predates the acquisition-disabled child contract.
Do not execute either writer. Prepare a bounded successor matching DESIGN-037's add/order
only, every-old-item-ID preservation and partial-journal rules, with finite protocol
regressions and independent review before any list apply. Read-only previews must still
be refreshed against the actual final corpus and source proofs.

## Exact next stage order

1. Release/deploy #866 as v0.110.5 and verify actual app/CronJob/census code/version.
   Re-read active Jobs and resource identities; the older idle checkpoint is not a fence.
2. Finish the native LIVE lifecycle correction and one bounded read-only proof while
   production runs. Prepare fresh complete corpus evidence and corrected-app capture;
   retain original expiry and refuse new/changed paths rather than adopting them.
3. Freeze the minimum Pathfinder selection and inverse from
   `2026-10-09-831-pathfinder-preflight.md`: retain the authoritative 1.2MB LL EPUB,
   Pathfinder PDF and genuine Visitors; archive only the two identical 480KB Pathfinder
   extras, one misfiled under Visitors. Full current LL table must prove unique keeper
   ownership; the targeted LL rows alone are insufficient. Review exact SOURCE/MAIN
   protection admission, immutable profiles and independent watcher before any pause.
4. Restore production on every outcome before subsequent checks. Observe normal scan
   enqueue/start/commit and both completion notifications; require retained EPUB mappings
   and exact saved/curated/lock state. Keep #864 and OC-047 open until actual mapping and
   the later unchanged-folder nightly scan pass with a deliberately updated file baseline.
5. If independently safe, complete Ransom's separate one-EPUB series-only stage before
   final corpus/list proof, with fresh idle proof, reviewed inverse and preserved reading
   state. No whole-library replay or unrelated metadata change.
6. Run the fresh 104-scope read-only preview. Apply **one** existing ready recipe first,
   then batches of **at most four**, library-only/acquisition disabled. Preserve item IDs
   and all unmodified payloads, retain partial journals and halt unknown outcomes.
7. Restore/verify normal acquisition and sync behavior, current Census/Request Events,
   and complete final corpus/list proof. Rebase haynes-ops draft #3571 to its single
   hourly strip flag + runbook change, review it and enable only after these gates pass.
   Record the actual next overnight checks and merge all receipts.

No service Stop, schedule pause, library move, metadata edit, list write, scan request
or strip gate change was performed for this checkpoint. Actual read-only runtime at
14:45Z had all six schedules unsuspended, services Ready and four Flux scopes Ready;
an active sync-books Job was observed later by ROOT, so use fresh full safety admission
before the next window. Raw private artifacts contain vendor auth material and must be
deleted after their bounded dependency audit; commit only these technical summaries.
