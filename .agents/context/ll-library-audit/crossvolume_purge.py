# Owed check (m) of the 2026-10-05 cross-volume repair: delete the holding folder
# books/quarantine/crossvolume-2026-10-05/ per its sort.jsonl. Run INSIDE the LazyLibrarian pod (it mounts the library rw):
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/crossvolume_purge.py          # dry run
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - --go < .agents/context/ll-library-audit/crossvolume_purge.py     # delete
# Add --md5 to re-verify every file against the manifest first (reads ~9 GB). It refuses to delete when a file is not in
# sort.jsonl, its size changed, its category is not one of the five, an LL book row points into the folder, or (for a
# duplicate or redundant omnibus) a counterpart title folder named in sort.jsonl no longer holds a book file of that kind.
import os,sys,json,hashlib,shutil,sqlite3
B='/data/cephfs-hdd/data/media/books/'; H=B+'quarantine/crossvolume-2026-10-05/'
DELETE={'duplicate','foreign_f10','omnibus_redundant','off_catalog','corrupt'}
GO='--go' in sys.argv; MD5='--md5' in sys.argv
KEEP=('manifest.jsonl','sort.jsonl')
if not os.path.isdir(H): sys.exit('holding folder is already gone: nothing to do')
rows={}
for l in open(H+'sort.jsonl'):
    r=json.loads(l); rows[r['path']]=r
bad=[]; plan=[]; by={}
for root,ds,fs in os.walk(H):
    for f in fs:
        p=os.path.join(root,f); rel=p.replace(B,'')
        if root.rstrip('/')==H.rstrip('/') and f in KEEP: continue
        r=rows.get(rel)
        if not r: bad.append(('not in sort.jsonl',rel)); continue
        if r['category'] not in DELETE: bad.append(('category '+str(r['category']),rel)); continue
        if os.path.getsize(p)!=r['size']: bad.append(('size changed',rel)); continue
        if MD5:
            h=hashlib.md5()
            with open(p,'rb') as fh:
                for b in iter(lambda: fh.read(1<<22),b''): h.update(b)
            if h.hexdigest()!=r['md5']: bad.append(('md5 changed',rel)); continue
        if r['category'] in ('duplicate','omnibus_redundant'):
            want=('.mp3','.m4b','.m4a','.flac') if rel.lower().endswith(('.mp3','.m4b','.m4a','.flac')) else ('.epub','.mobi','.azw3','.pdf','.azw')
            gone=[c for c in r.get('counterparts') or [None] if not c or not os.path.isdir(B+c) or not any(x.lower().endswith(want) for x in os.listdir(B+c))]
            if gone: bad.append(('counterpart copy missing '+str(gone),rel)); continue
        plan.append(p); c=by.setdefault(r['category'],[0,0]); c[0]+=1; c[1]+=r['size']
db=sqlite3.connect('file:/config/lazylibrarian.db?mode=ro',uri=True)
refs=db.execute("select BookID,BookFile,AudioFile from books where BookFile like ? or AudioFile like ?",('%quarantine/crossvolume-2026-10-05/%',)*2).fetchall()
for r in refs: bad.append(('LL row points here',str(r)))
print('to delete:',{k:(v[0],'%.2f GB'%(v[1]/1e9)) for k,v in by.items()},'| files',len(plan),'| sorted rows',len(rows))
if bad:
    for b in bad[:20]: print('REFUSE',*b)
    sys.exit('refused: %d problem(s); nothing deleted'%len(bad))
if not GO:
    print('dry run OK; re-run with --go to delete'); sys.exit(0)
keep='/config/crossvolume-2026-10-05/'
os.makedirs(keep,exist_ok=True)
for f in KEEP: shutil.copy2(H+f,keep+f)
for p in plan: os.remove(p)
for root,ds,fs in os.walk(H,topdown=False):
    for f in fs:
        if f in KEEP and root.rstrip('/')==H.rstrip('/'): os.remove(os.path.join(root,f))
    os.rmdir(root)
print('deleted %d files and the holding folder; manifest and sort kept in %s'%(len(plan),keep))
