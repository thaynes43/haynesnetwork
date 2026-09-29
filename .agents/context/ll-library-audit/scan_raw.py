# Dumps one JSON blob of every held book row plus the embedded metadata of every file in those rows' folders.
# Read-only: opens the LazyLibrarian database with mode=ro and files with 'rb'. Run inside the lazylibrarian pod:
#   kubectl -n downloads exec -i deploy/lazylibrarian -c app -- python3 - < scan_raw.py > raw.json
# Metadata read: epub OPF (title, creator, language), mobi/azw3 EXTH (100, 503, 524), ID3v2/v1 (album, artist, title),
# MP4 ilst (m4b, m4a), FLAC vorbis comments. PDFs only when /Title is in the clear.
# Read-only metadata dump for LazyLibrarian book rows. Opens files 'rb' only.
import os, sqlite3, json, zipfile, struct, re, sys, time
from concurrent.futures import ThreadPoolExecutor
import xml.etree.ElementTree as ET

EBK = {'.epub','.mobi','.azw3','.azw','.pdf'}
AUD = {'.mp3','.m4b','.m4a','.flac','.ogg','.opus','.wma'}

def dec(enc, b):
    try:
        if enc==0: return b.decode('latin-1')
        if enc==1: return b.decode('utf-16')
        if enc==2: return b.decode('utf-16-be')
        return b.decode('utf-8')
    except Exception:
        return b.decode('latin-1','replace')

def id3(f):
    f.seek(0); h=f.read(10)
    out={}
    if h[:3]==b'ID3':
        ver=h[3]; size=((h[6]&127)<<21)|((h[7]&127)<<14)|((h[8]&127)<<7)|(h[9]&127)
        flags=h[5]; pos=10
        if flags&0x40 and ver>=3:
            f.seek(10); eh=f.read(4)
            es=struct.unpack('>I',eh)[0] if ver==3 else ((eh[0]&127)<<21)|((eh[1]&127)<<14)|((eh[2]&127)<<7)|(eh[3]&127)
            pos=10+es+(4 if ver==3 else 0)
        end=10+size
        idlen=3 if ver==2 else 4
        mp={'TAL':'album','TALB':'album','TP1':'artist','TPE1':'artist','TP2':'aartist','TPE2':'aartist','TT2':'title','TIT2':'title','TCOM':'composer','TCM':'composer'}
        while pos+idlen+ (3 if ver==2 else 6) <= end:
            f.seek(pos); fh=f.read(idlen+(3 if ver==2 else 6))
            fid=fh[:idlen].decode('latin-1')
            if not fid.strip('\x00'): break
            if ver==2: fs=int.from_bytes(fh[3:6],'big'); hl=6
            elif ver==3: fs=struct.unpack('>I',fh[4:8])[0]; hl=10
            else:
                b=fh[4:8]; fs=((b[0]&127)<<21)|((b[1]&127)<<14)|((b[2]&127)<<7)|(b[3]&127); hl=10
            if fs<=0 or pos+hl+fs>end+1: break
            if fid in mp and fs<4096:
                f.seek(pos+hl); d=f.read(fs)
                if d: 
                    t=dec(d[0],d[1:]).strip('\x00 ').replace('\x00','/')
                    out.setdefault(mp[fid],t)
            pos+=hl+fs
        if out: return out
    # ID3v1
    try:
        f.seek(-128,2); t=f.read(128)
        if t[:3]==b'TAG':
            g=lambda b:b.split(b'\x00')[0].decode('latin-1').strip()
            r={'title':g(t[3:33]),'artist':g(t[33:63]),'album':g(t[63:93])}
            return {k:v for k,v in r.items() if v}
    except Exception: pass
    return out

