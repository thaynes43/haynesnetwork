"""Development-only extraction increment after baseline abstention, no verdicts."""
import hashlib,json
from pathlib import Path
import epub,prepare
ROOT=Path(__file__).resolve().parent
requests=json.loads((ROOT/'requests.json').read_text())
for i,request in enumerate(requests):
 d=epub.inspect(prepare.PRIVATE/f'pristine-{i}.epub');narrative=[x['text'] for x in d['spine'] if x['characters']>5000]
 request['document']['middle_body_excerpt']=' '.join(narrative[len(narrative)//2].split()[20:90])
 request['document']['ending_body_excerpt']=' '.join(narrative[-1].split()[-70:])
prepare.write(ROOT/'requests-increment.json',requests)
prepare.write(ROOT/'increment-freeze.json',{p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in ['requests-increment.json','prepare_increment.py','run_models.py','protocol.json','schema.json','repair.py']})
