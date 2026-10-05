# F10 azw3/mobi coverage sweep, follow-up (2026-10-05 ~23:30Z): the two eBook files that could not be read are broken books, so
# they go to the cross-volume holding folder (manifest.jsonl op "hold" with md5, sort.jsonl category "corrupt", which
# crossvolume_purge.py deletes like the other four categories). Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/f10_corrupt_hold.py        # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/f10_corrupt_hold.py   # move
# - C.S. Lewis, That Hideous Strength .mobi (168,112 bytes): no BOOKMOBI/TEXtREAd magic and a record table that points far past
#   the end of the file; the folder's only file. LL record iLQtvgAACAAJ (English) already reads Wanted with no BookFile, so the
#   eBook stays wanted and LL needs no write (no DB backup taken).
# - Charlaine Harris, Grave Secret .mobi (770,754 bytes): 84% zero bytes, no mobi header. Two English epubs beside it; LL
#   1IiNEAAAQBAJ links the epub and Kavita (series 495 and 1739) reads the epubs only.
# Refuses if a file changed size, is now a valid mobi, an LL book row names it, or the English epub that stays is missing.
# Touches each source folder afterwards (hdd-nfs-repl: a rename does not bump it). Undo: move dst back to src, drop the sort row.
import os,sys,json,hashlib,time,sqlite3
B='/data/cephfs-hdd/data/media/books/'; HR='quarantine/crossvolume-2026-10-05/'; H=B+HR
GO='--go' in sys.argv
E=[('EBooks/C.S. Lewis/That Hideous Strength/C.S. Lewis - That Hideous Strength.mobi',168112,'iLQtvgAACAAJ',
    'invalid mobi (no BOOKMOBI header, record table past end of file); the only eBook file in the folder; LL eBook stays Wanted (English record)',[]),
   ('EBooks/Charlaine Harris/Grave Secret/Grave Secret - Charlaine Harris.mobi',770754,'1IiNEAAAQBAJ',
    'truncated mobi (84% zero bytes, no mobi header); English: two epubs in the same folder, LL links one, Kavita reads both',
    ['EBooks/Charlaine Harris/Grave Secret/Grave Secret - Charlaine Harris.epub','EBooks/Charlaine Harris/Grave Secret/Charlaine Harris - Grave Secret.epub'])]
db=sqlite3.connect('file:/config/lazylibrarian.db?mode=ro',uri=True)
bad=[]
for s,z,rec,ev,keep in E:
    p=B+s
    if not os.path.isfile(p): bad.append(('missing',s)); continue
    if os.path.getsize(p)!=z: bad.append(('size',s)); continue
    raw=open(p,'rb').read()
    if raw[60:68] in (b'BOOKMOBI',b'TEXtREAd'): bad.append(('now a valid mobi',s))
    if db.execute('select count(*) from books where BookFile=? or AudioFile=?',(p,p)).fetchone()[0]: bad.append(('LL row names it',s))
    for k in keep:
        if not os.path.isfile(B+k): bad.append(('English keeper missing',k))
r=db.execute("select BookLang,Status,BookFile from books where BookID='iLQtvgAACAAJ'").fetchone()
if r!=('en','Wanted',None): bad.append(('LL record iLQtvgAACAAJ is',r))
r=db.execute("select BookFile from books where BookID='1IiNEAAAQBAJ'").fetchone()
if r[0]!=B+'EBooks/Charlaine Harris/Grave Secret/Grave Secret - Charlaine Harris.epub': bad.append(('LL 1IiNEAAAQBAJ links',r))
print('files',len(E))
if bad:
    for b in bad: print('REFUSE',*b)
    sys.exit('refused: nothing moved')
if not GO: sys.exit('dry run OK; re-run with --go')
man=open(H+'manifest.jsonl','a'); srt=open(H+'sort.jsonl','a')
for s,z,rec,ev,keep in E:
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
    man.write(json.dumps({'op':'hold','src':s,'dst':dst,'md5':md5,'size':z,'reason':'F10 2026-10-05 azw3/mobi sweep: corrupt file: '+ev,'record':rec,'ts':ts},ensure_ascii=False)+'\n')
    srt.write(json.dumps({'path':dst,'size':z,'md5':md5,'category':'corrupt','evidence':ev,'record':rec,'counterparts':[]},ensure_ascii=False)+'\n')
    os.utime(os.path.dirname(src),None)
man.close(); srt.close()
print('moved',len(E),'files; folders touched')
