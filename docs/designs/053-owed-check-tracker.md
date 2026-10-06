# DESIGN-053: The Owed Check tracker — dated, owned post-deploy checks with a runner and an overdue alert

- **Status:** Accepted (2026-10-06)
- **Last updated:** 2026-10-06
- **Satisfies:** issue #743 (adversarial review #731, finding W-08 and recommendation R-04,
  `.agents/context/2026-10-06-books-rollout-adversarial-review.md`); governed by the docs-first process
  (`docs/PROCESS.md`). No ADR: this is agent tooling around deploys, not app behaviour; nothing in the app changes.

## Overview

A deploy record often leaves a check for later: "after the 04:54Z backlog run, book 1's grab is a book-1 release".
Until now those checks lived as lettered items, (a) to (v), scattered through `.agents/HANDOFF.md` blocks. They had no
due time, no owner and no status, and nothing fired when one was missed: on 2026-10-06 eleven were pending, six due
that morning, and one of them (p) found a real defect only because a session happened to read the prose (#743, #755).

An **Owed Check** is now a row in one machine-readable file, `.agents/owed-checks.yaml`, with a due time, an owner, a
status and the exact check. Three things act on it:

1. **The runner** (`owed-checks`, a CronJob in the cluster, hourly) runs each pending row's automated, strictly
   read-only checks once the row's event has passed, and logs the verdicts.
2. **The overdue alert.** A pending row past its due time is overdue. The runner logs it and a Loki rule fires
   `OwedCheckOverdue` (warning); a GitHub Action keeps one open issue, "Owed checks overdue", listing every overdue row.
3. **The process hook.** A deploy record adds rows instead of lettered prose; a session records results in the file.

The runner never edits the tracker and never decides a check: it reports evidence. A person or agent records the
result (`status` plus a dated `evidence` line) in a docs PR, which is what clears an overdue row.

## Detailed design

### D-01 The tracker file

`.agents/owed-checks.yaml`, `version: 1`, a list `checks`. The header comment in the file is the field reference; the
schema is `packages/sync/src/owed-checks/tracker.ts` (zod), and `packages/sync/__tests__/owed-checks.test.ts` parses
the real file, so a malformed row fails the required `test` check on its PR. One row:

| Field | Meaning |
|---|---|
| `id` | `OC-NNN`, stable, never reused (repo ID convention). |
| `legacy` | The HANDOFF letter the check had before the tracker, e.g. `(k)`, so old prose still resolves. |
| `title`, `opened` | What is checked; the day it was written. |
| `after`, `not_before` | The event the check follows, in words; the UTC instant its automated checks start. |
| `due` | UTC instant the result must be recorded by. Required on every row (D-03). |
| `owner` | The session or agent kind that runs it (today: the haynesnetwork coordinator). |
| `status` | `pending`, `passed`, `failed` or `waived`. Not pending needs `evidence`; `failed` names its follow-up. |
| `check` | The exact check by hand: the query or command and the expected result. |
| `auto`, `auto_covers` | Read-only checks the runner runs (D-04); `all` if they cover the whole check, `part` if not. |
| `evidence`, `links` | Dated results, newest last; PRs, issues, the HANDOFF block, the follow-up. |

### D-02 Ownership and the status lifecycle

`pending` → `passed` | `failed` | `waived`. Only a recorded result changes the status; the runner never does. A
`failed` row links the issue or row that carries the fix (OC-012, Israel Potter, links #755 and OC-013). `waived`
needs an evidence line saying why the check no longer matters. A check whose event has not happened by its due date
is not failed: its `due` moves, with an evidence line saying why ("still waiting: Murtagh has no id").

### D-03 Due times, events and overdue

The work order allowed a due "event" ("after the next 04:54Z backlog run"); the tracker keeps the event as words
(`after`) and its expected instant as `not_before`, and always carries a UTC `due`, because a missed check can only
fire against a time. A check waiting on an event with no known time (the first natural Sonarr failure, OC-001) gets a
review date as its `due`. **Overdue** = `status: pending` and now > `due`. There is no grace period: `due` already
includes the slack.

### D-04 The runner and its sources (read-only by construction)

`packages/sync/src/scripts/owed-checks.ts` (+ `src/owed-checks/`), shipped in the app image's `/sync` tree. The
CronJob `owed-checks` (haynes-ops `kubernetes/main/apps/downloads/owed-checks/`, hourly at :50) reads the tracker from
main on GitHub (`raw.githubusercontent.com`), so a docs PR takes effect without a release. For every pending row whose
`not_before` has passed it runs the `auto` checks in order, one at a time. A check is one query plus an `expect`:

| `source` | What it reads | How it cannot write |
|---|---|---|
| `app-db` | The app's Postgres through `postgres16-ro` (a hot standby) | The standby refuses writes; the session sets `default_transaction_read_only=on` (verified before the first query); each query runs in `BEGIN READ ONLY` … `ROLLBACK`; 30 s statement timeout. |
| `ll-db` | LazyLibrarian's SQLite (`/config/lazylibrarian.db`) | Opened `SQLITE_OPEN_READONLY` (`mode=ro`) plus `PRAGMA query_only`; a write is refused by SQLite (tested). |
| `loki` | Instant LogQL metric queries (GET `/loki/api/v1/query`) | HTTP GET only. |
| `prometheus` | Instant PromQL queries (GET `/api/v1/query`) | HTTP GET only. |

Both SQL sources also refuse anything but a single `SELECT` or `WITH` statement before it reaches the database.

- **The LazyLibrarian volume.** The runner mounts LazyLibrarian's `ceph-block` RWO PVC, so it is pinned to the
  LazyLibrarian pod's node (pod affinity). The volume is mounted read-write at the kubelet level only because SQLite's
  WAL readers share the `-shm` index with the writer: a read-only mount fails to open the database ("unable to open
  database file", tested 2026-10-06). The database itself is opened read-only as above. The books NFS share is mounted
  read-only at LazyLibrarian's own path (`/data/cephfs-hdd`), so `paths_exist` resolves the paths LazyLibrarian stores.
- **`expect`.** SQL: `rows`, `min_rows`, `max_rows`, `paths_exist` (every non-empty first-column value is an
  existing file). Any source: `eq`, `min`, `max` against the value (a metric query's number, or a SQL query's first
  cell). An empty metric answer is 0.
- **`mismatch`.** `fail` (default): a mismatch is a defect. `wait`: what the check waits for has not happened yet
  (the drain is not empty, the scan has not finished). A row's verdict is fail > error > wait > pass.
- **Time.** `$SINCE` in a metric query becomes the range from the check's `since` (else the row's `not_before`,
  else `opened`) to the evaluation instant, clamped to 1 minute .. 30 days. `at` pins the evaluation instant ("the
  07:32Z run"); before `at` the check waits. Loki answers long ranges only for narrow stream selectors (a 10-day count
  over every `haynesnetwork` stream returned 502, the same count over one CronJob's pods returns at once): select a
  CronJob's pods by `pod=~"haynesnetwork-sync-<name>-.*"`.
- **What stays manual.** A check that needs LazyLibrarian's own Python (the #755 language and block rules) or
  judgement (a title, a policy) is `manual` or `auto_covers: part`; its `check` text carries the exact command (OC-013
  ships `.agents/context/ll-library-audit/owed_check_755_grabs.py`, read-only).

### D-05 What the runner logs

JSON lines (the sync logger), namespace `downloads`, container `main`, pods `owed-checks-*`:

- `owed_check_result` per automated check: `id`, `check`, `source`, `result` (`pass` / `fail` / `wait` / `error`),
  `unmet`, `observed` (counts, at most five sample rows, missing paths) or `error`.
- `owed_check` per pending row: `id`, `legacy`, `title`, `owner`, `due`, `overdue`, `overdueHours`, `auto` (the
  row's verdict, or `manual` / `not_yet`), `autoCovers`.
- `owed_checks_run` once per successful pass (counts); `owed_checks_run_failed` when the tracker cannot be read or is
  invalid (exit 1).

Findings are not job failures: the job exits 0 whatever the checks found.

### D-06 The alerts

Loki ruler rules in haynes-ops (`downloads/owed-checks/app/lokirule.yaml`), all `severity: warning`, which routes to
Alertmanager's `null` receiver like every warning in the estate (only `critical` reaches Pushover; the owner's rule
is that missed checks do not page):

- `OwedCheckOverdue` per `id`: an `owed_check` line with `overdue=true` in the last 75 minutes.
- `OwedCheckFailing` per `id` and `check`: an `owed_check_result` line with `result` `fail` or `error`.
- `OwedChecksRunnerSilent`: no `owed_checks_run` line for 3 hours (the CronJob stopped, cannot schedule, or the
  tracker is invalid).

A warning is visible only in Alertmanager and Grafana, so the human- and agent-facing signal is the GitHub issue:
`.github/workflows/owed-checks.yml` runs hourly and on every push to the tracker, evaluates timing only (`--no-data`;
GitHub cannot reach the cluster) and keeps one open issue labelled `owed-checks`: opened when a row first goes
overdue, its body rewritten and a comment added when the overdue set changes, closed when nothing is overdue. The
issue notifies the repository's watchers; it is not a page.

### D-07 The process hook

- A deploy record (a HANDOFF block) that leaves a check **adds a row** to the tracker in the same docs PR, with the
  exact query in `check` and, where the check is a read-only query, an `auto` list. The HANDOFF block names the row
  ids instead of lettered items.
- A session that runs a check by hand **records it in the row** (status, dated evidence) and merges; the HANDOFF
  block may summarise.
- **Session start** (KICKOFF): read the open `owed-checks` issue, and the pending rows due in the next day. A row
  whose `auto` verdict is `pass` and `auto_covers: all` is closed by recording the runner's line as evidence.
- HANDOFF's lettered prose before 2026-10-06 stays as it was, with a pointer to the tracker; the pending items were
  migrated (OC-001 to OC-020: 15 pending, 4 passed, 1 failed).

### D-08 Deploy and operation

- The CronJob runs the app image with its own tag (it lives in another namespace than the HelmRelease's
  `&mainImage`). Bump it with `&mainImage` in the same haynes-ops commit; a lagging runner still works unless the
  tracker schema changed, in which case it reports `owed_checks_run_failed` and `OwedChecksRunnerSilent` fires.
- Credentials: an ExternalSecret in `downloads` builds `OWED_CHECKS_DATABASE_URL` for `postgres16-ro` from the
  `haynesnetwork` 1Password item; nothing in git.
- Run it now: `kubectl -n downloads create job --from=cronjob/owed-checks owed-checks-manual-$(date +%s)`, then
  `kubectl -n downloads logs job/<name>`. Timing only, locally: `pnpm --filter @hnet/sync exec tsx
  src/scripts/owed-checks.ts --no-data --tracker=../../.agents/owed-checks.yaml --now=<UTC instant>`.
- A test row: point a one-off Job's `OWED_CHECKS_URL` at a branch's raw tracker, and run the Action on that branch
  (`gh workflow run owed-checks.yml --ref <branch>`); main is untouched.

## Alternatives considered

- **A dated table at the top of HANDOFF** (the issue's first proposal). Still prose: nothing can evaluate it and
  nothing fires; rejected for a file a program reads.
- **The alert-responder or dev-env-ops agent runs the checks daily.** An LLM run per check is costly and not
  repeatable; the checks are queries, so a deterministic runner evaluates them and agents handle the judgement.
- **The runner inside the haynesnetwork HelmRelease (frontend, sharing `&mainImage`).** It cannot mount
  LazyLibrarian's PVC (namespaced), and the LazyLibrarian checks were the issue's main case. `kubectl exec` into the
  LazyLibrarian pod would work but is not read-only (exec runs anything). So the runner lives in `downloads`.
- **Two runners** (Node in frontend for Postgres/Loki/Prometheus, Python on the LazyLibrarian image for SQLite, which
  could also import the #755 overlay). Two evaluators of the same `expect` rules would drift; `node:sqlite` reads the
  database from the app image, and the few checks that need the overlay's Python stay manual with a script.
- **A Prometheus metric (Pushgateway or textfile) instead of log lines.** There is no Pushgateway; the estate's app
  alerts are Loki rules on log lines (`haynesnetwork-loki-rules`), so this follows them.
- **The runner opens the GitHub issue itself.** That needs a GitHub write token in the cluster; the Action has one
  for free and needs no cluster access for timing.

## Test strategy

- `packages/sync/__tests__/owed-checks.test.ts` (in the required `test` check): the real tracker parses and has no
  value cut short by a YAML comment; the schema refuses duplicate ids, a closed row without evidence, a failed row
  without a follow-up, a bad timestamp, SQL-only conditions on a metric check; timing (overdue hours, `not_before`);
  `$SINCE`; every `expect` condition and `mismatch: wait`; the verdict order; the SQL guard; a real SQLite file opened
  through `ll-db` refuses a write; Loki is queried at the pinned instant; a whole run's log lines and the issue body.
- Live, once (2026-10-06): every SQL check run read-only against production, every Loki query shape run through
  Grafana; the deployed runner's first pass against today's rows; a dummy overdue row on a branch fires
  `OwedCheckOverdue` and opens the issue, and the issue closes again on main.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Should an overdue row page (critical) after some time? | No: the owner's rule is "don't page" for this; warning plus the GitHub issue (2026-10-06 work order). |
