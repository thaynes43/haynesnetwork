# Follow-up to fix_census_scan_1007.py (2026-10-07): the verifying library scan (13:26-14:05Z) kept every marked folder
# alone, but two records had more wrong folders than the first script marked. A library sweep for opfs naming any
# repaired record outside its own folder found them:
#   VKBoDwAAQBAJ The Expanse Origins #3: the 09:10Z scan had also written opfs naming it in "The Expanse Origins - James
#     Holden/" (#1 of 4) and "The Expanse Origins - Amos Burton/" (#4 of 4, epub OPF title "The Expanse Origins #4 (of
#     4)"); the verifying scan then linked #3 to the Amos Burton epub. Re-point to #3's own epub, hold both opfs, mark both.
#   uaBUIGS551cC Redwall (audio): the 09:10Z scan re-wrote "Eulalia!/Redwall.opf" (09:37Z), which fix_census_795.py had
#     held. Redwall is now Open on a new download in Redwall/ (grab 9618, OC-036 checks its content); the opf in Eulalia!/
#     would let a later scan link Eulalia! back. Hold it, mark Eulalia!/.
# Run INSIDE the LazyLibrarian pod (dry run without --go):
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - [--go] < .agents/context/ll-library-audit/fix_census_scan_1007b.py
import os, re, sys, json, hashlib, time, sqlite3

B = '/data/cephfs-hdd/data/media/books/'
HR = 'quarantine/crossvolume-2026-10-05/'
H = B + HR
GO = '--go' in sys.argv
TAG = 'OC-031/032/037 2026-10-07 (follow-up): '
SUFFIX = '.scan-20261007'
ts = lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
JC = 'EBooks/James S.A. Corey/'
AMOS, HOLDEN = JC + 'The Expanse Origins - Amos Burton/', JC + 'The Expanse Origins - James Holden/'
EUL = 'AudioBooks/Brian Jacques/Eulalia!/'
REPOINT = ('VKBoDwAAQBAJ', AMOS + 'James S.A. Corey - The Expanse Origins - Amos Burton.epub',
           JC + 'The Expanse Origins #3/James S.A. Corey - The Expanse Origins #3.epub')
OPFS = [(AMOS + 'James S.A. Corey - The Expanse Origins - Amos Burton.opf', 'VKBoDwAAQBAJ'),
        (HOLDEN + 'James S.A. Corey - The Expanse Origins - James Holden.opf', 'VKBoDwAAQBAJ'),
        (EUL + 'Redwall.opf', 'uaBUIGS551cC')]
IGNORE = [AMOS.rstrip('/'), HOLDEN.rstrip('/'), EUL.rstrip('/')]


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 22), b''): h.update(b)
    return h.hexdigest()


db = sqlite3.connect('/config/lazylibrarian.db', timeout=60)
bad = []
rec, old, new = REPOINT
r = db.execute('select BookFile from books where BookID=?', (rec,)).fetchone()
if r is None or r[0] != B + old: bad.append(('VKBo is', r))
if not os.path.isfile(B + new): bad.append(('target missing', new))
for p, i in OPFS:
    if not os.path.isfile(B + p): bad.append(('opf missing', p))
    elif i not in re.findall(r'<dc:identifier[^>]*>([^<]*)<', open(B + p, encoding='utf-8', errors='replace').read()):
        bad.append(('opf names another id', p))
    if os.path.exists(H + p + SUFFIX): bad.append(('hold target exists', p))
for d in IGNORE:
    if not os.path.isdir(B + d): bad.append(('folder missing', d))
print('repoint 1 | opfs %d | ignore %d' % (len(OPFS), len(IGNORE)))
if bad:
    for b in bad: print('REFUSE', *b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')
bk = '/config/lazylibrarian.db.pre-scan-durable-b-20261007'
assert not os.path.exists(bk)
b2 = sqlite3.connect(bk); db.backup(b2); assert b2.execute('pragma integrity_check').fetchone()[0] == 'ok'; b2.close()
man = open(H + 'manifest.jsonl', 'a'); srt = open(H + 'sort.jsonl', 'a')
for p, i in OPFS:
    s, d = B + p, H + p + SUFFIX
    m, z = md5(s), os.path.getsize(s)
    x = os.path.dirname(d)
    if not os.path.isdir(x):
        os.makedirs(x)
        while x.rstrip('/') != H.rstrip('/'): os.chown(x, 1000, 1000); x = os.path.dirname(x)
    os.rename(s, d)
    ev = 'LL opf naming %s that the 2026-10-07 09:10Z library scan wrote beside a wrong file' % i
    man.write(json.dumps({'op': 'hold', 'src': p, 'dst': HR + p + SUFFIX, 'md5': m, 'size': z, 'reason': TAG + ev,
                          'record': i, 'ts': ts()}, ensure_ascii=False) + '\n')
    srt.write(json.dumps({'path': HR + p + SUFFIX, 'size': z, 'md5': m, 'category': 'off_catalog', 'evidence': ev,
                          'record': i, 'counterparts': []}, ensure_ascii=False) + '\n')
for d in IGNORE:
    f = B + d + '/.ll_ignore'
    if not os.path.exists(f):
        open(f, 'w').close(); os.chown(f, 1000, 1000); os.chmod(f, 0o664)
        man.write(json.dumps({'op': 'write', 'dst': d + '/.ll_ignore', 'reason': TAG + 'the library scan skips this folder, so '
                              'it never re-links the wrong book in it to a record (delete to undo)', 'record': '', 'ts': ts()}) + '\n')
    os.utime(B + d, None)
man.close(); srt.close()
with db:
    assert db.execute("update books set BookFile=? where BookID=? and BookFile=?", (B + new, rec, B + old)).rowcount == 1
db.close()
db = sqlite3.connect('file:/config/lazylibrarian.db?mode=ro', uri=True)
print(db.execute('select BookID,Status,BookFile from books where BookID=?', (rec,)).fetchone())
