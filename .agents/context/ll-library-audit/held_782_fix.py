# Issue #782 (2026-10-06): the four books the EPUB converter held (#770) are broken files or other books than their folders
# say; fixed under the cross-volume repair rules. Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/held_782_fix.py        # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/held_782_fix.py   # apply
# Content read first (calibre ebook-meta + ebook-convert to text in a read-only Job, 2026-10-06 17:30Z):
# - Tom Clancy/Debt of Honor .mobi (5,474,769 bytes): ebook-convert fails "KF8 does not have a valid FDST record". Broken.
#   LL igdN-TOJVEsC (en) links it; it is the record's only eBook. -> hold `corrupt`, blank the pointer, re-want the eBook (queueBook).
# - Hugh Howey/Sand .azw3: The Best American Science Fiction and Fantasy 2024 (contents, foreword by the series editor, ISBN
#   9780063315778 = LL's 0063315777). LL Zi7wEAAAQBAJ (en) is that book and links this file, its only copy (Kavita had none).
#   -> re-home file + its LL opf under the record's own title folder; re-point the record. No LL record is named Sand.
# - Dennis E. Taylor/Potomu chto nas mnogo .mobi: the English For We Are Many (Bobiverse 2; English text, Worldbuilders Press
#   2017). LL DfEW0gEACAAJ (en) "For We Are Many" is Wanted with no file and Kavita has no copy, so this is its only copy.
#   -> re-home under For We Are Many, link the record, Open. The folder's own record (ZvSiEQAAQBAJ, which grabbed
#   For We Are Many in July under the Russian edition's title) is no longer in LL's books table: nothing to set Skipped.
# - J.R.R. Tolkien/Tree and Leaf - Including Mythopoeia ... .azw3: Beowulf: A Translation and Commentary (Tolkien, 2014).
#   No LL record and no app request names Beowulf; Kavita has none. -> hold `off_catalog`. The folder's record, Tree and
#   Leaf t3sI0QEACAAJ, already links its English epub in the sibling folder: nothing to re-want.
# Also: the three emptied folders are removed, and the four lines in the converter's books/.epub-convert/held.tsv are dropped
# (the re-homed books then convert on the converter's next run). LL DB backup first (sqlite backup API, integrity checked).
# Undo: move each manifest dst back to src, drop the sort rows, restore the printed old pointers (or the backup with LL stopped).
import os, sys, json, hashlib, time, sqlite3, configparser, urllib.request, urllib.parse

B = '/data/cephfs-hdd/data/media/books/'
HR = 'quarantine/crossvolume-2026-10-05/'
H = B + HR
E = 'EBooks/'
GO = '--go' in sys.argv
TAG = '#782 2026-10-06: '
DEBT = E + 'Tom Clancy/Debt of Honor/Tom Clancy - Debt of Honor.mobi'
SAND = E + 'Hugh Howey/Sand/Hugh Howey - Sand.azw3'
SAND_OPF = E + 'Hugh Howey/Sand/Hugh Howey - Sand.opf'
BA = E + 'Hugh Howey/The Best American Science Fiction and Fantasy 2024/'
BA_BASE = BA + 'The Best American Science Fiction and Fantasy 2024 - Hugh Howey'
POT = E + 'Dennis E. Taylor/Potomu chto nas mnogo/Dennis E. Taylor - Potomu chto nas mnogo.mobi'
FWAM = E + 'Dennis E. Taylor/For We Are Many/'
FWAM_FILE = FWAM + 'For We Are Many - Dennis E. Taylor.mobi'
TREE_DIR = E + "J.R.R. Tolkien/Tree and Leaf - Including Mythopoeia and The Homecoming of Beorhtnoth, Beorhthelm's Son"
TREE = TREE_DIR + "/J.R.R. Tolkien - Tree and Leaf - Including Mythopoeia and The Homecoming of Beorhtnoth, Beorhthelm's Son.azw3"
SIZES = {DEBT: 5474769, SAND: 1331913, POT: 930919, TREE: 589520}
HOLD = [  # (path, category, record, evidence)
    (DEBT, 'corrupt', 'igdN-TOJVEsC',
     'broken mobi: ebook-convert fails "KF8 does not have a valid FDST record"; the record\'s only eBook; LL eBook re-wanted'),
    (TREE, 'off_catalog', '',
     'the file is Beowulf: A Translation and Commentary (Tolkien, 2014), filed as Tree and Leaf; no LL record or app request '
     'names Beowulf and Kavita has no copy; Tree and Leaf (t3sI0QEACAAJ) keeps its English epub in the sibling folder'),
]
REHOME = [  # (src, dst, record, reason)
    (SAND, BA_BASE + '.azw3', 'Zi7wEAAAQBAJ',
     'the file is The Best American Science Fiction and Fantasy 2024, LL Zi7wEAAAQBAJ\'s only copy, filed under "Sand"'),
    (SAND_OPF, BA_BASE + '.opf', 'Zi7wEAAAQBAJ', 'LL\'s opf for Zi7wEAAAQBAJ, moved with its book'),
    (POT, FWAM_FILE, 'DfEW0gEACAAJ',
     'the file is the English For We Are Many (Bobiverse 2), the only copy of LL DfEW0gEACAAJ, filed under the Russian title'),
]
RMDIR = [E + 'Hugh Howey/Sand', E + 'Dennis E. Taylor/Potomu chto nas mnogo', TREE_DIR]
NEWDIRS = [BA, FWAM]
HELD_TSV = B + '.epub-convert/held.tsv'
HELD_FOLDERS = {'Tom Clancy/Debt of Honor', 'Hugh Howey/Sand', 'Dennis E. Taylor/Potomu chto nas mnogo',
                TREE_DIR[len(E):]}
now = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
row = lambda i: db.execute('select BookLang,Status,BookFile,BookLibrary from books where BookID=?', (i,)).fetchone()
bad = []
for p, z in SIZES.items():
    if not os.path.isfile(B + p): bad.append(('missing', p))
    elif os.path.getsize(B + p) != z: bad.append(('size changed', p))
for s, d, _, _ in REHOME:
    if os.path.exists(B + d): bad.append(('target exists', d))
for p, *_ in HOLD:
    if os.path.exists(H + p): bad.append(('hold target exists', HR + p))
for d in NEWDIRS:
    if os.path.exists(B + d): bad.append(('new folder exists', d))
r = row('igdN-TOJVEsC')
if r is None or r[0] != 'en' or r[2] != B + DEBT: bad.append(('igdN-TOJVEsC is', r))
r = row('Zi7wEAAAQBAJ')
if r is None or r[0] != 'en' or r[2] != B + SAND: bad.append(('Zi7wEAAAQBAJ is', r))
r = row('DfEW0gEACAAJ')
if r is None or r[0] != 'en' or r[1] != 'Wanted' or r[2]: bad.append(('DfEW0gEACAAJ is', r))
r = row('t3sI0QEACAAJ')
if r is None or not r[2] or not os.path.isfile(r[2]) or r[2].startswith(B + TREE_DIR + '/'): bad.append(('t3sI0QEACAAJ is', r))
if row('ZvSiEQAAQBAJ') is not None: bad.append(('ZvSiEQAAQBAJ exists again: set it Skipped (F10) instead', row('ZvSiEQAAQBAJ')))
refs = [x for x in db.execute('select BookID,BookFile from books') if x[1] and x[1].startswith(tuple(B + d + '/' for d in RMDIR))]
if sorted(x[0] for x in refs) != ['Zi7wEAAAQBAJ']: bad.append(('unexpected LL refs into the folders', refs))
for d in RMDIR:
    left = set(os.listdir(B + d)) - {os.path.basename(s) for s, *_ in REHOME} - {os.path.basename(p) for p, *_ in HOLD}
    if left: bad.append(('folder holds more', d, sorted(left)))
print('hold', len(HOLD), '| rehome', len(REHOME), '| rmdir', len(RMDIR), '| LL refs', [x[0] for x in refs])
if bad:
    for b in bad: print('REFUSE', *b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')

bk = '/config/lazylibrarian.db.pre-782-20261006'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2)
ok = b2.execute('pragma integrity_check').fetchone()[0]; b2.close()
assert ok == 'ok', ok
print('backup', bk, 'integrity', ok)


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''): h.update(b)
    return h.hexdigest()


