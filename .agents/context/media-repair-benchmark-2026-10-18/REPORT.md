# Measured Media Repair benchmark — 2026-10-18

The authorized bounded run is complete at source/test level. PR/CI/merge state is recorded in the story PR and work-order checkpoint. No production repair or saga/epic acceptance is claimed.

## Results

All scores are against the same frozen historical documentary corpus: 5 mismatch and 6 match cases, including 4 family-held-out rows. They do not measure media decoding. Baseline and corrected artifacts are immutable separate directories.

| Run | N | TP / TN / FP / FN | Abstain / error | Accuracy | Precision / recall / FPR | Held out |
| --- | --- | --- | --- | --- | --- | --- |
| qwen | 11 | 4 / 6 / 0 / 0 | 1 / 0 | 90.9% | 100.0% / 80.0% / 0.0% | 100.0% (4) |
| muse | 11 | 0 / 0 / 0 / 0 | 0 / 11 | 0.0% | undefined / 0.0% / 0.0% | 0.0% (4) |
| qwen-assisted | 5 | 3 / 2 / 0 / 0 | 0 / 0 | 100.0% | 100.0% / 100.0% / 0.0% | 100.0% (4) |
| muse-assisted | 5 | 0 / 0 / 0 / 0 | 0 / 5 | 0.0% | undefined / 0.0% / 0.0% | 0.0% (4) |
| muse-corrected | 4 | 2 / 2 / 0 / 0 | 0 / 0 | 100.0% | 100.0% / 100.0% / 0.0% | 100.0% (4) |
| muse-serving-full | 11 | 5 / 6 / 0 / 0 | 0 / 0 | 100.0% | 100.0% / 100.0% / 0.0% | 100.0% (4) |

Muse baseline and initial assisted errors are serving/output-contract failures, **not evidence of deficient mismatch reasoning**. A zero FPR with zero decision coverage is not safety evidence. Qwen abstained only on development c01, the omnibus/single-work case. The generic identity tool plus strict output schema resolved that development abstention and retained all four held-out successes. This is a composite tool-assisted result, not an independent model capability score.

Muse compatibility diagnosis used development-only probes: unconstrained chat spent its 64-token budget reasoning; a schema-only READY probe returned the requested object with a literal `<|eot|>` suffix. A per-request end-token stop then produced a clean development decision. The corrected four-row run retained the identity tool; the later **muse-serving-full** run removed that tool and used all 11 original payloads. Only response framing changed from baseline: strict decision schema and `options.stop=["<|eot|>"]`. Its 11/11 therefore separates the serving correction from semantic toolkit gains. No template, service, model digest, corpus, global setting or truth label changed.

The publisher template uses turn terminators and an assistant generation prefix ([official template](https://huggingface.co/meta-models/Muse-Glimmer-30B/blob/main/chat_template.jinja)). Ollama has a family-specific renderer ([upstream fix](https://github.com/ollama/ollama/commit/7ce88bd686cf6a7307ae66677dc5a44c0bbf31a3)); GitHub ancestry showed v0.40.6 already 276 commits ahead of that fix, so an upgrade was not assumed necessary. Schema requests follow [official API guidance](https://docs.ollama.com/capabilities/structured-outputs). Both models show `{{ .Prompt }}` in metadata, so that placeholder alone does not prove a broken template. The observed compatibility symptom and request-level remedy are measured; the exact internal renderer/termination bug is not proved.

## Runtime and latency

Both official downloads and checksums completed before every matrix. Prime0.40.6, rack card A / talosw01, UUID `GPU-6ff9702a-1b2c-6094-5a85-00aa1924c55a`. Exact full registry digests:

- Qwen `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813`, 27.3B Q4_K_M, `llamacpp`.
- Muse `de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1`, 27.9B Q4_K_M, `ggml`.

Registry originals, resolved wrappers, served-layer/config agreement, show parameters, requests, raw responses, parsed decisions and resource snapshots are retained. Same context4096, max256 output tokens, temperature0, seed42 and remote60s/local65s time limits; serial inference only.

| Run | First call, s | Warm mean, s | Max observed GPU used, MiB | Prompt / generated tokens |
| --- | --- | --- | --- | --- |
| qwen | 33.583 | 0.500 | 18114 | 2606 / 72 |
| muse | 9.048 | 2.020 | 17460 | 2620 / 772 |
| muse-serving-full | 5.053 | 0.486 | 17460 | 2620 / 71 |

These are end-to-end pod-exec HTTP times; native server load/prompt/eval durations are also in raw receipts. First-load cache state differs across later runs; no cache flush was performed. Muse failed baseline replies have different output lengths and cannot be ranked as reasoning speed. GPU/RAM values are endpoint samples, not peaks; cgroup RAM includes download/file cache and CPU deltas include probe overhead. CPU counters and memory totals are in model-summary.json. Electricity/cash cost and driving subscription usage were not metered. No external paid inference API was called.

## Isolated repair and checks

The fixture tool chooses a unique candidate from supplied internal evidence, writes a new local reference, independently checks it against a frozen candidate oracle, reads back the result and hashes original/copy bytes. It is model-triggered deterministic reference repair; LLM candidate-selection ability and real media repair are not measured. Qwen baseline verified 4/5 positive references plus all 6 controls; corrected Muse verified 5/5 plus all 6 controls. Every run preserved all original fixture bytes, and no control reference was unnecessarily changed. The standalone evidence-rule baseline was 11/11; filename-only rules were 6/11.

Five serial contract tests, six independent unfamiliar-title/alias/TV/missing-data probes, raw-response error/abstention scoring checks, and module compilation passed. The initial provenance annotation leak was removed uniformly before any inference; the old prepared payload remains audit-only. Toolkit/schema were frozen from development failures before held-out responses were opened. The final serving-only correction came from development protocol probes, not semantic held-out tuning.

## Handoff

Use README.md for exact offline, model and variant commands; CASES.md and corpus.jsonl contain pinned source labels. `model-summary.json` is recomputed by summarize.py. Models remain installed as explicitly authorized; own resident models were unloaded, existing tags preserved. Live media, household Muse on the other GPU, production writes, services and deployment were untouched.

This tiny selected corpus has six correlated families, metadata/title/subtitle observations and curator-provided references. Historical labels were revalidated against source artifacts, not independently re-decoded from media. High scores do not establish general reliability. The next concrete toolkit step is extraction from isolated EPUB/audio/video copies using this same identity contract, with independent content verification and original hashes; that step is not performed or newly authorized here. No wider taxonomy, training, routing or production promotion was started.
