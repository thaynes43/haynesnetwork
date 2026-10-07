# Issue #799 (2026-10-07): the Books Census's cut-title rule (v0.109.2) found one book held for a record that names more.
# Every file was read first (read-only): epub OPF titles, identifiers and tables of contents, audio tags and durations
# (Audiobookshelf), the folders' LazyLibrarian opfs, and the app's wants (book_requests, read-only session).
#
# Re-point to the right book already on disk (2):
#   83Hv_EYvHgEC Merge / Disciple (eBook)  -> Merge + Disciple - Two Short Novels from Crosstown to Oblivion/ (OPF "Merge and
#                                             Disciple (Crosstown to Oblivion)", ASIN B008BU78JM, both title pages, ~67k
#                                             words; no record linked it). It held Disciple alone (OPF "Disciple", ISBN
#                                             9781466816237, ~31k words), which stays in its own folder; its opf naming
#                                             83Hv_EYvHgEC is held. The audiobook ("Merge and Disciple", 8.7 h) was right.
#   4bLbswEACAAJ A Secret Rage and Sweet   -> Sweet and Deadly/Sweet and Deadly - Charlaine Harris.epub, the two-novel
#                and Deadly (eBook)           omnibus (OPF "A Secret Rage & Sweet and Deadly", ISBN 9781625672766), which
#                                             Sweet and Deadly (vcpmEQAAQBAJ) also links under its Census Hold. It held A
#                                             Secret Rage alone (ISBN 978-1-625671-10-3), which stays; its opf is held.
# Re-want (pairing want 6593ef4e asks for this audiobook; no right copy anywhere), 1, under the owner's #795 ruling:
#   4bLbswEACAAJ (audio): the six tracks are A Secret Rage alone (7.85 h; Audiobookshelf "A Secret Rage"); they stay in A
#                Secret Rage/, the folder's opf naming the omnibus record is held, the pointer is blanked and the
#                audiobook queued (queueBook). No grab row: the library scan linked it, so nothing is blocked.
# No want asks for these formats, so the pointer is cleared the way LazyLibrarian shows a book it does not hold and does
# not want (the #795 Catwings audiobook), and nothing is searched (2):
#   K3wuAAAACAAJ Code to Zero [and] The Man from St Petersburg (eBook): the epub is Code to Zero alone (OPF, ISBN
#                0786566574); it stays in Code to Zero/, its opf naming the two-novel record is held. The Man from St.
#                Petersburg has its own record (aeFZfuGryeYC, Wanted). Status Skipped.
#   4m0Qj9xKksYC The Ultimate Hitchhiker's Guide to the Galaxy (audio): the five tracks are book 1 alone (every album tag
#                "1-The Hitchhiker's Guide To The Galaxy", 4.96 h); the other four books are their own Audiobookshelf
#                items. AudioStatus Skipped, the folder's opf naming the omnibus held, and the tracks linked to book 1's own
#                record zaynQgAACAAJ "The Hitch Hiker's Guide to the Galaxy" (AudioStatus Skipped -> Open; its pairing want
#                3dcefd91 already reads the audiobook landed from Audiobookshelf). Its eBook stays Wanted.
# Census Hold instead (the file is the book): kyNEwgEACAAJ "Star Wars. Galaxy's Edge A Crash of Fate" (holds file).
# Undo: move each manifest dst back to src, drop the sort rows, restore the printed old pointers (or the backup with
# LazyLibrarian stopped). Run INSIDE the LazyLibrarian pod: dry run, then --go.
import os, sys, json, hashlib, time, sqlite3, configparser, urllib.request, urllib.parse

B = '/data/cephfs-hdd/data/media/books/'
HR = 'quarantine/crossvolume-2026-10-05/'
H = B + HR
GO = '--go' in sys.argv
TAG = '#799 2026-10-07: '
WM, CH, KF, DA = 'EBooks/Walter Mosley/', 'EBooks/Charlaine Harris/', 'EBooks/Ken Follett/', 'AudioBooks/Douglas Adams/'
CHA = 'AudioBooks/Charlaine Harris/'
DISCIPLE = WM + 'Disciple - A Novel from Crosstown to Oblivion/Walter Mosley - Disciple - A Novel from Crosstown to Oblivion'
MERGE = WM + 'Merge + Disciple - Two Short Novels from Crosstown to Oblivion/Walter Mosley - Merge + Disciple - Two Short Novels from Crosstown to Oblivion.epub'
RAGE = CH + 'A Secret Rage/Charlaine Harris - A Secret Rage'
OMNI = CH + 'Sweet and Deadly/Sweet and Deadly - Charlaine Harris.epub'
RAGE_AUDIO = CHA + 'A Secret Rage/'
CODE = KF + 'Code to Zero/Ken Follett - Code to Zero'
HHG = DA + "The Hitchhiker's Guide to the Galaxy/"
HHG1 = HHG + "Douglas Adams - The Hitchhiker's Guide to the Galaxy (1).mp3"

