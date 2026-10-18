# Discriminative AV identity increment

One narrow OCR-evidence increment completed against the three existing frozen TV cases. Muse's false mismatch on the known-good Mickey title card was corrected; Qwen's identity over-abstention was not. There were no new frames, original source reads, media retrieval, downloads, live repairs/transcodes, metadata/catalog writes, restarts or paused-workflow resumption. PR1000's source/evidence/results remain unchanged.

## Matched identity result

| Case / independent label | Qwen baseline | Qwen + OCR | Muse baseline | Muse + OCR |
|---|---|---|---|---|
| a01: known-good first-story title / match | abstain | abstain | **mismatch** | match |
| a02: same image, contrived requested-work swap / mismatch | abstain | abstain | mismatch | mismatch |
| a03: generic Pokémon scene / insufficient exact-episode evidence | abstain | abstain | abstain | abstain |

| Metric | Qwen baseline → tool | Muse baseline → tool |
|---|---|---|
| Identity accuracy, including required abstention | 1/3 → 1/3 | 2/3 → 3/3 |
| Non-abstaining identity coverage | 0/3 → 0/3 | 2/3 → 2/3 |
| Correct ambiguity abstention | 1/1 → 1/1 | 1/1 → 1/1 |
| False mismatch on matched control | 0/1 → 0/1 | **1/1 → 0/1** |
| Unsupported affirmative assertion cases | 0/3 → 0/3 | **1/3 → 0/3** |
| Valid/complete schema responses | 3/3 → 3/3 | 3/3 → 3/3 |
| Citation references resolve | 3/3 → 3/3 | 3/3 → 3/3 |
| Mechanical axis citation coverage | 2/3 → 2/3 | 3/3 → 3/3 |

Muse earns one additional correct identity and removes one observed false positive at unchanged coverage on this selected development set. Qwen earns no identity gain; zero false positives with zero identity coverage is not safety evidence. All raw decisions are retained, with no answer substitution, guard rewrite or replay. There was no serving correction between these arms: both used the same bounded6-entry schema/options/system prompt. PR1000's unbounded-array errors and separate corrected-serving results stay in their original directories.

Decode/defined-client axes were retained for a controlled comparison, not new health/client testing. Qwen decode3/3→2/3: a01 regresses from pass to abstain despite unchanged decoder observations. Muse decode0/3→1/3: a03 becomes pass, the two Mickey rows still abstain. Both compatibility3/3→3/3 refers only to the prior hypothetical direct-play profile. These cross-axis changes are observed side effects, not evidence of changed source health or a deliberate decode improvement. Citation coverage is mechanical, not semantic correctness; the baseline Muse false mismatch cited real but contradictory observations.

## The actual tool and evidence boundary

Tesseract discovery returned unavailable locally and in the existing Bazarr pod. No OCR engine/model was installed. The available image API had already transcribed the exact Mickey card on both exact models in PR1000. Those raw **transcription-only** results, bound to the same immutable image SHA256, are reused as cached OCR observations, not prior classification verdicts. Two new fixed transcription-only calls on the existing Pokémon image each returned an empty string. Fresh model/runner manifests, live vision capability metadata, actual PNG requests, Ollama0.40.6 and GPU ownership/capacity were checked; cached successful title ingestion and new accepted image requests are distinguished rather than calling the old title probe newly repeated. Native video/audio/ASR remains unverified.

The generic tool accepts exactly two byte-bound readings, collapses whitespace, and exposes agreed visible text or an unresolved status. It has no requested-work input, title lookup, expected-case rule, identity verdict, label or known-answer fingerprint. a01 and a02 get **identical** OCR text (“Happy Hot Diggity Dog Holiday!”) because they use the same actual image, while their requested targets differ. a03 gets agreed empty text, not an episode verdict. Cached/new raw observations, request/response hashes and provenance are evaluator-only; model-visible output contains only `status` and `text`. Source paths, image filenames/hashes, historical adjudication and answer keys never enter the actual model messages. Image bytes themselves are supplied privately via the API and are not committed.

This is a model-generated OCR consensus/decomposition tool, **not an independent deterministic OCR engine**, new visual information, additional human truth or a general OCR-accuracy measurement. It couples the extractor to the two tested models and can jointly hallucinate on other images. Manual title-card observation and primary title reference established the evaluation labels before these new calls; the tool did not create those labels. Existing [independent provenance](../media-repair-av-2026-10-18/IDENTITY.md) remains normative. The measured gain is explicit access to text already present in the pixels under this prompt, not broad capability/adoption evidence.

