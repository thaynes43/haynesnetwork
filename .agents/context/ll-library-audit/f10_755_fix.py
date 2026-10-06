# 2026-10-06, thaynes43/haynesnetwork#755: two foreign editions the language replay found still in the library, held the
# F10 way. Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - [--go] < .agents/context/ll-library-audit/f10_755_fix.py
# - Queen Charlotte audio (CQh5EAAAQBAJ): LL grabbed "Julia Quinn - Queen Charlotte-AUDiOBOOK-WEB-SE-2023-CRAViNGS iNT" again at
#   05:20Z (rowid 9589). Its mp3 has the md5 of the Swedish file the F10 sweep held (whisper sv twice); the F10 sweep wrote no
#   block row for it because that copy had no wanted row. Whole folder held, LL audio blanked and re-wanted, rowid 9589 blocked.
# - Artemis Fowl and the Atlantis Complex eBook (mNzNCHhqFwcC): rowid 1989 "...Atlantis.Complex.2016.SWEDiSH.RETAiL.ePub..."
#   (2026-07-21) delivered the Swedish edition ("Artemis Fowl 7 - Atlantissyndromet", OPF sv, text sv), linked since. Whole
#   folder held, LL eBook blanked and re-wanted, rowid 1989 blocked.
# Holds go under the cross-volume holding folder (manifest.jsonl + sort.jsonl, foreign_f10) for owed check (m)'s purge, in a
# subfolder f10-755/ because the earlier Queen Charlotte hold already uses its path. Backup first:
# /config/lazylibrarian.db.pre-f10-755-20261006.
import os, sys, json, hashlib, time, sqlite3, configparser, urllib.request, urllib.parse
B = '/data/cephfs-hdd/data/media/books/'; H = B + 'quarantine/crossvolume-2026-10-05/'; HR = 'quarantine/crossvolume-2026-10-05/'
SUB = 'f10-755/'
GO = '--go' in sys.argv
TAG = 'F10 follow-up 2026-10-06 (#755): '
SV_MD5 = '71afe2c9c905f4e0ffad2d7244d14d3d'  # the Swedish Queen Charlotte mp3 held by the F10 sweep (manifest.jsonl)
# (folder, LL record, LL format, the grab that delivered it, evidence, expected files)
P = [
    ('AudioBooks/Julia Quinn/Queen Charlotte', 'CQh5EAAAQBAJ', 'AudioBook', 9589,
     'Swedish edition (CRAViNGS WEB-SE single mp3, md5 of the F10-held file: whisper sv twice)', 5),
    ('EBooks/Eoin Colfer/Artemis Fowl and the Atlantis Complex', 'mNzNCHhqFwcC', 'eBook', 1989,
     'Swedish edition (DECiPHER SWEDiSH epub "Artemis Fowl 7 - Atlantissyndromet", OPF sv, text sv)', 3),
]


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
bad = []; plan = []
for folder, rec, aux, rid, ev, n in P:
    fs = sorted(os.listdir(B + folder))
    if len(fs) != n:
        bad.append(('files %d, expected %d' % (len(fs), n), folder))
    col = 'AudioFile' if aux == 'AudioBook' else 'BookFile'
    lang, linked = db.execute(f'select BookLang, {col} from books where BookID=?', (rec,)).fetchone()
    if lang != 'en' or not (linked or '').startswith(B + folder + '/'):
        bad.append(('LL record', rec, lang, linked))
    refs = db.execute('select BookID from books where BookFile like ? or AudioFile like ?', (B + folder + '/%',) * 2).fetchall()
    if [r[0] for r in refs] != [rec]:
        bad.append(('LL refs', folder, refs))
    w = db.execute('select BookID, AuxInfo, Status from wanted where rowid=?', (rid,)).fetchone()
    if w != (rec, aux, 'Processed'):
        bad.append(('grab row', rid, w))
    if os.path.exists(H + SUB + folder):
        bad.append(('already held', folder))
    for f in fs:
        plan.append((folder + '/' + f, rec, ev if f == os.path.basename(linked or '') else 'sidecar of the ' + ev.split(' (')[0]))
