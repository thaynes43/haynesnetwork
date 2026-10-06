# Issue #781 (2026-10-06): two LazyLibrarian books hold another book's file. Fixed under the cross-volume repair rules
# (the #782 precedent, held_782_fix.py). Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/fix_781.py        # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/fix_781.py   # apply
# Content read first (zipfile OPF dc:title + md5, read-only, 2026-10-06 21:20Z):
# - RZZRAQAAQBAJ "Four. The Traitor" (en, US ISBN 006228567X) links Four. The Traitor/Four. The Traitor - Veronica Roth.epub,
#   which is "Four Divergent Stories: The Transfer, The Initiate, The Son, and The Traitor": the four-story collection
#   (grab 4964, "Four- A Divergent Story Collection (...)"). The collection is also held as its own book in
#   Four - A Divergent Story Collection/ (Kavita series 256). The real Kindle Single is already in the library:
#   The Traitor/Veronica Roth - The Traitor.epub ("Four: The Traitor (Kindle Single) (Divergent Trilogy Book 4)", Kavita
#   series 1950; its folder's LazyLibrarian opf already names RZZRAQAAQBAJ). -> re-point to it; hold the collection
#   copy `duplicate` (counterpart: the collection's own folder) with its sidecars; nothing searched.
#   TYETAQAAQBAJ "The Traitor. A Divergent Story" (en, UK ISBN 0007550154) is the same book under its UK title, Wanted with
#   no file for pairing want 0841d533: a grab would put a second copy in Kavita and make Libretto's Divergent member
#   "Four: The Traitor" ambiguous. -> link the same file, Open (the twin-record repair of 2026-10-05).
# - Qw30DwAAQBAJ "Shift" (en) links First Shift - Legacy/Hugh Howey - First Shift - Legacy.epub, which is First Shift:
#   Legacy (Silo 6, grab 5046). Its own folder Shift/ holds Third Shift: Pact (epub, md5 = grab 9282's torrent copy) and
#   First Shift: Legacy (mobi, md5 = grab 5046's torrent copy). The right book was downloaded on 2026-08-22 (grab 6086,
#   "Shift Omnibus Edition (Shift 1-3)", still seeding in qBittorrent) and imported as Shift/Shift - Hugh Howey.epub,
#   which grab 9282 (Third Shift, 2026-09-27) overwrote under the same name. Wool Omnibus/ holds a third Third Shift
#   epub. Each of the three folders carries a LazyLibrarian opf naming Qw30DwAAQBAJ, which LazyLibrarian's library scan
#   reads before the file's own metadata, so any of them would be linked to Shift again.
#   -> hold the four wrong books and the two stray opfs `off_catalog` (no LazyLibrarian record, no request names First
#   or Third Shift; both are parts of the omnibus), copy the omnibus epub from the torrent folder (copy, the torrent
#   keeps seeding) to Shift/Shift - Hugh Howey.epub beside the folder's own opf and cover, and re-point the record.
#   Nothing searched: the right book is already downloaded.
# Also: the three emptied folders are removed. LL DB backup first (sqlite backup API, integrity checked). Kavita had one
# user and no pages read on series 1661, 291 or 1221 (the series that lose a file).
# Undo: move each manifest dst back to src, drop the sort rows, delete the copied omnibus, restore the printed old
# pointers (or the backup with LL stopped).
import os, sys, json, hashlib, time, shutil, sqlite3

B = '/data/cephfs-hdd/data/media/books/'
HR = 'quarantine/crossvolume-2026-10-05/'
H = B + HR
E = 'EBooks/'
GO = '--go' in sys.argv
TAG = '#781 2026-10-06: '
VR = E + 'Veronica Roth/'
HH = E + 'Hugh Howey/'
TRAITOR_OLD = VR + 'Four. The Traitor/Four. The Traitor - Veronica Roth'
TRAITOR_NEW = VR + 'The Traitor/Veronica Roth - The Traitor.epub'
COLLECTION = VR + 'Four - A Divergent Story Collection'
FSL = HH + 'First Shift - Legacy/Hugh Howey - First Shift - Legacy'
SHIFT = HH + 'Shift/Shift - Hugh Howey'
WOOL_OMNI = HH + 'Wool Omnibus/Hugh Howey - Wool Omnibus'
TORRENT = '/data/cephfs-hdd/torrents/books/books-mam/Shift Omnibus Edition (Shift 1-3) (Silo  - Howey, Hugh/' \
          'Shift Omnibus Edition (Shift 1-3) (Silo  - Howey, Hugh.epub'
