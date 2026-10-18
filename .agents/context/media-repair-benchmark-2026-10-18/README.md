# Media Repair benchmark — 2026-10-18

## Story and authorization record (before implementation)

Existing Saga43 / PLAN-078, baseline epic PLAN-081 and local feasibility PLAN-084.
Reuse tracker stories [64 corpus](https://work.haynesnetwork.com/work_packages/64),
[69 runtime](https://work.haynesnetwork.com/work_packages/69),
[61 protocol](https://work.haynesnetwork.com/work_packages/61),
[62 baseline](https://work.haynesnetwork.com/work_packages/62),
[65 tools](https://work.haynesnetwork.com/work_packages/65),
[67 tool detection](https://work.haynesnetwork.com/work_packages/67),
[68 isolated repair](https://work.haynesnetwork.com/work_packages/68), and
[63 report](https://work.haynesnetwork.com/work_packages/63). No parallel saga/story.

Authority: Tom's 2026-10-18 instruction to execute the bounded work order
`/home/dev/work/orders/media-repair-benchmark-1018/BRIEF.md`, followed by his direction
to finish the runnable offline benchmark while requested models are unavailable.
This is a narrow exception to the older documentation-only pause; PLAN-077 and the
Seerr bot remain paused. It does not accept a PLAN-079 loop or whole epic.

- Scope: small historical evidence corpus, frozen offline protocol/runner, runtime
  discovery and a minimal local evidence-fixture reference-repair demonstration.
  Excludes downloads, actual media retrieval/mutation, model substitution, service,
  cluster/config changes and other sessions' worktrees.
- Acceptance: precisely cited confirmed historical labels, paired controls and
  grouped held-out split; leakage-free detector payloads; reproducible commands;
  runtime/model blocker; measured offline confusion/error/abstention metrics;
  fixture repair correctness and original fixture byte preservation. Actual media
  and requested-model outcomes remain unmeasured when blocked.
- Dependencies: original corpus sources must revalidate before inclusion; runtime
  ownership/capacity and exact requested models must verify before inference.
  Serial order: discovery + corpus -> protocol -> offline baseline -> minimal
  fixture tool -> report. No inference dependency is treated as ready by fiat.
- Owner: sole session `01a14fc4-44b7-79b3-b7f9-95f4276da250`, host
  `dev-env-68b4b9f6cf-lt6j7`, worktree `/home/dev/work/haynesnetwork-1018-120622`,
  branch `agent/haynesnetwork-1018-120622`. Own only this evidence directory,
  narrow HANDOFF/PLAN links and this story's PR. No implementation agents.
  Work order requests Sol Medium; actual serving model/effort not exposed to shell.
- Proposed execution budget: 45 minutes from recorded 16:11 UTC planning point,
  one process at a time for benchmarks, no incremental paid API use. Earlier launch/
  discovery duration and subscription usage unavailable. Checkpoint at prepared
  corpus/runtime; stop at blocker after independent offline work, acceptance, or
  16:56 UTC. CI delivery can remain a documented handoff if checks exceed cap.
  No CPU burners, stress tests, wide/looped test runs; use `nice -n 19` serially.
- Artifacts: this directory, sanitized runtime receipt, corpus, protocol, runner,
  raw offline decisions, scores, tests and report; normal PR/required CI/merge.
  Tracker owner consumes the receipt in the work-order directory to update the
  existing IDs; no guessed API credential or duplicate task.
- Stop: checkpoint unavailable models and complete independent preparation. Never
  automatically download, resume a paused repair, or begin another story. Record
  final source/test/merge status and next safe step here and in HANDOFF.

## Frozen protocol

Version 1: 11 reconstructed documentary cases, 5 mismatches and 6 matches.
Development: c01-c06 (City, Crown, Zom pairs), c11 (Moana/Vaiana alias).
Held out by family: c07-c08 (Anne pair), c09-c10 (Spidey mismatch and matched
same-series control). Freeze before baseline. Held-out means excluded from tuning;
the preparer read their sources to label them. It does not mean unknown to the
preparer or a model's pretraining. No iteration may retune against those four rows.

`corpus.jsonl` is evaluator-only: source, split, label and candidate catalog stay
out of detector requests. `prepare` emits only opaque request ID, media kind,
expected identity/reference segment titles and observed evidence. A model sees
no diagnosis, repair result, explanation containing a verdict, or paired case.
No model may open this repo's evaluator files. Outputs must use exactly
`match`, `mismatch`, or `abstain`. Missing/invalid responses are errors.
The repair step separately receives the observed candidate catalog only after a
mismatch. Reference data are supplied evidence, not facts the model must recall.

Historical confirmations come from the pinned #795 repair source, the fetched
Spidey issue comment and #940's census/verified imports. Labels describe reported
historical findings, not a fresh independent audiovisual adjudication. The corpus
is a metadata/subtitle-evidence reasoning test. Source annotations were manually
transcribed, not generated from labels at run time. Same-family controls are
correlated and far easier than broad real media. Moana/Vaiana is an explicit hard
negative. Do not include #940's **probably** Josee hypothesis as confirmed truth.
All candidates/controls have source citations; source media bytes and exact original
hashes are unavailable here. No copyrighted media payload is retrieved or included.

Initial offline baseline v0 compares the catalog/filename title literally. v1 adds
the smallest evidence tool: read observed internal titles, declared aliases and TV
segment title sets. v1 uses no held-out family special cases. Both are deterministic
rules, **not requested-model inference**. They do not establish content identity
beyond supplied documentary observations. Repair selects exactly one matching
candidate and writes a new local record pointing to its copied evidence JSON;
ambiguous/absent candidates abstain. Controls keep their current pointer. It never
moves or edits media, changes source bytes or calls a service. Correctness oracle
is separately frozen `expected_candidate` in evaluator-only truth, not the rule's
own postcondition. Synthetic copied evidence bytes get SHA-256 before/after.
This is fixture reference repair, not a successful EPUB/audio/video repair.

For future exact-model runs: same frozen payloads, serial, no retries, temperature
0, seed 42, context 4096, maximum 256 generated tokens and 60 seconds per call,
11 calls/model maximum, two requested models maximum. Record Ollama digest,
quantization, full effective options, raw responses, prompt/eval token counts,
load/prompt/eval/total durations, wall latency, before/after GPU UUID/VRAM and cgroup
RAM. Any timeout/error remains in the denominator; a server may continue after a
client timeout, so stop the matrix and observe rather than issue another call.
No inference is allowed until exact installed IDs, idle ownership and capacity
are reverified. No network inference adapter is enabled by this offline runner.

Metrics: positive=mismatch. Strict accuracy=(TP+TN)/all cases. Precision=TP/(TP+FP).
Recall=TP/all labeled positives, including positive abstentions/errors. FPR=FP/all
labeled negatives. Also report 2x2 answered confusion matrix, abstentions/errors by
label, coverage, per-case latency, CPU time and max RSS. Zero denominators are null.
All positive fixture repairs use independently specified expected candidate IDs;
controls require unchanged pointers. Report full-suite and split scores separately.
No sampling confidence or population reliability claim is justified by 11 selected
cases (six families). Hardware snapshots are observations, not resource reservations.

## 16:18 UTC authorized continuation

Tom's new instruction and full `AUTHORIZED-MODELS.md` supersede the download hold
for **only** `qwen3.8:27b` and `muse-glimmer:30b`. Continue exact-model downloads,
serial measured comparison and a development-failure-guided toolkit increment.
The original 16:56 UTC execution cap remains the checkpoint threshold; record a
blocked/partial run if a prerequisite cannot fit it. No live media mutation, model
substitution, service restart, owner-model eviction or global setting change.
Only this benchmark's loaded models may be unloaded. Corpus hash remains
`39fe6a985bea4c4ac31a6d497db132a846269f04c86381259ddaa56a023946a7`.
The catalog pages were now independently read through the web tool; both official
NVIDIA variants report Q4_K_M, about 18 GB each. Installed pull/show digest is still
required before inference; page prefixes are not a substitute for registry proof.

Additional model matrix budget: two models, 11 frozen calls/model; maximum 60 s
and 256 generated tokens/call, serial context 4096. Reserve up to four development
probe/tool calls per model only if failures justify them; evaluate the same four
held-out cases once after freezing the increment, without inspecting them for
retuning. All attempts, failures and resource observations must be retained.

### Model-boundary audit before first inference

The frozen corpus is unchanged. The first prepared payloads retained an
`evidence_method` provenance annotation; c11's annotation said "same-film alias
adjudication". This is an evaluator conclusion and must not reach a detector.
The allowlist now strips **all** `evidence_method` fields, uniformly. The earlier
`results/requests-preflight-audit.jsonl` is retained solely as audit evidence;
`results/requests.jsonl` is the frozen payload used by both models. Both offline
rule versions ignore the removed field, so their measured predictions stand.
This correction preceded every LLM call; no held-out response was available to
inspect. Freeze final prompt and requests hashes before the first model call.
Model inputs contain observed titles/tags/durations and expected reference titles
including declared aliases, never source verdicts, labels, candidates or oracle
IDs. Candidate keys and evaluator family names are not inputs to either detector.

The v1 rule increment was prespecified alongside the filename baseline, then
measured; it was not selected by inspecting held-out failures. Any subsequent LLM
toolkit increment must follow actual development failures and freeze before its
held-out evaluation. Its 11/11 score is evidence-comparison correctness on tiny
reconstructed inputs, not a learned ability to decode or identify real media.

### Runtime transport and provenance

The service is `10.43.160.102:11434`, endpoint `10.42.3.168:11434` on talosw01.
FQDN resolution failed from dev-env, and the verified ClusterIP connection timed
out. No network policy, DNS setting, proxy or service was changed. The installed
image lacks curl/python; `ollama_matrix.py` uses existing authorized Kubernetes
pod exec to make literal HTTP requests to **that pod's own** `127.0.0.1:11434`
through bash's TCP facility. GET `/api/version` and `/api/ps` returned HTTP 200.
Payload bytes travel on stdin, never as shell code; the bridge only permits five
fixed Ollama API paths. Each call has remote 60 s and local 65 s timeouts.
A failed/uncertain request stops the matrix without replay or automatic unload.

The live GPU UUID/PCI read-back matches card A in the hardware runbook at
haynes-ops commit `7e92459a8a303d6c836f9796ede41fce54b9f3d4`,
`.agents/runbooks/egpu-test-node.md`, card ledger: rack HaynesIntelligence, VM103 /
talosw01. This mapping is documentary; the physical chassis was not opened here.
Muse's **existing household service** is a different deployment on talosw04,
UUID `GPU-18bf6eab-c76a-26ba-74c8-76093b705b8b`; it is not the requested model
installed on Prime and is untouched. Runtime inventory found Prime plus NVIDIA
plugin/exporter on card A; no resident model or GPU compute process was present.
This snapshot does not reserve Prime against concurrent household requests.

Parent's catalog receipt remains in CATALOG.md. Independent official-page reads:
[qwen3.8:27b](https://ollama.com/library/qwen3.8:27b) lists separate MLX and llama.cpp
variants; NVIDIA uses the Q4_K_M variant. [muse-glimmer:30b](https://ollama.com/library/muse-glimmer:30b)
lists Q4_K_M. Do not infer loaded VRAM from artifact size or advertised context.
Actual pull/show/tag digests and measured memory override catalog size estimates.

### Reproduction commands

Run from repo root; every output directory must be new. No dependency install:

```sh
PYTHONDONTWRITEBYTECODE=1 nice -n 19 python3 -m unittest discover -s .agents/context/media-repair-benchmark-2026-10-18 -p test_bench.py -v
PYTHONDONTWRITEBYTECODE=1 nice -n 19 python3 .agents/context/media-repair-benchmark-2026-10-18/probes.py
python3 .agents/context/media-repair-benchmark-2026-10-18/bench.py prepare --out /tmp/media-benchmark-requests
nice -n 19 python3 .agents/context/media-repair-benchmark-2026-10-18/bench.py offline --out /tmp/media-benchmark-offline
python3 .agents/context/media-repair-benchmark-2026-10-18/bench.py score --responses .agents/context/media-repair-benchmark-2026-10-18/results/v1-raw.jsonl --out /tmp/media-benchmark-scored
```

`score` accepts JSONL rows with opaque `request_id` and either `decision` or a
literal JSON `raw_response` string. It preserves missing/invalid decisions as
errors and rejects unknown/duplicate IDs. Malformed outer JSONL is an invalid
receipt, not a model decision. `results/requests.jsonl` plus `prompt.txt` define
the inference boundary; `protocol-hashes.json` freezes both and the corpus.

Explicitly authorized downloads and matrix (not part of offline commands):

```sh
kubectl -n ai exec ollama-prime-bc7bc7856-zgzjb -c app -- ollama pull qwen3.8:27b
kubectl -n ai exec ollama-prime-bc7bc7856-zgzjb -c app -- ollama pull muse-glimmer:30b
PYTHONDONTWRITEBYTECODE=1 nice -n 19 python3 .agents/context/media-repair-benchmark-2026-10-18/ollama_matrix.py --model qwen3.8:27b --out /tmp/media-benchmark-qwen
PYTHONDONTWRITEBYTECODE=1 nice -n 19 python3 .agents/context/media-repair-benchmark-2026-10-18/ollama_matrix.py --model muse-glimmer:30b --out /tmp/media-benchmark-muse
```

These pod names are the captured endpoint, not a promise of future identity;
re-discover and ratify the GPU/owner before adapting a later rerun. The matrix
refuses foreign resident models or active compute at preflight and checks the
resident model set before each call. It writes raw HTTP response bodies, exact
request options, installed digest, show config, each before/after resource
snapshot and score. Memory snapshots are endpoints, not peak measurements.
Its fixture step is explicitly **model-triggered deterministic reference repair**;
model candidate-selection/tool-use ability is not measured by that step.

Model provenance requires a successful official `ollama pull` (its blob checksum
verification), the exact official-library manifest, and agreement between that
manifest's locally computed SHA-256 and `/api/tags`' full digest. The matrix saves
that manifest and refuses a mismatch. `/api/show` records parameter size, family,
quantization, template and model parameters. We do not rehash 18 GB weights in a
second CPU-intensive loop after Ollama's own checksum verification.

Tom additionally requires both authorized pulls **and checksum verification** to
finish before timing either inference matrix. This run follows that serial-I/O
condition; no matrix is started during a download. Cold first-call load time is
included in each model's raw receipt and reported separately from warm calls.


### Observed registry-wrapper detail

The first provenance assertion expected the installed local file's bytes to hash
to the API digest. Live Qwen uses a resolved wrapper containing an MLX/llama.cpp
registry index plus the original selected manifest. The wrapper hash differs,
while the **original registry manifest** hashes exactly to the API ID (which has
no `sha256:` prefix). The verifier now checks that original blob's full hash,
its NVIDIA/llama.cpp index binding, identical config and every served data-layer
hash/size. Both wrapper and original remain in the receipt. This is a verified
representation correction before inference, not a model replacement or ignored
integrity failure. [Ollama's tags API](https://docs.ollama.com/api/tags) documents
the digest/quantization fields; the wrapper structure is directly observed in
`runtime/qwen-provenance/`, not inferred from that API documentation.


Baseline progress output seals the four held-out decisions. Raw receipts are
persisted, but the operator inspects development failures first and records the
minimal increment (or no-change decision) before opening the held-out aggregate.
The model itself never receives split membership. No held-out model response is
used to tune prompts, extraction or candidate selection.

## Final measured checkpoint

[REPORT.md](REPORT.md) and `model-summary.json` distinguish original baselines,
identity-tool/schema variants, development compatibility probes and corrected
serving. The original offline summary's unmeasured-model field is historical;
actual model scores are in the later model receipts. Muse's installed `ggml`
GGUF path was independently verified; a registry need not carry Qwen's explicit
`runner` field. No MLX substitution occurred.

Variant reproduction adds these flags to the exact-model command above:
`--tool-assisted` for c01 plus four held-out rows;
`--tool-assisted --serving-stop` for the separately corrected four held-out rows;
`--corrected-serving` for all eleven original rows with strict schema/end-token
framing correction **and no identity tool**. Every variant uses a new output
directory. Development compatibility probes preserve exact request bodies under
`models/muse-compatibility/`; their constants are diagnostic instructions, never
media truth labels. No further model iteration is authorized by these commands.
