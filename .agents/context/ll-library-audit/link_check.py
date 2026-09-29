import sqlite3,json,os,re,unicodedata,difflib,sys
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
pre={r[0]:r for r in json.load(open('/tmp/books_prescan.json'))}
c=sqlite3.connect('file:/config/lazylibrarian.db?mode=ro',uri=True)
out=[]
for r in c.execute("select b.BookID,b.BookName,a.AuthorName,b.Status,b.BookFile from books b join authors a on a.AuthorID=b.AuthorID where b.BookFile like '/data/cephfs-hdd/data/media/books/EBooks/%'"):
    bid,name,auth,st,bf=r
    p=pre.get(bid)
    changed = (p is None) or (p[5]!=bf)
    folder=os.path.basename(os.path.dirname(bf)); stem=os.path.splitext(os.path.basename(bf))[0]
    s=max(sim(name,folder),sim(name,stem))
    out.append({'id':bid,'name':name,'author':auth,'status':st,'file':bf.split('/EBooks/')[1],'score':round(s,2),'changed':changed,'new':p is None,'pre_status':p[3] if p else None,'pre_file':(p[5] or '').split('/EBooks/')[-1] if p else None})
json.dump(out,sys.stdout)
