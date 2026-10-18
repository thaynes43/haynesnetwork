"""Run once before inference. Refuses to overwrite an existing frozen manifest."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
names=['cases.json','schema.json','protocol.json','evaluator/truth.json','evaluator/provenance.json','prepare.py','tools.py','evaluate.py','run.py','test_selection.py','freeze.py','../media-repair-actual-epub-2026-10-18/epub.py','../media-repair-benchmark-2026-10-18/ollama_matrix.py','../media-repair-benchmark-2026-10-18/bench.py','../media-repair-benchmark-2026-10-18/toolkit.py']
with (ROOT/'freeze.json').open('x') as f:json.dump({n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in names},f,indent=2);f.write('\n')
