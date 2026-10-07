# OC-031 / OC-032 / OC-037 failed (2026-10-07): LazyLibrarian's 09:10Z library scan undid the census repairs. Run INSIDE
# the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/fix_census_scan_1007.py        # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/fix_census_scan_1007.py   # apply
#
# The mechanism (read from librarysync.py library_scan, image version-40a389ea, and the 09:10Z run's files and log):
# the scan walks EBooks/ and AudioBooks/ and matches every book file to a record by, in order, an id in a folder opf or
# in the epub's own OPF, the exact title + author, a fuzzy partial-ratio title match over that author's books
# (find_book_in_db: "Four Divergent Stories - Omnibus" contains "Divergent"), the ISBN, then an online search. On a
# match it writes an opf naming the record when the folder has none (create_opf, overwrite=False) and points the
# record's BookFile / AudioFile at the file, setting it Open even when it was Skipped or Wanted. Holding the opf, the
# earlier repair rule, only removed the first signal: at 09:11-09:43Z the scan re-matched each wrong file by title,
# wrote a fresh opf naming the wrong record beside it, and re-pointed the record (last match wins). The holding folder
# (books/quarantine/) is outside both scanned roots and played no part.
#
# The durable rule from here on: a folder that holds a book which is the wrong file for some record, and stays in the
# library for Kavita or Audiobookshelf, gets an empty `.ll_ignore`. library_scan skips any directory containing that
# file (upstream behaviour: it is removed from the walk, so nothing in it is matched or re-linked; the CronJob's API
# scans run with remove=False, so the scan never unlinks a record already pointing into it either). Undo: delete the
# marker. LazyLibrarian's postprocess of a new download does not read it.
#
# This run: re-applies fix_census_divergent.py, fix_census_795.py (nine undone re-points, Warriors 3's re-want) and
# fix_census_799.py (four undone states); holds the opfs the scan wrote; drops `.ll_ignore` in every folder the scan
# re-linked from (and in the two folders whose book a re-wanted record would match by title: Sparring Partners/ and
# Fifty Shades Darker/); and triages the two census findings that are new wrong books landing (OC-035 Partners, and
# Darker): each re-delivered copy is md5-identical to a copy already in its own folder, so it is held `duplicate`, the
# release that delivered it is blocked with a Failed wanted row (the #755 pattern) and the format re-wanted (owner
# ruling 2026-10-06 "Yes, re-download all of them"). Nothing is deleted. Nothing is searched by this script; the
# re-wants are queued for LazyLibrarian's normal backlog search.
import os, re, sys, json, hashlib, time, sqlite3, configparser, urllib.request, urllib.parse

B = '/data/cephfs-hdd/data/media/books/'
HR = 'quarantine/crossvolume-2026-10-05/'
H = B + HR
E, A = 'EBooks/', 'AudioBooks/'
GO = '--go' in sys.argv
TAG = 'OC-031/032/037 2026-10-07: '
IGNORE_FILE = '.ll_ignore'
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
now = time.strftime('%Y-%m-%d %H:%M:%S')

VR, LG, TP, DG = E + 'Veronica Roth/', E + 'Ursula K. Le Guin/', E + 'Terry Pratchett/', E + 'Diana Gabaldon/'
RD, RJ, RR, JC = E + 'Roald Dahl/', E + 'Robert Jordan/', E + 'Rick Riordan/', E + 'James S.A. Corey/'
GRRM, WM, CH, KF = E + 'George R.R. Martin/', E + 'Walter Mosley/', E + 'Charlaine Harris/', E + 'Ken Follett/'
CHA, DA, JG, ELJ = A + 'Charlaine Harris/', A + 'Douglas Adams/', A + 'John Grisham/', A + 'E.L. James/'

