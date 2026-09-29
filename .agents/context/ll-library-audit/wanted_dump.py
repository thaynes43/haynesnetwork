# Dumps every LazyLibrarian `wanted` row (grab history) with a flag for whether its recorded path still exists.
#   kubectl -n downloads exec -i deploy/lazylibrarian -c app -- python3 - < wanted_dump.py > wanted.json
import sqlite3,sys,json,os
c=sqlite3.connect("file:/config/lazylibrarian.db?mode=ro",uri=True); c.row_factory=sqlite3.Row
out={}
for r in c.execute("select BookID,NZBtitle,NZBdate,Status,DLResult,Source,AuxInfo from wanted order by NZBdate"):
    out.setdefault(r['BookID'],[]).append(dict(r))
# scan dirs for existing files of DLResult
for b,l in out.items():
    for w in l:
        p=w['DLResult']
        w['exists']= bool(p and p.startswith('/') and os.path.exists(p))
json.dump(out,sys.stdout)
