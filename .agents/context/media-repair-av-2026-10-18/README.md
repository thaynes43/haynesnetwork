# Bounded AV checkpoint — Saga43 story128

Sole owner session01a14fc4-44b7-79b3-b7f9-95f4276da250, branch agent/media-repair-av-1018. Prerequisite selection PR999 merged7a32eb20 after all required checks/review, before AV pickup. Canonical story128 under Epic48/Saga43; acceptance AV-STORY.md plus AV-NEXT.md, read in full. No duplicate story or wider issue992/PLAN077/Seerr resumption.

Scope/acceptance: recover precise PokémonE34/MickeyE45–46 historical receipts, select smallest available current-byte TV/control set, bounded ffprobe/FFmpeg samples and independently adjudicated identity/decode/compatibility axes; one known-good and ambiguous condition; matched model evidence/caps, served modality receipts and explicit unsafe/unsupported decisions. At most one readily available historical movie case. No broad scan, downloads, original modification/full transcode/replacement, service/job restart, live catalog writes or other agents.

Proposed budget before execution:45m evidence/extraction/model work +30m normal CI/review/merge, one owner/model. Source access cap: at most four exact media paths (PokémonE34, MickeyE45/E46, optional one historical movie), metadata/stat plus sampled head/tail fingerprints <=2MiB/file; bounded native ffprobe analyze/probe5MiB, read/packet budget <=8MiB per operation where supported; at most three4s decode ranges/file and three one-frame extractions/file, one optional4s audio sample and one bounded subtitle excerpt per selected file. No full-file hashing/read/transcode; report partial-fingerprint limitations. Commands timeout<=30s, nice19, FFmpeg/ffprobe threads1. CPU burners/wide or looped local tests forbidden. If decoder reads cannot be strictly bounded, use packet/read limits or record the limit and stop that operation rather than expand.

Model scope: at most two modality acceptance probes (one/model) and four frozen diagnostic cases/model, one response/case, context8192/output384, temperature0/seed42, corrected strict schema and appropriate per-request terminators, remote60s/local65s. Modality failures lead to equivalent text-only evidence, never pretending video/audio was viewed. At most one development-only extraction refinement; preserve baseline and frozen evaluation. Stop at first usable bounded result plus normal required CI/review/authorized merge, or concrete access/identity blocker, with durable handoff.

Expected artifacts: historical source links/commits, current availability/stat/partial fingerprints, exact command/range/version/exit/timing receipts, private extracts, frozen independent labels and model evidence, raw responses/resources, axis-specific scoring and limitations. Full media/private frame/audio bytes stay outside git. Earned updates go to canonical128; previous benchmark outputs remain frozen. No acceptance of a whole epic or production readiness.

One permitted development refinement, declared before its calls: Muse baseline a01/a03 reaches384 output tokens repeating the unbounded citation array and leaves incomplete JSON. Preserve these as protocol errors, not complete reasoning judgments. Add only maxItems6 to the response schema's evidence array, apply equally to both exact models on the same four frozen inputs/images/labels, and report as separate bounded-serving variant (eight additional calls, same8192/384/temperature0/seed42/time limits, no semantic retries/evidence changes). This consumes the single refinement; no further variants/tuning follow. Existing freeze and original runner/schema remain immutable.

## Reproduction and result

See REPORT.md and IDENTITY.md. Native image probes succeeded on both exact models; diagnostic baseline and separately bounded-serving results are preserved. Qwen over-abstains on identity; corrected Muse falsely mismatches the good Mickey card. All primary decode/defined-client labels are independent of identity. No model diagnosis triggers a write/remedy.

From repository root, Python stdlib only:

```bash
P=.agents/context/media-repair-av-2026-10-18
nice -n 19 python3 "$P/score.py" # offline original baseline
nice -n 19 python3 "$P/collect.py" # offline both variants/resources
nice -n 19 python3 -m unittest discover -s "$P" -p test_score.py
# Read-only current source checks, requires existing authorized access/private records:
nice -n 19 python3 "$P/verify_post.py"
```

Exact remote argv/read-quota/error receipts live under receipts/. `extract.py KEY MODE --at SECONDS --stream INDEX` dispatches fixed tools to only three historical/current exact paths held in private records; it refuses overwriting an existing receipt. For example, original actual reads were `python3 "$P/extract.py" m frame --at 62`, `python3 "$P/extract.py" p decode --at 600`, and `python3 "$P/extract.py" z decode --at 180`. Sources are never opened for write. sample_remote.py is sent on stdin to existing deploy/bazarr; its temporary localhost range listener has only one fixed read-only path and cumulative8MiB quota, not an egress proxy or permanent service. No full-file hashing or transcode.

A fresh authorized run needs fresh output/private destinations; completed freeze, frame hashes and model output directories must not be overwritten. Model sequence was one modality.py call/model, four run.py cases/model, then one development-only run_bounded.py variant/model with maxItems6. Explicit idle checks separated all model transitions. Freeze builders use exclusive creation; original and corrected schema/runner are separate. `verify_post.py` and collect.py only produce post-run receipts/summaries and do not change frozen evaluator truth/logic.

Modality proof is actual PNG image ingestion plus literal text transcription; native audio/video remains unverified. Complete wire JSON/base64 and media extracts are private; durable repo receipts retain hashes and bounded outputs. Read-only original paths are discoverable from historical receipts/current exact native IDs, not library scans. Current API use stayed inside existing Sonarr/Radarr pods with mounted credentials never exposed; no credential copies/settings changes. No old repair worker/helper was executed.

Budget ending: first AV experiment complete within proposed scope; required CI/review/authorized merge then earned128 final receipt and stop. No whole epic closure, further tuning, live repair or broad continuation.
