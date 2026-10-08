# Issue 825: deployed complete-credit repair and native refresh

Checkpoint at 2026-10-08 19:10Z. This is an intermediate result, not completion of PLAN-074.

Haynesnetwork #851 merged as `b9a1ca2` after all four required checks and the current Claude review passed.
The review's retry-budget finding was fixed and tested. Release #852 produced v0.110.4 from `8c16d6c`.
Haynes-ops #3605 deployed it as `d95138e3`; Flux is Ready at that revision and all three app replicas run
the verified signed image digest `sha256:df0481d0f665f711224e58b7703449a1579aabe85f8f089ccd8887c7e8483d29`.

Only format pairing is suspended, through haynes-ops #3603. Its inverse #3604 is rebased onto the deployed
repair and has green checks and a current review with no findings. Merge still requires actual native cache
verification. Books, books collections, Goodreads and EPUB conversion remain active; Libretto acquisition
is normal. Hourly series stripping remains disabled and Ransom remains held.

The acquisition-disabled native books Job `frontend/issue850-books-force-1008-01`, UID
`897f18a5-f303-44da-bb0a-635a0a2466b2`, completed at 19:06:11Z. Its thirteen source hashes match the reviewed
release. Both sources completed: 1,932 Kavita book holdings and 1,231 Audiobookshelf items, 3,216 upserts,
zero tombstones and zero owned LazyLibrarian write traces. Every live audiobook now carries its complete
source author array. The immediate before/after snapshots retain all 2,425 requests, 1,388 events,
746 pairs, 95 collections, 531 members, 13 account mappings and the empty release queue exactly.

The native log SHA-256 is `b095e69a64d26d030206a4b82571693f2c44affc16c4279a32836caa12b5de7d`.
The before/after application snapshot hashes are
`157707babdfffaed5fef8978d38fbac76f4d16c58e859270d1a0464c54d3cbe0` and
`32ff29fa9d10a89c26c71adb1d2ea8dbf58e788736ec7097df20e6d473bb732f`.
Other schedules remained live, so these are observed equalities rather than a claimed global write fence.

The 290 metadata operations and 289 current edited paths remain verified and must never be replayed.
Conclusive force-scan notification evidence, copy consolidation and reading-list repair remain pending.
No duplicate was moved. A complete eight-publisher scope rehearsal refused its 30-second deadline while
resolving Radarr paths; the receipt is retained and the next step is bounded resolver work while services run.
OC-045 remains pending the October 9 nightly scan and subsequent pairing run. OC-046 owns the separate
30-day-idle Ransom release rule. OC-040 through OC-044 are unchanged.
