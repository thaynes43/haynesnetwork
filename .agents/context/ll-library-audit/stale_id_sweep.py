import os,re,json,sys
m=json.load(sys.stdin)
stale=set(m)
out=[]
for root in ('/data/cephfs-hdd/data/media/books/EBooks','/data/cephfs-hdd/data/media/books/AudioBooks'):
    for dp,dn,fn in os.walk(root):
        for f in fn:
            if not f.endswith('.opf'): continue
            p=os.path.join(dp,f)
            t=open(p,errors='replace').read(10000)
            ids=re.findall(r'<dc:identifier[^>]*>([^<]+)<',t)
            hit=[i for i in ids if i.strip() in stale]
            if hit:
                ti=re.search(r'<dc:title>(.*?)</dc:title>',t,re.S)
                out.append({'p':p,'stale':hit[0],'title':ti.group(1) if ti else '','mtime':int(os.stat(p).st_mtime)})
json.dump(out,sys.stdout)
