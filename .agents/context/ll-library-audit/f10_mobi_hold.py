# F10 azw3/mobi coverage sweep, 2026-10-05 (~23:55Z): Kavita cannot read azw3/mobi, so the language sweeps never saw them.
# All 446 azw3/mobi files under books/EBooks were read from content (mobi.extract text sample + EXTH language/publisher; PalmDOC
# fallback for the few the unpacker rejects; the four Expanse Origins comics are page images, read by eye) and classified by
# stopword ratio. 444 are English (0.39-0.51 English stopword share, next language <= 0.11). Confirmed foreign: these two.
# Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/f10_mobi_hold.py        # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/f10_mobi_hold.py   # move
# Moves each file to books/quarantine/crossvolume-2026-10-05/ (manifest.jsonl op "hold" with md5, sort.jsonl category
# foreign_f10), so owed check (m)'s crossvolume_purge.py deletes them. Refuses if a file changed size, an LL book row names
# it, or the English copy that stays is missing. Touches the source folder afterwards (hdd-nfs-repl: a rename does not bump it).
# No LL record pointed at either file (LL links the English epub), so no LL write and no backup was needed.
# Undo: move each row's dst back to src and drop its sort.jsonl row.
import os,sys,json,hashlib,time,sqlite3
B='/data/cephfs-hdd/data/media/books/'; HR='quarantine/crossvolume-2026-10-05/'; H=B+HR
GO='--go' in sys.argv
D='EBooks/Tahereh Mafi/These Infinite Threads/'
EV='German edition "This Woven Kingdom 02 - These Infinite Threads" (cbj, EXTH language de, text de, stopwords de 0.42)'
EN='English: HarperCollins epub x2 in the same folder (OPF en, text en), LL links one'
E=[(D+'These Infinite Threads - Tahereh Mafi.mobi',4515284,'PyRvEAAAQBAJ'),(D+'These Infinite Threads - Tahereh Mafi.azw3',2221120,'PyRvEAAAQBAJ')]
KEEP=[D+'These Infinite Threads - Tahereh Mafi.epub',D+'Tahereh Mafi - These Infinite Threads.epub']
db=sqlite3.connect('file:/config/lazylibrarian.db?mode=ro',uri=True)
bad=[]
for s,z,rec in E:
    if not os.path.isfile(B+s): bad.append(('missing',s)); continue
    if os.path.getsize(B+s)!=z: bad.append(('size',s))
    if db.execute('select count(*) from books where BookFile=? or AudioFile=?',(B+s,B+s)).fetchone()[0]: bad.append(('LL row names it',s))
for k in KEEP:
    if not os.path.isfile(B+k): bad.append(('English keeper missing',k))
print('files',len(E))
if bad:
    for b in bad: print('REFUSE',*b)
    sys.exit('refused: nothing moved')
if not GO: sys.exit('dry run OK; re-run with --go')
man=open(H+'manifest.jsonl','a'); srt=open(H+'sort.jsonl','a')
for s,z,rec in E:
    src=B+s; dst=HR+s; d=B+dst
    assert os.path.isfile(src) and not os.path.exists(d),s
    h=hashlib.md5()
    with open(src,'rb') as fh:
        for b in iter(lambda: fh.read(1<<22),b''): h.update(b)
    md5=h.hexdigest(); dd=os.path.dirname(d)
    if not os.path.isdir(dd):
        os.makedirs(dd); x=dd
        while x.rstrip('/')!=H.rstrip('/'): os.chown(x,1000,1000); x=os.path.dirname(x)
    os.rename(src,d)
    ts=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    man.write(json.dumps({'op':'hold','src':s,'dst':dst,'md5':md5,'size':z,'reason':'F10 2026-10-05 azw3/mobi sweep: '+EV+'; '+EN,'record':rec,'ts':ts},ensure_ascii=False)+'\n')
    srt.write(json.dumps({'path':dst,'size':z,'md5':md5,'category':'foreign_f10','evidence':EV+', F10; '+EN,'record':rec,'counterparts':[]},ensure_ascii=False)+'\n')
man.close(); srt.close()
os.utime(B+D,None)
print('moved',len(E),'files; folder touched')