TORRENT_MD5, TORRENT_SIZE = '717b3c27d3e4ba089b020ac70d52c3d0', 499380
EXPECT = {  # path: (size, md5) of every file this moves, as read at 21:20Z
    TRAITOR_OLD + '.epub': (594652, 'd53b6a6f3fa9e17c6f36a17711b664e1'),
    FSL + '.epub': (221847, '4ee406d41160d9592592414d5293469f'),
    SHIFT + '.epub': (274880, 'ce40efa629ea11904531a0c8fc5cdf47'),
    SHIFT + '.mobi': (297132, 'e6ae6cc9a666de69e03f81d626a5c1b3'),
    WOOL_OMNI + '.epub': (294683, '765910a91afbc956ba995bda68c3729b'),
}
COLL_EV = ('the four-story collection "Four Divergent Stories: The Transfer, The Initiate, The Son, and The Traitor" filed '
           'as Four. The Traitor (grab 4964); the collection is held in Four - A Divergent Story Collection/ and the '
           'Kindle Single The Traitor in The Traitor/, now RZZRAQAAQBAJ\'s file')
FSL_EV = ('First Shift: Legacy (Silo 6) linked as Shift (grab 5046); no LL record or request names it; part 1 of the Shift '
          'omnibus, which is now Qw30DwAAQBAJ\'s file')
TS_EV = ('Third Shift: Pact (Silo 8) filed as Shift (grab 9282 overwrote the omnibus under the same name); no LL record or '
         'request names it; part 3 of the Shift omnibus, now Qw30DwAAQBAJ\'s file')
HOLD = [  # (path, category, record, evidence, counterparts)
    (TRAITOR_OLD + '.epub', 'duplicate', 'RZZRAQAAQBAJ', COLL_EV, [COLLECTION]),
    (TRAITOR_OLD + '.jpg', 'off_catalog', 'RZZRAQAAQBAJ', 'cover sidecar of the held collection copy', []),
    (TRAITOR_OLD + '.opf', 'off_catalog', 'RZZRAQAAQBAJ',
     'LL opf naming RZZRAQAAQBAJ beside the held collection copy (The Traitor/ keeps its own)', []),
    (FSL + '.epub', 'off_catalog', 'Qw30DwAAQBAJ', FSL_EV, []),
    (FSL + '.opf', 'off_catalog', 'Qw30DwAAQBAJ', 'LL opf naming Qw30DwAAQBAJ beside First Shift: Legacy', []),
    (SHIFT + '.epub', 'off_catalog', 'Qw30DwAAQBAJ', TS_EV, []),
    (SHIFT + '.mobi', 'off_catalog', 'Qw30DwAAQBAJ',
     'First Shift: Legacy (Silo 6) mobi (md5 = grab 5046\'s torrent copy) filed as Shift; part 1 of the Shift omnibus', []),
    (WOOL_OMNI + '.epub', 'off_catalog', 'Qw30DwAAQBAJ',
     'Third Shift: Pact (Silo 8) in a folder named Wool Omnibus with an opf naming Shift; no LL record or request names '
     'it; part 3 of the Shift omnibus, now Qw30DwAAQBAJ\'s file', []),
    (WOOL_OMNI + '.opf', 'off_catalog', 'Qw30DwAAQBAJ', 'LL opf naming Qw30DwAAQBAJ beside the held Third Shift copy', []),
]
RMDIR = [VR + 'Four. The Traitor', HH + 'First Shift - Legacy', HH + 'Wool Omnibus']
SHIFT_NEW = SHIFT + '.epub'
now = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''): h.update(b)
    return h.hexdigest()


db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
row = lambda i: db.execute('select BookLang,Status,BookFile,BookLibrary from books where BookID=?', (i,)).fetchone()
bad = []
for p, (z, m) in EXPECT.items():
    if not os.path.isfile(B + p): bad.append(('missing', p))
    elif os.path.getsize(B + p) != z or md5(B + p) != m: bad.append(('changed', p))
for p, *_ in HOLD:
    if not os.path.isfile(B + p): bad.append(('missing', p))
    if os.path.exists(H + p): bad.append(('hold target exists', HR + p))
if not os.path.isfile(TORRENT) or os.path.getsize(TORRENT) != TORRENT_SIZE or md5(TORRENT) != TORRENT_MD5:
    bad.append(('torrent copy changed or missing', TORRENT))
if not os.path.isfile(B + TRAITOR_NEW): bad.append(('missing', TRAITOR_NEW))
if not any(x.endswith('.epub') for x in os.listdir(B + COLLECTION)): bad.append(('collection folder has no epub', COLLECTION))
r = row('RZZRAQAAQBAJ')
if r is None or r[0] != 'en' or r[1] != 'Open' or r[2] != B + TRAITOR_OLD + '.epub': bad.append(('RZZRAQAAQBAJ is', r))
r = row('TYETAQAAQBAJ')
if r is None or r[0] != 'en' or r[1] != 'Wanted' or r[2]: bad.append(('TYETAQAAQBAJ is', r))
r = row('Qw30DwAAQBAJ')
if r is None or r[0] != 'en' or r[1] != 'Open' or r[2] != B + FSL + '.epub': bad.append(('Qw30DwAAQBAJ is', r))
held_dirs = tuple(B + d + '/' for d in RMDIR) + (B + HH + 'Shift/',)
refs = sorted((x[0], x[1].replace(B, '')) for x in db.execute('select BookID,BookFile from books where BookFile is not null')
              if x[1].startswith(held_dirs))
