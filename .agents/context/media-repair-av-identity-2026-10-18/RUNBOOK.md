# Reproduce the landed identity checkpoint

From repository root, Python stdlib only, no models or media needed for offline scores:

```bash
P=.agents/context/media-repair-av-identity-2026-10-18
nice -n 19 python3 "$P/score.py"
nice -n 19 python3 "$P/summarize.py"
nice -n 19 python3 -m unittest discover -s "$P" -p test_tools.py
# With existing authorized private image/wire artifacts only (no original sources opened):
nice -n 19 python3 "$P/verify_post.py"
```

Fresh execution requires separate empty output/private destinations and fresh authorization; do not overwrite this frozen experiment. Authoring sequence: prepare.py; freeze.py plan; ocr.py qwen3.8:27b; explicit idle check; ocr.py muse-glimmer:30b; evidence.py; freeze.py evidence; run.py qwen3.8:27b; explicit idle check; run.py muse-glimmer:30b; offline score/post verification. Each OCR/model output directory and frozen manifest uses exclusive creation. No retry or extra case/variant exists in the protocol.

The prior successful image-OCR cache is pinned by commit/response/request hashes under PR1000's modality directories, with complete wire bytes held privately there. New raw wire/base64 is private under /home/dev/.cache/media-repair-av-identity-1018; existing PNGs remain under /home/dev/.cache/media-repair-av-1018. Durable request receipts replace image bytes with metadata/SHA256 and retain full-wire SHA256. Actual API bodies contain only base64 images, never those audit filenames/path references. The post verifier decodes those actual private requests and proves image equality, matched model inputs and the sole OCR-observation delta. No original source paths are required by this increment.

The model adapter is the unchanged prior Ollama pod-exec API bridge, not a network/configuration workaround; endpoints are fixed and no model download or live-media tool is exposed. Runtime version is0.40.6. Current CLI discovery receipts show tesseract absent, and no installation followed. Native OCR consensus is target-agnostic and model-dependent; cached text is never treated as an evaluator label or independent OCR gold standard.

The pre-inference README is part of plan-freeze.json and remains immutable. REPORT.md/RUNBOOK.md and post-verification/summary utilities are post-run documentation/receipt artifacts; they do not modify the frozen tools, protocol or scorer. See REPORT.md for exact denominators, unsupported assertion accounting, remaining evidence gaps and deployment exclusions. Normal current-head CI/review/authorized merge receipts are on this story's PR and canonical128 activity. No subsequent work is authorized by a successful checkpoint alone.
