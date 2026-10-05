# Classifier that wrote books/quarantine/crossvolume-2026-10-05/sort.jsonl (2026-10-05). Run inside the LazyLibrarian pod:
#   kubectl exec -i -n downloads deploy/lazylibrarian -c app -- python3 - < .agents/context/ll-library-audit/crossvolume_sort.py
# Classify every file in the 2026-10-05 holding folder (one category each) and write sort.jsonl next to the manifest.
# The F10 foreign-edition sweep (f10_foreign_hold.py, 2026-10-05 ~21:25Z) appended its own rows; this rule reproduces them.
import json,os,collections
B='/data/cephfs-hdd/data/media/books/'; H=B+'quarantine/crossvolume-2026-10-05/'
def cat(src,reason,fn):
    s=src+'/'+fn
    if reason.startswith('F10 2026-10-05 foreign-edition sweep: '): return 'foreign_f10',reason.split(': ',1)[1]+', F10'  # f10_foreign_hold.py
    if src=='EBooks/Dean Koontz/Dean Koontzs Frankenstein': return 'omnibus_redundant','Frankenstein 5-Book Bundle: all five volumes held in their own folders'
    if src=='AudioBooks/John Grisham/The Firm':
        if fn=='metadata.json': return 'off_catalog','stale 2024 in-folder Audiobookshelf metadata.json'
        if fn.lower().endswith('.mp3'): return 'duplicate','The Runaway Jury track, byte-identical to its copy in The Runaway Jury/ (the other 2 replaced corrupt copies there)'
        return None,'UNCLASSIFIED'
    if src=='AudioBooks/John Grisham/The Runaway Jury':
        if fn=='metadata.json': return 'off_catalog','stale 2026-06-29 in-folder Audiobookshelf metadata.json titled The Firm'
        if fn.lower().endswith('.mp3'): return 'off_catalog','corrupt copy (about 250 KB zeroed), replaced in The Runaway Jury/ by an intact copy'
        return None,'UNCLASSIFIED'
    if src=='AudioBooks/John Grisham/Firm':
        if fn.lower().endswith('.mp3'): return 'duplicate','incomplete fragments (discs 10-14) of The Firm; The Firm/ holds the complete 15.0 h copy'
        return 'off_catalog','sidecar of the removed fragments folder'
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
import re
DW=[(r'Discworld Part \d+ of 136\.mp3$','Jingo'),(r'Discworld Part \d+ of 36\.mp3$','Snuff'),(r' - Pyramids\.mp3$','Pyramids'),
    (r' - Going Postal\.mp3$','Going Postal'),(r'Witches Abroad','Witches Abroad'),(r'Light Fantastic','The Light Fantastic'),
    (r'Small Gods','Small Gods'),(r'Maskerade','Maskerade - (Discworld Novel 18) (Discworld Novels) by Terry Pratchett'),
    (r'Sourcery','Sourcery'),(r' Eric - ','Eric'),(r'Night Watch','Night Watch'),(r'Thud!','Thud!'),
    (r'Unseen Academicals','Unseen Academicals'),(r'Wyrd Systers','Wyrd Sisters'),(r'Equal Rights','Equal Rites')]
def counterparts(src,fn,c):
    if c=='duplicate':
        if src.startswith('AudioBooks/Terry Pratchett/'):
            t=[f for p,f in DW if re.search(p,fn)]
            return ['AudioBooks/Terry Pratchett/'+t[0]] if len(t)==1 else None
        if src.startswith('EBooks/Terry Pratchett/'): return ['EBooks/Terry Pratchett/Making Money']
        if 'The Infernal Devices' in src: return ['AudioBooks/Cassandra Clare/Clockwork Prince']
    if c=='duplicate' and src=='AudioBooks/John Grisham/The Firm': return ['AudioBooks/John Grisham/The Runaway Jury']
    if c=='duplicate' and src=='AudioBooks/John Grisham/Firm': return ['AudioBooks/John Grisham/The Firm']
    if c=='omnibus_redundant' and 'Dean Koontz' in src: return ['EBooks/Dean Koontz/'+x for x in ('Prodigal Son','City of Night','Dead and Alive (Dean Koontzs Frankenstein Book 3)','Lost Souls','The Dead Town')]
    if c=='omnibus_redundant':
        if 'Shatter Me' in src: return ['EBooks/Tahereh Mafi/'+x for x in ('Shatter Me','Destroy Me','Unravel Me','Fracture Me','Ignite Me')]
        if 'Inheritance' in src: return ['EBooks/Christopher Paolini/'+x for x in ('Eragon','Eldest','Brisingr')]
        if src.endswith('E.L. James/Grey'): return ['EBooks/E.L. James/Grey','EBooks/E.L. James/Darker']
    return []
rows=[]; seen=set()
M=[json.loads(l) for l in open(H+'manifest.jsonl')]
moved_on={d['src'] for d in M if d['op'] in ('rehome','hold','delete')}
for d in M:
    if d['op']!='hold' or d['dst'] in moved_on: continue
    src,fn=d['src'].rsplit('/',1)
    c,ev=cat(src,d['reason'],fn)
    cp=counterparts(src,fn,c) if c else []
    if cp is None: c,ev=None,'UNMAPPED duplicate: no title folder'
    rows.append({'path':d['dst'],'size':d['size'],'md5':d['md5'],'category':c,'evidence':ev,'record':d['record'],'counterparts':cp or []}); seen.add(d['dst'])
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
print({k:(c[k],round(s[k]/1e9,2)) for k in c},'with counterparts',sum(1 for r in rows if r['counterparts']), 'unclassified',sum(1 for r in rows if not r['category']),'extra',extra[:5],'missing',missing[:5])
g=collections.Counter((r['category'],r['path'].rsplit('/',1)[0].replace('quarantine/crossvolume-2026-10-05/','')) for r in rows)
for (k,p),n in sorted(g.items()): print('%-18s %4d  %s'%(k,n,p))
