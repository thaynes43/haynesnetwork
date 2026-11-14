# Story 843 — first adversarial corrections, 2026-11-14

Scope is the canonical story (`opwork show 843 --history --full`) and the correction work order. No story claim/status change. The existing PR is https://github.com/thaynes43/haynesnetwork/pull/1079. No scope conflict with the tracker was found. The session rule requires commits on `agent/haynesnetwork-1114-083731`, pushing that branch and opening a PR; the work order instead requests only the existing PR branch. Preserve a session-branch review mirror while updating the authorized existing PR; neither PR is merged by this worker.

Source preparation measured 2026-11-14: `git fetch origin main agent/haynesnetwork-1114-065403`; freshly fetched main was `780fdeb178850c7b9f11941e9442ed09d1afe101`, an ancestor of the reviewed `d1bbb7803d421ec4b440ce1880a82031ac8b648e`. The latter was fast-forwarded into this session branch without changing worktree or branch. Main had not advanced at pickup, so no merge was necessary.

Budget/stop: the assigned session only; stop at its context limit or a hard blocker, preserve/push source and report. No delegation, extra session, live media action, deployment or merge. The dependency and uncertainty questions are D-32 Q-38 and Q-39. Disk measured by `df -h`, `df -i`, `du -sx /tmp` before preparation: the home volume had 18 GiB available, inode use was 5%, and `/tmp` was empty. Working budget: at most 8 GiB additional home data, with at least 6 GiB reserved; keep temporary data below 1 GiB. A later `df -h` on this date showed 17 GiB home headroom. These are displayed filesystem measurements, rounded by `df`, not exact byte counts.

Corrections:

- F3: migration 0112 edited in place. A Restore Keep has its own UUID and unique kind/external identity, title snapshot and nullable ledger link with SET NULL; no cascade. All reads use stable identity. Admin removal works by keep UUID after unlink. The review probe's old-row expectation was corrected deliberately: a reused ledger row now naming another title must not inherit the original title's keep.
- F1: final sweep/Expire-now keep checks use the resolved kind/external identity. A transaction advisory lock coordinates keep acquisition/removal, deletion claim and bulk action. Durable deletion claims commit with the ordinary intent/audit before the handle; unfinished/ambiguous claims refuse Restore and bulk until reconciled. Expedite shares the protocol. No automatic expiry. Unknown identity keeps/refuses.
- F2: both release-post writers require a release name and check the current managed profile before POST. Release Pick plain/override, `sendReleaseGrab` (Wrong-Content Replace, retry and selected-part continuations), and Language Replace all supply it. Language preflights before destructive steps and never falls back to a search after this refusal. Durable offers become stale and local search caches are cleared at delete/restore intent. Restore never mutates terms. The current-term check is not historical coverage or permanence: story 845 / PR 1080 is required for term lifetime.
- F4/F5: target reads and missing-tag creation finish before the locked final check. It checks the exact frozen request identity, its unchanged ledger binding, Trash history and unfinished delete claim; the lock and ledger row lock continue through add/monitor/search and receipt. Skips send none of those title writes.
- F6: keep management follows the table. The table retains initial membership/order while results show. The Playwright regression checks a neighbour through success, a lost response that still creates a keep, and keep removal.
- Documentation: ADR-121 remains Proposed; D-32, T-341 and the hard-rule text are updated. Original ids retained; only Q-38/Q-39 added. No second migration. `packages/domain/src/release-block.ts` is unchanged. Keep removal has no grace period. Image rollback retains rows/audits/revoked grants but old code ignores keeps and can grant Restore again; check grants and hold destructive Trash work on rollback.

Guard preservation was reviewed against main: existing tag, Save, Request Keep, recent-view, Age Guard, watchlist and posted-name checks retain their earlier precedence, and the batch's pre-existing Save predicate is unchanged. The stable-identity keep and claim checks add refusals. Main's migration journal is an identical prefix (`python3` comparison of `git show origin/main:packages/db/migrations/meta/_journal.json` with the working file, 2026-11-14). Embedded migrations exercised the revised schema.

Seerr evidence is request-event ingestion plus tagged ledger sync for a movie and TV; Title Exclusion and Seerr writers are unchanged. The harness does not execute Seerr's own request controller against a manager, so it cannot prove exclusion-present request delivery. Q-39 gives the coordinator's proposed authorized live check. No live check was performed.

Validation measured 2026-11-14 UTC. Counts are Vitest's per-invocation summaries, with parameterized cases counted separately. Rows overlap and are never summed.

| Command | Measured result |
| --- | --- |
| `pnpm --filter @hnet/domain exec vitest run --maxWorkers=2` | Initial completed checkpoint: 138 files, 2809 tests passed. Earlier run exposed inherited uncertain claims in independent fixture scenarios; test isolation was corrected without removing the production hold. |
| `pnpm --filter @hnet/api exec vitest run --maxWorkers=2` | 48 files, 641 tests passed. |
| `pnpm --filter web exec vitest run --maxWorkers=2` | 61 files, 728 tests passed. |
| `pnpm --filter @hnet/arr exec vitest run --maxWorkers=2` | 17 files, 185 tests passed. |
| `pnpm --filter @hnet/domain exec vitest run review-843 --maxWorkers=2` | Earlier focused checkpoint: 2 files, 22 tests passed, including delete-intent offer invalidation after the full run. |
| `pnpm typecheck` | Passed. |
| `pnpm lint` | Passed; warnings occur in unchanged network/book-fix/pool-refresh files. |
| `pnpm lint:css`; `git diff --check` | Passed. |

