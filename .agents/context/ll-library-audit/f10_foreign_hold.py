# F10 foreign-edition sweep, 2026-10-05: move the foreign-language editions found by the 2026-10-05 language audit into the
# cross-volume holding folder (books/quarantine/crossvolume-2026-10-05/), appending each move to its manifest.jsonl (op
# "hold", md5) and sort.jsonl (category foreign_f10), so owed check (m)'s crossvolume_purge.py deletes them on or after
# 2026-10-12. Run INSIDE the LazyLibrarian pod (it mounts the library rw):
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/f10_foreign_hold.py        # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/f10_foreign_hold.py   # move
# Every file is named exactly (eBooks: path + the size seen when its language was read; audio: the folder's mp3s whose ID3
# album is the foreign edition's, with an expected count). Language evidence: OPF dc:language + publisher + a text sample
# from the middle of the book (eBooks), ID3 album/publisher/TLAN plus a whisper large-v3 language check on sampled tracks
# (audio). English files in the same folders stay. Undo: move each row's dst back to src and drop its sort.jsonl row.
# Ran 2026-10-05 ~21:23Z (611 files). Afterwards every source folder was touched by hand (os.utime(dir, None)): on the
# hdd-nfs-repl export a rename does not bump the source folder's mtime, so Kavita (another node) kept listing the moved files.
import os,sys,json,hashlib,time,re,struct
B='/data/cephfs-hdd/data/media/books/'; H=B+'quarantine/crossvolume-2026-10-05/'
GO='--go' in sys.argv
TAG='F10 2026-10-05 foreign-edition sweep: '
E=[ # (path under books/, size, LL record, language/edition evidence, where English stands)
 ('EBooks/Christopher Paolini/Brisingr/Brisingr - Christopher Paolini.epub',829923,'43CqLq7TkroC','Dutch edition (OPF nl, Kavita series "DE ERFGOED-TRILOGIE", text nl)','English: Brisingr Deluxe Edition azw3 in the same folder'),
 ('EBooks/Tom Clancy/Dead or Alive/Dead or Alive - Tom Clancy.epub',800815,'BL6LDQAAQBAJ','German edition (OPF de, text de)','no English eBook held; LL eBook re-wanted'),
 ('EBooks/Tom Clancy/Dead or Alive/Dead or Alive - Tom Clancy.pdf',3155284,'BL6LDQAAQBAJ','German edition (calibre pdf, text de)','no English eBook held; LL eBook re-wanted'),
 ('EBooks/Tom Clancy/Dead or Alive/Dead or Alive - Tom Clancy.azw3',1440960,'BL6LDQAAQBAJ','German edition (EXTH language de, text de)','no English eBook held; LL eBook re-wanted'),
 ('EBooks/Tom Clancy/Dead or Alive/Dead or Alive - Tom Clancy.mobi',1159758,'BL6LDQAAQBAJ','German edition (EXTH language de, text de)','no English eBook held; LL eBook re-wanted'),
 ('EBooks/Colleen Hoover/Verity/Verity - Colleen Hoover.pdf',1245168,'CRen0QEACAAJ','German edition (calibre pdf, text de)','English: Verity epub (Hoover Ink) in the same folder, LL links it'),
 ('EBooks/Colleen Hoover/Verity/Verity - Colleen Hoover.azw3',952082,'CRen0QEACAAJ','German edition (dtv, ISBN 9783423437288, text de)','English: Verity epub (Hoover Ink) in the same folder, LL links it'),
 ('EBooks/Colleen Hoover/Verity/Verity - Colleen Hoover.mobi',679003,'CRen0QEACAAJ','German edition (dtv, ISBN 9783423437288, text de)','English: Verity epub (Hoover Ink) in the same folder, LL links it'),
 ('EBooks/Christopher Paolini/Fractal Noise/Fractal Noise - Christopher Paolini.epub',1016839,'mN6LEAAAQBAJ','German edition "Mission ins Ungewisse" (Knaur, ISBN 9783426468548, text de; Kavita series 1865)','English: Pan Macmillan epub in "Fractal Noise - Is humanity no longer alone!..." folder'),
 ('EBooks/Christopher Paolini/Murtagh - Eine dunkle Bedrohung/Murtagh - Eine dunkle Bedrohung - Christopher Paolini.epub',7223091,'hN-yEAAAQBAJ','German edition (cbj, ISBN 9783641312893, text de)','English: Murtagh epubs in Murtagh/ (LL FOqzEAAAQBAJ)'),
 ('EBooks/Christopher Paolini/Murtagh - Eine dunkle Bedrohung/Murtagh - Eine dunkle Bedrohung - Christopher Paolini.mobi',5975214,'hN-yEAAAQBAJ','German edition (cbj, EXTH de, text de)','English: Murtagh epubs in Murtagh/ (LL FOqzEAAAQBAJ)'),
 ('EBooks/Stephanie Garber/The Ballad of Never After/The Ballad of Never After - Stephanie Garber.epub',2598787,'ZHRUEAAAQBAJ','German edition (cbj, OPF de-DE, text de)','English: Flatiron azw3 and mobi in the same folder'),
 ('EBooks/Herman Melville/Israel Potter/Israel Potter - Herman Melville.epub',714538,'mPGNzQEACAAJ','Danish edition "Pierre & Israel Potter" (Forlaget Bindslev, text da)','no English eBook held; LL eBook re-wanted'),
 ('EBooks/Walter Mosley/Karma/Karma - Walter Mosley.epub',1167310,'GOhLAQAACAAJ','Danish edition (Rosenkilde & Bahnhof, text da)','English: Penguin mobi in the same folder'),
 ('EBooks/Isaac Asimov/Azazel/Azazel - Isaac Asimov.epub',537448,'PitFPgAACAAJ','Italian edition (OPF it, text it)','no English eBook held; LL record is a Spanish edition (BookLang es), eBook set Skipped'),
 ('EBooks/Diana Gabaldon/A Breath of Snow and Ashes/A Breath of Snow and Ashes - Diana Gabaldon.epub',1792807,'MjBcPwAACAAJ','Swedish edition "Snö och aska" (Stockholm Text, text sv)','English: Dell epub in the same folder, LL links it'),
 ('EBooks/Brandon Sanderson/The Well of Ascension/The Well of Ascension - Brandon Sanderson.epub',6387542,'Y-41Q9zk32kC','Hebrew edition (Opus, he-IL, text he)','English: epub, azw3, mobi and pdf in the same folder'),
 ('EBooks/Brandon Sanderson/The Hero of Ages/The Hero of Ages - Brandon Sanderson.epub',7431582,'X9q_7-nWisgC','Hebrew edition (Opus, he-IL, text he)','English: epub, azw3, mobi and pdf in the same folder'),
 ('AudioBooks/Stephanie Garber/Once Upon a Broken Heart/101-stephanie_garber_-_onupabrhesvut_01.01-cravings_int.mp3',297450370,'7_8iEAAAQBAJ','Swedish edition (ID3 album "Once upon a broken heart (svensk utgåva)", whisper sv)','English: m4b in the same folder (whisper en)'),
 ('AudioBooks/Stephanie Garber/Once Upon a Broken Heart/playlist.ll',3658,'7_8iEAAAQBAJ','sidecar of the German edition: LL playlist naming its 59 German tracks','English: m4b in the same folder (whisper en)'),
 ('AudioBooks/Stephanie Garber/The Ballad of Never After/playlist.ll',3339,'ZHRUEAAAQBAJ','sidecar of the German edition: LL playlist naming its 53 German tracks','English: m4b and single mp3 in the same folder (whisper en)'),
]
A=[ # (folder, ID3 albums of the foreign edition, expected count, LL record, evidence, English)
 ('AudioBooks/Christopher Paolini/Fractal Noise',('Fractal Noise - Mission ins Ungewisse (Ungekürzt)','Fractal Noise 2MP3CD'),366,'mN6LEAAAQBAJ','German edition (Argon Verlag "Mission ins Ungewisse (Ungekürzt)" and the FKK "2MP3CD" set, TLAN German, whisper de)','English: m4b in the same folder (whisper en)'),
 ('AudioBooks/Stephanie Garber/Once Upon a Broken Heart',('Once Upon a Broken Heart (Once Upon a Broken Heart 1) (Ungekürzt)',),118,'7_8iEAAAQBAJ','German edition (Wunderkind Audiobooks, narr. Constanze Buttmann, TLAN German, whisper de)','English: m4b in the same folder (whisper en)'),
 ('AudioBooks/Stephanie Garber/The Ballad of Never After',('The Ballad of Never After (Once Upon a Broken Heart 2) (Ungekürzt)',),106,'ZHRUEAAAQBAJ','German edition (Wunderkind Audiobooks, narr. Constanze Buttmann, TLAN German, whisper de)','English: m4b and single mp3 in the same folder (whisper en)'),
]
KEEP_EN={'AudioBooks/Stephanie Garber/The Ballad of Never After/The Ballad of Never After_ Once Upon a Broken Heart, Book 2.mp3',
 'AudioBooks/Stephanie Garber/The Ballad of Never After/The Ballad of Never After - Stephanie Garber.m4b',
 'AudioBooks/Stephanie Garber/Once Upon a Broken Heart/Once upon a Broken Heart.m4b',
 'AudioBooks/Christopher Paolini/Fractal Noise/Fractal Noise - Christopher Paolini.m4b'}
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
plan=[]; bad=[]
for src,size,rec,ev,en in E:
    p=B+src
    if not os.path.isfile(p): bad.append(('missing',src)); continue
    if os.path.getsize(p)!=size: bad.append(('size %d != %d'%(os.path.getsize(p),size),src)); continue
    plan.append((src,rec,ev,en))
