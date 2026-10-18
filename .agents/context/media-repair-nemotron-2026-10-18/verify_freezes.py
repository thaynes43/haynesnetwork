"""Verify executed and archived phase files without changing their hash lists."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
ARCHIVES={
 'suite-freeze.json':{'README.md':'README.suite-frozen.md'},
 'text-freeze-before-server-completion.json':{'run_text.py':'run_text.pre-server-completion.py'},
 'p2-freeze.json':{'io_startup.py':'io_startup.p2-first.py'},
 'p2-first-freeze.json':{'io_startup.py':'io_startup.p2-first.py'},
 'p3-freeze.pre-settle.json':{'finish_local.py':'finish_local.pre-settle.py','run_p3.py':'run_p3.pre-settle.py','io_startup_local.py':'io_startup_local.pre-dirty-accounting.py'},
 'p3-freeze.pre-driver-settle.json':{'run_p3.py':'run_p3.pre-settle.py','io_startup_local.py':'io_startup_local.pre-dirty-accounting.py'},
 'p3-freeze.pre-dirty-accounting.json':{'run_p3.py':'run_p3.pre-dirty-accounting.py','io_startup_local.py':'io_startup_local.pre-dirty-accounting.py'},
}
def verify():
 checked=[]
 for freeze in sorted(ROOT.glob('*freeze*.json')):
  if freeze.name=='freeze-verification.json':continue
  for name,digest in json.loads(freeze.read_text()).items():
   source=ROOT/ARCHIVES.get(freeze.name,{}).get(name,name)
   assert hashlib.sha256(source.read_bytes()).hexdigest()==digest,(freeze.name,name)
  checked.append(freeze.name)
 return {'checked':checked,'archive_resolution':ARCHIVES,'mismatches':[]}
if __name__=='__main__':print(json.dumps(verify(),indent=2))