def mp4(f, size):
    out={}
    def rd(pos,n): f.seek(pos); return f.read(n)
    pos=0; moov=None
    while pos+8<=size:
        h=rd(pos,16); sz=struct.unpack('>I',h[:4])[0]; typ=h[4:8]; hl=8
        if sz==1: sz=struct.unpack('>Q',h[8:16])[0]; hl=16
        elif sz==0: sz=size-pos
        if typ==b'moov': moov=(pos+hl,pos+sz); break
        if sz<8: break
        pos+=sz
    if not moov: return out
    if moov[1]-moov[0]>16*1024*1024: return {'err':'moov too big'}
    data=rd(moov[0],moov[1]-moov[0])
    def kids(b,s,e):
        while s+8<=e:
            sz=struct.unpack('>I',b[s:s+4])[0]; typ=b[s+4:s+8]
            if sz<8 or s+sz>e: break
            yield typ,s+8,s+sz
            s+=sz
    def find(b,s,e,path):
        for typ,cs,ce in kids(b,s,e):
            if typ==path[0]:
                if len(path)==1: return cs,ce
                if typ==b'meta': cs+=4
                r=find(b,cs,ce,path[1:])
                if r: return r
        return None
    r=find(data,0,len(data),[b'udta',b'meta',b'ilst'])
    if not r: return out
    names={b'\xa9alb':'album',b'\xa9ART':'artist',b'aART':'aartist',b'\xa9nam':'title',b'\xa9wrt':'composer'}
    for typ,cs,ce in kids(data,r[0],r[1]):
        if typ in names:
            for t2,c2,e2 in kids(data,cs,ce):
                if t2==b'data':
                    out.setdefault(names[typ],data[c2+8:e2].decode('utf-8','replace').strip())
    return out

def flac(f):
    f.seek(0)
    if f.read(4)!=b'fLaC': return {}
    out={}
    while True:
        h=f.read(4)
        if len(h)<4: break
        last=h[0]&128; t=h[0]&127; n=int.from_bytes(h[1:4],'big')
        if t==4 and n<1<<20:
            d=f.read(n); p=0
            vl=struct.unpack('<I',d[p:p+4])[0]; p+=4+vl
            c=struct.unpack('<I',d[p:p+4])[0]; p+=4
            for _ in range(c):
                l=struct.unpack('<I',d[p:p+4])[0]; p+=4
                kv=d[p:p+l].decode('utf-8','replace'); p+=l
                if '=' in kv:
                    k,v=kv.split('=',1); k=k.lower()
                    m={'album':'album','artist':'artist','albumartist':'aartist','title':'title'}
                    if k in m: out.setdefault(m[k],v)
            break
        f.seek(n,1)
        if last: break
    return out

def mobi(f):
    f.seek(0); hd=f.read(78)
    if hd[60:68] not in (b'BOOKMOBI',b'TEXtREAd'): return {'err':'not palm mobi'}
    n=struct.unpack('>H',hd[76:78])[0]
    ri=f.read(16)
    off0=struct.unpack('>I',ri[:4])[0]; off1=struct.unpack('>I',ri[8:12])[0]
    f.seek(off0); r0=f.read(min(off1-off0,400000))
    if r0[16:20]!=b'MOBI': return {'err':'no MOBI hdr'}
    hlen=struct.unpack('>I',r0[20:24])[0]
    out={}
    fno,fnl=struct.unpack('>II',r0[84:92])
    if 0<fnl<500 and fno+fnl<=len(r0):
        out['title']=r0[fno:fno+fnl].decode('utf-8','replace').strip()
    exflag=struct.unpack('>I',r0[128:132])[0] if len(r0)>=132 else 0
    if exflag&0x40:
        p=16+hlen
        if r0[p:p+4]==b'EXTH':
            cnt=struct.unpack('>I',r0[p+8:p+12])[0]; p+=12
            authors=[]
            for _ in range(cnt):
                if p+8>len(r0): break
                t,l=struct.unpack('>II',r0[p:p+8])
                d=r0[p+8:p+l]; p+=l
                if l<8: break
                if t==100: authors.append(d.decode('utf-8','replace'))
                elif t==503: out['title']=d.decode('utf-8','replace').strip()
                elif t==524: out['lang']=d.decode('utf-8','replace')
                elif t==101: out['pub']=d.decode('utf-8','replace')
            if authors: out['author']=' & '.join(authors)
    return out

