# One actual EPUB pair — authorized increment

Scope: Saga43 existing stories #64/#69/#61/#62/#65/#67/#68/#63, sole owner session 01a14fc4-44b7-79b3-b7f9-95f4276da250. Fresh branch agent/media-repair-actual-epub-1018. Prerequisite PR997 merged as 3ddd98f7; installed exact Qwen/Muse digests retained. This increment is distinct from its frozen documentary corpus.

Acceptance: recover at most one historical pair, independently prove internal content identity, validate EPUB structure, freeze equivalent two-model requests before decisions, measure serial inference, select an isolated correct copy and independently validate its resolved content and unchanged originals; normal PR/checks/review/merge. Report ambiguous or missing bytes honestly. No library/DB/OPF writes, downloads, restarts, broad scans, other media, agents or production promotion.

Proposed budget: 60 minutes execution plus up to 30 minutes required CI/closeout, maximum concurrency one owner and one model. Stop at acceptance, concrete dependency/access blocker or budget; preserve durable evidence and next safe step. No CPU burners or wide/looped tests; serial modest checks under nice19.

Pair selection pending exact-path read-only stat: Anne of Green Gables historical quarantined candidate and current Collection candidate, grounded in fix_census_795.py at ff789924f0402bc67896c24c3f1b8bf462118eb8. Do not execute historical repair script. Cap 8 MiB per file/16 MiB total; private scratch pristine copies, derived outputs only. Source hashes before/after, ZIP/package/manifest/spine/readable content validation, no media bytes/full text in git. Filename/OPF/history alone cannot adjudicate identity; omnibus inclusion is not a mismatch.

Expected artifacts: reproducible bounded extraction/scoring/selection scripts, source hashes/provenance and independent identity proof, frozen minimal model evidence and schema, raw replies/resource receipts, report/PR and earned existing tracker comments. No whole epic closure. All unrelated PLAN077/Seerr/live repair holds persist.

Execution result: see REPORT.md and IDENTITY.md. Eight calls across baseline and one frozen development extraction increment; Qwen mismatch+match, Muse abstain+match in both. No more calls authorized by this completed increment. Source SHA256 and isolated resolved content independently rechecked; final Prime GPU idle. Repository artifacts contain only bounded excerpts/receipts, never EPUBs or full extracted body.

Reproduction from repo root (Python stdlib only):

```bash
P=.agents/context/media-repair-actual-epub-2026-10-18
nice -n 19 python3 "$P/score.py" # offline preserved raw outputs
nice -n 19 python3 -m unittest discover -s "$P" -p test_epub.py
# With existing private scratch only, no inference:
nice -n 19 python3 "$P/verify_after.py"
# Fresh execution requires a new authorized empty output workspace and private scratch.
# copy_pair.py refuses an existing scratch; prepare.py freezes opening requests;
# run_models.py executes baseline; prepare_increment.py freezes expanded evidence;
# run_models.py --increment executes expanded matrix. No downloads in these scripts.
# repair.py refuses an existing derived directory and changes only isolated references.
```

Historical source files are read only through the existing LazyLibrarian pod, with per-file size cap and pre/copy/post SHA256 receipts. The independent verifier re-reads only those same two exact source paths. The model adapter is imported unchanged from the prior merged benchmark. Source/fixture preparation commands deliberately refuse existing destination directories; do not overwrite frozen artifacts to reproduce a run. JSON files trigger normal repository CI. No runtime deployment is needed.

Stopped transition and resume: models-increment/muse-preflight-stopped retains the pre-inference owner check; runner-increment-first.py is its exact driver. resume-freeze.json records the final driver's operational-only resume change. Evidence/schema/protocol/repair hashes remain unchanged; baseline freeze and increment freeze both verify locally. Re-running freeze builders on these completed artifacts is inappropriate; use a fresh run directory.
