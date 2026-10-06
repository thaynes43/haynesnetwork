# Books Census first live run (2026-10-06): LazyLibrarian K0UczgEACAAJ "Divergent" (eBook) holds the four-story collection.
# Fixed under the cross-volume repair rules (the #781 pattern, fix_781.py). Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/fix_census_divergent.py        # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/fix_census_divergent.py   # apply
# Content read first (2026-10-06): the BookFile, Four - A Divergent Story Collection/Veronica Roth - Four - A Divergent
# Story Collection.epub, is "Four Divergent Stories - Omnibus" (OPF dc:title; Kavita series 256), the collection's only
# copy now that #781 held the second one. Divergent/Veronica Roth - Divergent.pdf is Divergent: PDF Info Title
# "Divergent", Author Veronica Roth, 381 pages, and its text (pdftotext in a read-only calibre Job) opens "Divergent /
# Veronica Roth / To my mother, who gave me the moment when Beatrice realizes...", then its chapter list (One, "THERE IS ONE mirror in my house"); Kavita
# shows it as series 530 "Divergent". The collection folder carries LazyLibrarian's opf naming K0UczgEACAAJ, which the
# library scan reads before the file, so it would link the collection to Divergent again.
# -> re-point K0UczgEACAAJ's BookFile to the PDF; hold that opf `off_catalog`. The collection epub stays where it is (its
# own folder, Kavita 256; the #781 duplicate row names that folder as its counterpart). Nothing searched.
# Undo: move the opf back (manifest dst -> src), drop its sort row, restore the printed old pointer.
import os, sys, json, hashlib, time, sqlite3

B = '/data/cephfs-hdd/data/media/books/'
HR = 'quarantine/crossvolume-2026-10-05/'
H = B + HR
GO = '--go' in sys.argv
TAG = 'books-census 2026-10-06: '
VR = 'EBooks/Veronica Roth/'
OLD = VR + 'Four - A Divergent Story Collection/Veronica Roth - Four - A Divergent Story Collection.epub'
OPF = VR + 'Four - A Divergent Story Collection/Veronica Roth - Four - A Divergent Story Collection.opf'
NEW = VR + 'Divergent/Veronica Roth - Divergent.pdf'
NEW_SIZE = 2143652
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''): h.update(b)
    return h.hexdigest()


db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
bad = []
r = db.execute('select BookLang,Status,BookFile from books where BookID=?', ('K0UczgEACAAJ',)).fetchone()
if r is None or r[0] != 'en' or r[1] != 'Open' or r[2] != B + OLD: bad.append(('K0UczgEACAAJ is', r))
if not os.path.isfile(B + NEW) or os.path.getsize(B + NEW) != NEW_SIZE: bad.append(('pdf missing or changed', NEW))
if not os.path.isfile(B + OPF): bad.append(('opf missing', OPF))
elif 'K0UczgEACAAJ' not in open(B + OPF, encoding='utf-8', errors='replace').read(): bad.append(('opf names another id', OPF))
if os.path.exists(H + OPF): bad.append(('hold target exists', HR + OPF))
refs = [x[0] for x in db.execute('select BookID,BookFile from books where BookFile=? or BookFile=?', (B + OLD, B + NEW))]
if refs != ['K0UczgEACAAJ']: bad.append(('unexpected LL refs', refs))
print('re-point 1 | hold 1 | refs', refs)
if bad:
    for b in bad: print('REFUSE', *b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')

bk = '/config/lazylibrarian.db.pre-census-divergent-20261006'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2)
ok = b2.execute('pragma integrity_check').fetchone()[0]; b2.close()
assert ok == 'ok', ok
print('backup', bk, 'integrity', ok)

s, d = B + OPF, H + OPF
m, z = md5(s), os.path.getsize(s)
x = os.path.dirname(d)
if not os.path.isdir(x):
    os.makedirs(x)
    while x.rstrip('/') != H.rstrip('/'): os.chown(x, 1000, 1000); x = os.path.dirname(x)
os.rename(s, d)
ev = 'LL opf naming K0UczgEACAAJ (Divergent) beside the Four collection; Divergent is now its own PDF'
with open(H + 'manifest.jsonl', 'a') as man:
    man.write(json.dumps({'op': 'hold', 'src': OPF, 'dst': HR + OPF, 'md5': m, 'size': z, 'reason': TAG + ev,
                          'record': 'K0UczgEACAAJ', 'ts': ts()}, ensure_ascii=False) + '\n')
with open(H + 'sort.jsonl', 'a') as srt:
    srt.write(json.dumps({'path': HR + OPF, 'size': z, 'md5': m, 'category': 'off_catalog', 'evidence': ev,
                          'record': 'K0UczgEACAAJ', 'counterparts': []}, ensure_ascii=False) + '\n')
os.utime(B + VR + 'Four - A Divergent Story Collection', None)
with db:
    assert db.execute('update books set BookFile=? where BookID=? and BookFile=?',
                      (B + NEW, 'K0UczgEACAAJ', B + OLD)).rowcount == 1
db.close()
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
r = db.execute('select BookID,BookName,Status,BookFile from books where BookID=?', ('K0UczgEACAAJ',)).fetchone()
print(json.dumps([v.replace(B, '') if isinstance(v, str) else v for v in r]), 'file ok' if os.path.isfile(r[3]) else 'MISSING')
