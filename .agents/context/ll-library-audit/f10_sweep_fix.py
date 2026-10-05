# F10 final sweep, 2026-10-05 ~23:00Z: the Audiobookshelf audiobooks confirmed foreign. Run INSIDE the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - [--go] < .agents/context/ll-library-audit/f10_sweep_fix.py
# Flag pass: f10_sweep_flag.py over all 1,179 Audiobookshelf items (title, folder, track names, narrators, ID3 album, publisher,
# language, comment); 30 flagged. Confirmed by whisper large-v3 on one track per tag group (album, narrator, publisher, file-name
# pattern), plus a second sample of every group held here. Each group below is selected by its own tags, with an expected count,
# and every English group in the same folder stays. Whole-foreign folders go with their sidecars and the folder is removed.
# Holds go to the cross-volume holding folder (manifest.jsonl + sort.jsonl, foreign_f10) for owed check (m)'s purge.
# LL (backup /config/lazylibrarian.db.pre-f10-sweep-20261005 first): English records that linked a held file are re-pointed to an
# English copy left in the folder, else blanked and re-wanted (queueBook); foreign or mislinked records are blanked and Skipped.
# The grabs that delivered re-wanted foreign editions get a Failed block row (LL blacklist_failed).
import os,sys,json,hashlib,time,re,struct,sqlite3,configparser,urllib.request,urllib.parse
B='/data/cephfs-hdd/data/media/books/'; A='AudioBooks/'; H=B+'quarantine/crossvolume-2026-10-05/'; HR='quarantine/crossvolume-2026-10-05/'
GO='--go' in sys.argv
TAG='F10 2026-10-05 foreign-edition sweep: '
def id3(p):
    out={}
    with open(p,'rb') as f:
        h=f.read(10)
        if h[:3]!=b'ID3': return out
        ver=h[3]; sz=(h[6]<<21)|(h[7]<<14)|(h[8]<<7)|h[9]; d=f.read(sz)
    i=0
    while i+10<=len(d):
        fid=d[i:i+4]
        if not re.match(rb'[A-Z0-9]{4}',fid): break
        fs=(d[i+4]<<21)|(d[i+5]<<14)|(d[i+6]<<7)|d[i+7] if ver==4 else struct.unpack('>I',d[i+4:i+8])[0]
        if fid in (b'TALB',b'TCOM',b'TPUB'):
            b=d[i+10:i+10+fs]
            if b:
                enc={0:'latin-1',1:'utf-16',2:'utf-16-be',3:'utf-8'}.get(b[0],'latin-1')
                out[fid.decode()]=b[1:].decode(enc,'ignore').replace('\x00','').strip()
        i+=10+fs
    return out