The reviewer reproductions are committed as regressions, expanded for both manager kinds and the specified interleavings. Intermediate failing runs were fixture/setup corrections, not acceptance evidence; no aggregate test count is inferred.

Checkpoint state: source and package validation complete; browser position check and required CI pending. Built, installed/deployed and accepted are separate: no deployed or accepted claim. Coordinator retains story ownership and the required Fable review/merge decision. Next safe step: browser check, required CI on the pushed PR head, then coordinator review. Final evidence will be appended below.

Final self-review checkpoint: deletion intent/Activity audit still used the frozen ledger link after a successful resolved-identity claim. The claim now row-locks and validates that resolved binding, audits that title, retains the old frozen-link Save predicate and adds a resolved-link Save check. A movie/TV obsolete-link regression verifies that the unrelated ledger row receives no delete event. This is part of F1's resolved-identity correction. Validation for this delta is pending below. Browser bootstrap built successfully, but the initial filter matched no tests; the corrected filter then found the cached Chromium version did not match the installed Playwright package. Installing the matching Chromium; neither run is browser acceptance evidence.

Advisory follow-up, 2026-11-14: applied the same locked ledger-binding check to both Expedite scopes, report late contention/remaps as unevaluable instead of Saved, reserve admin-restored attribution for actual keep rows, and merge refreshed data into the pinned row positions (disable Restore for a missing row). Definitive claim completion now waits for the title lock with a configured bounded timeout. Crashed/ambiguous claims remain conservatively held as Q-38 explicitly proposes; automatic stranded-settle completion is not implemented without a positive completion contract. The advisory finding is answered on the PR; this policy question remains for coordinator/Fable review. Focused command `pnpm --filter @hnet/domain exec vitest run review-843 trash-flow trash-restore-keep --maxWorkers=2` measured 91 tests passed across 5 files. This overlaps prior runs and is not added to their counts. A browser run reached the final keep-removal interaction and exposed an unstable test locator (resting accessible name changes when armed); the locator now matches both armed/resting names. That failed run is not browser acceptance evidence.

## Final source handoff checkpoint

Measured 2026-11-14 UTC. The table below supersedes earlier checkpoints for the same command. Counts are per invocation, parameterized cases count separately, and overlapping rows are never summed.

| Command | Measured result |
| --- | --- |
| `pnpm --filter @hnet/domain exec vitest run --maxWorkers=2` | 139 files / 2817 tests passed (start 09:37:55 UTC, 224.25 s). |
| `pnpm --filter @hnet/api exec vitest run --maxWorkers=2` | 48 files / 641 tests passed (start 09:41:40 UTC). |
| `pnpm --filter web exec vitest run --maxWorkers=2` | 61 files / 728 tests passed (start 09:43:02 UTC). |
| `pnpm --filter @hnet/domain exec vitest run review-843 --maxWorkers=2` | 3 files / 30 tests passed (start 09:45:04 UTC), after supplying explicit `watchlist: null` to the new regression fixture for typecheck. Product source was unchanged after the full suite. |
| `pnpm --filter @hnet/arr exec vitest run --maxWorkers=2` | 17 files / 185 tests passed. `git diff 6b057299..622ae93d -- packages/arr` was empty: these client files were unchanged through the later domain/UI fixes. |
| `pnpm typecheck`; `pnpm lint`; `pnpm lint:css` | Passed after the fixture correction. Lint warnings remain confined to unchanged files. |
| `CIRCLE_NODE_TOTAL=3 RAYON_NUM_THREADS=2 pnpm --filter web exec playwright test trash.spec.ts --grep 'Recently deleted keeps neighbouring' --workers=1` | 1 test passed, reported duration 19.3 s. The stack built/served the production Next build, with the build worker count bounded through Next's configured CPU input. Test confirms refreshed neighbour data and unchanged control coordinates through success, uncertainty and keep removal. |
| `git diff --check`; main journal-prefix comparison | Passed. Fresh `git fetch origin main` still identified `780fdeb178850c7b9f11941e9442ed09d1afe101` as an ancestor, so no base merge or id renumbering was needed. |

All listed counts were checked against their individual logs; no household totals were recomputed or inferred. Intermediate failures (fixture isolation, a missing schema import, a missing typed snapshot, test-name filtering, browser availability and an unstable armed-button locator) were corrected and are not presented as acceptance evidence.

Advisory findings have replies on PR 1079. Valid code findings were fixed. A crashed/ambiguous claim's conservative hold remains explicit in Q-38; background auto-unlock is not implemented, and an unconditional finally-unlock would be unsafe without completion evidence. The coordinator/Fable review must settle that recovery contract. Q-39 records the live Seerr/exclusion-present evidence boundary. No Release Block term or existing Save/Request Keep guard was removed.

Source: this session branch and canonical `agent/haynesnetwork-1114-065403` are pushed with the same source; draft PR 1085 is the session-rule mirror and must not be merged independently. Canonical PR 1079 owns review/merge. Built/tested: local production build, package suites and browser test as above. Installed/deployed live: none. Accepted: pending coordinator, independent Fable review, and subsequent installation/acceptance evidence. No story claim/status/complete action was taken.

Required CI on the next pushed checkpoint commit is pending at the time this file is committed. Its final result and exact commit are recorded on PR 1079 and story 843 after completion; this worker will not end while its required checks run. Next safe step after green CI: coordinator/Fable review of Q-38/Q-39 and the final diff, then the coordinator's merge decision. No merge or deployment is authorized for this worker.
