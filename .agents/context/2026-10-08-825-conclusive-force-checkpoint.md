# Issue 825 conclusive Force checkpoint

Recorded 2026-10-08 19:48Z. This is a checkpoint, not completion of copy or recipe work.

The new Force request (owned Job UID c35121c3-0b00-467b-a41c-bcb768a6ab57) was accepted at 19:44:04.139Z.
The same server enqueued it at 19:44:04.137759Z, started at 19:44:04.142983Z and committed at
19:47:13.838811Z. The scan processed 2,034 files and 1,932 series in 189,699 ms. Both blank-series completion
notifications arrived at 19:47:13.684Z and 19:47:13.880Z. The source Pod UID and restart count stayed unchanged.

Proof `/home/dev/work/hn-825b-force-only-cont03-proof.json` SHA-256:
`ef3ecd0e50215689f0bf297a3b97a02157b49fee0d5a5dace10d759acacb8f59`.
The controlled continuous log closed after both notifications, retaining 4,027,597 bytes and 18,878 lines.
It proves the current requested scan, while original historical backfill observation remains false.

All 48 reading rows, saved lock flags, values and references across eight tables, and all 27 curated tables
and file path mappings stayed exact. Scanner timestamps and unlocked colors changed; whole locked
Chapter/Series rows are not claimed byte-equal.
The fresh 1,956 EPUB inventory accounts for every file, mapping 1,949 with the same seven missing and 13
nonunique paths already recorded in `2026-10-08-825-coverage-gaps.md`. No new loss or metadata replay occurred.

[Pause haynes-ops #3606](https://github.com/thaynes43/haynes-ops/pull/3606) merged at 19:42:45Z.
[Full inverse #3607](https://github.com/thaynes43/haynes-ops/pull/3607) merged at 19:47:38Z after fresh required
checks and a clean current Claude review. All five CronJobs were unsuspended, Libretto acquisition was normal,
and all three Flux scopes were unsuspended/Ready on `35cb8f40980adfab4122d3ef229bd80e5cfbb408` at 19:48:44Z.
The recovery watcher completed and both clean merged worktrees were removed. Hourly metadata stripping stays
at zero and Ransom stays held. Production is running.

Native v0.110.4 refresh and conservative pairing are verified separately: 1,932 held-book reads and 1,231
expanded Audiobookshelf records, 716 pairs, 35 reservations, seven approved settlements/events and all 764
protected wants exact, with no acquisition/provider/LazyLibrarian/release write. Issue #850 is closed.
The Assistant to the Villain want from OC-043 points at the correctly held ebook and exact BookFile for
Hannah Nicole Maehrer. Its requested audiobook is distinct from Accomplice; no corrective write was needed.

Remaining work: bounded guarded duplicate consolidation, physically verified library-only reading lists,
hourly flag enablement and final documentation. OC-045 waits for October 9 04:00Z scanning and 04:32Z pairing;
OC-046 separately governs the retained Ransom folder using its actual July reading timestamp.

Final independent packet `/home/dev/work/hn-825b-force-only-cont03-final-evidence-packet.json`, SHA-256
`4d4b9d6313da99a4230ac3e7b23590c748ef1a59478f947fa1a97c1b97b9ba19`, preserves an immutable received observer
prefix through the original proof timestamp. Known owned Job/Pods and local/remote observers are absent.