# (record, column, the wrong file the scan linked, the right file the repair had set)
REPOINT = [
    ('K0UczgEACAAJ', 'BookFile', VR + 'Four - A Divergent Story Collection/Veronica Roth - Four - A Divergent Story Collection.epub',
     VR + 'Divergent/Veronica Roth - Divergent.pdf'),
    ('QGPZEAAAQBAJ', 'BookFile', LG + 'Catwings/Ursula K. Le Guin - Catwings.epub',
     LG + 'Wonderful Alexander and the Catwings/Ursula K. Le Guin - Wonderful Alexander and the Catwings.pdf'),
    ('wzxmQgAACAAJ', 'BookFile', TP + "The Science of Discworld III - Darwin's Watch/Terry Pratchett - The Science of Discworld III - Darwin's Watch.epub",
     TP + 'The Science Of Discworld II - The Globe/Terry Pratchett - The Science Of Discworld II - The Globe.epub'),
    ('IMlH63ZPShAC', 'BookFile', DG + 'Outlander/Diana Gabaldon - Outlander.epub',
     DG + 'A Plague of Zombies/Diana Gabaldon - A Plague of Zombies.epub'),
    ('zTCLswEACAAJ', 'BookFile', E + 'Dean Koontz/Innocence - A Novel/Dean Koontz - Innocence - A Novel.epub',
     E + 'Benedict Carey/How We Learn/How We Learn - Benedict Carey.epub'),
    ('qKuOEAAAQBAJ', 'BookFile', RD + 'More Tales of the Unexpected/Roald Dahl - More Tales of the Unexpected.epub',
     RD + 'Tales of the Unexpected/Roald Dahl - Tales of the Unexpected.epub'),
    ('lSybHLQbZ_kC', 'BookFile', RJ + 'Towers of Midnight/Robert Jordan - Towers of Midnight.epub',
     RJ + 'Distinctions - Prologue to Towers of Midnight/Robert Jordan - Distinctions - Prologue to Towers of Midnight.epub'),
    ('W4ZDugEACAAJ', 'BookFile', RR + 'The Hammer of Thor/Rick Riordan - The Hammer of Thor.epub',
     RR + 'The Ship of the Dead/Rick Riordan - The Ship of the Dead.epub'),
    ('VKBoDwAAQBAJ', 'BookFile', JC + 'The Expanse Origins #2/James S.A. Corey - The Expanse Origins #2.epub',
     JC + 'The Expanse Origins #3/James S.A. Corey - The Expanse Origins #3.epub'),
    ('ENRSDwAAQBAJ', 'BookFile', GRRM + 'Nightflyers - The Illustrated Edition/George R.R. Martin - Nightflyers - The Illustrated Edition.epub',
     GRRM + 'Nightflyers & Other Stories/Nightflyers & Other Stories - George R.R. Martin.epub'),
    ('83Hv_EYvHgEC', 'BookFile', WM + 'Disciple - A Novel from Crosstown to Oblivion/Walter Mosley - Disciple - A Novel from Crosstown to Oblivion.epub',
     WM + 'Merge + Disciple - Two Short Novels from Crosstown to Oblivion/Walter Mosley - Merge + Disciple - Two Short Novels from Crosstown to Oblivion.epub'),
    ('4bLbswEACAAJ', 'BookFile', CH + 'A Secret Rage/Charlaine Harris - A Secret Rage.epub',
     CH + 'Sweet and Deadly/Sweet and Deadly - Charlaine Harris.epub'),
]
# (record, LL type, the wrong file the scan linked): back to Skipped with no file (fix_census_799.py)
CLEAR = [
    ('K3wuAAAACAAJ', 'eBook', KF + 'Code to Zero/Ken Follett - Code to Zero.epub'),
    ('4m0Qj9xKksYC', 'AudioBook', DA + "The Hitchhiker's Guide to the Galaxy/Douglas Adams - The Hitchhiker's Guide to the Galaxy (1).mp3"),
]
# (record, LL type, the wrong file linked, wanted rowid of the release that delivered it, or None): pointer blanked,
# format queued (Wanted); a delivering release is blocked with a Failed wanted row
REWANT = [
    ('OwTswUGVzVcC', 'eBook', GRRM + 'Warriors 1/George R.R. Martin - Warriors 1.epub', None),
    ('4bLbswEACAAJ', 'AudioBook', CHA + 'A Secret Rage/Charlaine Harris - A Secret Rage (1).mp3', None),
    ('VNalCwAAQBAJ', 'AudioBook', JG + 'Partners/John Grisham - Partners Part 001 of 102.mp3', 9616),
    ('8CzFswEACAAJ', 'AudioBook', ELJ + 'Darker/E.L. James - Darker Part 1 of 3.mp3', 9600),
]
# The opfs the 09:10Z scan wrote beside a wrong file, naming the record: (path, record)
OPFS = [
    (VR + 'Four - A Divergent Story Collection/Veronica Roth - Four - A Divergent Story Collection.opf', 'K0UczgEACAAJ'),
    (LG + 'Catwings/Ursula K. Le Guin - Catwings.opf', 'QGPZEAAAQBAJ'),
    (TP + "The Science of Discworld III - Darwin's Watch/Terry Pratchett - The Science of Discworld III - Darwin's Watch.opf", 'wzxmQgAACAAJ'),
    (DG + 'Outlander/Diana Gabaldon - Outlander.opf', 'IMlH63ZPShAC'),
    (E + 'Dean Koontz/Innocence - A Novel/Dean Koontz - Innocence - A Novel.opf', 'zTCLswEACAAJ'),
    (RD + 'More Tales of the Unexpected/Roald Dahl - More Tales of the Unexpected.opf', 'qKuOEAAAQBAJ'),
    (RJ + 'Towers of Midnight/Robert Jordan - Towers of Midnight.opf', 'lSybHLQbZ_kC'),
    (RR + 'The Hammer of Thor/Rick Riordan - The Hammer of Thor.opf', 'W4ZDugEACAAJ'),
    (JC + 'The Expanse Origins #2/James S.A. Corey - The Expanse Origins #2.opf', 'VKBoDwAAQBAJ'),
    (GRRM + 'Nightflyers - The Illustrated Edition/George R.R. Martin - Nightflyers - The Illustrated Edition.opf', 'ENRSDwAAQBAJ'),
    (WM + 'Disciple - A Novel from Crosstown to Oblivion/Walter Mosley - Disciple - A Novel from Crosstown to Oblivion.opf', '83Hv_EYvHgEC'),
    (CH + 'A Secret Rage/Charlaine Harris - A Secret Rage.opf', '4bLbswEACAAJ'),
    (CHA + 'A Secret Rage/A Secret Rage and Sweet and Deadly.opf', '4bLbswEACAAJ'),
    (KF + 'Code to Zero/Ken Follett - Code to Zero.opf', 'K3wuAAAACAAJ'),
    (DA + "The Hitchhiker's Guide to the Galaxy/The Ultimate Hitchhiker's Guide to the Galaxy.opf", '4m0Qj9xKksYC'),
    (GRRM + 'Warriors 1/George R.R. Martin - Warriors 1.opf', 'OwTswUGVzVcC'),
    (JG + 'Partners/Partners - John Grisham.opf', 'VNalCwAAQBAJ'),
    (JG + 'Partners/Partners.opf', 'VNalCwAAQBAJ'),
    (ELJ + 'Darker/Darker - E.L. James.opf', '8CzFswEACAAJ'),
]
# Re-delivered copies of a book already in its own folder: (wrong path, the identical copy it duplicates, record, evidence)
DUPS = [(JG + 'Partners/John Grisham - Partners Part %03d of 102.mp3' % n,
         JG + 'Sparring Partners/John Grisham - Sparring Partners Part %03d of 102.mp3' % n, 'VNalCwAAQBAJ',
         'Sparring Partners re-delivered as Partners by grab 9616 ("John Grisham - JB 03.5 - Sparring Partners", 05:29Z); '
         'Sparring Partners/ holds the identical track') for n in range(1, 103)]
