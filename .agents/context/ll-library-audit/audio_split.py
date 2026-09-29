import os,json,sys,time,sqlite3
A='/data/cephfs-hdd/data/media/books/AudioBooks/'
Q='/data/cephfs-hdd/data/media/books/quarantine/audit-631-2026-09-29/AudioBooks/'
ops=json.load(sys.stdin)
ops.sort(key=lambda o:0 if o['op']=='move' else 1)
man=open('/data/cephfs-hdd/data/media/books/quarantine/audit-631-2026-09-29/manifest.jsonl','a')
def mk(d):
    if not os.path.isdir(d):
        mk(os.path.dirname(d)); os.mkdir(d); os.chown(d,1000,1000)
n={'move':0,'quarantine':0,'skip':0}
for o in ops:
    src=A+o['rel']
    if not os.path.isfile(src) or os.path.getsize(src)!=o['size']: n['skip']+=1; print('SKIP',o['rel']); continue
    dst=(A+o['to']) if o['op']=='move' else (Q+o['rel'])
    assert not os.path.exists(dst),dst
    mk(os.path.dirname(dst)); os.rename(src,dst); n[o['op']]+=1
    man.write(json.dumps({'kind':'rehome' if o['op']=='move' else 'quarantine','from':src,'to':dst,'size':o['size'],'why':o['why'],'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})+'\n')
man.close()
print(json.dumps(n))
# DB: point each affected row's AudioFile at its own book's file
c=sqlite3.connect('/config/lazylibrarian.db',timeout=60)
now=time.strftime('%Y-%m-%d %H:%M:%S')
def first(folder,starts):
    fs=sorted(f for f in os.listdir(A+folder) if f.startswith(starts) and f.lower().endswith(('.mp3','.m4b','.m4a')))
    assert fs,(folder,starts); return A+folder+'/'+fs[0]
plan={
 'IaMpAAAACAAJ':first('George R.R. Martin/The Hedge Knight','HK_1-5'),
 '8IhkAgAACAAJ':first('George R.R. Martin/The Hedge Knight','HK_1-5'),
 'BHHhBQAAQBAJ':first('Brandon Sanderson/Shadows of Self','Brandon Sanderson - Shadows of Self 01-29'),
 't_ZYYXZq4RgC':first('Brandon Sanderson/Mistborn','01 The Final Empire'),
 'dlfOfxkm1PoC':first('Brandon Sanderson/Mistborn','01 The Final Empire'),
 'Ow6iEAAAQBAJ':first('Cassandra Clare/Sword Catcher','Cassandra Clare - Sword Catcher Part 01'),
 's3H2EAAAQBAJ':first('Sarah J. Maas/House of Flame and Shadow','House of Flame and Shadow'),
 'TJKmCQAAQBAJ':first('E.L. James/Grey','01 Grey - Part 01'),
 'bg-dAQAACAAJ':first('E.L. James/Grey','01 Grey - Part 01'),
 'r_i4_Lr5fA4C':first('Sarah J. Maas/Throne of Glass','Throne of Glass Part 1'),
 'gil-EAAAQBAJ':first('Sarah J. Maas/Throne of Glass','Throne of Glass Part 1'),
}
log=[]
for bid,p in plan.items():
    b=c.execute('select AudioStatus,AudioFile from books where BookID=?',(bid,)).fetchone()
    c.execute('update books set AudioFile=? where BookID=?',(p,bid)); log.append((bid,b,p.split('/AudioBooks/')[1]))
chbc=A+'Rick Riordan/Camp Half-Blood Confidential/Rick Riordan - Percy Jackson and the Olympians.m4b'
b=c.execute('select AudioStatus,AudioFile from books where BookID=?',('hRQiDgAAQBAJ',)).fetchone()
c.execute("update books set AudioFile=?,AudioStatus='Open',AudioLibrary=? where BookID=?",(chbc,now,'hRQiDgAAQBAJ')); log.append(('hRQiDgAAQBAJ',b,'Open '+chbc.split('/AudioBooks/')[1]))
b=c.execute('select AudioStatus,AudioFile from books where BookID=?',('DyM10QEACAAJ',)).fetchone()
c.execute("update books set AudioFile='',AudioLibrary='',AudioStatus='Skipped' where BookID=?",('DyM10QEACAAJ',)); log.append(('DyM10QEACAAJ',b,'cleared Skipped'))
c.commit()
for l in log: print(l)
