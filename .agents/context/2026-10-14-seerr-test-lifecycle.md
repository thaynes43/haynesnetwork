# Seerr browser test lifecycle

The first Seerr bridge attempt in [this test job](https://github.com/thaynes43/haynesnetwork/actions/runs/38504272778/job/115658462396)
exceeded the 60-second `beforeAll` hook budget. Manual admin-context cleanup then received a missing-context protocol
error. The specific UI action that consumed the hook budget is unknown because no first-attempt trace was retained.

The installed Playwright runner races a hook with its timeout without cancelling the callback, then tears down the
worker browser. The helper owned a manual context inside the hook, so its `finally` could overlap browser teardown.
The same helper created separate manual context lifetimes in the second test and `afterAll`.

Use two Playwright worker fixtures. The context depends on `browser`, yields immediately, and owns its only close in
fixture teardown with a 15-second fixture budget. The page depends on that context, signs in once through the normal
OIDC helper, and yields with a separate 30-second fixture budget. Yielding the owning context before authentication
registers teardown even when page setup or authentication fails. The runtime environment's `BETTER_AUTH_URL` is the
harness app URL and matches the configured local origin; no worker fixture depends on the test-scoped `baseURL` option.

Keep stub preparation in `beforeAll`. Move admin preparation into the first existing test, reuse the managed admin
page for the second test's admin assertions and settings restoration, and retain the second test's member page and
identity. Put unconditional issue cleanup, sync and stub reset in a separate `afterAll` hook. Named steps identify
future stalled phases. All product assertions, width captures, retry-specific report IDs and settings restoration
remain. No global timeout or retry increase, error suppression or product change. This fixes the verified resource
ownership issue without claiming to cure the unknown original UI stall.

The first focused local run passed the first case and completed the second case's product assertions and width
captures. Both managed settings restorations ran, but the independent cleanup hook reported a native-fetch
`SocketError: other side closed`. The exact failed request was not retained. Its blocking sync subprocess prevents
the worker event loop from processing browser messages and HTTP connection-close events. That blocking is verified;
its role in this particular transport error is not proven. Replace all five sync calls with awaited async child
processes, preserving exit, signal and spawn failures. Retain at most 64 KiB from each output stream and kill only
the owned child if its 30-second deadline expires. Name issue removal, issue sync and stub reset separately.

[PR #977's advisory review](https://github.com/thaynes43/haynesnetwork/pull/977#issuecomment-6160669999) identified
that killing the tsx CLI wrapper could orphan its actual Node process. Launch `process.execPath` directly with
`--import` and the installed tsx loader instead. The installed loader supports Node 22 used by CI; a direct import
probe also passed on the pod's Node 24 runtime. A test-scoped runner yields before commands start, owns an
AbortController and refuses launches once disposed. Its teardown cancels any active command and waits for the
actual child `close` event. Each command keeps the 30-second deadline. Cancellation sends TERM, then KILL after one
second if closure has not arrived; the fixture has a separate five-second cleanup budget. Spawn, output, exit and
signal failures remain visible. The independent cleanup hook receives its own runner scope. The installed runner
tears down test fixtures before `afterAll` and tears down each hook's test fixtures before the next hook.

Keep the configured test budgets. The old local `beforeAll` budget was 30 seconds, just like the current local test;
both are 60 seconds in CI. Authentication now has a separate fixture budget and happens once. The observed first
case took 9.5 and 12.5 seconds. Scoped child cancellation addresses a test timing out before its command deadline
without a blanket timeout increase. The original stalled UI action remains unknown.

After the async change, one focused run of `seerr-bridge.spec.ts` passed both cases in 2.0 minutes, including the
independent cleanup phases and both managed settings restorations. It used nice 19, one worker and one CPU affinity
with the local dev server, embedded PostgreSQL 16 and stubs. Web typecheck, changed-file ESLint and the whitespace
check passed. No owned test processes remained and the local test port was closed afterwards. This successful run
does not identify the original stalled UI action or prove the cause of the earlier socket error.

The revised ownership change passed nine deterministic fake-timer/deferred-close tests. These cover closure after
exit, scoped cancellation, the command deadline, refusal after disposal, spawn/output failures, nonzero exit and
signal failures, and bounded output. One focused browser run passed both cases in 1.8 minutes; the cases took 9.7
and 19.6 seconds, within the existing local budgets. Web typecheck, changed-file ESLint and whitespace checks passed.
The browser run again used nice 19, one worker, one CPU affinity, the local dev server, PostgreSQL 16 and stubs.
No owned test processes remained and the local test port was closed afterwards.

No load reproduction, busy loops, unchanged retries or wide local suite were used. Only processes started for this
verification were managed. Release PR #975 merged at 04:14 UTC, so its earlier merge hold is lifted. The coordinator
owns final review and merge. The original UI stall and the earlier socket error's cause remain unproven.