if [x[0] for x in refs] != ['Qw30DwAAQBAJ', 'RZZRAQAAQBAJ']: bad.append(('unexpected LL refs into the folders', refs))
arefs = [x[0] for x in db.execute('select BookID,AudioFile from books where AudioFile is not null')
         if x[1].startswith(held_dirs)]
if arefs: bad.append(('audio refs into the folders', arefs))
for d in RMDIR:
    left = set(os.listdir(B + d)) - {os.path.basename(p) for p, *_ in HOLD}
    if left: bad.append(('folder holds more', d, sorted(left)))
left = set(os.listdir(B + HH + 'Shift')) - {os.path.basename(p) for p, *_ in HOLD}
if left != {'Shift - Hugh Howey.jpg', 'Shift - Hugh Howey.opf'}: bad.append(('Shift/ holds', sorted(left)))
print('hold', len(HOLD), '| copy 1 | rmdir', len(RMDIR), '| LL refs', refs)
if bad:
    for b in bad: print('REFUSE', *b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')

bk = '/config/lazylibrarian.db.pre-781-20261006'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2)
ok = b2.execute('pragma integrity_check').fetchone()[0]; b2.close()
assert ok == 'ok', ok
print('backup', bk, 'integrity', ok)


def mkd(d, stop):
    if not os.path.isdir(d):
        os.makedirs(d); x = d
        while x.rstrip('/') != stop.rstrip('/'): os.chown(x, 1000, 1000); x = os.path.dirname(x)


man = open(H + 'manifest.jsonl', 'a'); srt = open(H + 'sort.jsonl', 'a')
for p, cat, rec, ev, cps in HOLD:
    s = B + p; d = H + p; m = md5(s); z = os.path.getsize(s); mkd(os.path.dirname(d), H); os.rename(s, d)
    man.write(json.dumps({'op': 'hold', 'src': p, 'dst': HR + p, 'md5': m, 'size': z, 'reason': TAG + ev, 'record': rec,
                          'ts': ts()}, ensure_ascii=False) + '\n')
    srt.write(json.dumps({'path': HR + p, 'size': z, 'md5': m, 'category': cat, 'evidence': ev, 'record': rec,
                          'counterparts': cps}, ensure_ascii=False) + '\n')
# The omnibus: copied under a hidden name, checked, then renamed into place (the torrent keeps seeding its own copy).
tmp = B + HH + 'Shift/.Shift - Hugh Howey.epub.781'
shutil.copyfile(TORRENT, tmp); os.chown(tmp, 1000, 1000); os.chmod(tmp, 0o664)
assert md5(tmp) == TORRENT_MD5
os.rename(tmp, B + SHIFT_NEW)
man.write(json.dumps({'op': 'copy', 'src': TORRENT, 'dst': SHIFT_NEW, 'md5': TORRENT_MD5, 'size': TORRENT_SIZE,
                      'reason': TAG + 'the Shift omnibus LazyLibrarian downloaded for Qw30DwAAQBAJ (grab 6086) and grab 9282 '
                      'overwrote, copied back from the seeding torrent', 'record': 'Qw30DwAAQBAJ', 'ts': ts()}) + '\n')
for d in RMDIR:
    os.rmdir(B + d)
    man.write(json.dumps({'op': 'rmdir', 'src': d, 'reason': TAG + 'emptied folder', 'record': '', 'ts': ts()}) + '\n')
man.close(); srt.close()
for d in [VR + 'The Traitor', HH + 'Shift', VR.rstrip('/'), HH.rstrip('/')]:
    os.utime(B + d, None)  # hdd-nfs-repl does not bump a folder's mtime on rename; Kavita compares it
with db:
    assert db.execute('update books set BookFile=? where BookID=? and BookFile=?',
                      (B + TRAITOR_NEW, 'RZZRAQAAQBAJ', B + TRAITOR_OLD + '.epub')).rowcount == 1
    assert db.execute("update books set BookFile=?,BookLibrary=?,Status='Open' where BookID=? and BookFile is null "
                      "and Status='Wanted'", (B + TRAITOR_NEW, now, 'TYETAQAAQBAJ')).rowcount == 1
    assert db.execute('update books set BookFile=?,BookLibrary=? where BookID=? and BookFile=?',
                      (B + SHIFT_NEW, now, 'Qw30DwAAQBAJ', B + FSL + '.epub')).rowcount == 1
db.close()
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
for i in ('RZZRAQAAQBAJ', 'TYETAQAAQBAJ', 'Qw30DwAAQBAJ'):
    r = db.execute('select BookID,BookName,BookLang,Status,BookFile,BookLibrary from books where BookID=?', (i,)).fetchone()
    print(json.dumps([x.replace(B, '') if isinstance(x, str) else x for x in r], ensure_ascii=False),
          'file ok' if r[4] and os.path.isfile(r[4]) else 'FILE MISSING')