# (record, column, old, new)
REPOINT = [('83Hv_EYvHgEC', 'BookFile', DISCIPLE + '.epub', MERGE), ('4bLbswEACAAJ', 'BookFile', RAGE + '.epub', OMNI)]
SIZES = {MERGE: 515387, OMNI: 1173482, HHG1: 53294646}
# (record, kind, old) -> pointer blanked, format Skipped
CLEAR = [('K3wuAAAACAAJ', 'eBook', CODE + '.epub'), ('4m0Qj9xKksYC', 'AudioBook', HHG1)]
# (record, kind, old) -> pointer blanked, queueBook
REWANT = [('4bLbswEACAAJ', 'AudioBook', RAGE_AUDIO + 'Charlaine Harris - A Secret Rage (1).mp3')]
# (record, column, new, status before)
LINK = [('zaynQgAACAAJ', 'AudioFile', HHG1, 'Skipped')]
# (path, record it names, evidence)
HOLD = [
    (DISCIPLE + '.opf', '83Hv_EYvHgEC', 'LL opf naming 83Hv_EYvHgEC (Merge / Disciple) beside Disciple alone (stays, no LL record)'),
    (RAGE + '.opf', '4bLbswEACAAJ', 'LL opf naming 4bLbswEACAAJ (the A Secret Rage and Sweet and Deadly omnibus) beside A Secret '
                                    'Rage alone (stays, no LL record)'),
    (RAGE_AUDIO + 'A Secret Rage and Sweet and Deadly.opf', '4bLbswEACAAJ', 'LL opf naming 4bLbswEACAAJ (the omnibus) beside the '
                                                                             'A Secret Rage audiobook alone (stays)'),
    (CODE + '.opf', 'K3wuAAAACAAJ', 'LL opf naming K3wuAAAACAAJ (Code to Zero [and] The Man from St Petersburg) beside Code to '
                                    'Zero alone (stays, no LL record)'),
    (HHG + "The Ultimate Hitchhiker's Guide to the Galaxy.opf", '4m0Qj9xKksYC', "LL opf naming 4m0Qj9xKksYC (The Ultimate "
     "Hitchhiker's Guide) beside book 1's audiobook alone (stays, linked to zaynQgAACAAJ)"),
]
COL = {'eBook': ('BookFile', 'BookLibrary', 'Status'), 'AudioBook': ('AudioFile', 'AudioLibrary', 'AudioStatus')}
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
now = time.strftime('%Y-%m-%d %H:%M:%S')


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''): h.update(b)
    return h.hexdigest()


db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
bad = []
get = lambda rec, c: db.execute('select %s from books where BookID=?' % c, (rec,)).fetchone()
for rec, c, old, new in REPOINT:
    if get(rec, c) != (B + old,): bad.append(('repoint: record is', rec, get(rec, c)))
    if not os.path.isfile(B + new) or os.path.getsize(B + new) != SIZES[new]: bad.append(('repoint target missing or changed', new))
for rec, kind, old in CLEAR + REWANT:
    f, _, st = COL[kind]
    r = db.execute('select %s,%s from books where BookID=?' % (f, st), (rec,)).fetchone()
    if r != (B + old, 'Open'): bad.append(('clear/rewant: record is', rec, kind, r))
for rec, c, new, st in LINK:
    r = db.execute('select AudioFile,AudioStatus from books where BookID=?', (rec,)).fetchone()
    if r[0] or r[1] != st: bad.append(('link: record is', rec, r))
    if not os.path.isfile(B + new) or os.path.getsize(B + new) != SIZES[new]: bad.append(('link target missing or changed', new))
for p, rec, ev in HOLD:
    if not os.path.isfile(B + p) or rec not in open(B + p, encoding='utf-8', errors='replace').read(): bad.append(('opf', p))
    if os.path.exists(H + p): bad.append(('hold target exists', p))
