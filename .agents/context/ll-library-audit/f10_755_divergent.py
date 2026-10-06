# 2026-10-06, thaynes43/haynesnetwork#755 follow-up: LazyLibrarian rowid 9587 grabbed "Veronica.Roth.The.Divergent" (indexer 16)
# for Divergent's audio (K0UczgEACAAJ, book 1). It is the English trilogy: 1.Divergent, 2.Insurgent, 3.Allegiant subfolders
# (HarperAudio, Emma Galvin, 96 kbps). The post-processor never imported it (no audio at the folder's top level), the queue
# janitor retried the import and then deleted the SABnzbd history job, and LL aborted the snatch (Failed, which now blocks the
# release). The household has no Divergent audio (the Swedish copy was held by the F10 sweep), and 1.Divergent is a clean,
# complete book 1 (tracks 01/39 to 39/39, about 11.2 h), so only that part is imported, through LL's own alternate import (a
# folder named "LL.(<bookid>)"). The rest of the download is held in the cross-volume holding folder for owed check (m):
# the import's source copy and 3.Allegiant as `duplicate` (the library holds both), 2.Insurgent as `off_catalog` (LL's
# Insurgent audio is Skipped); cover images as `off_catalog`. Manifest `src` paths are relative to /data/cephfs-hdd/data/. Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - [--go] < .agents/context/ll-library-audit/f10_755_divergent.py
# Backup first: /config/lazylibrarian.db.pre-divergent-755-20261006.
import os, sys, json, hashlib, time, re, sqlite3, configparser, urllib.request, urllib.parse
B = '/data/cephfs-hdd/data/media/books/'; H = B + 'quarantine/crossvolume-2026-10-05/'; HR = 'quarantine/crossvolume-2026-10-05/'
SUB = 'f10-755/'
U = '/data/cephfs-hdd/data/usenet/complete-k8s/'
D = U + 'lazylibrarian/Veronica.Roth.The.Divergent'
REC = 'K0UczgEACAAJ'
S = U + 'll-import-755/Divergent LL.(' + REC + ')'
GO = '--go' in sys.argv
TAG = 'Divergent trilogy grab 2026-10-06 (#755 follow-up): '
CH = re.compile(r'^Chapter (\d\d) - Divergent by Veronica Roth\.mp3$')

db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
bad = []
w = db.execute('select BookID, AuxInfo, Status, NZBtitle from wanted where rowid=9587').fetchone()
if w != (REC, 'AudioBook', 'Failed', 'Veronica.Roth.The.Divergent'):
    bad.append(('wanted 9587', w))
b = db.execute('select BookName, BookLang, AudioStatus, AudioFile from books where BookID=?', (REC,)).fetchone()
if b != ('Divergent', 'en', 'Wanted', None):
    bad.append(('book', b))
if os.path.exists(B + 'AudioBooks/Veronica Roth/Divergent') or os.path.exists(S):
    bad.append(('target or staging folder already exists',))
parts = sorted(os.listdir(D)) if os.path.isdir(D) else []
if parts != ['1.Divergent', '2.Insurgent', '3.Allegiant']:
    bad.append(('download folder', parts))
else:
    fs = sorted(os.listdir(D + '/1.Divergent'))
    nums = sorted(int(CH.match(f).group(1)) for f in fs if CH.match(f))
    if nums != list(range(1, 40)) or set(fs) - {f for f in fs if CH.match(f)} != {'cover.jpg'}:
        bad.append(('1.Divergent is not tracks 01-39 plus cover.jpg', fs[:3], len(fs)))
al = db.execute('select AudioFile from books where BookID=?', ('mFMG1eUXyfcC',)).fetchone()[0] or ''
if not al.startswith(B + 'AudioBooks/Veronica Roth/Allegiant/') or not os.path.isfile(al):
    bad.append(('Allegiant audio not held', al))
ins = db.execute('select AudioStatus, AudioFile from books where BookID=?', ('BG3P0sFxnT4C',)).fetchone()
if ins != ('Skipped', None):
    bad.append(('Insurgent audio', ins))