def epub(path):
    z=zipfile.ZipFile(path)
    try:
        c=z.read('META-INF/container.xml')
        m=re.search(rb'full-path="([^"]+)"',c)
        opf=m.group(1).decode()
        root=ET.fromstring(z.read(opf))
    finally:
        pass
    ns={'dc':'http://purl.org/dc/elements/1.1/'}
    def g(tag):
        return [ (e.text or '').strip() for e in root.iter('{http://purl.org/dc/elements/1.1/}'+tag)]
    out={}
    t=g('title'); a=g('creator'); l=g('language')
    if t: out['title']=t[0]
    if a: out['author']=' & '.join(x for x in a if x)
    if l: out['lang']=l[0]
    for e in root.iter('{http://www.idpf.org/2007/opf}meta'):
        if e.get('name')=='calibre:series' and e.get('content'): out['series']=e.get('content')
    return out

def pdf(f,size):
    f.seek(0); a=f.read(4096)
    f.seek(max(0,size-8192)); b=f.read(8192)
    m=re.search(rb'/Title\s*\(([^)]{1,200})\)',a+b)
    return {'title':m.group(1).decode('latin-1')} if m else {}

def meta(path):
    ext=os.path.splitext(path)[1].lower()
    try:
        st=os.stat(path)
        r={'size':st.st_size,'mtime':int(st.st_mtime)}
        if ext=='.epub': r.update(epub(path))
        else:
            with open(path,'rb') as f:
                if ext in ('.mobi','.azw3','.azw'): r.update(mobi(f))
                elif ext=='.pdf': r.update(pdf(f,st.st_size))
                elif ext=='.mp3': r.update(id3(f))
                elif ext in ('.m4b','.m4a'): r.update(mp4(f,st.st_size))
                elif ext=='.flac': r.update(flac(f))
        return r
    except Exception as e:
        return {'err':repr(e)[:120]}

c=sqlite3.connect("file:/config/lazylibrarian.db?mode=ro",uri=True); c.row_factory=sqlite3.Row
rows=[dict(r) for r in c.execute("select b.BookID,b.BookName,b.BookSub,b.BookLang,b.SeriesDisplay,b.BookFile,b.AudioFile,b.Status,b.AudioStatus,b.Narrator,a.AuthorName,b.AuthorID from books b left join authors a on a.AuthorID=b.AuthorID")]
allrows=rows
files=set(); dirs_e=set(); dirs_a=set()
for r in rows:
    bf=r['BookFile']; af=r['AudioFile']
    if bf and os.path.exists(bf):
        files.add(bf); dirs_e.add(os.path.dirname(bf))
    if af and os.path.exists(af):
        dirs_a.add(os.path.dirname(af))
for d in dirs_e:
    for e in os.scandir(d):
        if e.is_file() and os.path.splitext(e.name)[1].lower() in EBK|AUD: files.add(e.path)
listing={}
for d in dirs_a:
    fl=[]
    for root,ds,fs in os.walk(d):
        for x in fs:
            if os.path.splitext(x)[1].lower() in AUD: 
                files.add(os.path.join(root,x))
sys.stderr.write(f"rows {len(rows)} files {len(files)} edirs {len(dirs_e)} adirs {len(dirs_a)}\n")
t0=time.time()
res={}
with ThreadPoolExecutor(16) as ex:
    for p,m in zip(sorted(files), ex.map(meta, sorted(files))):
        res[p]=m
sys.stderr.write(f"done {time.time()-t0:.0f}s\n")
# dir file listings for row dirs (all files, names only) for folder-content checks
dl={}
for d in dirs_e|dirs_a:
    try: dl[d]=sorted(os.listdir(d))
    except Exception: pass
json.dump({'rows':rows,'meta':res,'dirs':dl},sys.stdout)