for fo,albums,n,rec,ev,en in A:
    sel=[]
    for f in sorted(os.listdir(B+fo)):
        rel=fo+'/'+f
        if not f.lower().endswith('.mp3'): continue
        t=talb(B+rel)
        if t in albums: sel.append(rel)
    if any(s in KEEP_EN for s in sel): bad.append(('English file selected',fo))
    if len(sel)!=n: bad.append(('selected %d, expected %d'%(len(sel),n),fo))
    plan+= [(s,rec,ev,en) for s in sel]
for k in KEEP_EN:
    if not os.path.isfile(B+k): bad.append(('English keeper missing',k))
total=sum(os.path.getsize(B+s) for s,*_ in plan)
print('files',len(plan),'%.2f GB'%(total/1e9),'| by folder:')
import collections
for k,v in sorted(collections.Counter(s.rsplit('/',1)[0] for s,*_ in plan).items()): print('  %4d %s'%(v,k))
if bad:
    for b in bad: print('REFUSE',*b)
    sys.exit('refused: nothing moved')
if not GO: print('dry run OK; re-run with --go to move'); sys.exit(0)
man=open(H+'manifest.jsonl','a'); srt=open(H+'sort.jsonl','a')
for src,rec,ev,en in plan:
    s=B+src; dst='quarantine/crossvolume-2026-10-05/'+src; d=B+dst
    assert os.path.isfile(s) and not os.path.exists(d),src
    h=hashlib.md5()
    with open(s,'rb') as fh:
        for b in iter(lambda: fh.read(1<<22),b''): h.update(b)
    md5=h.hexdigest(); size=os.path.getsize(s)
    dd=os.path.dirname(d)
    if not os.path.isdir(dd):
        os.makedirs(dd)
        x=dd
        while x.rstrip('/')!=H.rstrip('/'): os.chown(x,1000,1000); x=os.path.dirname(x)
    os.rename(s,d)
    ts=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    man.write(json.dumps({'op':'hold','src':src,'dst':dst,'md5':md5,'size':size,'reason':TAG+ev+'; '+en,'record':rec,'ts':ts},ensure_ascii=False)+'\n')
    srt.write(json.dumps({'path':dst,'size':size,'md5':md5,'category':'foreign_f10','evidence':ev+', F10; '+en,'record':rec,'counterparts':[]},ensure_ascii=False)+'\n')
man.close(); srt.close()
print('moved',len(plan),'files')