DUPS += [(ELJ + 'Darker/E.L. James - Darker Part %d of 3.mp3' % n, ELJ + 'Fifty Shades Darker/E.L. James - Fifty Shades Darker (%d).mp3' % n,
          '8CzFswEACAAJ', 'Fifty Shades Darker delivered as Darker (2017) by grab 9600 ("Fifty Shades 2 - Fifty Shades Darker '
          '(2012) MP3", 05:27Z); Fifty Shades Darker/ holds the identical track') for n in (1, 2, 3)]
SIDECARS = [(JG + 'Partners/Partners - John Grisham.jpg', 'VNalCwAAQBAJ'), (JG + 'Partners/playlist.ll', 'VNalCwAAQBAJ'),
            (ELJ + 'Darker/Darker - E.L. James.jpg', '8CzFswEACAAJ'), (ELJ + 'Darker/playlist.ll', '8CzFswEACAAJ')]
# Folders the scan must not match from: every wrong file's folder that stays, plus the books a re-want would match by title.
IGNORE = sorted({os.path.dirname(old) for _, _, old, _ in REPOINT} | {os.path.dirname(old) for _, _, old in CLEAR} |
                {GRRM + 'Warriors 1', CHA + 'A Secret Rage', JG + 'Sparring Partners', ELJ + 'Fifty Shades Darker'})
