# 2026-10-06, thaynes43/haynesnetwork#755 follow-up: the German "The Serpent and the Wings of Night" audiobook (LL drNVzwEACAAJ,
# English record) found while holding the Divergent leftovers. Rowid 9550 (2026-10-05 22:36Z) imported
# '(01/17) - Description - "Carissa Broadbent - Crowns of Nyaxia 01 - The Serpent and the Wings of Night (UngekÃ¼rzt).par2"':
# 245 tracks "Kapitel N", album "... (Ungekürzt)", (C) Hörbuch Hamburg HHV GmbH, publisher TIDE exklusiv, narrator Vanida
# Karun. The F10 sweep (23:00Z) missed it; the indexer's mojibake slipped past REJECT_AUDIO (fixed in the resultlist.py
# overlay, haynes-ops #3433). Whole folder held F10-style (foreign_f10, for owed check (m)), LL audio blanked and re-wanted,
# the release blocked by a Failed row that copies 9550 under the link's own title (9550 stores "(01"). Nobody had
# progress on the Audiobookshelf item. Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - [--go] < .agents/context/ll-library-audit/f10_755_serpent.py
# Backup first: /config/lazylibrarian.db.pre-serpent-755-20261006.
import os, sys, json, hashlib, time, sqlite3, configparser, urllib.request, urllib.parse
from urllib.parse import urlsplit, parse_qs
B = '/data/cephfs-hdd/data/media/books/'; H = B + 'quarantine/crossvolume-2026-10-05/'; HR = 'quarantine/crossvolume-2026-10-05/'
SUB = 'f10-755/'
F = 'AudioBooks/Carissa Broadbent/The Serpent and the Wings of Night'
REC = 'drNVzwEACAAJ'
EV = ('German edition (245 tracks "Kapitel N", album "(Ungekürzt)", Hörbuch Hamburg / TIDE exklusiv, narrator Vanida Karun; '
      'grab 9550)')
GO = '--go' in sys.argv


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
bad = []
fs = sorted(os.listdir(B + F))
mp3 = [f for f in fs if f.lower().endswith('.mp3')]
if len(mp3) != 245 or len(fs) != 249:
    bad.append(('files', len(mp3), len(fs)))
b = db.execute('select BookLang, AudioStatus, AudioFile from books where BookID=?', (REC,)).fetchone()
if b[0] != 'en' or b[1] != 'Open' or not (b[2] or '').startswith(B + F + '/'):
    bad.append(('LL record', b))
refs = db.execute('select BookID from books where BookFile like ? or AudioFile like ?', (B + F + '/%',) * 2).fetchall()
if [r[0] for r in refs] != [REC]:
    bad.append(('LL refs', refs))
w = db.execute('select BookID, AuxInfo, Status, NZBurl from wanted where rowid=9550').fetchone()
title = parse_qs(urlsplit(w[3] or '').query).get('file', [''])[0] if w else ''
if not w or w[:3] != (REC, 'AudioBook', 'Processed') or 'Serpent and the Wings of Night' not in title:
    bad.append(('grab row 9550', w and w[:3], title[:60]))
if os.path.exists(H + SUB + F):
    bad.append(('already held',))
print('hold', len(fs), 'files of', F, '| block title', title[:110])
if bad:
    for x in bad:
        print('REFUSE', *x)
    sys.exit('refused: nothing changed')
if not GO:
    sys.exit('dry run OK; re-run with --go')
bk = '/config/lazylibrarian.db.pre-serpent-755-20261006'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2); b2.close()
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
man = open(H + 'manifest.jsonl', 'a'); srt = open(H + 'sort.jsonl', 'a')
os.makedirs(H + SUB + F, exist_ok=True)
linked = os.path.basename(b[2])
for f in fs:
    s = B + F + '/' + f; d = H + SUB + F + '/' + f; z = os.path.getsize(s); m = md5(s)
    ev = EV if f.lower().endswith('.mp3') else 'sidecar of the German edition'
    os.rename(s, d)
    man.write(json.dumps({'op': 'hold', 'src': F + '/' + f, 'dst': HR + SUB + F + '/' + f, 'md5': m, 'size': z,
                          'reason': 'F10 follow-up 2026-10-06 (#755): ' + ev, 'record': REC, 'ts': ts()}, ensure_ascii=False) + '\n')
    srt.write(json.dumps({'path': HR + SUB + F + '/' + f, 'size': z, 'md5': m, 'category': 'foreign_f10', 'evidence': ev + ', F10 #755',
                          'record': REC, 'counterparts': []}, ensure_ascii=False) + '\n')
os.rmdir(B + F)
os.utime(os.path.dirname(B + F), None)
man.write(json.dumps({'op': 'rmdir', 'src': F, 'reason': 'F10 follow-up 2026-10-06 (#755): emptied foreign-edition folder', 'record': '',
                      'ts': ts()}) + '\n')
man.close(); srt.close()
now = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
with db:
    db.execute('update books set AudioFile=NULL, AudioLibrary=NULL where BookID=?', (REC,))
    db.execute("""insert into wanted (BookID,NZBurl,NZBtitle,NZBdate,NZBprov,Status,NZBsize,AuxInfo,NZBmode,Source,DownloadID,DLResult,
      Completed,Label) select BookID,NZBurl,?,?,NZBprov,'Failed',NZBsize,AuxInfo,NZBmode,NULL,NULL,?,0,'' from wanted where rowid=9550""",
               (title, now, 'Blocked by hand 2026-10-06 (#755): this release delivered the German edition, held in '
                            'quarantine/crossvolume-2026-10-05/f10-755'))
db.close()
c = configparser.RawConfigParser(); c.read('/config/config.ini')
print('queueBook', urllib.request.urlopen('http://localhost:5299/api?' + urllib.parse.urlencode(
    {'apikey': c.get('API', 'api_key'), 'cmd': 'queueBook', 'id': REC, 'type': 'AudioBook'}), timeout=60).read().decode()[:5])
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
print(REC, db.execute('select BookLang, Status, AudioStatus, AudioFile from books where BookID=?', (REC,)).fetchone())
print('block row', db.execute("select rowid, AuxInfo, NZBtitle from wanted where BookID=? and DLResult like 'Blocked by hand 2026-10-06%'",
                               (REC,)).fetchall())
