import os,sys,json,hashlib
A='/data/cephfs-hdd/data/media/books/AudioBooks/'
AUD=('.mp3','.m4b','.m4a','.flac')
def md5(p):
    h=hashlib.md5()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1<<22),b''): h.update(b)
    return h.hexdigest()
jobs=json.load(sys.stdin)
for j in jobs:
    src=A+j['src']; tgt=A+j['tgt']
    sel=[f for f in os.listdir(src) if f.lower().endswith(AUD) and any(k.lower() in f.lower() for k in j['names'])] if j.get('names') else []
    tf=[f for f in os.listdir(tgt) if f.lower().endswith(AUD)] if os.path.isdir(tgt) else []
    tsz={}
    for f in tf: tsz.setdefault(os.path.getsize(tgt+'/'+f),[]).append(f)
    same=0; hashed=0
    for f in sel:
        sz=os.path.getsize(src+'/'+f)
        if sz in tsz:
            h=md5(src+'/'+f)
            if any(md5(tgt+'/'+g)==h for g in tsz[sz]): same+=1
    print(json.dumps({'src':j['src'],'sel':len(sel),'sel_mb':round(sum(os.path.getsize(src+'/'+f) for f in sel)/1e6),'tgt':j['tgt'],'tgt_exists':os.path.isdir(tgt),'tgt_n':len(tf),'tgt_mb':round(sum(os.path.getsize(tgt+'/'+f) for f in tf)/1e6),'identical_in_tgt':same,'sample':sel[:2],'tgt_sample':sorted(tf)[:3]}))