COL = {'eBook': ('BookFile', 'BookLibrary', 'Status'), 'AudioBook': ('AudioFile', 'AudioLibrary', 'AudioStatus')}
# Twin records that share the right file (both point at it, as the earlier repairs left them).
TWINS = {'zTCLswEACAAJ': ['opCLDQAAQBAJ'], 'W4ZDugEACAAJ': ['1BeXtAEACAAJ'], '4bLbswEACAAJ': ['vcpmEQAAQBAJ']}
# The earlier repairs already hold an opf under each of these names, so the scan-written ones are held beside it.
OPF_SUFFIX = '.scan-20261007'


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''): h.update(b)
    return h.hexdigest()


def opf_ids(p):
    return re.findall(r'<dc:identifier[^>]*>([^<]*)<', open(p, encoding='utf-8', errors='replace').read())


db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
bad = []
for rec, c, old, new in REPOINT:
    r = db.execute('select %s from books where BookID=?' % c, (rec,)).fetchone()
    if r is None or r[0] != B + old: bad.append(('repoint: %s %s is' % (rec, c), r))
    if not os.path.isfile(B + new): bad.append(('repoint target missing', new))
    other = [x[0] for x in db.execute('select BookID from books where %s=? and BookID<>?' % c, (B + new, rec))]
    if other and other != TWINS.get(rec): bad.append(('repoint target linked by', new, other))
for rec, typ, old in CLEAR + [(r, t, o) for r, t, o, _ in REWANT]:
    f, _, s = COL[typ]
    r = db.execute('select %s,%s from books where BookID=?' % (f, s), (rec,)).fetchone()
    if r is None or r[0] != B + old or r[1] != 'Open': bad.append(('%s %s is' % (rec, typ), r))
for _, typ, _, rid in REWANT:
    if rid:
        r = db.execute('select Status,NZBtitle from wanted where rowid=?', (rid,)).fetchone()
        if r is None or r[0] != 'Processed': bad.append(('block row', rid, r))
for p, rec in OPFS:
    if not os.path.isfile(B + p): bad.append(('opf missing', p))
    elif rec not in opf_ids(B + p): bad.append(('opf names another id', p, opf_ids(B + p)))
    if os.path.exists(H + p + OPF_SUFFIX): bad.append(('hold target exists', p + OPF_SUFFIX))
dup_md5 = {}
for p, twin, rec, _ in DUPS:
    if not os.path.isfile(B + p) or not os.path.isfile(B + twin): bad.append(('dup pair missing', p, twin)); continue
    if os.path.getsize(B + p) != os.path.getsize(B + twin): bad.append(('dup size differs', p)); continue
    m = md5(B + p)
    if m != md5(B + twin): bad.append(('dup md5 differs', p)); continue
    dup_md5[p] = m
    if os.path.exists(H + p): bad.append(('hold target exists', p))
for p, _ in SIDECARS:
    if not os.path.isfile(B + p): bad.append(('sidecar missing', p))
for d in IGNORE:
    if not os.path.isdir(B + d): bad.append(('ignore folder missing', d))
left = {os.path.dirname(p) for p, *_ in DUPS}
for d in left:
    rest = set(os.listdir(B + d)) - {os.path.basename(p) for p, *_ in DUPS + [(q, None, None, None) for q, _ in OPFS + SIDECARS]}
    if any(x.lower().endswith(('.mp3', '.m4b', '.m4a')) for x in rest): bad.append(('audio left after holds', d, sorted(rest)))
print('repoint %d | clear %d | rewant %d | opfs %d | dups %d | sidecars %d | ignore %d' % (
    len(REPOINT), len(CLEAR), len(REWANT), len(OPFS), len(DUPS), len(SIDECARS), len(IGNORE)))