AUD=('.mp3','.m4b','.m4a')
RPO=re.compile(r'^(Ernest Cline - Ready Player One Part \d+ of 217|Ernest Cline - Ready Player One - \d+|Ready Player One - \d+)\.mp3$')
# (folder, language evidence, LL record, selector or 'ALL', expected audio count)
P=[
 ('Julia Quinn/Queen Charlotte','Swedish edition (single mp3, CRAViNGS release; whisper sv twice)','CQh5EAAAQBAJ','ALL',1),
 ('J.R.R. Tolkien/Roverandom','German edition ("Fantasy-Story fuer Kidz", read by Ulrich Noeten; whisper de on both naming sets)','2TEPAAAAQBAJ','ALL',50),
 ('J.R.R. Tolkien/Bauer Giles von Ham','German edition (Farmer Giles of Ham; whisper de on both tracks)','aBz-CgAAQBAJ','ALL',2),
 ('Nnedi Okorafor/Binti','Swedish edition of Binti 3 ("Nattens magiska mask"; whisper sv twice)','(none)','ALL',1),
 ('Veronica Roth/Divergent','Swedish edition (single mp3; whisper sv twice)','K0UczgEACAAJ','ALL',1),
 ('Dean Koontz/The Other Emily','German edition ("Die Doppelgängerin (Ungekürzt)", SAGA Egmont; whisper de)','GGcbzgEACAAJ','ALL',98),
 ('Amber V. Nicole/The Book of Azrael','German edition ("Götter & Monster 1 (Ungekürzt)"; whisper de)','lcpmEQAAQBAJ','ALL',54),
 ('Tahereh Mafi/These Infinite Threads','German edition (cbj audio, "(Ungekürzt)"; whisper de)','PyRvEAAAQBAJ','ALL',138),
 ('Cassandra Clare/Chain of Thorns','German edition ("Die letzten Stunden 3", Der Hörverlag; whisper de)','d-DrEAAAQBAJ','ALL',664),
 ('R.F. Kuang/Katabasis','French edition (Editions Theleme; whisper fr)','Nlf8EAAAQBAJ','ALL',44),
 ('Dennis E. Taylor/Outland','German edition ("Der geheime Planet", Random House Audio Deutschland, Simon Jäger; whisper de)','(none)',lambda f,t: t.get('TALB')=='Outland - Der geheime Planet',239),
 ('Dean Koontz/Phantoms','Swedish edition (CRAViNGS single mp3; whisper sv)','Vizr87UNMpEC',lambda f,t: 'cravings_int' in f,1),
 ('Veronica Roth/Allegiant','Swedish edition (CRAViNGS single mp3; whisper sv)','mFMG1eUXyfcC',lambda f,t: 'cravings_int' in f,1),
 ('Cassandra Clare/Chain of Iron','German edition (Der Hörverlag, Oliver Kube; whisper de)','uZWvEAAAQBAJ',lambda f,t: t.get('TCOM')=='Oliver Kube',323),
 ('Ernest Cline/Ready Player One','German edition (Argon Verlag, David Nathan; three copies; whisper de on each)','J8ahqXjUhAAC',lambda f,t: bool(RPO.match(f)) and t.get('TALB')=='Ready Player One',651),
 ('Rachel Gillig/One Dark Window','German edition ("Die Schatten zwischen uns", TIDE, Nina Reithmeier; whisper de)','8RY_EAAAQBAJ',lambda f,t: t.get('TCOM')=='Nina Reithmeier',410),
 ('Rachel Gillig/Two Twisted Crowns','German edition ("Die Magie zwischen uns", Silberfisch, Nina Reithmeier; whisper de)','fjWsEAAAQBAJ',lambda f,t: t.get('TCOM')=='Nina Reithmeier',474),
 ('Michael Lewis/The Big Short','German edition ("Wie eine Handvoll Trader die Welt verzockte", David Nathan; whisper de)','eParwQ0YdrcC',lambda f,t: 'Wie eine Handvoll' in f or (t.get('TALB') or '').startswith('The Big Short: Wie eine Handvoll'),22),
 ('Stieg Larsson/The Girl Who Kicked The Hornets Nest','Indonesian edition (m4b "Millenium (Indonesian)"; whisper id)','jB3-AwAAQBAJ',lambda f,t: '(Indonesian)' in f,1),
 ('Cassandra Clare/Lady Midnight','German edition (Der Hoerverlag; whisper de)','MlU3DwAAQBAJ',lambda f,t: t.get('TPUB')=='Der Hoerverlag',494),
 ('Matt Dinniman/Carls Doomsday Scenario','German edition (Audible Studios DE, Stefan Kaminski, TLAN German; whisper de)','(none)',lambda f,t: t.get('TCOM')=='Stefan Kaminski',30),
 ('Colleen Hoover/Verity','Swedish edition (single mp3; whisper sv)','CRen0QEACAAJ',lambda f,t: f=='Colleen Hoover - Verity.mp3',1),
]
EN={ # what stays English in each mixed folder (must exist after the move)
 'Dennis E. Taylor/Outland':'Ray Porter mp3s (Audible), 3 copies','Dean Koontz/Phantoms':'m4b (Buck Schirner) and mp3 sets',
 'Veronica Roth/Allegiant':'110 mp3s','Cassandra Clare/Chain of Iron':'Simon & Schuster and Finty Williams mp3s',
 'Ernest Cline/Ready Player One':'Wil Wheaton m4b and mp3 sets','Rachel Gillig/One Dark Window':'m4b (Orbit) and 38 Hachette mp3s',
 'Rachel Gillig/Two Twisted Crowns':'m4b (Orbit)','Michael Lewis/The Big Short':'Simon & Schuster mp3s and Part 1/2',
 'Stieg Larsson/The Girl Who Kicked The Hornets Nest':'two English mp3 sets','Cassandra Clare/Lady Midnight':'m4b (Morena Baccarin) and single mp3',
 'Matt Dinniman/Carls Doomsday Scenario':'Jeff Hays mp3s','Colleen Hoover/Verity':'m4b (Vanessa Johansson, Amy Landon)'}
