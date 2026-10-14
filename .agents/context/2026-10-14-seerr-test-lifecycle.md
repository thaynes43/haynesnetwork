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

After the async change, one focused run of `seerr-bridge.spec.ts` passed both cases in 2.0 minutes, including the
independent cleanup phases and both managed settings restorations. It used nice 19, one worker and one CPU affinity
with the local dev server, embedded PostgreSQL 16 and stubs. Web typecheck, changed-file ESLint and the whitespace
check passed. No owned test processes remained and the local test port was closed afterwards. This successful run
does not identify the original stalled UI action or prove the cause of the earlier socket error.

No load reproduction, busy loops, unchanged retries or wide local suite were used. Only processes started for this
verification were managed. The coordinator reviews the final PR and holds its merge until release PR #975 merges.
