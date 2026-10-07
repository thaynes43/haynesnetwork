# ADR-103: The e2e suite serves a production build, with a guarded harness flag

- **Status:** Accepted (2026-10-07; drafted and accepted by an agent under the Accept authority in
  `.agents/plans/README.md`, on the coordinator's work order for issue #812)
- **Date:** 2026-10-07
- **Deciders:** coordinator 2026-10-07 (issue #812 work order) · drafted by Opus 5.5
- **Amends:** [ADR-010](010-test-strategy.md)'s e2e layer (which server the suite runs against; ADR-010 does not
  name one, the code ran `next dev`) and [ADR-100](100-e2e-gates-the-book-pipeline.md) C-03 ("a pipeline PR waits
  about 15 minutes for the suite"). Both ADRs stand otherwise.
- **Closes:** [#812](https://github.com/thaynes43/haynesnetwork/issues/812). Evidence: the runs on PR
  [#824](https://github.com/thaynes43/haynesnetwork/pull/824).

## Context and problem statement

The Playwright suite is the gate on every pipeline PR and on every release PR update (ADR-100, ADR-102), so a pull
request in either group waits for it. It runs serially on purpose (`workers: 1`, one app, one database, one stub
state: ADR-010) against a stack the harness boots in Playwright's global setup, and until now that stack served the
app with `next dev`. On a green main run (37570022958) the suite step took 818 s, inside a job of about 15 minutes.

The question in #812 was whether a production server (`next build` once, then `next start`) cuts that, and why.
#824 measured both servers on the same tree and the same kind of runner. The harness recorded its boot phases and the
server's request log, and Playwright's JSON reporter recorded every test:

| | `next dev` (run 37685179146) | `next start` (run 37687511750) |
|---|---:|---:|
| Suite (`pnpm --filter web e2e`) | 791.8 s, 237 passed | 396.7 s, 237 passed, 0 flaky |
| Global setup | 42.7 s (15.8 s of it the route prewarm) | 34.6 s (the build finished at 28.9 s, the seeds at 29.7 s) |
| Sum of test durations | 736.9 s | 352.1 s |
| e2e job, wall clock | 13 min 57 s | 8 min 18 s (68 s of it the chromium install) |

Per spec, in seconds (`next dev` / `next start`): trash 212 / 121, progress-feedback 74 / 61, activity 39 / 25,
storage 33 / 11, integrations 31 / 13, ledger 30 / 11, library 26 / 8, connections 26 / 10, admin 24 / 10,
library-views 22 / 6. Most specs take a third of the time; the ones that take more than half are bound by real
timers (poll intervals, the 3 s arm windows, the scripted stub queue).

On-demand compilation was not the main cost. The first hits of routes the prewarm missed add up to about 33 s
during the tests, and the prewarm itself is 16 s. Most of the 385 s the tests saved comes from `next dev`'s slower
handling of every request and page: development React, unminified bundles, and the dev server's own framework time
(99 s across the tests' requests).

The repo is public, so its jobs on GitHub's standard runners are not billed (the owner's ruling, 2026-10-07: only his
private repos are). The gain is wait time on every gated PR and release PR update, and runner time, not money.

A production build changes behaviour the suite relies on. Four places in the app branch on `NODE_ENV`:

- the two harness pages (`/e2e/card-gallery`, ADR-058's drift gate; `/e2e/activity-progress`) bake a 404;
- the ADR-081 boot tasks run (the Default all-grant seed and the cold-start plex-match sync), which would rewrite the
  state the suite seeds;
- Better Auth rate limits (DESIGN-002), and the suite signs in far more than 10 times a minute;
- Trash candidates serve a stale snapshot for 20 minutes (ADR-035), where the specs need every read to refresh.

## Decision drivers

- No spec is skipped, loosened or retried into passing (ADR-100); a race the faster server exposes is fixed.
- Nothing a deployed pod does may become switchable by an environment variable alone.
- Local runs and CI run the same server, so a CI failure reproduces locally.
- Debugging a spec under `next dev` (source maps, readable errors, hot reload) stays one variable away.

## Considered options

- **A. Keep `next dev` and prewarm the routes it misses.** Recovers part of the 33 s of first-hit compiles and none
  of the per-request cost.
- **B. Serve one production build per run (`next build` + `next start`), with a harness flag for the four branches.**
- **C. Parallel workers or sharding.** Rejected: the suite shares one database and one stub state by design (ADR-010),
  and more runners spend more runner time.
- **D. Build once in its own CI job or step and hand `.next` to the suite.** Rejected: started first in the harness,
  the build already finishes before the seeds do, and moving `.next` between jobs adds an upload and a download.

## Decision outcome

Chosen: **B**, with these rules.

1. **The suite serves a production build, locally and in CI.** Playwright's global setup runs
   `startStack({ server: 'start' })`. `HNET_E2E_SERVER=dev` runs it against `next dev` instead, for debugging. Other
   `startStack` callers (`pnpm dev:local`, the capture scripts) keep `next dev`, the harness's default.
2. **One build per run, overlapped with the boot.** The harness starts `next build` before Postgres, so it runs during
   the migrations and the sync seeds, and awaits it only before starting the server. The build gets none of the
   stack's runtime env, like the release image build, except the harness flag and its localhost `BETTER_AUTH_URL`
   (the harness pages are static and prerender at build time). `HNET_E2E_BUILD=1`, set only on that build, skips the
   build's TypeScript pass (`next.config.ts`): the required `lint-and-typecheck` and `build` checks type-check the
   same tree. It changes nothing at runtime.
3. **The harness flag is guarded.** `HNET_E2E_HARNESS=1` is read only through `e2eHarnessActive()`
   (`@hnet/domain/e2e-harness`), and it counts only when `BETTER_AUTH_URL`'s host is `localhost` or `127.0.0.1`,
   which the e2e stack and `dev:local` always are and a deployed pod never is. Set anywhere else it is ignored,
   production behaviour stays on, and the process warns once. When it counts, and only at the four branches above:
   the harness pages render, the boot tasks stay off, Better Auth does not rate limit, and Trash candidates refresh
   inline. Every other production build bakes the harness pages' 404 as before, the release image included. A new
   `NODE_ENV` branch the suite needs on its non-production side goes through the same helper.
4. **The timings stay measured.** CI sets `HNET_E2E_TIMINGS_DIR`. The harness then writes its boot phases and a
   timestamped server log, Playwright writes its JSON report, and `e2e/support/timings-report.mjs` publishes the
   per-spec durations as annotations and the job summary. The dev-env pod can read annotations through the
   check-runs API; it cannot reach run logs or artifacts.
5. **Timeouts and retries are unchanged.** The 60 s test and 15 s expect budgets still cover the `next dev` opt-in;
   CI still retries once.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the suite takes half as long (791.8 s to 396.7 s; the e2e job about 14 to 9 minutes), so each gated PR and release PR update waits about 5 minutes less and uses 5 fewer runner minutes. All 237 tests still run. ADR-100 C-03's "about 15 minutes" is now about 9. |
| C-02 | Good: the gate tests the production bundles and runtime that ship. Its first find was a real defect: the Goodreads hub and link cards showed "Not linked" while their query loaded, so a linked user saw the link form flash (fixed in #824). |
| C-03 | Bad: behaviour that only `next dev` shows (React development warnings, the error overlay) no longer appears in a run. `HNET_E2E_SERVER=dev` brings it back for a local investigation. |
| C-04 | Bad: four production code paths consult a test flag. Mitigated by one helper, the localhost-only guard, its unit tests, and a warning when a flag is set but ignored. |
| C-05 | Bad: every local run pays one build (about 25 to 30 s, mostly hidden behind the seeds), even for a single spec. `HNET_E2E_SERVER=dev` is quicker while editing a spec. |
| C-06 | Neutral: no billing effect; this public repo's standard-runner jobs are not billed. |
| C-07 | Neutral: a faster server exposes races written against `next dev`'s timing. Each one is fixed deterministically, never by a retry (ADR-100). |

## More information

Issue #812 and PR #824 (the measurement and its three suite runs). OPS-003 section 5 (running the suite, the
`next dev` opt-in), DESIGN-002 (the rate-limit row). The other affected ADRs keep their decisions: ADR-035's inline
refresh still holds for the e2e stack, ADR-058's harness route still 404s in every deployed build, and ADR-081's
boot tasks still never run under the e2e harness.
