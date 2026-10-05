# Classifier that wrote books/quarantine/crossvolume-2026-10-05/sort.jsonl (2026-10-05). Run inside the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/crossvolume_sort.py
# Classify every file in the 2026-10-05 holding folder (one category each) and write sort.jsonl next to the manifest.
import json,os,collections
B='/data/cephfs-hdd/data/media/books/'; H=B+'quarantine/crossvolume-2026-10-05/'
def cat(src,reason,fn):
    s=src+'/'+fn
    if reason.startswith('F10') and 'Schattenj' in src: return 'foreign_f10','German edition (or its sidecar), F10; English Shadowhunter\'s Codex is its own record'
    if src.endswith('Terry Pratchetts Discworld'):
        if fn.lower().endswith(('.mp3','.epub')): return 'duplicate','own title folder holds a copy of matching length (Making Money/, and each Discworld novel\'s folder)'
        return 'off_catalog','sidecar of the removed Discworld record folder'
    if 'The Infernal Devices' in src: return 'duplicate','Clockwork Prince/ (15.58 h) and the boxed set\'s Book 2 m4b hold it'
    if 'Hebrew' in reason: return 'foreign_f10','foreign edition (Hebrew), F10; English Mistborn 1 is at EBooks/Brandon Sanderson/Mistborn/'
    if 'This Woven Kingdom' in src or 'Chroniken der Unterwelt' in src or 'City of Heavenly Fire' in src:
        if fn.endswith('.pdf') and 'Chroniken der Unterwelt - Cassandra Clare' in fn: return 'off_catalog','one-page usenet-board advert pdf'
        return 'foreign_f10','German edition (or its sidecar), F10; English held under its own record'
    if 'Shatter Me' in src: return 'omnibus_redundant','Shatter Me Complete Collection: Shatter Me, Destroy Me, Unravel Me, Fracture Me, Ignite Me all held in English'
    if 'Inheritance' in src: return 'omnibus_redundant','Inheritance Cycle Omnibus: Eragon (mobi, en), Eldest, Brisingr (azw3, en) all held'
    if src.endswith('E.L. James/Grey'):
        if fn.endswith('.epub'): return 'omnibus_redundant','Grey + Darker omnibus: Grey (mobi) and Darker held'
        if fn.endswith('.pdf'): return 'off_catalog','"Master of the Universe" fan fiction'
        if fn.endswith('.azw3'): return 'off_catalog','Fifty Shades of Grey eBook: no LL record and no app request (its audiobook is held)'
    return None,'UNCLASSIFIED'
rows=[]; seen=set()
for l in open(H+'manifest.jsonl'):
    d=json.loads(l)
    if d['op']!='hold': continue
    src,fn=d['src'].rsplit('/',1)
    c,ev=cat(src,d['reason'],fn)
    rows.append({'path':d['dst'],'size':d['size'],'md5':d['md5'],'category':c,'evidence':ev,'record':d['record']}); seen.add(d['dst'])
present=set()
for root,ds,fs in os.walk(H):
    for f in fs: present.add(os.path.join(root,f).replace(B,''))
extra=sorted(present-seen-{'quarantine/crossvolume-2026-10-05/manifest.jsonl','quarantine/crossvolume-2026-10-05/sort.jsonl'})
missing=sorted(seen-present)
with open(H+'sort.jsonl','w') as f:
    for r in rows: f.write(json.dumps(r,ensure_ascii=False)+'\n')
os.chown(H+'sort.jsonl',1000,1000)
c=collections.Counter(r['category'] for r in rows); s=collections.Counter()
for r in rows: s[r['category']]+=r['size']
print({k:(c[k],round(s[k]/1e9,2)) for k in c}, 'unclassified',sum(1 for r in rows if not r['category']),'extra',extra[:5],'missing',missing[:5])
g=collections.Counter((r['category'],r['path'].rsplit('/',1)[0].replace('quarantine/crossvolume-2026-10-05/','')) for r in rows)
for (k,p),n in sorted(g.items()): print('%-18s %4d  %s'%(k,n,p))
