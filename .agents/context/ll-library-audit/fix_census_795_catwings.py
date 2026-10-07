# Issue #795 follow-up (2026-10-07): found while clearing the Catwings audiobook pointer. LazyLibrarian QGPZEAAAQBAJ
# "Wonderful Alexander and the Catwings" (Catwings 3) links Catwings/Ursula K. Le Guin - Catwings.epub, which is Catwings
# (book 1: OPF dc:title "Catwings", ASIN B00MEWSDOW, title page "A CATWINGS TALE / Catwings"). The census passed it because
# the file's title is contained in the record's (a gap, filed as its own issue). The right book is already in the library:
# Wonderful Alexander and the Catwings/Ursula K. Le Guin - Wonderful Alexander and the Catwings.pdf (PDF Info Title
# "Wonderful Alexander and the Catwings", 59 page objects; the record says 56 pages), unlinked.
# -> re-point the eBook to the PDF; hold the Catwings folder's LazyLibrarian opf (it names QGPZEAAAQBAJ, and the library
# scan reads it before the file). Catwings itself stays in its folder (no LL record). Nothing searched.
# Run INSIDE the LazyLibrarian pod (dry run, then --go), like fix_census_795.py.
import os, sys, json, hashlib, time, sqlite3

B = '/data/cephfs-hdd/data/media/books/'
HR = 'quarantine/crossvolume-2026-10-05/'
H = B + HR
GO = '--go' in sys.argv
U = 'EBooks/Ursula K. Le Guin/'
OLD = U + 'Catwings/Ursula K. Le Guin - Catwings.epub'
OPF = U + 'Catwings/Ursula K. Le Guin - Catwings.opf'
NEW = U + 'Wonderful Alexander and the Catwings/Ursula K. Le Guin - Wonderful Alexander and the Catwings.pdf'
NEW_SIZE = 5020623
REC = 'QGPZEAAAQBAJ'
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''): h.update(b)
    return h.hexdigest()


db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
bad = []
r = db.execute('select BookLang,Status,BookFile from books where BookID=?', (REC,)).fetchone()
if r != ('en', 'Open', B + OLD): bad.append(('record is', r))
if not os.path.isfile(B + NEW) or os.path.getsize(B + NEW) != NEW_SIZE: bad.append(('pdf missing or changed', NEW))
if not os.path.isfile(B + OPF) or REC not in open(B + OPF, encoding='utf-8', errors='replace').read(): bad.append(('opf', OPF))
if os.path.exists(H + OPF): bad.append(('hold target exists', OPF))
refs = [x[0] for x in db.execute('select BookID from books where BookFile in (?,?)', (B + OLD, B + NEW))]
if refs != [REC]: bad.append(('refs', refs))
print('re-point 1 | hold 1 | refs', refs)
if bad:
    for b in bad: print('REFUSE', *b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')
bk = '/config/lazylibrarian.db.pre-795-catwings-20261007'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2)
ok = b2.execute('pragma integrity_check').fetchone()[0]; b2.close()
assert ok == 'ok', ok
print('backup', bk, 'integrity', ok)
m, z = md5(B + OPF), os.path.getsize(B + OPF)
os.makedirs(os.path.dirname(H + OPF), exist_ok=True)
for x in (os.path.dirname(H + OPF), os.path.dirname(os.path.dirname(H + OPF))): os.chown(x, 1000, 1000)
os.rename(B + OPF, H + OPF)
ev = 'LL opf naming QGPZEAAAQBAJ (Wonderful Alexander and the Catwings) beside Catwings, book 1 (stays, no LL record)'
with open(H + 'manifest.jsonl', 'a') as man:
    man.write(json.dumps({'op': 'hold', 'src': OPF, 'dst': HR + OPF, 'md5': m, 'size': z, 'reason': '#795 2026-10-07: ' + ev,
                          'record': REC, 'ts': ts()}, ensure_ascii=False) + '\n')
with open(H + 'sort.jsonl', 'a') as srt:
    srt.write(json.dumps({'path': HR + OPF, 'size': z, 'md5': m, 'category': 'off_catalog', 'evidence': ev, 'record': REC,
                          'counterparts': []}, ensure_ascii=False) + '\n')
for d in (U + 'Catwings', U + 'Wonderful Alexander and the Catwings', U.rstrip('/')): os.utime(B + d, None)
with db:
    assert db.execute('update books set BookFile=? where BookID=? and BookFile=?', (B + NEW, REC, B + OLD)).rowcount == 1
db.close()
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
r = db.execute('select BookID,BookName,Status,AudioStatus,BookFile,AudioFile from books where BookID=?', (REC,)).fetchone()
print(json.dumps([v.replace(B, '') if isinstance(v, str) else v for v in r]), 'file ok' if os.path.isfile(r[4]) else 'MISSING')
