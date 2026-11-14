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
| `pnpm --filter @hnet/domain exec vitest run --maxWorkers=2` | Final full run: 138 files, 2809 tests passed. Earlier run exposed inherited uncertain claims in independent fixture scenarios; test isolation was corrected without removing the production hold. |
| `pnpm --filter @hnet/api exec vitest run --maxWorkers=2` | 48 files, 641 tests passed. |
| `pnpm --filter web exec vitest run --maxWorkers=2` | 61 files, 728 tests passed. |
| `pnpm --filter @hnet/arr exec vitest run --maxWorkers=2` | 17 files, 185 tests passed. |
| `pnpm --filter @hnet/domain exec vitest run review-843 --maxWorkers=2` | Final focused run: 2 files, 22 tests passed, including delete-intent offer invalidation after the full run. |
| `pnpm typecheck` | Passed. |
| `pnpm lint` | Passed; warnings occur in unchanged network/book-fix/pool-refresh files. |
| `pnpm lint:css`; `git diff --check` | Passed. |

The reviewer reproductions are committed as regressions, expanded for both manager kinds and the specified interleavings. Intermediate failing runs were fixture/setup corrections, not acceptance evidence; no aggregate test count is inferred.

Checkpoint state: source and package validation complete; browser position check and required CI pending. Built, installed/deployed and accepted are separate: no deployed or accepted claim. Coordinator retains story ownership and the required Fable review/merge decision. Next safe step: browser check, required CI on the pushed PR head, then coordinator review. Final evidence will be appended below.

Final self-review checkpoint: deletion intent/Activity audit still used the frozen ledger link after a successful resolved-identity claim. The claim now row-locks and validates that resolved binding, audits that title, retains the old frozen-link Save predicate and adds a resolved-link Save check. A movie/TV obsolete-link regression verifies that the unrelated ledger row receives no delete event. This is part of F1's resolved-identity correction. Validation for this delta is pending below. Browser bootstrap built successfully, but the initial filter matched no tests; the corrected filter then found the cached Chromium version did not match the installed Playwright package. Installing the matching Chromium; neither run is browser acceptance evidence.
