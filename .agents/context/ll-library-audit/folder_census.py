import os,re,json,sqlite3,unicodedata,difflib,collections,sys
ROOT="/data/cephfs-hdd/data/media/books/EBooks"
EXT=('.epub','.mobi','.pdf','.azw3','.azw')
STOP={'the','a','an','of','and','book','vol','volume','part','series','novel','edition','unabridged','abridged','illustrated','by','bk'}
def norm(s):
    s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower().replace('&',' and ')
    s=re.sub(r"['’`]",'',s); s=re.sub(r'[\(\[][^\)\]]*[\)\]]',' ',s); s=re.sub(r"[^a-z0-9]+",' ',s); return s.strip()
def toks(s): return [t for t in norm(s).split() if t not in STOP]
def sim(a,b):
    a,b=' '.join(toks(a)),' '.join(toks(b))
    if not a or not b: return 0
    if a==b: return 1
    if (a in b or b in a) and min(len(a),len(b))>=4: return .9
    return difflib.SequenceMatcher(None,a,b).ratio()
c=sqlite3.connect("file:/config/lazylibrarian.db?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=[dict(r) for r in c.execute("select b.BookID,b.BookName,b.Status,b.AudioStatus,b.BookFile,b.BookLibrary,b.AuthorID,a.AuthorName from books b left join authors a on a.AuthorID=b.AuthorID")]
byid={r['BookID']:r for r in rows}
byfolder=collections.defaultdict(list)
for r in rows:
    if r['BookFile'] and r['BookFile'].startswith(ROOT): byfolder[os.path.dirname(r['BookFile'])].append(r['BookID'])
byauthor=collections.defaultdict(list)
for r in rows: byauthor[norm(r['AuthorName'])].append(r)
out=[]
for a in sorted(os.listdir(ROOT)):
    ad=os.path.join(ROOT,a)
    if not os.path.isdir(ad): continue
    for t in sorted(os.listdir(ad)):
        fd=os.path.join(ad,t)
        if not os.path.isdir(fd): continue
        files=os.listdir(fd)
        eb=[f for f in files if f.lower().endswith(EXT)]
        opfs=[]
        for f in files:
            if f.endswith('.opf'):
                txt=open(os.path.join(fd,f),errors='replace').read(8000)
                m=re.search(r'<dc:title>(.*?)</dc:title>',txt,re.S)
                ids=re.findall(r'<dc:identifier[^>]*scheme="GoogleBooks"[^>]*>([^<]+)<',txt)
                opfs.append({'f':f,'title':m.group(1) if m else '','gb':ids[0] if ids else '','score':round(max(sim(m.group(1) if m else '',t),sim(m.group(1) if m else '',os.path.splitext(f)[0])),2),'mtime':int(os.stat(os.path.join(fd,f)).st_mtime)})
        linked=byfolder.get(fd,[])
        # candidate own row by author+title
        cands=[]
        for r in byauthor.get(norm(a),[]):
            s=sim(r['BookName'],t)
            if s>=.8: cands.append((round(s,2),r['BookID']))
        cands.sort(reverse=True)
        out.append({'dir':a+'/'+t,'ebooks':eb,'opfs':opfs,'linked':linked,'cands':cands[:3]})
json.dump(out,sys.stdout)