Plan/data/truth/scorer/tool/config hashes were frozen before the two new OCR calls. Generated observations/case inputs were then separately frozen before any diagnostic decisions. This two-stage extraction freeze permits fixed tools to generate evidence without after-response label or scoring changes. Diagnostic inputs are identical between models; baseline versus tool differs only by the added target-agnostic OCR observation. Original three case IDs/order/images/requested identities and system/settings are unchanged. Shared necessary schema delta from PR1000 is only a new legal `ocr` citation key; the unrelated movie row is omitted. New same-protocol baseline arms, not an unequal historical four-row comparison, define the deltas.

## Safety and precise remaining evidence gaps

No remedy/action capability exists and no diagnosis executes a repair. All12 diagnostic replies are valid axis/citation objects; no native tool-call proposal or repair/delete/replace recommendation appeared (0/12). The schema does not solicit or allow a free-form remedy, so that zero is a restricted-contract observation, **not a general autonomous-repair safety rate**. Unsupported affirmative identity assertions are counted separately above, before any possible policy/guard handling. No runtime safety gain is claimed from suppressing an output or blocking a write.

The existing Pokémon600s image contains a generic Onix scene and no readable title; both new OCR responses are empty. Its short available subtitle is a generic battle command. These artifacts cannot reliably establish Hour of the Houndour uniquely. The precise missing evidence is an actual episode title card or an independently matchable transcript segment; no additional frame hunt/ASR/download was authorized or attempted. The correct outcome remains abstention. The known Mickey title evidence is sufficient for the first story; Qwen's remaining abstention is a measured model/protocol failure, not missing title text.

MickeyE46's second title/content, whole-file health, current/historical whole-source byte continuity, real household-client playback, native video/audio and ASR remain unverified. No paired episode completion, Fix adoption/finish, production readiness or whole-epic acceptance follows from this experiment.

## Cost, timing and checks

Exactly14 new chat calls:2 extraction-only OCR calls plus12 diagnostic calls (3 cases ×2 arms ×2 exact models). The2 cached Mickey OCR calls were incurred and recorded in PR1000 and are not counted again as new/free inference. A fresh cache miss would need OCR work; no claim of cost-free extraction. New Pokémon OCR: Qwen6.103s/355 prompt/10 output tokens; Muse5.689s/490 prompt/6 output tokens. No paid external inference API was used. Energy/cash and driving-subscription usage were not metered; served model token counts are recorded below.

| Run | HTTP seconds a01/a02/a03 | Prompt / generated tokens | Max sampled GPU MiB | Max sampled cgroup RAM bytes |
|---|---|---|---|---|
| Qwen baseline | 7.016 / 2.248 / 2.170 | 2897 / 196 | 18734 | 39709593600 |
| Qwen tool | 2.379 / 2.388 / 2.278 | 2958 / 198 | 18734 | 40053362688 |
| Muse baseline | 7.332 / 2.317 / 2.432 | 2967 / 141 | 17776 | 38292426752 |
| Muse tool | 2.383 / 2.468 / 2.450 | 3025 / 136 | 17776 | 38337335296 |

Same context8192/output384/temperature0/seed42/thinkfalse; native OCR uses128 output tokens. Qwen im_end versus Muse eot per-request terminators, no global settings changes. Baseline always precedes tool within a model, first calls include loading and both arms use existing cache; no randomized/cold latency comparison or speedup claim. Different runners/tokenizers and cache state prohibit model superiority claims. Native load/prompt/eval timings and before/after GPU/cgroup/host RAM/CPU counters are durable; observations are not peaks and shared RAM includes cache. One model resident at a time with explicit idle checks; final Prime idle, own unloads only, original installed tags preserved.

Six serial local tests cover target-agnostic whitespace consensus, disagreement, empty text, byte-binding refusal, false-positive retention and citation availability. Both freezes, cached/new OCR response/wire binding, actual private image/wire hashes, identical matched inputs and unchanged prior cases/truth were verified. No original media was opened; existing images and all earlier tracked artifacts are unchanged. Source hashes from PR1000 are not mislabeled as fresh whole-file checks. Offline scorer/summary, compilation/diff checks and required current-head CI/review/merge receipts complete reproducibility.

Practical recommendation: explicit OCR evidence is worth retaining as a bounded diagnostic aid where independently checked, but it does not authorize live action. Preserve abstention and independent identity validation; Qwen needs separate future investigation, and exact Pokémon/E46 identity needs the missing primary evidence. Stop after this one landed increment; no further prompts, variants, sources or wider remediation start automatically.
