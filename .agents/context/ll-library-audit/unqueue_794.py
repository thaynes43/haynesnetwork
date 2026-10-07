# Issue #794 (2026-10-06): LazyLibrarian LgDwDwAAQBAJ "Crescent City - La casa di terra e sangue" (Sarah J. Maas,
# BookLang it) reads eBook Wanted. It came from collection want 76848581 (crescent-city, Kavita), whose member is
# Hardcover's unmerged Italian book 3027642 in series 2211; the find-missing cron's addBook seated it at 14:28Z and
# queued it before LazyLibrarian's language label could be read. English-only rule (F10): unqueue it.
# Sets ONLY this book's eBook Status Wanted -> Skipped (guarded, rowcount 1). AudioStatus is already Skipped.
# Nothing searched, no other row touched. Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/unqueue_794.py        # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/unqueue_794.py   # apply
# Undo: update books set Status='Wanted' where BookID='LgDwDwAAQBAJ' and Status='Skipped' (not wanted: F10).
import os, sys, sqlite3

GO = '--go' in sys.argv
ID = 'LgDwDwAAQBAJ'
COLS = 'BookID,BookName,BookLang,Status,AudioStatus,BookLibrary,AudioLibrary,BookFile'

db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
before = db.execute(f'select {COLS} from books where BookID=?', (ID,)).fetchone()
print('before', before)
bad = []
if before is None: bad.append('no such book')
else:
    if before[2] != 'it': bad.append(('BookLang is not it', before[2]))
    if before[3] != 'Wanted': bad.append(('Status is not Wanted', before[3]))
    if before[5] or before[7]: bad.append(('eBook is held', before[5], before[7]))
snatched = db.execute("select count(*) from wanted where BookID=? and Status='Snatched'", (ID,)).fetchone()[0]
if snatched: bad.append(('a download is in flight', snatched))
if bad:
    for b in bad: print('REFUSE', b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')

bk = '/config/lazylibrarian.db.pre-794-20261006'
assert not os.path.exists(bk), bk
b2 = sqlite3.connect(bk); db.backup(b2)
ok = b2.execute('pragma integrity_check').fetchone()[0]; b2.close()
assert ok == 'ok', ok
print('backup', bk, 'integrity', ok)

with db:
    n = db.execute("update books set Status='Skipped' where BookID=? and Status='Wanted'", (ID,)).rowcount
    assert n == 1, n
db.close()
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
print('after', db.execute(f'select {COLS} from books where BookID=?', (ID,)).fetchone())
