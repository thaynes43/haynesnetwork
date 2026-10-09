# Parallel adversarial review and Kometa outcome — 2026-10-09

The requested haynesnetwork adversarial review and overnight Kometa investigation
ran in parallel with native Codex subagents. Both original asks are complete and
verified in production. The inherited #825 operational work remains separately
gated; source preparation and diagnostic equality must not be recorded as COPY,
list application or hourly-strip completion.

## Haynesnetwork review

Five reproduced defects landed in [#866](https://github.com/thaynes43/haynesnetwork/pull/866),
merge `68a3ccd9ce59c69983b7f2d3962a0d00fce0ab41`:

- Partial title/contributor matches falsely covered distinct collection requests.
- Goodreads fallback evidence falsely proved a held book with the wrong identity.
- A pairing change during an awaited acquisition could queue the previous source.
- Unicode conjunction and punctuation variants escaped the extra-work census guard.
- LazyLibrarian drain/orphan cleanup acted on ownership that changed during its read.

The advisory follow-up also retained independently verified complete contributor
rosters and deferred unproved held candidates across every automatic acquisition
path. The full regression/race limits are in
[the adversarial review record](2026-10-09-adversarial-books-review.md).
All required checks and actual advisory findings were resolved before merge.

[#867](https://github.com/thaynes43/haynesnetwork/pull/867) separately limited
owed-check issue mutations to the workflow's owned marker. #864 was reopened;
its manually maintained repair issue must not be closed as an owned reminder.

Release [#868](https://github.com/thaynes43/haynesnetwork/pull/868), source
`8374aeca2456ec7aba035530be4755fd89216cf1`, shipped v0.110.5. Signed publication
and ops [#3639](https://github.com/thaynes43/haynes-ops/pull/3639) deployment were
verified: three app Pods, released raw/compiled modules, init success and all 24
relevant CronJob image pins. Evidence is durable in ops
[#3641](https://github.com/thaynes43/haynes-ops/pull/3641). Production was rechecked
healthy at 20:44Z: app 3/3, SourceReady, normal schedules/acquisition, strip at 0.

## Kometa

The 2026-10-09 operations Job took 77m47s. The growth began with v2.5.0:
v2.4.8 took 3m25s on September 21; subsequent operations runs grew to 43–52m
before this incident, while the library remained approximately 6,200 titles.
The release replaced bulk IMDb rating data with per-ID utility calls cached only
within a run ([upstream change](https://github.com/Kometa-Team/Kometa/pull/3374)).
There was no observed restart, rate-limit or retry storm. Old timers were disabled,
so the final additional 26 minutes cannot be attributed precisely.

Ops [#3635](https://github.com/thaynes43/haynes-ops/pull/3635) restored the official
bulk IMDb dataset for the reviewed exact module SHA, with a source-drift refusal
and explicit upstream rollback mode. All three Kometa Jobs share a serial lock;
timers are enabled and the deadline is now three hours. Paging thresholds remain.
The actual normal operations Job completed in **91 seconds**, with **one bulk IMDb
request and zero per-ID requests**, processing 6,224 rated titles. It exited 0 with
no restarts or new errors. Exact timings, warnings and cleanup are in ops
[#3637](https://github.com/thaynes43/haynes-ops/pull/3637) and
`.agents/reports/kometa-runtime-2026-10-09.md` in haynes-ops. This proves the operations
fix; it is not a claim that collections and overlays were separately rerun.

## Inherited #825 assurance

Production acquisition is on. `STRIP_SERIES_METADATA=0`; #3571 remains held.
The unused drafts #3622/#3623 and successor drafts #3659/#3660 were closed
without merge or application; their branches remain preserved. Old worktrees
remain under the configured rescue/sweeper policy.

The third isolated Ransom fixture reached the actual pinned native scanner. All
82 schemas, 34,433 rows and IDs remained; all 77 other tables were unchanged,
including protected reading/history/list/curation state. It returned UNKNOWN on
25 metadata cells in five intended catalog rows; the inverse did not run. Exact
UID foreground cleanup and fresh independent full Jobs/Pods union absence passed.
Ops [#3673](https://github.com/thaynes43/haynes-ops/pull/3673), merge
`e0f14715d9c57624687107104ba8f1d80dab61d6`, records the actual result. The native
source uses nondeterministic cover colors; the successor must bind encoded cover
bytes and the exact native output format rather than predict one random sample.
No production writer is approved by this diagnostic.

The final complete LIVE diagnostic used the signed writer runtime and separately
hash-reviewed two-reader source closure. It completed in **165.603374 seconds**:
1,964 EPUB rows, 4,819 file fingerprints and the current three selected paths
(2,159,232 bytes). Exact artifact/ACK, Kubernetes Job completion with exit 0 and foreground
UID cleanup/full union absence passed. Ops
[#3680](https://github.com/thaynes43/haynes-ops/pull/3680) retains the actual proof.
Its original earliest-byte-plus-300-second clock expired honestly; it is
permanently non-COPY and cannot be restamped or adopted for a later mutation.

The one separately authorized Normal-only rehearsal proved actual suspension and
fresh same-UID handler drains for both parents, four apps and the Source while
services remained Normal. It restored all seven owned holds and annotations,
then proved fresh Job/Pod union and both PG leases absent; watcher exit and
unchanged Deployment/Pod identities were verified independently. It **missed
the original 50-second recovery budget**: restoration began 22:29:08.925175Z,
missed at 22:29:58.925777Z, and completed 22:31:07.270425Z (**118.345250s**).
The result is `RECOVERED_AFTER_MISSED_BUDGET`, not an in-budget pass.
Ops [#3685](https://github.com/thaynes43/haynes-ops/pull/3685) records the result and
the narrow atomic/cold-state completion correction. The unresolved timing gate,
next bounded instrumentation and unchanged guards/budgets are in ops
[#3684](https://github.com/thaynes43/haynes-ops/issues/3684). Per-call timings were
not retained, so no quantified bottleneck or ready-for-Stop claim is justified.

The latest isolated Ransom v8 attempt also returned **UNKNOWN**, with exact UID
cleanup and full native union absence. Before/after-Build equality and its durable
ACK passed; after-bind/scan metadata projection, the inverse and native zero-exit
completion remain unproved. Ops
[#3683](https://github.com/thaynes43/haynes-ops/pull/3683) records the actual result
and the concrete missing `IDefaultParser` dependency in native `BasicParser`
construction. Source correction and signed fixture publication are preparation;
they do not prove another scan or inverse and authorize no new Job.
The corrected fixture `53dfa067` was signed and published from source `5dda7676`
by [main run 38000667440](https://github.com/thaynes43/haynes-ops/actions/runs/38000667440).
Its full 13-module/SDK closure passed, receipt
`889403dea9d7724d7bf3bd1cd13a82b0d3bee1c5df50f8e54ddc53b720449ac1`.
The CLOSED successor pin and publication record are in ops
[#3686](https://github.com/thaynes43/haynes-ops/pull/3686); the native scan/inverse
gate remains pending, with no successor Job authorization.

Every future actual phase needs a newly frozen packet and exact-command approval.
The merged host/fixture/CI source improvements preserve full finite checks and
canonical image provenance; they grant no production write authority. Neither
the expired LIVE diagnostic nor Normal safety recovery closes the COPY gate.

#831/#864, reading lists and hourly enable remain open. Ransom's July 27 reading is
already past the 30-day idle threshold; preserve the folder hold for the separate
native preservation proof, not another 30-day delay. The minimum Pathfinder scope
is two duplicate extras; preserve the authoritative EPUB/PDF and genuine Visitors.
Full COPY still requires current saved-state checks, complete synchronized caller
closure, fresh actual fenced captures and original service/lease budgets. No
production catalog/EPUB/library/list write or service Stop was performed by these
diagnostics. The Normal rehearsal's temporary owned Flux holds were fully retired.