refs = {}
for p in [MERGE, OMNI, HHG1] + [old for _, _, old in CLEAR + REWANT] + [old for _, _, old, _ in REPOINT]:
    refs[p] = [x[0] for x in db.execute('select BookID from books where BookFile=? or AudioFile=?', (B + p, B + p))]
print('re-point', len(REPOINT), '| clear', len(CLEAR), '| re-want', len(REWANT), '| link', len(LINK), '| hold', len(HOLD))
for p, r in refs.items(): print('  refs', r, p.split('/')[-1])
if refs[MERGE] != [] or refs[OMNI] != ['vcpmEQAAQBAJ'] or refs[HHG1] != ['4m0Qj9xKksYC']: bad.append(('refs changed', refs))
if bad:
    for b in bad: print('REFUSE', *b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')

bk = '/config/lazylibrarian.db.pre-799-20261007'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2)
ok = b2.execute('pragma integrity_check').fetchone()[0]; b2.close()
assert ok == 'ok', ok
print('backup', bk, 'integrity', ok)


def mkd(d, stop):
    if not os.path.isdir(d):
        os.makedirs(d); x = d
        while x.rstrip('/') != stop.rstrip('/'): os.chown(x, 1000, 1000); x = os.path.dirname(x)


with open(H + 'manifest.jsonl', 'a') as man, open(H + 'sort.jsonl', 'a') as srt:
    for p, rec, ev in HOLD:
        s, d = B + p, H + p; m = md5(s); z = os.path.getsize(s); mkd(os.path.dirname(d), H)
        os.rename(s, d)
        man.write(json.dumps({'op': 'hold', 'src': p, 'dst': HR + p, 'md5': m, 'size': z, 'reason': TAG + ev, 'record': rec,
                              'ts': ts()}, ensure_ascii=False) + '\n')
        srt.write(json.dumps({'path': HR + p, 'size': z, 'md5': m, 'category': 'off_catalog', 'evidence': ev, 'record': rec,
                              'counterparts': []}, ensure_ascii=False) + '\n')
for d in sorted({os.path.dirname(B + p) for p, *_ in HOLD}, key=len, reverse=True):
    os.utime(d, None)  # hdd-nfs-repl does not bump a folder's mtime on rename; Kavita compares it
with db:
    for rec, c, old, new in REPOINT:
        assert db.execute('update books set %s=? where BookID=? and %s=?' % (c, c), (B + new, rec, B + old)).rowcount == 1, rec
    for rec, kind, old in CLEAR:
        f, lib, st = COL[kind]
        assert db.execute("update books set %s=NULL,%s=NULL,%s='Skipped' where BookID=? and %s=? and %s='Open'"
                          % (f, lib, st, f, st), (rec, B + old)).rowcount == 1, rec
    for rec, kind, old in REWANT:
        f, lib, st = COL[kind]
        assert db.execute('update books set %s=NULL,%s=NULL where BookID=? and %s=?' % (f, lib, f), (rec, B + old)).rowcount == 1, rec
    for rec, c, new, st in LINK:
        assert db.execute("update books set AudioFile=?,AudioLibrary=?,AudioStatus='Open' where BookID=? and AudioFile is null "
                          "and AudioStatus=?", (B + new, now, rec, st)).rowcount == 1, rec
db.close()
c = configparser.RawConfigParser(); c.read('/config/config.ini'); key = c.get('API', 'api_key')
for rec, typ, old in REWANT:
    u = 'http://localhost:5299/api?' + urllib.parse.urlencode({'apikey': key, 'cmd': 'queueBook', 'id': rec, 'type': typ})
    print('queueBook', rec, typ, urllib.request.urlopen(u, timeout=60).read().decode()[:20])
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
for rec in ['83Hv_EYvHgEC', '4bLbswEACAAJ', 'K3wuAAAACAAJ', '4m0Qj9xKksYC', 'zaynQgAACAAJ', 'vcpmEQAAQBAJ']:
    r = db.execute('select BookID,BookName,Status,AudioStatus,BookFile,AudioFile from books where BookID=?', (rec,)).fetchone()
    print(json.dumps([x.replace(B, '')[:90] if isinstance(x, str) else x for x in r], ensure_ascii=False),
          'files ok' if all(f is None or os.path.isfile(f) for f in r[4:6]) else 'FILE MISSING')
print('max wanted rowid', db.execute('select max(rowid) from wanted').fetchone())
