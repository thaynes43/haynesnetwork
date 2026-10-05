# F10 follow-up, 2026-10-05 (after f10_foreign_hold.py / f10_foreign_ll.py): the five items that sweep found outside its
# list. Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - [--go] < .agents/context/ll-library-audit/f10_followup.py
# 1. Dutch Eragon epub -> hold (foreign_f10); the three English Eragon records re-point to the English mobi beside it.
# 2. German Murtagh audiobook (652 mp3s, Random House Audio Deutschland, whisper de) + its sidecars, and the German eBook
#    folder's leftover sidecars -> hold (foreign_f10), folders removed. LL: the German record's audio blanked + Skipped; the
#    English record FOqzEAAAQBAJ (holds the English eBook) wants the audio; the "Murtagh. Deluxe Edition" record
#    3-wFEQAAQBAJ (Wanted since it was added, never grabbed) is Skipped so only one record searches.
# 3. The epub in Once Upon a Broken Heart/ is The Ballad of Never After (English, Flatiron; text has "Words of Warning",
#    not the book-1 opening). Ballad's folder has no epub (its German one is held), so it is re-homed there (op rehome).
#    Once Upon a Broken Heart's eBook stays linked to its azw3, which is book 1 (text checked).
# 4. The Ballad of Never After audio: two complete English copies (54 chapters each). Kept: the m4b (AAC 64 kbps, the
#    source's own bitrate, named chapters, linked by LL). Held as duplicate: the single mp3 (a 128 kbps mp3 transcode of
#    an Audible aax, same 54 chapters).
# 5. Azazel (Spanish-edition record PitFPgAACAAJ): audio Wanted -> Skipped. LL has no English Azazel record.
# Backup before the first DB write: /config/lazylibrarian.db.pre-f10-followup-20261005.
import os,sys,json,hashlib,time,re,struct,sqlite3,configparser,urllib.request,urllib.parse
B='/data/cephfs-hdd/data/media/books/'; H=B+'quarantine/crossvolume-2026-10-05/'; HR='quarantine/crossvolume-2026-10-05/'
GO='--go' in sys.argv
TAGF='F10 2026-10-05 foreign-edition sweep: '      # crossvolume_sort.py maps this prefix to foreign_f10
TAGD='F10 2026-10-05 follow-up duplicate: '        # ... and this one to duplicate
CP='Christopher Paolini/'; SG='Stephanie Garber/'
MA='AudioBooks/'+CP+'Murtagh - Eine dunkle Bedrohung'; ME='EBooks/'+CP+'Murtagh - Eine dunkle Bedrohung'
BAL='AudioBooks/'+SG+'The Ballad of Never After'
HOLD=[ # (path, size or None, category, record, reason, counterparts)
 ('EBooks/'+CP+'Eragon/Eragon - Christopher Paolini.epub',753208,'foreign_f10','iVCNDQAAQBAJ',TAGF+'Dutch edition (OPF nl, text nl; Kavita series 1836 "DE ERFGOED-TRILOGIE"); English: Random House mobi in the same folder',[]),
 (BAL+'/The Ballad of Never After_ Once Upon a Broken Heart, Book 2.mp3',540405714,'duplicate','ZHRUEAAAQBAJ',TAGD+'second complete English copy (128 kbps mp3 transcode of an Audible aax, 54 chapters); the folder keeps the m4b (AAC 64 kbps, 54 named chapters, 9.38 h)',[BAL]),
]
for f in sorted(os.listdir(B+MA)):
    HOLD.append((MA+'/'+f,None,'foreign_f10','hN-yEAAAQBAJ',TAGF+('German edition (Random House Audio Deutschland, "Murtagh - Eine dunkle Bedrohung (Ungekürzt)", whisper de)' if f.lower().endswith('.mp3') else 'sidecar of the German edition')+'; no English Murtagh audiobook held, LL FOqzEAAAQBAJ audio wanted',[]))
for f in sorted(os.listdir(B+ME)):
    HOLD.append((ME+'/'+f,None,'foreign_f10','hN-yEAAAQBAJ',TAGF+'sidecar of the German edition (its epub and mobi are already held); English: Murtagh/ (LL FOqzEAAAQBAJ)',[]))
