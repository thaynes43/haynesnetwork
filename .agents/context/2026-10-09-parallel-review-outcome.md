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
The unused drafts #3622/#3623 were closed without application. Prepared successor
drafts #3659/#3660 have also never been applied. Old worktrees remain under the
configured rescue/sweeper policy.

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

Read the current ops source/proof records before another phase. LIVE census host
finalization, Normal-only recovery and native projection/inverse source successors
are being independently reviewed in #3674/#3672/#3676. Every actual run needs its
own newly frozen packet and exact-command GO; an expired diagnostic baseline never
supplies COPY authority. Shared CI cache correction #3677 must retain canonical
digests, full tests and publication provenance.

#831/#864, reading lists and hourly enable remain open. Ransom's July 27 reading is
already past the 30-day idle threshold; preserve the folder hold for the separate
native preservation proof, not another 30-day delay. The minimum Pathfinder scope
is two duplicate extras; preserve the authoritative EPUB/PDF and genuine Visitors.
Full COPY still requires current saved-state checks, complete synchronized caller
closure, fresh actual fenced captures and original service/lease budgets. No
production catalog/EPUB/library/list write or Stop/pause was performed by these
diagnostics.