qc = B + P[0][0] + '/Julia Quinn - Queen Charlotte.mp3'
if not os.path.isfile(qc) or md5(qc) != SV_MD5:
    bad.append(('Queen Charlotte mp3 is not the held Swedish file', qc))
for p, rec, ev in plan:
    print('hold', p, '|', rec, '|', ev[:70])
if bad:
    for b in bad:
        print('REFUSE', *b)
    sys.exit('refused: nothing changed')
if not GO:
    sys.exit('dry run OK; re-run with --go')
bk = '/config/lazylibrarian.db.pre-f10-755-20261006'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2); b2.close()
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
man = open(H + 'manifest.jsonl', 'a'); srt = open(H + 'sort.jsonl', 'a')
for p, rec, ev in plan:
    s = B + p; d = H + SUB + p; m = md5(s); z = os.path.getsize(s)
    dd = os.path.dirname(d)
    if not os.path.isdir(dd):
        os.makedirs(dd); x = dd
        while x.rstrip('/') != H.rstrip('/'):
            os.chown(x, 1000, 1000); x = os.path.dirname(x)
    os.rename(s, d)
    man.write(json.dumps({'op': 'hold', 'src': p, 'dst': HR + SUB + p, 'md5': m, 'size': z, 'reason': TAG + ev, 'record': rec,
                          'ts': ts()}, ensure_ascii=False) + '\n')
    srt.write(json.dumps({'path': HR + SUB + p, 'size': z, 'md5': m, 'category': 'foreign_f10', 'evidence': ev + ', F10 #755',
                          'record': rec, 'counterparts': []}, ensure_ascii=False) + '\n')
for folder, *_ in P:
    os.rmdir(B + folder)
    os.utime(os.path.dirname(B + folder), None)  # NFS: a rename does not bump the parent's mtime (Kavita, Audiobookshelf)
    man.write(json.dumps({'op': 'rmdir', 'src': folder, 'reason': TAG + 'emptied foreign-edition folder', 'record': '',
                          'ts': ts()}) + '\n')
man.close(); srt.close()
now = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
with db:
    for folder, rec, aux, rid, ev, n in P:
        if aux == 'AudioBook':
            db.execute('update books set AudioFile=NULL, AudioLibrary=NULL where BookID=?', (rec,))
        else:
            db.execute('update books set BookFile=NULL, BookLibrary=NULL where BookID=?', (rec,))
        db.execute("""insert into wanted (BookID,NZBurl,NZBtitle,NZBdate,NZBprov,Status,NZBsize,AuxInfo,NZBmode,Source,DownloadID,DLResult,
          Completed,Label) select BookID,NZBurl,NZBtitle,?,NZBprov,'Failed',NZBsize,AuxInfo,NZBmode,NULL,NULL,?,0,'' from wanted where rowid=?""",
                   (now, 'Blocked by hand 2026-10-06 (#755): this release delivered the Swedish edition, held in '
                         'quarantine/crossvolume-2026-10-05/f10-755', rid))
db.close()
c = configparser.RawConfigParser(); c.read('/config/config.ini'); key = c.get('API', 'api_key')
for folder, rec, aux, rid, ev, n in P:
    print('queueBook', rec, aux, urllib.request.urlopen('http://localhost:5299/api?' + urllib.parse.urlencode(
        {'apikey': key, 'cmd': 'queueBook', 'id': rec, 'type': aux}), timeout=60).read().decode()[:5])
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
for folder, rec, aux, rid, ev, n in P:
    print(rec, db.execute('select BookLang, Status, AudioStatus, BookFile, AudioFile from books where BookID=?', (rec,)).fetchone())
print('block rows', db.execute("select rowid, BookID, AuxInfo, NZBtitle from wanted where DLResult like 'Blocked by hand 2026-10-06 (#755)%'").fetchall())
