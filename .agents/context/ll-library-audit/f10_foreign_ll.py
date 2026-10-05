# F10 foreign-edition sweep, 2026-10-05, LazyLibrarian side (run after f10_foreign_hold.py --go). Run INSIDE the LL pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - [--go] < .agents/context/ll-library-audit/f10_foreign_ll.py
# Backup taken first: /config/lazylibrarian.db.pre-f10-foreign-20261005 (sqlite backup API, integrity ok).
# One transaction with preconditions (each row must read exactly the old value), then the status changes through LL's own
# API (queueBook / unqueueBook). Re-point = the record linked a moved file and an English copy of that format is held;
# blank = no English copy held (re-want an English record, Skip a foreign-edition record). Undo: restore the old values
# printed below (or copy the backup back with LL stopped) and delete the two block rows (rowid > 9547, DLResult 'Blocked by hand 2026-10-05 (F10').
import sqlite3,sys,time,os,json,configparser,urllib.request,urllib.parse
B='/data/cephfs-hdd/data/media/books/'
GO='--go' in sys.argv
now=time.strftime('%Y-%m-%d %H:%M:%S',time.gmtime())
CP='EBooks/Christopher Paolini/'; SG='Stephanie Garber/'
# (BookID, field, old value (path under books/ or None), new value)
PTR=[
 ('43CqLq7TkroC','BookFile',CP+'Brisingr/Brisingr - Christopher Paolini.epub',CP+'Brisingr/Brisingr - Christopher Paolini.azw3'),
 ('mN6LEAAAQBAJ','BookFile',CP+'Fractal Noise/Fractal Noise - Christopher Paolini.epub',CP+'Fractal Noise - Is humanity no longer alone! They’ll risk everything to find out/Christopher Paolini - Fractal Noise - Is humanity no longer alone! They’ll risk everything to find out.epub'),
 ('mN6LEAAAQBAJ','AudioFile','AudioBooks/Christopher Paolini/Fractal Noise/001 - Kapitel 1.mp3','AudioBooks/Christopher Paolini/Fractal Noise/Fractal Noise - Christopher Paolini.m4b'),
 ('GOhLAQAACAAJ','BookFile','EBooks/Walter Mosley/Karma/Karma - Walter Mosley.epub','EBooks/Walter Mosley/Karma/Karma - Walter Mosley.mobi'),
 ('Y-41Q9zk32kC','BookFile','EBooks/Brandon Sanderson/The Well of Ascension/The Well of Ascension - Brandon Sanderson.epub','EBooks/Brandon Sanderson/The Well of Ascension/Brandon Sanderson - The Well of Ascension.epub'),
 ('X9q_7-nWisgC','BookFile','EBooks/Brandon Sanderson/The Hero of Ages/The Hero of Ages - Brandon Sanderson.epub','EBooks/Brandon Sanderson/The Hero of Ages/Brandon Sanderson - The Hero of Ages.epub'),
 # Wanted with no file although English copies are held (the German audio in the folder hid them): link them, Open.
 ('7_8iEAAAQBAJ','BookFile',None,'EBooks/'+SG+'Once Upon a Broken Heart/Once Upon a Broken Heart - Stephanie Garber.azw3'),
 ('7_8iEAAAQBAJ','AudioFile',None,'AudioBooks/'+SG+'Once Upon a Broken Heart/Once upon a Broken Heart.m4b'),
 ('ZHRUEAAAQBAJ','BookFile',None,'EBooks/'+SG+'The Ballad of Never After/The Ballad of Never After - Stephanie Garber.azw3'),
 ('ZHRUEAAAQBAJ','AudioFile',None,'AudioBooks/'+SG+'The Ballad of Never After/The Ballad of Never After - Stephanie Garber.m4b'),
 # blank: the moved file was the record's only eBook
 ('BL6LDQAAQBAJ','BookFile','EBooks/Tom Clancy/Dead or Alive/Dead or Alive - Tom Clancy.epub',None),
 ('mPGNzQEACAAJ','BookFile','EBooks/Herman Melville/Israel Potter/Israel Potter - Herman Melville.epub',None),
 ('hN-yEAAAQBAJ','BookFile',CP+'Murtagh - Eine dunkle Bedrohung/Murtagh - Eine dunkle Bedrohung - Christopher Paolini.epub',None),
 ('PitFPgAACAAJ','BookFile','EBooks/Isaac Asimov/Azazel/Azazel - Isaac Asimov.epub',None),
]
OPEN={('7_8iEAAAQBAJ','Status'),('7_8iEAAAQBAJ','AudioStatus'),('ZHRUEAAAQBAJ','Status'),('ZHRUEAAAQBAJ','AudioStatus')}
API=[('BL6LDQAAQBAJ','queueBook','eBook'),('mPGNzQEACAAJ','queueBook','eBook'),
     ('hN-yEAAAQBAJ','unqueueBook','eBook'),('PitFPgAACAAJ','unqueueBook','eBook'),('CyO6zwEACAAJ','unqueueBook','eBook')]
