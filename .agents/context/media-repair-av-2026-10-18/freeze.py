"""Freeze before model diagnostic decisions; no overwriting completed manifests."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
names=['cases.json','evaluator/truth.json','image-hashes.json','protocol.json','schema.json','sample_remote.py','extract.py','prepare.py','run.py','score.py','modality.py','freeze.py','../media-repair-benchmark-2026-10-18/ollama_matrix.py']
with (ROOT/'freeze.json').open('x') as f:json.dump({n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in names},f,indent=2);f.write('\n')
