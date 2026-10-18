import subprocess,pathlib,json,hashlib,sys,os
root=pathlib.Path('/home/dev/.cache/media-repair-actual-epub-1018');root.mkdir(mode=0o700,exist_ok=False)
paths=['/data/cephfs-hdd/data/media/books/quarantine/crossvolume-2026-10-05/EBooks/L.M. Montgomery/Anne of Green Gables/Anne of Green Gables - L.M. Montgomery.epub','/data/cephfs-hdd/data/media/books/EBooks/L.M. Montgomery/Anne of Green Gables - Collection/L.M. Montgomery - Anne of Green Gables - Collection.epub']
prefix=['kubectl','-n','downloads','exec','lazylibrarian-565f8b89b9-htmcq','-c','app','--','python3','-c']
receipts=[]
for i,p in enumerate(paths):
 cmd='import pathlib,hashlib,json; p=pathlib.Path(__import__("sys").argv[1]); s=p.stat(); assert s.st_size<=8388608; print(json.dumps(dict(bytes=s.st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),mtime_ns=s.st_mtime_ns)))'
 before=json.loads(subprocess.check_output(prefix+[cmd,p]));data=subprocess.check_output(prefix+['import pathlib,sys; p=pathlib.Path(sys.argv[1]); assert p.stat().st_size<=8388608; sys.stdout.buffer.write(p.read_bytes())',p]);assert hashlib.sha256(data).hexdigest()==before['sha256'];after=json.loads(subprocess.check_output(prefix+[cmd,p]));assert before==after
 out=root/f'pristine-{i}.epub';out.write_bytes(data);out.chmod(0o400);receipts.append(dict(source=p,copy=str(out),before=before,after_copy=after))
pathlib.Path('.agents/context/media-repair-actual-epub-2026-10-18/sources.json').write_text(json.dumps(receipts,indent=2)+'\n')
