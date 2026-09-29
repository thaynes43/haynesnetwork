import os,json,hashlib,time,sqlite3
B='/data/cephfs-hdd/data/media/books/'
E=B+'EBooks/'
Q=B+'quarantine/audit-631-2026-09-29/'
os.makedirs(Q,exist_ok=True); os.chown(Q,1000,1000)
man=open(Q+'manifest.jsonl','a')
def mv(src,dst,kind,why):
    assert os.path.isfile(src),src; assert not os.path.exists(dst),dst
    st=os.stat(src); h=hashlib.sha256(open(src,'rb').read()).hexdigest()
    d=os.path.dirname(dst)
    if not os.path.isdir(d):
        os.makedirs(d); os.chown(d,1000,1000)
    os.rename(src,dst)
    man.write(json.dumps({'kind':kind,'from':src,'to':dst,'sha256':h,'size':st.st_size,'why':why,'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})+'\n')
    print(kind,src[len(B):],'->',dst[len(B):])
mv(E+'Brandon Sanderson/Skyward/Skyward - Brandon Sanderson.epub', E+'Brandon Sanderson/Skyward Flight. The Collection/Skyward Flight. The Collection - Brandon Sanderson.epub','rehome','embedded title Skyward Flight: the Collection (ISBN 9780593567869); the Skyward novel is the pdf beside it')
mv(E+'Diana Gabaldon/The Lord John Series 4-Book Bundle/Diana Gabaldon - The Lord John Series 4-Book Bundle.epub', E+'Diana Gabaldon/The Outlander Series 7-Book Bundle/Diana Gabaldon - The Outlander Series 7-Book Bundle.epub','rehome','embedded title The Outlander Series 7-Book Bundle (ISBN 978-0-345-54110-9)')
mv(E+'Terry Pratchett/Terry Pratchetts Discworld/Terry Pratchetts Discworld - Terry Pratchett.epub', Q+'EBooks/Terry Pratchett/Terry Pratchetts Discworld/Terry Pratchetts Discworld - Terry Pratchett.epub','quarantine','is Unseen Academicals (ISBN 9780061161704), a second edition of a book already in Terry Pratchett/Unseen Academicals')
mv(E+'Cassandra Clare/The Mortal Instruments/The Mortal Instruments - Cassandra Clare.epub', Q+'EBooks/Cassandra Clare/The Mortal Instruments/The Mortal Instruments - Cassandra Clare.epub','quarantine',"is The Shadowhunter's Codex illustrated edition (ISBN 9781442496835), a 2026-09-22 wrong grab; the codex is already in its own folder and the folder's mobi is the real Mortal Instruments series")
man.close()
for dp,dn,fn in os.walk(Q): os.chown(dp,1000,1000)
os.chown(Q+'manifest.jsonl',1000,1000)
# DB
c=sqlite3.connect('/config/lazylibrarian.db',timeout=60)
now=time.strftime('%Y-%m-%d %H:%M:%S')
log=[]
def row(i): return c.execute('select BookID,BookName,Status,AudioStatus,BookFile,BookLibrary from books where BookID=?',(i,)).fetchone()
def setf(i,p,open_=False):
    assert os.path.isfile(p),p
    b=row(i)
    if open_: c.execute("update books set BookFile=?,Status='Open',BookLibrary=? where BookID=?",(p,now,i))
    else: c.execute('update books set BookFile=? where BookID=?',(p,i))
    log.append({'before':b,'after':row(i)})
def clear(i):
    b=row(i); c.execute("update books set BookFile='',BookLibrary='',Status='Skipped' where BookID=?",(i,)); log.append({'before':b,'after':row(i)})
setf('sal2DwAAQBAJ',E+'Brandon Sanderson/Skyward/Skyward - Brandon Sanderson.pdf')
setf('wnVOEAAAQBAJ',E+'Brandon Sanderson/Skyward Flight. The Collection/Skyward Flight. The Collection - Brandon Sanderson.epub',True)
setf('iwsfcAAACAAJ',E+'Cassandra Clare/The Mortal Instruments/The Mortal Instruments - Cassandra Clare.mobi')
setf('2CKuEQAAQBAJ',E+'Rick Riordan/The Lost Hero/Rick Riordan - The Lost Hero.epub',True)
clear('YVfJMgEACAAJ')
c.commit()
print(json.dumps(log))