plan=[]; bad=[]; rmdirs=[]; groups={}
for fo,ev,rec,sel,n in P:
    d=B+A+fo; fs=sorted(os.listdir(d)); aud=[f for f in fs if f.lower().endswith(AUD)]
    if sel=='ALL':
        pick=list(fs); na=len(aud); rmdirs.append(A+fo)
    else:
        pick=[f for f in aud if sel(f,id3(d+'/'+f) if f.lower().endswith('.mp3') else {})]
        na=len(pick)
        keep=[f for f in aud if f not in pick]
        if not keep: bad.append(('no English audio would remain',fo))
        if 'playlist.ll' in fs:
            pl=[l.strip() for l in open(d+'/playlist.ll') if l.strip()]
            if pl and all(l in pick for l in pl): pick.append('playlist.ll')
    if na!=n: bad.append(('audio selected %d, expected %d'%(na,n),fo))
    groups[fo]=[f for f in pick if f.lower().endswith(AUD)]
    for f in pick:
        side=not f.lower().endswith(AUD)
        plan.append((A+fo+'/'+f,rec,ev if not side else 'sidecar of the '+ev.split(' (')[0]))
print('files',len(plan),'%.2f GB'%(sum(os.path.getsize(B+p) for p,_,_ in plan)/1e9),'| folders removed',len(rmdirs))
for fo,g in groups.items(): print('  %4d %-55s sample: %s'%(len(g),fo[:55],g[len(g)//2] if g else '-'))
# LL
db=sqlite3.connect('/config/lazylibrarian.db',timeout=60)
moved={B+p for p,_,_ in plan}
REQ={'CQh5EAAAQBAJ','2TEPAAAAQBAJ','K0UczgEACAAJ','GGcbzgEACAAJ','PyRvEAAAQBAJ','d-DrEAAAQBAJ','Nlf8EAAAQBAJ'}   # English: blank + re-want audio
SKIP={'aBz-CgAAQBAJ','6s_qLDNW0kwC'}   # German record; World of Divergent mislinked to the Swedish Divergent
REPOINT={'J8ahqXjUhAAC':A+'Ernest Cline/Ready Player One/Ernest Cline - [Ready Player One - 1] - Ready Player One (Wil Wheaton).m4b',
         'fjWsEAAAQBAJ':A+'Rachel Gillig/Two Twisted Crowns/Two Twisted Crowns [B0BWGZFRJ4].m4b',
         'CRen0QEACAAJ':A+'Colleen Hoover/Verity/Colleen Hoover - Verity.m4b'}
BLOCK=[9322,187,3321,4157,5275,9325]
refs={r[0]:r for r in db.execute('select BookID,BookLang,AudioFile from books') if r[2] in moved}
if set(refs)!=REQ|SKIP|set(REPOINT): bad.append(('LL refs differ',sorted(set(refs)^(REQ|SKIP|set(REPOINT)))))
for i in REQ|set(REPOINT)|{'6s_qLDNW0kwC'}:
    if refs.get(i,(0,'en'))[1]!='en': bad.append(('not English',i))
for i,t in REPOINT.items():
    if not os.path.isfile(B+t) or B+t in moved: bad.append(('repoint target',i))
for rid in BLOCK:
    r=db.execute("select BookID,AuxInfo,Status from wanted where rowid=?",(rid,)).fetchone()
    if not r or r[0] not in REQ or r[1]!='AudioBook' or r[2] not in ('Processed','Seeding'): bad.append(('block row',rid,r))
if bad:
    for b in bad: print('REFUSE',*b)
    sys.exit('refused: nothing changed')
if not GO: sys.exit('dry run OK; re-run with --go')
bk='/config/lazylibrarian.db.pre-f10-sweep-20261005'; assert not os.path.exists(bk)
b2=sqlite3.connect(bk); db.backup(b2); b2.close()
def md5(p):
    h=hashlib.md5()
    with open(p,'rb') as fh:
        for b in iter(lambda: fh.read(1<<22),b''): h.update(b)
    return h.hexdigest()
ts=lambda: time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
man=open(H+'manifest.jsonl','a'); srt=open(H+'sort.jsonl','a')
for p,rec,ev in plan:
    s=B+p; d=H+p; m=md5(s); z=os.path.getsize(s)
    dd=os.path.dirname(d)
    if not os.path.isdir(dd):
        os.makedirs(dd); x=dd
        while x.rstrip('/')!=H.rstrip('/'): os.chown(x,1000,1000); x=os.path.dirname(x)
    os.rename(s,d)
    man.write(json.dumps({'op':'hold','src':p,'dst':HR+p,'md5':m,'size':z,'reason':TAG+ev,'record':rec,'ts':ts()},ensure_ascii=False)+'\n')
    srt.write(json.dumps({'path':HR+p,'size':z,'md5':m,'category':'foreign_f10','evidence':ev+', F10','record':rec,'counterparts':[]},ensure_ascii=False)+'\n')
for d in rmdirs:
    os.rmdir(B+d); man.write(json.dumps({'op':'rmdir','src':d,'reason':'F10 2026-10-05 sweep: emptied foreign-edition folder','record':'','ts':ts()})+'\n')
man.close(); srt.close()
for fo,*_ in P:
    x=B+A+fo
    os.utime(x if os.path.isdir(x) else os.path.dirname(x),None)
now=time.strftime('%Y-%m-%d %H:%M:%S',time.gmtime())
with db:
    for i in REQ|SKIP: db.execute('update books set AudioFile=NULL,AudioLibrary=NULL where BookID=?',(i,))
    for i,t in REPOINT.items(): db.execute('update books set AudioFile=? where BookID=?',(B+t,i))
    for rid in BLOCK:
        db.execute("""insert into wanted (BookID,NZBurl,NZBtitle,NZBdate,NZBprov,Status,NZBsize,AuxInfo,NZBmode,Source,DownloadID,DLResult,Completed,Label)
          select BookID,NZBurl,NZBtitle,?,NZBprov,'Failed',NZBsize,AuxInfo,NZBmode,NULL,NULL,?,0,'' from wanted where rowid=?""",
          (now,'Blocked by hand 2026-10-05 (F10 sweep): this release delivered a foreign-language edition, held in quarantine/crossvolume-2026-10-05',rid))
db.close()
key=configparser.RawConfigParser(); key.read('/config/config.ini'); key=key.get('API','api_key')
for i in sorted(REQ): print('queueBook',i,urllib.request.urlopen('http://localhost:5299/api?'+urllib.parse.urlencode({'apikey':key,'cmd':'queueBook','id':i,'type':'AudioBook'}),timeout=60).read().decode()[:5])
for i in sorted(SKIP): print('unqueueBook',i,urllib.request.urlopen('http://localhost:5299/api?'+urllib.parse.urlencode({'apikey':key,'cmd':'unqueueBook','id':i,'type':'AudioBook'}),timeout=60).read().decode()[:5])
db=sqlite3.connect('file:/config/lazylibrarian.db?mode=ro',uri=True)
for r in db.execute('select BookID,BookLang,AudioStatus,AudioFile from books where BookID in (%s)'%','.join('?'*len(REQ|SKIP|set(REPOINT))),tuple(REQ|SKIP|set(REPOINT))):
    print(r[0],r[1],r[2],'ok' if r[3] is None or os.path.isfile(r[3]) else 'MISSING',(r[3] or '').replace(B,'')[-60:])
print('moved',len(plan),'files; removed',len(rmdirs),'folders; block rows',db.execute("select rowid from wanted where DLResult like 'Blocked by hand 2026-10-05 (F10 sweep)%'").fetchall())
