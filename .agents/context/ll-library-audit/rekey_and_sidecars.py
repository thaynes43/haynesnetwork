import os,re,json,sys,time,hashlib,sqlite3,unicodedata,difflib
DRY = sys.argv[1]=='dry'
cfg=json.load(open('/tmp/phase2_ids.json')); corrupt=cfg['corrupt']; merges=set(cfg['merges'])
B='/data/cephfs-hdd/data/media/books/'
Q=B+'quarantine/opf-stamps-2026-09-29/phase2/'
FUZZ=['J.K. Rowling/Hogwarts - An Incomplete and Unreliable Guide','Frank Herbert/Destination - Void',
 'Philip Pullman/La Belle Sauvage - The Book of Dust Volume One','Rick Riordan/The Hidden Oracle','Cassandra Clare/The Lost Herondale',
 'Roald Dahl/The Enormous Crocodile','Roald Dahl/Esio Trot','George R.R. Martin/Busted Flush','George R.R. Martin/Jokers Wild',
 'Terry Pratchett/The Last Hero - A Discworld Fable','Terry Pratchett/The Science Of Discworld','Veronica Roth/Allegiant']
# Inheritance folder name is long; resolve by prefix
for d in os.listdir(B+'EBooks/Christopher Paolini'):
    if d.startswith('Inheritance - Book Four'): FUZZ.append('Christopher Paolini/'+d)
STOP={'the','a','an','of','and','book','vol','volume','part','series','novel','edition','by','bk'}
def norm(s):
    s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower().replace('&',' and ')
    s=re.sub(r"['’`]",'',s); s=re.sub(r'[\(\[][^\)\]]*[\)\]]',' ',s); s=re.sub(r"[^a-z0-9]+",' ',s); return ' '.join(t for t in s.split() if t not in STOP)
def sim(a,b):
    a,b=norm(a),norm(b)
    if not a or not b: return 0
    if a==b: return 1
    if (a in b or b in a) and min(len(a),len(b))>=4: return .9
    return difflib.SequenceMatcher(None,a,b).ratio()
log={'rewrite':[],'quarantine':[],'ignore':[],'db':[]}
man=None if DRY else open(Q+'manifest.jsonl','a') if os.path.isdir(Q) else None
if not DRY:
    os.makedirs(Q,exist_ok=True); man=open(Q+'manifest.jsonl','a')
