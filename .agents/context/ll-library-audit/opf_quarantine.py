import json,sys,os,hashlib,time,re
BASE='/data/cephfs-hdd/data/media/books/'
Q=BASE+'quarantine/opf-stamps-2026-09-29/'
items=json.load(sys.stdin)
os.makedirs(Q,exist_ok=True)
man=open(Q+'manifest.jsonl','a')
moved=skipped=0
for rel,title,gb,score,mtime in items:
    src=BASE+rel
    if not os.path.isfile(src): skipped+=1; continue
    t=open(src,errors='replace').read(8000)
    m=re.search(r'<dc:title>(.*?)</dc:title>',t,re.S)
    ids=re.findall(r'<dc:identifier[^>]*scheme="GoogleBooks"[^>]*>([^<]+)<',t)
    # re-verify the file is still the stamped one we listed
    if (m.group(1) if m else '')!=title or (ids[0] if ids else '')!=gb: skipped+=1; continue
    dst=Q+rel
    os.makedirs(os.path.dirname(dst),exist_ok=True)
    st=os.stat(src)
    h=hashlib.sha256(open(src,'rb').read()).hexdigest()
    os.rename(src,dst)
    os.chown(dst,st.st_uid,st.st_gid)
    man.write(json.dumps({'from':src,'to':dst,'stamped_title':title,'stamped_gb_id':gb,'sha256':h,'mtime':int(st.st_mtime),'moved_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})+'\n')
    moved+=1
man.close()
for dp,dn,fn in os.walk(Q):
    os.chown(dp,1000,1000)
os.chown(Q+'manifest.jsonl',1000,1000)
print(json.dumps({'moved':moved,'skipped':skipped}))