REHOME=[('EBooks/'+SG+'Once Upon a Broken Heart/Once Upon a Broken Heart - Stephanie Garber.epub',967434,
         'EBooks/'+SG+'The Ballad of Never After/The Ballad of Never After - Stephanie Garber.epub','ZHRUEAAAQBAJ',
         'F10 2026-10-05 follow-up: this epub is The Ballad of Never After (English, Flatiron), not Once Upon a Broken Heart; Ballad\'s folder had no epub')]
RMDIR=[MA,ME]
TOUCH=['EBooks/'+CP+'Eragon','EBooks/'+SG+'Once Upon a Broken Heart','EBooks/'+SG+'The Ballad of Never After',BAL,'AudioBooks/'+CP[:-1],'EBooks/'+CP[:-1]]
ER=('iVCNDQAAQBAJ','zKl_4L9AWccC','nEeu0AEACAAJ')
EPUB=B+'EBooks/'+CP+'Eragon/Eragon - Christopher Paolini.epub'; MOBI=B+'EBooks/'+CP+'Eragon/Eragon - Christopher Paolini.mobi'
API=[('hN-yEAAAQBAJ','unqueueBook','AudioBook'),('FOqzEAAAQBAJ','queueBook','AudioBook'),('3-wFEQAAQBAJ','unqueueBook','AudioBook'),('PitFPgAACAAJ','unqueueBook','AudioBook')]
def talb(p):
    f=open(p,'rb'); h=f.read(10)
    if h[:3]!=b'ID3': return None
    ver=h[3]; sz=(h[6]<<21)|(h[7]<<14)|(h[8]<<7)|h[9]; d=f.read(sz); i=0
    while i+10<=len(d):
        fid=d[i:i+4]
        if not re.match(rb'[A-Z0-9]{4}',fid): return None
        fs=(d[i+4]<<21)|(d[i+5]<<14)|(d[i+6]<<7)|d[i+7] if ver==4 else struct.unpack('>I',d[i+4:i+8])[0]
        if fid==b'TALB':
            b=d[i+10:i+10+fs]; enc={0:'latin-1',1:'utf-16',2:'utf-16-be',3:'utf-8'}.get(b[0],'latin-1')
            return b[1:].decode(enc,'ignore').replace('\x00','').strip()
        i+=10+fs
    return None
bad=[]
mp3=[h for h in HOLD if h[0].startswith(MA) and h[0].lower().endswith('.mp3')]
if len(mp3)!=652: bad.append(('Murtagh mp3 count',len(mp3)))
if any(talb(B+h[0])!='Murtagh - Eine dunkle Bedrohung (Ungekürzt)' for h in mp3): bad.append(('a Murtagh mp3 is not the German album',))
if len(HOLD)!=2+656+2: bad.append(('hold count',len(HOLD)))
for p,size,*_ in HOLD:
    if not os.path.isfile(B+p): bad.append(('missing',p))
    elif size and os.path.getsize(B+p)!=size: bad.append(('size',p))
    if os.path.exists(B+HR+p): bad.append(('already held',p))
for s,size,d,*_ in REHOME:
    if os.path.getsize(B+s)!=size or os.path.exists(B+d): bad.append(('rehome',s,d))
if not os.path.isfile(B+BAL+'/The Ballad of Never After - Stephanie Garber.m4b'): bad.append(('kept m4b missing',))
if not os.path.isfile(MOBI): bad.append(('Eragon mobi missing',))
db=sqlite3.connect('/config/lazylibrarian.db',timeout=60)
for i in ER:
    if db.execute('select BookFile from books where BookID=?',(i,)).fetchone()[0]!=EPUB: bad.append(('Eragon pointer',i))
r=db.execute("select AudioFile,BookLang from books where BookID='hN-yEAAAQBAJ'").fetchone()
if r!=(B+MA+'/001 - Kapitel 1.mp3','de'): bad.append(('Murtagh de record',r))
for i,lang in (('FOqzEAAAQBAJ','en'),('3-wFEQAAQBAJ','en'),('PitFPgAACAAJ','es')):
    if db.execute('select BookLang from books where BookID=?',(i,)).fetchone()[0]!=lang: bad.append(('lang',i))
