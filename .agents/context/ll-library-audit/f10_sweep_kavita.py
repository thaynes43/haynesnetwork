# F10 final sweep, Kavita side (2026-10-05 ~23:30Z). Flag pass over all 1,711 Kavita book series (series and chapter titles,
# folder and file names, series language tag, ISBN registration group): 5 flagged, text samples confirm one foreign edition:
# EBooks/Alice Oseman/Solitaire/Solitaire - Alice Oseman.epub is the German dtv edition (OPF de, ISBN 9783423428804, text de).
# Held (foreign_f10); LL -2R-EAAAQBAJ (English record) blanked and its eBook re-wanted; the grab that delivered it (rowid 92)
# blocked with a Failed row. Run INSIDE the LL pod: python3 - [--go]. Backup /config/lazylibrarian.db.pre-f10-sweep-kavita-20261005.
import os,sys,json,hashlib,time,sqlite3,configparser,urllib.request,urllib.parse
B='/data/cephfs-hdd/data/media/books/'; H=B+'quarantine/crossvolume-2026-10-05/'; HR='quarantine/crossvolume-2026-10-05/'
P='EBooks/Alice Oseman/Solitaire/Solitaire - Alice Oseman.epub'; SIZE=946158; REC='-2R-EAAAQBAJ'
GO='--go' in sys.argv
db=sqlite3.connect('/config/lazylibrarian.db',timeout=60)
r=db.execute('select BookLang,BookFile from books where BookID=?',(REC,)).fetchone()
w=db.execute('select BookID,AuxInfo,Status from wanted where rowid=92').fetchone()
ok=os.path.getsize(B+P)==SIZE and not os.path.exists(H+P) and r==('en',B+P) and w==(REC,'eBook','Processed')
refs=[x[0] for x in db.execute('select BookID from books where BookFile=? or AudioFile=?',(B+P,B+P))]
print('preconditions',ok,'refs',refs)
if not ok or refs!=[REC]: sys.exit('refused')
if not GO: sys.exit('dry run OK')
b=sqlite3.connect('/config/lazylibrarian.db.pre-f10-sweep-kavita-20261005'); db.backup(b); b.close()
h=hashlib.md5(open(B+P,'rb').read()).hexdigest()
os.makedirs(os.path.dirname(H+P),exist_ok=True); os.chown(os.path.dirname(H+P),1000,1000); os.chown(os.path.dirname(os.path.dirname(H+P)),1000,1000)
os.rename(B+P,H+P); os.utime(os.path.dirname(B+P),None)
ev='German edition (dtv, ISBN 9783423428804, OPF de, text de); no English Solitaire eBook held, LL -2R-EAAAQBAJ eBook re-wanted'
ts=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
open(H+'manifest.jsonl','a').write(json.dumps({'op':'hold','src':P,'dst':HR+P,'md5':h,'size':SIZE,'reason':'F10 2026-10-05 foreign-edition sweep: '+ev,'record':REC,'ts':ts})+'\n')
open(H+'sort.jsonl','a').write(json.dumps({'path':HR+P,'size':SIZE,'md5':h,'category':'foreign_f10','evidence':ev+', F10','record':REC,'counterparts':[]})+'\n')
now=time.strftime('%Y-%m-%d %H:%M:%S',time.gmtime())
with db:
    db.execute('update books set BookFile=NULL,BookLibrary=NULL where BookID=?',(REC,))
    db.execute("""insert into wanted (BookID,NZBurl,NZBtitle,NZBdate,NZBprov,Status,NZBsize,AuxInfo,NZBmode,Source,DownloadID,DLResult,Completed,Label)
      select BookID,NZBurl,NZBtitle,?,NZBprov,'Failed',NZBsize,AuxInfo,NZBmode,NULL,NULL,?,0,'' from wanted where rowid=92""",
      (now,'Blocked by hand 2026-10-05 (F10 sweep): this release delivered the German edition, held in quarantine/crossvolume-2026-10-05'))
c=configparser.RawConfigParser(); c.read('/config/config.ini')
print(urllib.request.urlopen('http://localhost:5299/api?'+urllib.parse.urlencode({'apikey':c.get('API','api_key'),'cmd':'queueBook','id':REC,'type':'eBook'}),timeout=60).read().decode()[:5])
print(sqlite3.connect('file:/config/lazylibrarian.db?mode=ro',uri=True).execute('select BookID,Status,BookFile from books where BookID=?',(REC,)).fetchone())
