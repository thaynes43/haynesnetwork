# Library-wide sidecar check: walks every .opf under EBooks and AudioBooks and prints JSON rows of
# [path, opf title, GoogleBooks id, best title match against folder and file name (0 to 1), mtime].
# A score under 0.75 means the sidecar names a different book than the folder holds.
#   kubectl -n downloads exec -i deploy/lazylibrarian -c app -- python3 - < opfwalk.py > opfwalk.json
import os,re,unicodedata,collections,difflib,json,sys
TH=.75
STOP={'the','a','an','of','and','book','vol','volume','part','series','novel','edition','unabridged','abridged','illustrated','de','der','die','das','und','le','la','by','bk'}
SYN={'mister':'mr','versus':'vs','doctor':'dr','saint':'st'}
def norm(s):
    s=unicodedata.normalize('NFKD',s or '')
    s=s.encode('ascii','ignore').decode().lower().replace('&',' and ')
    s=re.sub(r"['’`]",'',s)
    s=re.sub(r'[\(\[][^\)\]]*[\)\]]',' ',s)
    s=re.sub(r"[^a-z0-9]+",' ',s)
    return s.strip()
def toks(s): return [SYN.get(t,t) for t in norm(s).split() if t not in STOP]
def nonlatin(s):
    if not s: return False
    letters=[c for c in s if c.isalpha()]
    return bool(letters) and sum(1 for c in letters if ord(c)>0x24f)/len(letters)>.5
def title_ok(m,r):
    a,b=toks(m),toks(r)
    if not a or not b: return None
    A,B=set(a),set(b)
    inter=len(A&B); c=inter/min(len(A),len(B)); j=inter/len(A|B)
    ja,jb=' '.join(a),' '.join(b)
    rt=difflib.SequenceMatcher(None,ja,jb).ratio()
    if ja==jb: return 1.0
    if (ja in jb or jb in ja) and min(len(ja),len(jb))>=4: return 0.9
    if rt>=.8: return rt
    if c>=.99 and j>=.3: return .8
    if c>=.8 and j>=.5: return .75
    return min(max(rt,j),0.59)

out=[]
for root in ("/data/cephfs-hdd/data/media/books/EBooks","/data/cephfs-hdd/data/media/books/AudioBooks"):
    for dp,dn,fn in os.walk(root):
        for f in fn:
            if not f.endswith('.opf'): continue
            p=os.path.join(dp,f)
            try: t=open(p,errors='replace').read(6000)
            except Exception: continue
            m=re.search(r'<dc:title>(.*?)</dc:title>',t,re.S); title=m.group(1) if m else ''
            ids=re.findall(r'<dc:identifier[^>]*scheme="GoogleBooks"[^>]*>([^<]+)<',t)
            fold=os.path.basename(dp); stem=os.path.splitext(f)[0]
            sc=max(title_ok(title,fold) or 0, title_ok(title,stem) or 0)
            st=os.stat(p)
            out.append((p.replace('/data/cephfs-hdd/data/media/books/',''),title,ids[0] if ids else '',round(sc,2),int(st.st_mtime)))
json.dump(out,sys.stdout)