def mkd(d, stop):
    if not os.path.isdir(d):
        os.makedirs(d); x = d
        while x.rstrip('/') != stop.rstrip('/'): os.chown(x, 1000, 1000); x = os.path.dirname(x)


man = open(H + 'manifest.jsonl', 'a'); srt = open(H + 'sort.jsonl', 'a')
for p, cat, rec, ev in HOLD:
    s = B + p; d = H + p; m = md5(s); z = os.path.getsize(s); mkd(os.path.dirname(d), H); os.rename(s, d)
    man.write(json.dumps({'op': 'hold', 'src': p, 'dst': HR + p, 'md5': m, 'size': z, 'reason': TAG + ev, 'record': rec,
                          'ts': ts()}, ensure_ascii=False) + '\n')
    srt.write(json.dumps({'path': HR + p, 'size': z, 'md5': m, 'category': cat, 'evidence': ev, 'record': rec,
                          'counterparts': []}, ensure_ascii=False) + '\n')
for d in NEWDIRS: mkd(B + d.rstrip('/'), B + 'EBooks')
for s, d, rec, why in REHOME:
    m = md5(B + s); z = os.path.getsize(B + s); os.rename(B + s, B + d)
    man.write(json.dumps({'op': 'rehome', 'src': s, 'dst': d, 'md5': m, 'size': z, 'reason': TAG + why, 'record': rec,
                          'ts': ts()}, ensure_ascii=False) + '\n')
for d in RMDIR:
    os.rmdir(B + d)
    man.write(json.dumps({'op': 'rmdir', 'src': d, 'reason': TAG + 'emptied folder', 'record': '', 'ts': ts()}) + '\n')
man.close(); srt.close()
for d in [E + 'Tom Clancy/Debt of Honor', BA, FWAM, E + 'Tom Clancy', E + 'Hugh Howey', E + 'Dennis E. Taylor', E + 'J.R.R. Tolkien']:
    os.utime(B + d.rstrip('/'), None)  # hdd-nfs-repl does not bump a folder's mtime on rename; Kavita compares it
with db:
    assert db.execute('update books set BookFile=NULL,BookLibrary=NULL where BookID=? and BookFile=?',
                      ('igdN-TOJVEsC', B + DEBT)).rowcount == 1
    assert db.execute('update books set BookFile=? where BookID=? and BookFile=?',
                      (B + BA_BASE + '.azw3', 'Zi7wEAAAQBAJ', B + SAND)).rowcount == 1
    assert db.execute("update books set BookFile=?,BookLibrary=?,Status='Open' where BookID=? and BookFile is null and Status='Wanted'",
                      (B + FWAM_FILE, now, 'DfEW0gEACAAJ')).rowcount == 1
db.close()
c = configparser.RawConfigParser(); c.read('/config/config.ini'); key = c.get('API', 'api_key')
u = 'http://localhost:5299/api?' + urllib.parse.urlencode({'apikey': key, 'cmd': 'queueBook', 'id': 'igdN-TOJVEsC', 'type': 'eBook'})
print('queueBook igdN-TOJVEsC eBook', urllib.request.urlopen(u, timeout=60).read().decode()[:40])
# The converter's held list: drop the four (the folders are gone or emptied; the re-homed books convert next run).
lines = open(HELD_TSV, encoding='utf-8').read().splitlines(keepends=True)
kept = [l for l in lines if l.startswith('#') or l.split('\t', 1)[0] not in HELD_FOLDERS]
with open(HELD_TSV, 'w', encoding='utf-8') as fh: fh.writelines(kept)
print('held.tsv lines', len(lines), '->', len(kept))
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
for i in ('igdN-TOJVEsC', 'Zi7wEAAAQBAJ', 'DfEW0gEACAAJ', 't3sI0QEACAAJ'):
    r = db.execute('select BookID,BookName,BookLang,Status,BookFile,BookLibrary from books where BookID=?', (i,)).fetchone()
    print(json.dumps([x.replace(B, '') if isinstance(x, str) else x for x in r], ensure_ascii=False),
          'file ok' if r[4] is None or os.path.isfile(r[4]) else 'FILE MISSING')
