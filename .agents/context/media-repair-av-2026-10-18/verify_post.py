"""Read-only source partial-fingerprint checks; never claims whole-file hashes."""
import hashlib,json,subprocess
from pathlib import Path
import extract
ROOT=Path(__file__).resolve().parent;PRIVATE=Path('/home/dev/.cache/media-repair-av-1018')
def main():
 checks=[]
 for key,path in extract.SOURCES.items():
  before=json.loads((PRIVATE/f'{key}-stat-0-0.bin').read_text());run=subprocess.run(['kubectl','-n','media','exec','-i','deploy/bazarr','-c','app','--','python3','-','stat',path],input=(ROOT/'sample_remote.py').read_bytes(),capture_output=True,timeout=15);assert run.returncode==0;after=json.loads(run.stdout);assert after==before;checks.append({'source':path,'before':before,'after':after,'sample_fingerprints_size_mtime_unchanged':True})
 for cid,meta in json.loads((ROOT/'image-hashes.json').read_text()).items():assert hashlib.sha256((PRIVATE/meta['artifact']).read_bytes()).hexdigest()==meta['sha256']
 for name,h in json.loads((ROOT/'freeze.json').read_text()).items():assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==h
 for name,h in json.loads((ROOT/'bounded-freeze.json').read_text()).items():assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==h
 (ROOT/'post-verification.json').write_text(json.dumps({'sources':checks,'all_frozen_images_and_protocols_match':True,'full_source_sha256_measured':False},indent=2)+'\n');print('Partial source fingerprints/size/mtime and frozen image/protocol hashes pass')
if __name__=='__main__':main()
