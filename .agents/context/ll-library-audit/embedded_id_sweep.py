import os,re,json,sys,zipfile
m=json.load(sys.stdin); stale=set(m); true=set(m.values())
out=[]
for dp,dn,fn in os.walk('/data/cephfs-hdd/data/media/books/EBooks'):
    for f in fn:
        if not f.lower().endswith('.epub'): continue
        p=os.path.join(dp,f)
        try:
            z=zipfile.ZipFile(p)
            for n in z.namelist():
                if n.endswith('.opf'):
                    x=z.read(n).decode('utf8','replace')
                    ids=re.findall(r'<dc:identifier[^>]*>\s*([^<]+?)\s*<',x)
                    for i in ids:
                        i2=i.split(':')[-1]
                        if i2 in stale or i2 in true:
                            t=re.findall(r'<dc:title[^>]*>(.*?)</dc:title>',x)
                            out.append({'p':p.split('/EBooks/')[1],'id':i2,'kind':'stale' if i2 in stale else 'true','title':t[0][:60] if t else ''})
                    break
        except Exception: pass
json.dump(out,sys.stdout)