for d in IGNORE: print('  ignore', d, '(present)' if os.path.exists(B + d + '/' + IGNORE_FILE) else '')
if bad:
    for b in bad: print('REFUSE', *b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')

bk = '/config/lazylibrarian.db.pre-scan-durable-20261007'
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


def hold(p, cat, rec, ev, cps, m=None, suffix=''):
    s, d = B + p, H + p + suffix
    m = m or md5(s); z = os.path.getsize(s); mkd(os.path.dirname(d), H)
    os.rename(s, d)
    man.write(json.dumps({'op': 'hold', 'src': p, 'dst': HR + p + suffix, 'md5': m, 'size': z, 'reason': TAG + ev, 'record': rec,
                          'ts': ts()}, ensure_ascii=False) + '\n')
    srt.write(json.dumps({'path': HR + p + suffix, 'size': z, 'md5': m, 'category': cat, 'evidence': ev, 'record': rec,
                          'counterparts': cps}, ensure_ascii=False) + '\n')


for p, rec in OPFS:
    hold(p, 'off_catalog', rec, 'LL opf naming %s that the 2026-10-07 09:10Z library scan wrote beside a wrong file' % rec, [],
         suffix=OPF_SUFFIX)
for p, twin, rec, ev in DUPS:
    hold(p, 'duplicate', rec, ev, [twin], dup_md5[p])
for p, rec in SIDECARS:
    hold(p, 'off_catalog', rec, 'LazyLibrarian sidecar beside the held re-delivered copy', [])
for d in IGNORE:
    f = B + d + '/' + IGNORE_FILE
    if not os.path.exists(f):
        open(f, 'w').close(); os.chown(f, 1000, 1000); os.chmod(f, 0o664)
        man.write(json.dumps({'op': 'write', 'dst': d + '/' + IGNORE_FILE, 'reason': TAG + 'the library scan skips this '
                              'folder, so it never re-links the wrong book in it to a record (delete to undo)', 'record': '',
                              'ts': ts()}) + '\n')
man.close(); srt.close()
dirs = {os.path.dirname(B + p) for p, *_ in OPFS + SIDECARS} | {os.path.dirname(B + p) for p, *_ in DUPS} | {B + d for d in IGNORE}
for d in sorted(dirs | {os.path.dirname(d) for d in dirs}, key=len, reverse=True):
    if os.path.isdir(d): os.utime(d, None)  # hdd-nfs-repl does not bump a folder's mtime on rename; Kavita compares it
with db:
    for rec, c, old, new in REPOINT:
        assert db.execute("update books set %s=?,Status='Open' where BookID=? and %s=?" % (c, c), (B + new, rec, B + old)).rowcount == 1, rec
    for rec, typ, old in CLEAR:
        f, lib, s = COL[typ]
        assert db.execute("update books set %s=NULL,%s=NULL,%s='Skipped' where BookID=? and %s=?" % (f, lib, s, f),
                          (rec, B + old)).rowcount == 1, rec
    for rec, typ, old, rid in REWANT:
        f, lib, _ = COL[typ]
        assert db.execute('update books set %s=NULL,%s=NULL where BookID=? and %s=?' % (f, lib, f), (rec, B + old)).rowcount == 1, rec
        if rid:
            db.execute("""insert into wanted (BookID,NZBurl,NZBtitle,NZBdate,NZBprov,Status,NZBsize,AuxInfo,NZBmode,Source,DownloadID,
              DLResult,Completed,Label) select BookID,NZBurl,NZBtitle,?,NZBprov,'Failed',NZBsize,AuxInfo,NZBmode,NULL,NULL,?,0,''
              from wanted where rowid=?""", (now, 'Blocked by hand 2026-10-07 (OC-035, census): this release delivered another '
                                                 'book, held duplicate (quarantine/crossvolume-2026-10-05)', rid))
max_rowid = db.execute('select max(rowid) from wanted').fetchone()[0]
db.close()
c = configparser.RawConfigParser(); c.read('/config/config.ini'); key = c.get('API', 'api_key')
for rec, typ, _, _ in REWANT:
    u = 'http://localhost:5299/api?' + urllib.parse.urlencode({'apikey': key, 'cmd': 'queueBook', 'id': rec, 'type': typ})
    print('queueBook', rec, typ, urllib.request.urlopen(u, timeout=60).read().decode()[:20])
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
for rec in sorted({r for r, *_ in REPOINT + CLEAR + REWANT}):
    print(db.execute('select BookID,Status,BookFile,AudioStatus,AudioFile from books where BookID=?', (rec,)).fetchone())
print('max wanted rowid', max_rowid)