print('download parts', parts, '| book', b, '| wanted 9587', w)
if bad:
    for x in bad:
        print('REFUSE', *x)
    sys.exit('refused: nothing changed')
if not GO:
    sys.exit('dry run OK; re-run with --go')

bk = '/config/lazylibrarian.db.pre-divergent-755-20261006'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2); b2.close(); db.close()
os.makedirs(os.path.dirname(S), exist_ok=True)
os.rename(D + '/1.Divergent', S)
c = configparser.RawConfigParser(); c.read('/config/config.ini'); key = c.get('API', 'api_key')
r = urllib.request.urlopen('http://localhost:5299/api?' + urllib.parse.urlencode(
    {'apikey': key, 'cmd': 'importAlternate', 'dir': S, 'library': 'AudioBook', 'wait': 1}), timeout=1800).read().decode()
print('importAlternate', r[:80])
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
st, af = db.execute('select AudioStatus, AudioFile from books where BookID=?', (REC,)).fetchone()
dest = os.path.dirname(af or '')
others = db.execute('select BookID from books where AudioFile like ? and BookID<>?', (dest + '/%', REC)).fetchall() if af else []
n = len([f for f in os.listdir(dest) if f.lower().endswith('.mp3')]) if af and os.path.isdir(dest) else 0
print('book after import', st, (af or '').replace(B, ''), '| mp3s', n, '| other records there', others)
db.close()
if st != 'Open' or not af or not os.path.isfile(af) or n != 39 or others:
    sys.exit('import not as expected: nothing held; the staging folder %s is left for a look' % S)


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for blk in iter(lambda: fh.read(1 << 22), b''):
            h.update(blk)
    return h.hexdigest()


ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
held = [(S, 'usenet/ll-import-755/Divergent LL.(%s)' % REC, 'duplicate', [dest.replace(B, '')],
         'source copy of the imported Divergent audio (LL copies on import)'),
        (D + '/2.Insurgent', 'usenet/lazylibrarian/Veronica.Roth.The.Divergent/2.Insurgent', 'off_catalog', [],
         'Insurgent part of a trilogy grabbed for Divergent; LL Insurgent audio is Skipped'),
        (D + '/3.Allegiant', 'usenet/lazylibrarian/Veronica.Roth.The.Divergent/3.Allegiant', 'duplicate',
         ['AudioBooks/Veronica Roth/Allegiant'], 'Allegiant part of a trilogy grabbed for Divergent; the library holds Allegiant')]
man = open(H + 'manifest.jsonl', 'a'); srt = open(H + 'sort.jsonl', 'a')
for src, rel, cat, cp, ev in held:
    for f in sorted(os.listdir(src)):
        s = src + '/' + f; d = H + SUB + rel + '/' + f; z = os.path.getsize(s); m = md5(s)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        os.rename(s, d)
        man.write(json.dumps({'op': 'hold', 'src': s.replace('/data/cephfs-hdd/data/', ''), 'dst': HR + SUB + rel + '/' + f, 'md5': m,
                              'size': z, 'reason': TAG + ev, 'record': REC, 'ts': ts()}) + '\n')
        audio = f.lower().endswith(('.mp3', '.m4b', '.m4a', '.flac'))  # the purge checks a duplicate's counterpart by kind
        srt.write(json.dumps({'path': HR + SUB + rel + '/' + f, 'size': z, 'md5': m, 'category': cat if audio else 'off_catalog',
                              'evidence': ev + ', #755', 'record': REC, 'counterparts': cp if audio else []}) + '\n')
    os.rmdir(src)
for x in (D, os.path.dirname(S)):
    os.rmdir(x)
    man.write(json.dumps({'op': 'rmdir', 'src': x.replace('/data/cephfs-hdd/data/', ''), 'reason': TAG + 'emptied download folder',
                          'record': '', 'ts': ts()}) + '\n')
man.close(); srt.close()
print('held', sum(len(os.listdir(H + SUB + rel)) for _, rel, *_ in held), 'files; removed', D, 'and', os.path.dirname(S))
