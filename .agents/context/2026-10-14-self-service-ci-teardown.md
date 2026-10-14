# Release validation: database teardown

The v0.125.2 release PR passed all 667 web assertions but failed on an unhandled PostgreSQL `57P01` shutdown error.
The error came from the release-block stub smoke. [The failing test job](https://github.com/thaynes43/haynesnetwork/actions/runs/38505348496/job/115661519387)
records the failure. The release PR changes only version metadata; the earlier paired-audio PR passed the same tests.

The installed `pg-pool` implementation removes idle clients from its count and resolves `pool.end()` before their
socket-close callbacks emit the public `remove` event. The smoke then stopped embedded PostgreSQL immediately.
That lets a still-connected client receive the shutdown error. This is a cleanup ordering defect, not a failed
product assertion.

The fix observes public pool `connect` and `remove` events before any query. Cleanup waits for both `pool.end()` and
the removal of every observed connection, including a pending connection that opens during shutdown, under a bounded
deadline. An already-disconnecting connection remains tracked until it closes. Pool errors stay visible; no error
listener suppresses them. The same helper replaces the exact unsafe sequence in sibling database fixtures. PostgreSQL
16 remains the test database. Validation uses deferred events and fake timers, then focused fixture cases under nice
19 with one worker. No load reproduction, test loops or wide local runs.

The Seerr browser case is separate. Its first attempt exceeded the 60-second `beforeAll` hook budget before the manual
context-close error. Playwright races the hook with its timeout without cancelling its callback, then tears down the
worker browser. Cleanup can overlap that teardown. The specific stalled UI action is unknown because the first attempt
has no retained trace. The managed admin-page proposal remains held for coordinator review; this change makes no
browser or product edits.

Local validation passed under nice 19 with one test worker: the nine deferred/fake-timer lifecycle tests, the three
release-block smoke cases, and focused sibling cases for domain roles (11), API roles (14), first Plex match (4),
admin bootstrap and shared rate limits (11), and the recommendation query (3). That is 55 tests across eight files.
Affected package typechecks and changed-file lint also passed. No full local suite or load reproduction was run.

The exact unsafe pool-end/server-stop pattern was checked across the fixtures and shared harness. Migration and
database-schema tests use an individual client's `end()` promise, which already waits for its connection close;
the browser harness has no parent-owned pool in that sequence. Their shutdown behavior is unchanged. Existing
fixture error listeners were teardown suppressors, with no intentional database-restart case using them.