BLOCK=[(114,'German'),(96,'Danish')]  # the grabs that delivered the moved Dead or Alive / Israel Potter editions
EXPECT_LANG={'BL6LDQAAQBAJ':'en','mPGNzQEACAAJ':'en','hN-yEAAAQBAJ':'de','PitFPgAACAAJ':'es','CyO6zwEACAAJ':'es'}
db=sqlite3.connect('/config/lazylibrarian.db',timeout=60)
def get(i,f): return db.execute('select %s from books where BookID=?'%f,(i,)).fetchone()[0]
bad=[]
for i,f,old,new in PTR:
    cur=get(i,f); o=B+old if old else None
    if cur!=o: bad.append(('%s %s is %r, expected %r'%(i,f,cur,o)))
    if new and not os.path.isfile(B+new): bad.append(('target missing',new))
    if old and os.path.exists(B+old): bad.append(('old file still in place',old))
for i,lang in EXPECT_LANG.items():
    if get(i,'BookLang')!=lang: bad.append(('%s BookLang %r != %r'%(i,get(i,'BookLang'),lang)))
for i,f in OPEN:
    if get(i,f)!='Wanted': bad.append(('%s %s is %r, expected Wanted'%(i,f,get(i,f))))
for rid,_ in BLOCK:
    r=db.execute('select BookID,Status,AuxInfo from wanted where rowid=?',(rid,)).fetchone()
    if r[0] not in ('BL6LDQAAQBAJ','mPGNzQEACAAJ') or r[1]!='Processed' or r[2]!='eBook': bad.append(('block source',rid,r))
if bad:
    for b in bad: print('REFUSE',b)
    sys.exit('refused: nothing written')
print('preconditions OK:',len(PTR),'pointer changes,',len(OPEN),'Wanted->Open,',len(API),'API status changes,',len(BLOCK),'block rows')
if not GO: sys.exit('dry run; re-run with --go')
with db:
    for i,f,old,new in PTR:
        lib='BookLibrary' if f=='BookFile' else 'AudioLibrary'
        if new is None: db.execute('update books set %s=NULL,%s=NULL where BookID=?'%(f,lib),(i,))
        elif old is None: db.execute('update books set %s=?,%s=? where BookID=?'%(f,lib),(B+new,now,i))
        else: db.execute('update books set %s=? where BookID=?'%f,(B+new,i))
    for i,f in OPEN: db.execute("update books set %s='Open' where BookID=?"%f,(i,))
    for rid,lang in BLOCK:
        db.execute("""insert into wanted (BookID,NZBurl,NZBtitle,NZBdate,NZBprov,Status,NZBsize,AuxInfo,NZBmode,Source,DownloadID,DLResult,Completed,Label)
          select BookID,NZBurl,NZBtitle,?,NZBprov,'Failed',NZBsize,AuxInfo,NZBmode,NULL,NULL,?,0,'' from wanted where rowid=?""",
          (now,'Blocked by hand 2026-10-05 (F10 foreign-edition sweep): this release delivered the %s edition, held in quarantine/crossvolume-2026-10-05'%lang,rid))
db.close()
c=configparser.RawConfigParser(); c.read('/config/config.ini'); key=c.get('API','api_key')
for i,cmd,t in API:
    u='http://localhost:5299/api?'+urllib.parse.urlencode({'apikey':key,'cmd':cmd,'id':i,'type':t})
    print(cmd,i,t,urllib.request.urlopen(u,timeout=60).read().decode()[:40])
db=sqlite3.connect('file:/config/lazylibrarian.db?mode=ro',uri=True)
for i in sorted({p[0] for p in PTR}|{a[0] for a in API}):
    r=db.execute('select BookID,BookName,BookLang,Status,AudioStatus,BookFile,BookLibrary,AudioFile,AudioLibrary from books where BookID=?',(i,)).fetchone()
    print(json.dumps([x.replace(B,'') if isinstance(x,str) else x for x in r],ensure_ascii=False))
for r in db.execute("select rowid,BookID,Status,NZBprov,NZBtitle from wanted where rowid>9547"): print('wanted',r)
