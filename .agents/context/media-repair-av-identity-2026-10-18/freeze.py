"""Two-stage freeze: plan before OCR calls, generated observations before diagnosis."""
import hashlib,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
if sys.argv[1:]==['plan']:
 names=['README.md','cases-baseline.json','evaluator/truth.json','evaluator/provenance.json','image-hashes.json','protocol.json','schema.json','ocr-config.json','tools.py','ocr.py','evidence.py','run.py','prepare.py','score.py','test_tools.py','freeze.py','../media-repair-av-2026-10-18/modality.py','../media-repair-av-2026-10-18/modality/qwen3.8/request.json','../media-repair-av-2026-10-18/modality/qwen3.8/response.json','../media-repair-av-2026-10-18/modality/muse-glimmer/request.json','../media-repair-av-2026-10-18/modality/muse-glimmer/response.json','../media-repair-benchmark-2026-10-18/ollama_matrix.py'];out='plan-freeze.json'
elif sys.argv[1:]==['evidence']:
 names=['cases-tool.json','evaluator/ocr-provenance.json','ocr-observations.json','plan-freeze.json'];out='evidence-freeze.json'
else:raise SystemExit('Use plan before OCR; evidence after extraction and before diagnosis')
with (ROOT/out).open('x') as f:json.dump({n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in names},f,indent=2);f.write('\n')
