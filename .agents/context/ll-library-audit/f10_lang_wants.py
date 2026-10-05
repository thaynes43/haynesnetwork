# F10, 2026-10-05 ~22:15Z: LazyLibrarian records with a foreign BookLang that were still Wanted. Run INSIDE the LL pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - [--go] < .agents/context/ll-library-audit/f10_lang_wants.py
# All 12 were added by the app's API (format-pairing, 07-16..07-25, and the #668 re-request on 10-04/05) before the v0.107.3
# guard, which refuses a push to a foreign BookLang but does not write LL. Eleven are foreign editions (publisher, ISBN
# group and description agree with the tag): their Wanted format goes Skipped (LL unqueueBook). One tag is wrong:
# ESS3mAEACAAJ "Life, the Universe and Everything" is Pan/Tor UK (ISBN 0330508571), English; BookLang iw -> en, stays Wanted.
# Backup first: /config/lazylibrarian.db.pre-f10-langwants-20261005. Undo: queueBook the same id/type; BookLang back to iw.
import sqlite3,sys,os,configparser,urllib.request,urllib.parse
GO='--go' in sys.argv
SKIP=[('Vl3_swEACAAJ','tr','eBook'),('_tiYRR30oe0C','de','eBook'),('a4toDwAAQBAJ','de','eBook'),('31wuzwEACAAJ','it','eBook'),
      ('aBz-CgAAQBAJ','de','eBook'),('IBCmEAAAQBAJ','fr','eBook'),('c3GpCwAAQBAJ','nl','eBook'),('1P53DwAAQBAJ','de','eBook'),
      ('O_t3jgEACAAJ','it','eBook'),('m2B70QEACAAJ','it','AudioBook'),('Jf1GDQAAQBAJ','fr','AudioBook')]
FIX=('ESS3mAEACAAJ','iw','en')
db=sqlite3.connect('/config/lazylibrarian.db',timeout=60)
bad=[]
for i,lang,t in SKIP:
    r=db.execute('select BookLang,Status,AudioStatus from books where BookID=?',(i,)).fetchone()
    if r is None or r[0]!=lang or (r[1] if t=='eBook' else r[2])!='Wanted': bad.append((i,r))
r=db.execute('select BookLang,Status,BookIsbn from books where BookID=?',(FIX[0],)).fetchone()
if r!=(FIX[1],'Wanted','0330508571'): bad.append((FIX[0],r))
if bad: sys.exit('refused: %r'%bad)
print('preconditions OK:',len(SKIP),'to Skip, 1 tag fix')
if not GO: sys.exit('dry run; re-run with --go')
bk='/config/lazylibrarian.db.pre-f10-langwants-20261005'; assert not os.path.exists(bk)
b=sqlite3.connect(bk); db.backup(b); b.close()
with db: db.execute('update books set BookLang=? where BookID=? and BookLang=?',(FIX[2],FIX[0],FIX[1]))
db.close()
c=configparser.RawConfigParser(); c.read('/config/config.ini'); key=c.get('API','api_key')
for i,lang,t in SKIP:
    print(i,t,urllib.request.urlopen('http://localhost:5299/api?'+urllib.parse.urlencode({'apikey':key,'cmd':'unqueueBook','id':i,'type':t}),timeout=60).read().decode()[:10])
db=sqlite3.connect('file:/config/lazylibrarian.db?mode=ro',uri=True)
left=db.execute("select BookID,BookName,BookLang,Status,AudioStatus from books where (Status='Wanted' or AudioStatus='Wanted') and coalesce(BookLang,'') not in ('en','eng','English','Unknown','','XXX') and lower(BookLang) not like 'en-%'").fetchall()
print('foreign-language records still Wanted:',left)
print(db.execute('select BookID,BookLang,Status from books where BookID=?',(FIX[0],)).fetchone())
