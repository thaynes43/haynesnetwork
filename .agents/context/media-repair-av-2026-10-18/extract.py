"""Host-side exact-path sample driver; outputs remain private, receipts are durable."""
import argparse,hashlib,json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent;PRIVATE=Path('/home/dev/.cache/media-repair-av-1018')
SOURCES={'p':json.loads(Path('/home/dev/.local/state/selfserve-plan077/pokemon-20261014/paused-current-20261014-124048/e34-source-physical.json').read_text())['source']['path'],'m':json.loads((PRIVATE/'mickey-file.json').read_text())['path'],'z':json.loads((PRIVATE/'movie-record.json').read_text())['movieFile']['path']}
def sample(key,mode,at=0,stream=0):
 name=f'{key}-{mode}-{at:g}-{stream}';out=PRIVATE/(name+'.bin');receipt=ROOT/'receipts'/(name+'.json');assert not receipt.exists();receipt.parent.mkdir(exist_ok=True)
 cmd=['kubectl','-n','media','exec','-i','deploy/bazarr','-c','app','--','python3','-',mode,SOURCES[key],'--at',str(at),'--stream',str(stream)]
 run=subprocess.run(cmd,input=(ROOT/'sample_remote.py').read_bytes(),capture_output=True,timeout=35);assert run.returncode==0,run.stderr.decode(errors='replace');out.write_bytes(run.stdout)
 if mode=='stat':data=json.loads(run.stdout)
 else:data=json.loads(run.stderr.decode().splitlines()[-1]);assert data['source_unchanged'];assert data['bytes_read']<=8388608
 data.update(source=SOURCES[key],private_artifact=out.name,sha256=hashlib.sha256(run.stdout).hexdigest());receipt.write_text(json.dumps(data,indent=2)+'\n');print(name,{k:data.get(k) for k in ['size','exit_code','bytes_read','quota_exhausted','stdout_bytes','stderr']})
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('key',choices=list(SOURCES));p.add_argument('mode',choices=['stat','probe','decode','frame','audio','subtitle']);p.add_argument('--at',type=float,default=0);p.add_argument('--stream',type=int,default=0);a=p.parse_args();sample(a.key,a.mode,a.at,a.stream)
