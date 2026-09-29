# Offline analysis of raw.json + wanted.json (same folder). Writes audit.json and prints class counts.
# Classes: POINTER (row's recorded file is another book's file, its own folder is elsewhere), CONTENT (wrong book in the
# row's own path), LANGEDITION, AUTHOR? (title matches, author tag does not), audio MIXED / NOOWN, plus siblings
# (other-book files in a claimed folder) and dblclaims (one file claimed by two rows).
# Fuzzy title match: token containment plus difflib ratio, series/subtitle/parenthetical tolerant. Expect tag noise
# (swapped title and author, "Unknown") to show up as AUTHOR? or CONTENT and be triaged by hand.
import json,os,re,unicodedata,collections,difflib,sys
d=json.load(open('raw.json')); rows=d['rows']; M=d['meta']; DL=d['dirs']
W=json.load(open('wanted.json'))
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
def rcands(r):
    out=[r['BookName'] or '']
    if r['BookSub']: out.append((r['BookName'] or '')+' '+r['BookSub'])
    return out
def best(m,cands):
    s=[title_ok(m,c) for c in cands]; s=[x for x in s if x is not None]
    return max(s) if s else None
def author_ok(ma,ra):
    if not ma or not ra: return None
    A=set(toks(ma)); R=toks(ra)
    if not R: return None
    return any(t in A or any(t==x for x in A) for t in R if len(t)>=3)
TH=.75
rowby={r['BookID']:r for r in rows}
short=lambda p:p.replace('/data/cephfs-hdd/data/media/books/','')
claimE=collections.defaultdict(list); claimA=collections.defaultdict(list); claimAd=collections.defaultdict(list); claimEd=collections.defaultdict(list)
for r in rows:
    if r['BookFile']: claimE[r['BookFile']].append(r['BookID']); claimEd[os.path.dirname(r['BookFile'])].append(r['BookID'])
    if r['AudioFile']: claimA[r['AudioFile']].append(r['BookID']); claimAd[os.path.dirname(r['AudioFile'])].append(r['BookID'])
def owners(t):
    out=[]
    for r in rows:
        sc=best(t,rcands(r))
        if sc and sc>=.8: out.append((round(sc,2),r['BookID'],r['BookName'],r['AuthorName']))
    return sorted(out,reverse=True)[:3]
res={'ebook':[], 'audio':[], 'dblclaims':[], 'siblings':[], 'summary':{}}
cnt=collections.Counter()
# ---------- ebooks
for r in rows:
    bf=r['BookFile']
    if not bf: continue
    cnt['ebook_rows']+=1
    x=M.get(bf)
    if x is None: res['ebook'].append(dict(cls='MISSING',row=r['BookID'],name=r['BookName'],file=short(bf))); continue
    t=x.get('title')
    if not t: cnt['ebook_nometa']+=1; continue
    if nonlatin(t): cnt['ebook_nonlatin']+=1; cls='LANG'; 
    sc=best(t,rcands(r)); au=author_ok(x.get('author'),r['AuthorName'])
    folder=os.path.basename(os.path.dirname(bf))
    fsc=best(folder,rcands(r)) or 0
    if nonlatin(t):
        res['ebook'].append(dict(cls='LANGEDITION',row=r['BookID'],name=r['BookName'],author=r['AuthorName'],file=short(bf),mtitle=t,claimants=claimE[bf])); continue
    if sc is not None and sc<TH:
        cls='CONTENT' if fsc>=TH else 'POINTER'
        res['ebook'].append(dict(cls=cls,row=r['BookID'],name=r['BookName'],author=r['AuthorName'],file=short(bf),mtitle=t,mauthor=x.get('author'),score=round(sc,2),claimants=claimE[bf],owners=owners(t)))
    elif au is False and sc is not None:
        res['ebook'].append(dict(cls='AUTHOR?',row=r['BookID'],name=r['BookName'],author=r['AuthorName'],file=short(bf),mtitle=t,mauthor=x.get('author'),score=round(sc,2)))
    else: cnt['ebook_ok']+=1
# double claims (ebook & audio file)
for kind,cl in (('ebook',claimE),('audio',claimA)):
    for f,ids in cl.items():
        if len(ids)>1:
            names=[rowby[i]['BookName'] for i in ids]
            same=all((title_ok(names[0],n) or 0)>=TH for n in names[1:])
            res['dblclaims'].append(dict(kind=kind,file=short(f),rows=ids,names=names,same_title=same,statuses=[(rowby[i]['Status'],rowby[i]['AudioStatus']) for i in ids]))