moved={B+h[0] for h in HOLD}|{B+s for s,*_ in REHOME}
refs=[x for x in db.execute('select BookID,BookFile,AudioFile from books') if x[1] in moved or x[2] in moved]
if sorted(x[0] for x in refs)!=sorted(ER+('hN-yEAAAQBAJ',)): bad.append(('unexpected LL refs',refs))
print('hold',len(HOLD),'files, %.2f GB'%(sum(os.path.getsize(B+h[0]) for h in HOLD if os.path.isfile(B+h[0]))/1e9),'| rehome',len(REHOME),'| LL refs',[x[0] for x in refs])
if bad:
    for b in bad: print('REFUSE',*b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')
bk='/config/lazylibrarian.db.pre-f10-followup-20261005'; assert not os.path.exists(bk)
b2=sqlite3.connect(bk); db.backup(b2); b2.close()
def md5(p):
    h=hashlib.md5()
    with open(p,'rb') as fh:
        for b in iter(lambda: fh.read(1<<22),b''): h.update(b)
    return h.hexdigest()
def mkd(d,stop):
    if not os.path.isdir(d):
        os.makedirs(d); x=d
        while x.rstrip('/')!=stop.rstrip('/'): os.chown(x,1000,1000); x=os.path.dirname(x)
ts=lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
man=open(H+'manifest.jsonl','a'); srt=open(H+'sort.jsonl','a')
for p,size,cat,rec,reason,cps in HOLD:
    s=B+p; d=H+p; m=md5(s); z=os.path.getsize(s); mkd(os.path.dirname(d),H); os.rename(s,d)
    man.write(json.dumps({'op':'hold','src':p,'dst':HR+p,'md5':m,'size':z,'reason':reason,'record':rec,'ts':ts()},ensure_ascii=False)+'\n')
    srt.write(json.dumps({'path':HR+p,'size':z,'md5':m,'category':cat,'evidence':reason.split(': ',1)[1],'record':rec,'counterparts':cps},ensure_ascii=False)+'\n')
for s,size,d,rec,reason in REHOME:
    m=md5(B+s); os.rename(B+s,B+d)
    man.write(json.dumps({'op':'rehome','src':s,'dst':d,'md5':m,'size':size,'reason':reason,'record':rec,'ts':ts()},ensure_ascii=False)+'\n')
for d in RMDIR:
    os.rmdir(B+d); man.write(json.dumps({'op':'rmdir','src':d,'reason':'F10 2026-10-05 follow-up: emptied German Murtagh folder','record':'hN-yEAAAQBAJ','ts':ts()})+'\n')
man.close(); srt.close()
for d in TOUCH: os.utime(B+d,None)   # hdd-nfs-repl does not bump a folder's mtime on rename: other clients (Kavita) need it
with db:
    for i in ER: db.execute('update books set BookFile=? where BookID=?',(MOBI,i))
    db.execute("update books set AudioFile=NULL,AudioLibrary=NULL where BookID='hN-yEAAAQBAJ'")
db.close()
key=configparser.RawConfigParser(); key.read('/config/config.ini'); key=key.get('API','api_key')
for i,cmd,t in API:
    print(cmd,i,t,urllib.request.urlopen('http://localhost:5299/api?'+urllib.parse.urlencode({'apikey':key,'cmd':cmd,'id':i,'type':t}),timeout=60).read().decode()[:20])
db=sqlite3.connect('file:/config/lazylibrarian.db?mode=ro',uri=True)
for r in db.execute("select BookID,BookLang,Status,AudioStatus,BookFile,AudioFile from books where BookID in ('iVCNDQAAQBAJ','zKl_4L9AWccC','nEeu0AEACAAJ','hN-yEAAAQBAJ','FOqzEAAAQBAJ','3-wFEQAAQBAJ','PitFPgAACAAJ','7_8iEAAAQBAJ','ZHRUEAAAQBAJ')"):
    print(json.dumps([x.replace(B,'') if isinstance(x,str) else x for x in r],ensure_ascii=False), 'files ok' if all(x is None or os.path.isfile(x) for x in r[4:]) else 'FILE MISSING')
print('moved',len(HOLD),'held +',len(REHOME),'re-homed; removed',RMDIR)