def quarantine(p,why):
    rel=p[len(B):]; dst=Q+rel
    log['quarantine'].append((rel,why))
    if DRY: return
    os.makedirs(os.path.dirname(dst),exist_ok=True)
    h=hashlib.sha256(open(p,'rb').read()).hexdigest(); os.rename(p,dst)
    man.write(json.dumps({'from':p,'to':dst,'sha256':h,'why':why,'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})+'\n')
# 1. sidecars carrying a corrupted id
fuzzdirs={B+'EBooks/'+f for f in FUZZ}
for root in ('EBooks','AudioBooks'):
    for dp,dn,fn in os.walk(B+root):
        for f in fn:
            if not f.endswith('.opf'): continue
            p=os.path.join(dp,f); t=open(p,errors='replace').read()
            ids=[i.strip() for i in re.findall(r'<dc:identifier[^>]*>([^<]+)<',t)]
            hit=[i for i in ids if i in corrupt]
            ti=re.search(r'<dc:title>(.*?)</dc:title>',t,re.S); title=ti.group(1) if ti else ''
            folder=os.path.basename(dp)
            if hit:
                s=hit[0]
                if sim(title,folder)>=.75 or sim(title,os.path.splitext(f)[0])>=.75:
                    log['rewrite'].append((p[len(B):],s,corrupt[s]))
                    if not DRY:
                        st=os.stat(p); new=t.replace('>'+s+'<','>'+corrupt[s]+'<')
                        open(p+'.tmp','w').write(new); os.chown(p+'.tmp',st.st_uid,st.st_gid); os.chmod(p+'.tmp',st.st_mode&0o777); os.replace(p+'.tmp',p)
                        man.write(json.dumps({'rewrote':p,'id_from':s,'id_to':corrupt[s],'sha256_before':hashlib.sha256(t.encode()).hexdigest(),'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})+'\n')
                else:
                    quarantine(p,f'carries corrupted id {s} with another book\'s title ({title})')
            elif dp in fuzzdirs and sim(title,folder)<.75:
                quarantine(p,f'fuzzy mis-match sidecar ({title}) in a folder LL now ignores')
# 2. .ll_ignore the fuzzy-trap folders
for f in FUZZ:
    d=B+'EBooks/'+f; assert os.path.isdir(d),d
    log['ignore'].append(f)
    if not DRY:
        open(d+'/.ll_ignore','w').write('haynes-ops repair 2026-09-29 (thaynes43/haynesnetwork#631): LazyLibrarian fuzzy-matches this book to another row; remove this file once LL has an exact row for it.\n')
        os.chown(d+'/.ll_ignore',1000,1000)
if man: man.close()
if not DRY:
    for dp,dn,fn in os.walk(Q): os.chown(dp,1000,1000)
    os.chown(Q+'manifest.jsonl',1000,1000)
# 3. DB
c=sqlite3.connect('/config/lazylibrarian.db' if not DRY else 'file:/config/lazylibrarian.db?mode=ro',uri=DRY,timeout=60)
c.row_factory=sqlite3.Row
pre={r[0]:r for r in json.load(open('/tmp/books_prescan.json'))}
def row(i):
    r=c.execute('select BookID,BookName,Status,AudioStatus,BookFile,AudioFile,BookLibrary,AudioLibrary from books where BookID=?',(i,)).fetchone(); return dict(r) if r else None
def act(sql,args):
    if not DRY: c.execute(sql,args)
if not DRY: c.execute('PRAGMA foreign_keys = OFF')
for s,t in corrupt.items():
    rs,rt=row(s),row(t)
    if s not in merges:
        assert rt is None,(s,t)
        log['db'].append({'op':'rekey','from':s,'to':t,'before':rs})
        for tb in ('books','wanted','bookauthors'): act(f'UPDATE {tb} SET BookID=? WHERE BookID=?',(t,s))
    else:
        assert rt is not None
        upd={}
        if rs['BookFile'] and os.path.isfile(rs['BookFile']) and rs['Status'] in ('Open','Have') and (rt['Status'] not in ('Open','Have') or not rt['BookFile']):
            upd.update(Status=rs['Status'],BookFile=rs['BookFile'],BookLibrary=rs['BookLibrary'] or rt['BookLibrary'])
        if s!='a5W-i1wdyk8C' and rs['AudioFile'] and os.path.isfile(rs['AudioFile']) and rs['AudioStatus'] in ('Open','Have') and (rt['AudioStatus'] not in ('Open','Have') or not rt['AudioFile']):
            upd.update(AudioStatus=rs['AudioStatus'],AudioFile=rs['AudioFile'],AudioLibrary=rs['AudioLibrary'] or rt['AudioLibrary'])
        log['db'].append({'op':'merge','from':s,'into':t,'stale_row':rs,'true_row_before':rt,'set':upd})
        if upd: act('UPDATE books SET '+','.join(f'{k}=?' for k in upd)+' WHERE BookID=?',(*upd.values(),t))
        act('UPDATE wanted SET BookID=? WHERE BookID=?',(t,s))
        act('UPDATE OR IGNORE bookauthors SET BookID=? WHERE BookID=?',(t,s))
        act('DELETE FROM bookauthors WHERE BookID=?',(s,))
        act('DELETE FROM books WHERE BookID=?',(s,))
# 4. revert fuzzy-wrong row links from the first fixed scan
for bid in ['7O9P486Lcb8C','KHiMEAAAQBAJ','GCD3PwAACAAJ','YVfJMgEACAAJ','btud0AEACAAJ','zksuBQAAQBAJ','6s_qLDNW0kwC']:
    p=pre[bid]; r=row(bid)
    log['db'].append({'op':'revert','id':bid,'now':r,'to':{'Status':p[3],'BookFile':p[5],'BookLibrary':p[7]}})
    act('UPDATE books SET Status=?,BookFile=?,BookLibrary=? WHERE BookID=?',(p[3],p[5] or '',p[7] or '',bid))
ch=[f for f in os.listdir(B+"EBooks/Frank Herbert") if f.startswith('CHARTERHOUSE')][0]
pf=[x for x in os.listdir(B+'EBooks/Frank Herbert/'+ch) if x.endswith('.epub')][0]
pp=B+'EBooks/Frank Herbert/'+ch+'/'+pf
log['db'].append({'op':'set_bookfile','id':'QIF5EAAAQBAJ','before':row('QIF5EAAAQBAJ'),'to':pp})
act('UPDATE books SET BookFile=? WHERE BookID=?',(pp,'QIF5EAAAQBAJ'))
if not DRY:
    c.execute('PRAGMA foreign_keys = ON'); c.commit()
print(json.dumps(log,default=str))
