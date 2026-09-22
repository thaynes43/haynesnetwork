# 2026-09-22 — the LazyLibrarian push guard: evidence, and the LL source facts behind it

Companion evidence note for the HANDOFF entry of the same date and for the DESIGN-028 / DESIGN-036 /
DESIGN-033 amendments. Everything here was read live from the deployed pod
(`downloads/lazylibrarian-6c9df5c44d-5xnsb`, `linuxserver/lazylibrarian`), read-only.

## 1. The three LL source facts the fix rests on

Each of these was quoted from the running build, not from upstream docs — the deployed LL is old enough
that upstream behaviour is not a safe proxy.

**(a) `queueBook` has no held-file guard.** `/app/lazylibrarian/lazylibrarian/api.py::_queuebook`:

```python
if kwargs.get('type', '') == 'AudioBook':
    db.action("UPDATE books SET AudioStatus='Wanted' WHERE BookID=?", (kwargs["id"],))
else:
    db.action("UPDATE books SET Status='Wanted' WHERE BookID=?", (kwargs["id"],))
```

The only precondition is that the BookID exists. `Open`, `Have`, a set `BookFile`, a dated
`BookLibrary` — none of them stop it.

**(b) `searchBook` cannot substitute for it.** `searchbook.py::search_book`, the per-id branch, selects
the book regardless of status and then:

```python
if searchbook['Status'] == "Wanted":       # eBook leg
    ... searchlist.append(...)
if searchbook['AudioStatus'] == "Wanted":  # AudioBook leg
    ... searchlist.append(...)
```

So on an `Open` book, `cmd=searchBook` starts a thread that enqueues nothing and returns. **There is no
way to make LL search for a format it already holds without first clobbering its status.** This is the
fact that decides the Force Search behaviour (DESIGN-033 D-12) — it is a property of LL, not a policy
choice we made.

**(c) `getBook` is still unreachable on this build — but `getAllBooks` carries what we need.** The
method `_getbook` exists, but `getBook` is absent from `cmd_dict`, and the dispatcher rejects unknown
commands _before_ the method lookup:

```python
if kwargs['cmd'].lower() not in self.lower_cmds:
    self.data = {... 'Message': f"Unknown command: {kwargs['cmd']}, try cmd=help"}
    return
```

The 2026-07-15 finding stands. What changed is that `_getallbooks`'s projection already includes the
fields the guard needs:

```sql
SELECT ... books.Status, audiostatus, booklibrary, audiolibrary FROM books,authors ...
```

`_dic_from_query` keys rows by the declared column names — verified live, the keys come back as
`Status`, `AudioStatus`, `BookLibrary`, `AudioLibrary` (and the two Library values are ISO-formatted by
LL itself). `BookFile`/`AudioFile` are **not** in this projection, which is why the ACL accepts them
optionally and the guard ORs across every held-signal it is given rather than depending on one.

## 2. The measurement

Read-only against `/config/lazylibrarian.db` (`mode=ro` URI), cross-tabbing each format's status
against whether LL carries a file **and** a library date for it. The two file/library columns agreed on
every single row, which is why `getAllBooks`'s library dates are a faithful stand-in for the file paths
it does not serve.

| eBook `Status` | file+library | count   |     | AudioBook `AudioStatus` | file+library | count   |
| -------------- | ------------ | ------- | --- | ----------------------- | ------------ | ------- |
| Open           | yes          | 184     |     | Open                    | yes          | 119     |
| Skipped        | no           | 350     |     | Skipped                 | no           | 322     |
| **Skipped**    | **yes**      | **24**  |     | **Skipped**             | **yes**      | **15**  |
| Snatched       | no           | 1       |     | Snatched                | no           | 16      |
| **Snatched**   | **yes**      | **10**  |     | **Snatched**            | **yes**      | **19**  |
| Wanted         | no           | 88      |     | Wanted                  | no           | 184     |
| **Wanted**     | **yes**      | **155** |     | **Wanted**              | **yes**      | **137** |

LL tracked **812 books** — 1624 per-format rows, of which **564 read `Wanted` and 292 of those carried a
real file** — the daily re-search engine. The bolded `Skipped`/`Snatched`
rows (39 + 29) are why the guard reads the file/library fields and not just the status: a status-only
guard would have left the `Skipped` sweep free to clobber 39 already-imported books.

## 3. What shipped app-side

- `llFormatAlreadyHeld(status, format)` in `packages/domain/src/book-requests.ts`, beside `mapLlStatus`
  (the ACL parses, the domain decides). True on `Open`/`Have`, or a non-blank library date / file path
  for that format. LL's blank spellings (`null`, `''`, whitespace, the literal `'None'`) all normalize
  to not-held.
- Six suppression points across four modules: the shelf push and its `Skipped` sweep
  (`goodreads-sync.ts`), the pairing mint push and its `Skipped` sweep (`format-pairing.ts`), and both
  find-missing collection legs — the hourly cron and the on-demand button (`collection-force-search.ts`).
  Each logs `ll_push_skipped_have` with a `site` discriminator and counts into `pushesSkippedHeld` /
  `skippedHeld`.
- **The fourth site was not in the original finding and is the worst one.** `collection-force-search.ts`
  gathers its worklist with `ne(statusCol,'landed')` on our OWN row — a statement about our mirror, not
  about LL. Unattended, hourly, ≤25 wants per run, re-firing every 12h per want forever. A suppressed
  want there is stamped `last_searched_at` (settled, so the cooldown holds it) but writes NO audit row:
  nothing was asked of LL. Found by chasing the work order's "keep the existing 12h cooldown/caps" line,
  which belongs to this file and to none of the three sites the finding named.
- `runBookItemForceSearch` returns `{ searched: false, reason: 'already_held' }` for a held format, and
  the books detail head renders "Already have this copy" pointing at Fix.
- The books **Fix** chain is deliberately NOT guarded — see DESIGN-028's amendment, last paragraph.

## 4. Two design points worth not re-litigating

**Why the shelf sync takes a second `getAllBooks`.** The pairing run reuses its one existing read (D-18's
seat gate), but the shelf sync cannot: it needs a _pre-push_ snapshot for the guard and a _post-push_
snapshot for the reconcile. A single pre-push snapshot reconciles freshly-pushed wants from stale rows
and re-sweeps the exact formats that run just queued — caught by a test, not by review. The extra call is
an LL sqlite read, taken only when there is something to push.

**Why the guard defaults to "push".** An absent book, an unknown status, or a failed LL read all read as
not-held. The guard may suppress a write; it must never invent one. Three tests pin that (one per push
site), because the failure mode of getting this backwards is silently stopping all book acquisition.

## 5. Cluster-side, for the record (not this repo's change)

Handled outside haynesnetwork the same evening, and documented in OPS-013 §12: qBittorrent's
`torrent_content_layout` → `Subfolder` (plus 282 bare torrents relocated via `torrents/setLocation`,
which keeps them seeding), the 195 GB `books-mam.unpack` scratch deleted, LL `REJECT_WORDS` +=
`m4b, m4a, flac` and `REJECT_AUDIO` += `azw3, azw, pdf`, `SEARCH_BOOKINTERVAL` 360 → 1440, both MAM
sessions re-issued with a daily keepalive plus the `MamSeedboxSessionDead` /
`MamGovernorActuationFailing` Loki alerts. LL still has **no scheduled library scan** (`librarysync.py`
is the only other writer of `Open`); a haynes-ops CronJob for it is pending.
