# ADR-101: Every write to a book request records a Request Event

- **Status:** Accepted (2026-10-06; the owner approved the safeguard on issue #741 after the books-rollout review,
  implemented by an agent, Accept authority per `.agents/plans/README.md`)
- **Date:** 2026-10-06
- **Deciders:** Tom Haynes (approved the queued safeguards, "All four, after the bugs") · drafted by Opus 5.5
- **Supersedes in part:** [ADR-055](055-integration-linking-and-app-side-shelf-requests.md) ("sync mint/reconcile
  unaudited") and [ADR-056](056-kapowarr-comic-acquisition-routing.md) ("the mint/route/reconcile writes are
  UNaudited"), for `book_requests` only; DESIGN-028, DESIGN-036 and DESIGN-038 repeat that wording for their writers
  and are amended. Everything else in those ADRs stands.
- **Closes:** [#741](https://github.com/thaynes43/haynesnetwork/issues/741). Evidence: the review report
  `.agents/context/2026-10-06-books-rollout-adversarial-review.md` (issue #731).

## Context and problem statement

`book_requests` is the request ledger: what each want points at in LazyLibrarian, each format's status, its park and
its one re-request. Its sync writers change what the estate downloads, and none of them left a record. In the three
days before this ADR they re-pointed, settled, parked and re-requested wants thousands of times (Loki: 819
`ll_book_gone`, 412 `ll_rerequest`, 79 `pairing_want_reidentified`, 25 `pairing_want_retitled`, 8
`request_landed_reverted`). The only trace was Loki, which keeps 30 to 60 days, and the prose of the handoff notes.
The repairs of 2026-10-03 to 2026-10-05 kept their old values in markdown tables because nothing else kept them.
`permission_audit` held 67 `request_book_search` rows for the same period, and nothing else.

ADR-055 had called these writes synced, derived state, like `media_items`. They are not: `media_items` is rebuilt from
the *arrs, but a request's pointer, park and re-request are decisions the app made, and the next decision reads them.

## Decision drivers

- A review or a repair must be able to answer, without Loki, what changed a request, when, from what to what, and why.
- The record must commit with the change or not at all (CLAUDE.md hard rule 6, the `packages/domain` single-writer
  pattern).
- It must cover every writer, including the next one someone adds, and the repair scripts.
- It must not change what any sync decides or downloads.

## Considered options

- **A. A `book_request_events` table, written by one domain module that is the only `book_requests` write path.**
- **B. `permission_audit` rows.** It can hold a system actor (`actor_id` NULL), but it is the admin audit of what
  people did with permissions, it has no column for the request, and hundreds of sync rows a day would bury it.
- **C. A Postgres trigger on `book_requests`.** Catches hand-written SQL too, but it would be the first trigger in the
  schema, and the reason and actor would have to reach it through session settings, an implicit channel every writer
  must remember to set. The codebase writes its audit rows explicitly, in the writer.

## Decision outcome

Chosen option: **A**.

- **The table.** `book_request_events` (migration 0096): `request_id` (no foreign key, so a deleted want keeps its
  history), `kind` (`mint`, `update`, `delete`), `reason` (the decision, e.g. `ll_book_gone_repointed`, `parked`,
  `ll_rerequest`), `writer` (the domain function), `site` (the job and leg, e.g. `goodreads-sync`,
  `format-pairing.rerequest`), `actor` (`sync`, `repair`, `user`) and `actor_user_id`, `before` and `after` (the
  changed recorded fields, keyed by column name), `detail` (the writer's own context, e.g. a re-request's outcome), and
  `created_at`. Append-only: nothing updates or deletes it.
- **The write path.** `packages/domain/src/book-request-events.ts` is the only domain module that inserts, updates or
  deletes `book_requests`; a guard test fails the build otherwise. Its `updateBookRequests` locks and reads the rows,
  updates them, and inserts one event per row whose recorded fields changed, in the caller's transaction.
  `insertBookRequest` and `deleteBookRequests` record the mint and the delete; `recordCascadedRequestDeletes` records
  the wants a parent delete cascades away (a books collection that left its server).
- **What is recorded.** The want's identity and state: its keys, title and author, library match, LazyLibrarian and
  Kapowarr ids, the three statuses, the park, the re-request columns and the Author Check's id. The bookkeeping stamps
  (`last_searched_at`, `last_reconciled_at`, `english_edition_tried_at`, the Mint Backoff columns, `updated_at`) are
  not: they say when the app last looked, most runs rewrite them, and recording them would bury the decisions. A write
  that only stamps records nothing, and only `stampBookRequests` (which refuses any other field) may write one.
- **Who.** A writer names its `writer` and `reason`. The actor and site come from the call, else from a scope the job
  opens (`withRequestEventScope`): the sync orchestrator opens one per mode (`actor: 'sync'`, the mode as site), the
  one-off repair opens `actor: 'repair'`, and a person's on-demand collection Force Search opens `actor: 'user'` with
  their id. Outside any scope a write records `sync` and no site.
- **`reason` has no CHECK.** `kind` and `actor` are CHECK-enforced; `reason` is a TypeScript union
  (`BOOK_REQUEST_EVENT_REASONS`), so a new writer adds its reason without a migration (the `ll_format_releases.reason`
  precedent).
- **Where it shows.** No screen shows a request's history yet; the rows are read by SQL (the review and repair use).
  A request-history view on the Wanted detail is issue
  [#792](https://github.com/thaynes43/haynesnetwork/issues/792).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: every mint, change and delete of a request is recorded with its decision, writer, job, actor and the values it replaced, in the same transaction, and outlives Loki. |
| C-02 | Good: the write path is structural. A new writer cannot write `book_requests` without going through the module that records the event, and a repair script's writes say they were a repair. |
| C-03 | Bad: each recorded update reads the row first (one extra primary-key `SELECT ... FOR UPDATE` and a `RETURNING`), and the table grows by every recorded change: hundreds of rows a day at the October 2026 rate, nothing for an hourly pass that changes nothing. No retention yet; a cap is a later decision if it ever matters. |
| C-04 | Bad: hand-written SQL against `book_requests` (a repair run in `psql`) records nothing. Repairs go through a script that calls the single writers, as the issue #693 repair does. |
| C-05 | Neutral: deleting a user cascades their Goodreads requests away without an event (an account deletion, not a request decision). |

## More information

Issue #741; review report issue #731; ADR-055, ADR-056; DESIGN-028 (amendment 2026-10-06, "every write to a
book request records a Request Event"); `packages/domain/README.md` (writer index).
