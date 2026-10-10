# #825 / #864: V23 actual private-export refusal and safe closure

Observed production outcome as of 2026-10-10 19:35Z: zero selected Pathfinder
moves, zero Ransom catalog/tag writes, no target scans or list additions.
Preparation and merged source are not repairs.

V23 phase `2e324a0462a049edb1b25888f259cb7f` used Stop #3778 and inverse #3779.
Fresh read-only capture passed in 119.510788679s. The first rejected artifact was
`copy-runtime/issue831-kavita-source-1009-03/reading-state-all.json`: regular,
UID 1000, one link, 37,421 bytes, mode 0644. Dependencies (3,800,311 bytes) and
saved locks (44,924 bytes) had the same mode. The 32 MiB cap was not exceeded.
The original V8 reading-state, dependencies and saved-locks exporters use
`Path.write_text`; inherited umask yields forbidden group/other mode bits.
A future fix must create absent outputs private from the beginning, preserve
JSON semantics and reject overwrite/symlink paths. No old-file chmod or replay.

The private diagnosis receipt is
`/tmp/hn-825-v23-private-artifact-refusal-peer-1010.json`, SHA-256
`e9d1fc9d2696559a79c6513f459ccde1edeeb1cc9d7b519f56960bc46c43019f`.
These paths are supporting local evidence; their absence after cleanup does not
make the old phase executable again.

The main writer never started. Recovery was requested 138.896s after the
original service origin, within the 170s abort boundary. Normal restoration
completed in 70.650373s within the unchanged 130s reserve. Root's accepted final
audit `/home/dev/work/hn-825-pathfinder-copy-packet-1010-v23/actual-final-audit.json`
has SHA-256 `cf583fba086fd94816b0245cdf143e189ff6efd35fd0d6a104937858e0c40f8a`
and timestamp 19:26:20.340954Z. It establishes Normal `31b8b3f4`, exact restored
controller/Deployment specs, healthy current Pods, full typed phase Job/Pod
absence, both primary process-group absence, and retired original watch group.
All temporary holds/activity ended. Old failures remain failures; this elapsed
time is historical evidence rather than a guarantee for the next window.

Merged source #3777 supplies exact prospective publisher profiles; V22's
unretained offending tuple remains unidentified. Ransom #3775 and #3782 are
merged, latest `fd356c378a1fb72cf40b6f9bb329379441c13801` at 19:35:22Z. #3782
adds the complete readonly Lidarr prelude and finite guarded Ransom execution
route. Its reader runs under umask077 and verifies private output creation.
The owner already approved the exact seven-cell/tag/scan repair; no new decision
is pending. All runtime admissions still must be fresh and actual.

The source-only advisory on #3782 was unavailable (error-only result, no
substantive source review); Root read the independent source review and posted
an explicit disposition before merging. V23's actual inverse #3779 separately
had authenticated current-head raw zero-model/no-assistant evidence and distinct
Root ratification of that exact inverse. Underlying advisory failure causes
remain unknown. Neither disposition is authority for a later phase.

Remaining necessary work: fresh guarded Pathfinder two-copy quarantine and
post-Normal scan/mapping/list; approved Ransom repair and preservation checks;
fresh broader #831 accounting; real October 11 04:00Z derived nightly outcome
and subsequent hourly validation. The automatic strip stays off until those
gates. Completed metadata/list batches, original review and Kometa work are
recorded in HANDOFF and must not be repeated.