# sibling ebook files in claimed dirs
EBK={'.epub','.mobi','.azw3','.azw','.pdf'}
for dd,ids in claimEd.items():
    if not dd in DL: continue
    for n in DL[dd]:
        p=dd+'/'+n
        if os.path.splitext(n)[1].lower() not in EBK: continue
        x=M.get(p); 
        if not x or not x.get('title') or nonlatin(x['title']): continue
        cands=[c for i in ids for c in rcands(rowby[i])]+[os.path.basename(dd)]
        sc=best(x['title'],cands)
        if sc is not None and sc<TH:
            res['siblings'].append(dict(dir=short(dd),file=n,mtitle=x['title'],mauthor=x.get('author'),claimed_by=[(i,rowby[i]['BookName']) for i in ids],is_bookfile=p in claimE,owners=owners(x['title']),size=x['size']))
# ---------- audio
AUD={'.mp3','.m4b','.m4a','.flac'}
GENERIC={'chapter','track','disc','cd','part','unknown','album','audiobook','audio','unabridged','abridged','intro','introduction','prologue','epilogue','side','file','book','volume','vol','narrated','read','kapitel','teil','vorspann','ungekurzt'}
def informative(tag):
    t=[x for x in toks(tag) if x.isalpha() and len(x)>=3 and x not in GENERIC]
    return bool(t)
def serieslike(tag):
    return bool(re.search(r'(\bbk\b|\bbook\b|\bvol\.?|\bvolume\b|\bpart\b)\s*\d+\s*$|[-–:]\s*\d+\s*$|\s\d+\s*$',tag.strip(),re.I))
byns=collections.defaultdict(list)
for p,x in M.items():
    if os.path.splitext(p)[1].lower() in AUD: byns[(os.path.basename(p),x['size'])].append(p)
audio_rows=0
for r in rows:
    af=r['AudioFile']
    if not af: continue
    audio_rows+=1
    fd=os.path.dirname(af)
    files=[p for p in M if p.startswith(fd+'/') and os.path.splitext(p)[1].lower() in AUD]
    if not files: res['audio'].append(dict(cls='MISSING',row=r['BookID'],name=r['BookName'],file=short(af))); continue
    cands=rcands(r)
    fsc=best(os.path.basename(fd),cands) or 0
    n=len(files)
    own=0; foreign=collections.Counter(); ex={}; unk=0
    for p in files:
        x=M[p]; alb,tt=x.get('album'),x.get('title')
        stem=os.path.splitext(os.path.basename(p))[0]
        tags=[t for t in ([alb]+([tt] if n<=3 else [])) if t]
        matched=False; informative_mismatch=None
        for t in tags:
            sc=best(t,cands)
            if sc and sc>=TH: matched=True;break
        if not matched:
            for t in tags:
                if informative(t) and not serieslike(t): informative_mismatch=t;break
        if matched: own+=1
        elif informative_mismatch: foreign[informative_mismatch]+=1; ex.setdefault(informative_mismatch,p)
        else:
            sc=best(stem,cands)
            if sc and sc>=TH: own+=1
            elif not alb and not tt: unk+=1
            else:
                # tags uninformative/series-like and filename does not match: unknown, count
                unk+=1
    if unk==n: cnt['audio_nometa']+=1; continue
    rec=dict(row=r['BookID'],name=r['BookName'],author=r['AuthorName'],dir=short(fd),folder_matches_row=round(fsc,2),n=n,own=own,unk=unk,foreign=[(k,v,short(ex[k]).split('/')[-1],M[ex[k]]['size'], len({os.path.dirname(q) for q in byns[(os.path.basename(ex[k]),M[ex[k]]['size'])]})) for k,v in foreign.most_common(8)],claimants=claimAd[fd],status=(r['Status'],r['AudioStatus']))
    if not foreign: cnt['audio_ok']+=1; continue
    rec['cls']=('NOOWN' if own==0 else 'MIXED')+('' if fsc>=TH else '_FOREIGNDIR')
    res['audio'].append(rec)
res['summary']=dict(cnt); res['summary']['audio_rows']=audio_rows
json.dump(res,open('audit.json','w'),indent=1,ensure_ascii=False)
print(dict(cnt), 'audio_rows',audio_rows)
print('ebook',collections.Counter(x['cls'] for x in res['ebook']))
print('audio',collections.Counter(x['cls'] for x in res['audio']))
print('dbl',len(res['dblclaims']),'siblings',len(res['siblings']))
