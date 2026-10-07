# Owed check OC-013 (HANDOFF (q), #755): every LazyLibrarian grab after a rowid, on a book LazyLibrarian holds as
# English, names no foreign language and repeats no earlier Failed release (the #755 overlay's own rules); and the
# grabs of the four books re-wanted on 2026-10-06 are listed for a look. Read-only: the database is opened mode=ro
# with query_only. Run inside the LazyLibrarian pod (it imports the deployed overlay):
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- sh -c \
#     'cd /app/lazylibrarian && PYTHONDONTWRITEBYTECODE=1 python3 - 9596' \
#     < .agents/context/ll-library-audit/owed_check_755_grabs.py
# Prints one line per grab and a summary; exits 1 when a grab breaks a rule.
import sqlite3
import sys

from lazylibrarian.resultlist import is_english, names_language, release_key, url_title

AFTER = int(sys.argv[1]) if len(sys.argv) > 1 else 9596
WATCH = {
    'mPGNzQEACAAJ': 'Israel Potter eBook',
    'CQh5EAAAQBAJ': 'Queen Charlotte audio',
    'Tm-rzwEACAAJ': 'Queen Charlotte audio',
    'mNzNCHhqFwcC': 'Artemis Fowl and the Atlantis Complex eBook',
    'drNVzwEACAAJ': 'The Serpent and the Wings of Night audio',
}

db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
db.execute('PRAGMA query_only = ON')
db.row_factory = sqlite3.Row

first_failed = {}
for r in db.execute("SELECT rowid, NZBprov, AuxInfo, NZBtitle, NZBurl FROM wanted WHERE Status='Failed' ORDER BY rowid"):
    for spelling in (r['NZBtitle'], url_title(r['NZBurl'])):
        if spelling:
            first_failed.setdefault((r['NZBprov'], r['AuxInfo'], release_key(spelling)), r['rowid'])

rows = db.execute(
    "SELECT w.rowid, w.BookID, w.NZBtitle, w.NZBprov, w.AuxInfo, w.Status, b.BookName, b.BookSub, b.BookLang, "
    "a.AuthorName FROM wanted w JOIN books b ON b.BookID = w.BookID LEFT JOIN authors a ON a.AuthorID = b.AuthorID "
    # A block a repair script wrote by hand (the #755 pattern: a Failed copy of the release that delivered another book,
    # DLResult 'Blocked by hand ...', e.g. rowid 9598 from fix_census_795.py) is not a grab: skip it.
    "WHERE w.rowid > ? AND NOT (w.Status = 'Failed' AND COALESCE(w.DLResult, '') LIKE 'Blocked by hand%') "
    "ORDER BY w.rowid", (AFTER,)).fetchall()
broken = 0
for r in rows:
    problems = []
    if is_english(r['BookLang']):
        lang = names_language(r['NZBtitle'], r['BookName'], r['BookSub'], r['AuthorName'] or '')
        if lang:
            problems.append('names language %s' % lang)
        prior = first_failed.get((r['NZBprov'], r['AuxInfo'], release_key(r['NZBtitle'])))
        if prior is not None and prior < r['rowid']:
            problems.append('repeats Failed row %d' % prior)
    broken += bool(problems)
    print('%s %d %s %s %s [%s] %s%s' % ('BAD ' if problems else 'ok  ', r['rowid'], r['BookID'], r['AuxInfo'],
                                       r['Status'], r['BookLang'], r['NZBtitle'],
                                       ('  <- ' + WATCH[r['BookID']]) if r['BookID'] in WATCH else ''))
    for p in problems:
        print('      ' + p)
print('summary: %d grabs after rowid %d, %d break a rule; watched books grabbed: %s' % (
    len(rows), AFTER, broken, ', '.join(sorted({WATCH[r['BookID']] for r in rows if r['BookID'] in WATCH})) or 'none'))
sys.exit(1 if broken else 0)
