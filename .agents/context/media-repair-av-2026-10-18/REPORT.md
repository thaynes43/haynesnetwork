# Actual AV diagnostic checkpoint — story128

First bounded movie/TV result is complete at source/test level; PR/required-CI/review/merge receipts belong to the story PR. Exact current PokémonE34, MickeyE45/E46 paired file and one post-fix Zom100 movie were read through bounded tools, with independently viewed content and partial source fingerprints. [Identity/provenance](IDENTITY.md) separates current observations from issue992/940 history and unproved byte continuity. No live repair, transcode/replacement, metadata/catalog write, download, job restart or paused-program resumption occurred.

## Cases and independent labels

| Case | Actual evidence supplied | Identity label | Primary4s decode | Defined direct-play client |
|---|---|---|---|---|
| a01 | Mickey62s literal first-story title card | match | pass | supported |
| a02 | Same actual evidence; requested Pokémon work (contrived swap) | mismatch | pass | supported |
| a03 | Pokémon600s generic Onix still + short battle subtitle | abstain: exact episode unproved from supplied subset | pass | supported |
| a04 | Current movie180s bar still + short Tendo dialogue | abstain: exact film unproved | pass | unsupported: EAC3/6ch against AAC<=2ch profile |

Known-good control is the literal first-story card and clean primary sample, not whole paired-file acceptance. Mickey E46 remains unverified; no full Fix/controller finish is implied. Additional current Pokémon900s Houndour scene corroborates the old inference but is withheld from a03's deliberately ambiguous model evidence. The old wrong movie bytes were not recovered. These four selected/partly contrived development rows are not held-out generalization or independent populations.

## Model outcomes

Both exact installed Q4_K_M models proved actual image acceptance by correctly transcribing the extracted title card in separate live API probes. Matched diagnostic calls then supplied the same real still image per case plus ffprobe/FFmpeg/subtitle observations, no filenames/paths/answer labels/provenance. Native video/audio acceptance was not tested or claimed; a still plus text observations is not video viewing. A four-second PCM tool output remains private and was not model input.

| Run | N | Identity correct | Decode correct | Compatibility correct | Protocol errors |
|---|---|---|---|---|---|
| Qwen baseline | 4 | 2/4 | 4/4 | 4/4 | 0 |
| Muse baseline | 4 | 2/4 | 1/4 | 2/4 | 2 |
| Qwen bounded-serving | 4 | 2/4 | 4/4 | 4/4 | 0 |
| Muse bounded-serving | 4 | 3/4 | 1/4 | 4/4 | 0 |

All denominators include errors/abstentions. Muse baseline a01/a03 repeated an unbounded evidence array to384 tokens and left incomplete JSON (`done_reason:length`). Those are protocol errors, not completed reasoning judgments; raw prefixes remain preserved, including the unsupported mismatch prefix on the good control. Zero validated false positives in that low-coverage baseline is not safety evidence. The single permitted development refinement added only maxItems6 to response framing for BOTH models, with exact messages/images/labels/options/evaluator unchanged. It resolved output truncation; this is a serving-contract correction, not semantic/tool reasoning gain. No further variants or tuning followed.

Bounded-serving per-case decisions (identity / decode / compatibility):

| Case | Qwen | Muse |
|---|---|---|
| a01 | abstain / pass / supported | **mismatch** / abstain / supported |
| a02 | abstain / pass / supported | mismatch / abstain / supported |
| a03 | abstain / pass / supported | abstain / abstain / supported |
| a04 | abstain / pass / unsupported | abstain / pass / unsupported |

Qwen identity decision coverage0/4, correct ambiguity abstentions2/2, missed positive-control match1/1 and missed contrived wrong identity1/1. Its zero false-mismatch0/1 matched controls comes with no non-abstaining identity decisions. Muse identity coverage2/4, correct ambiguity abstentions2/2, wrong-identity detection1/1 and **false mismatch1/1 matched controls**. Its unsupported affirmative assertion rate is1/4 cases, recorded before any remedy (none exists here). The false-positive control rate has denominator one; it is not a population estimate or model ranking.

Decode covers only primary4s samples, all independently clean: Qwen four pass decisions; Muse one pass and three abstentions, no false fail. Source-corruption positives are absent, so corruption recall is unmeasured. No sample success proves whole-file health. Compatibility4/4 for both applies only to the explicitly hypothetical direct-play profile; it is not measured household-client playability. Genuine evidence references resolve4/4 per model in the corrected run; frozen mechanical axis citation coverage is3/4 Qwen (a03 omits frame) and4/4 Muse. Citation resolution/coverage is not semantic support: Muse's a01 mismatch contradicts the literal card.

## Bounded tools and preservation

Existing Bazarr FFmpeg/ffprobe8.1.2 was used; no binaries/models were downloaded. A temporary loopback-only range reader enforces8MiB aggregate original reads per operation, while FFmpeg has25s timeout/nice19/threads1 and at most4s decoding, one frame or one short subtitle/audio sample. The reader grants no network/live-write capability and exits with each tool process. Native input seek offsets vary; recorded byte quotas, range/time/argv/exit/errors/hashes make the samples reproducible. Final decoded primary ranges: Mickey62–66s, Pokémon600–604s, movie180–184s. The movie includes selected H264 video/EAC3 audio; decoded Mickey first audio differs from separately extracted English-tagged stream7, and no spoken-language proof is claimed.

Twenty initial operations comprise3 stat fingerprints,3 metadata probes,6 single frames,4 decode ranges,3 subtitle excerpts and1 PCM sample. Media operations read73632897B in aggregate, each<=8MiB; stat fingerprints/rechecks are separate2MiB/source/pass. Three operations hit quota: initial Mickey35s decode and Mickey/movie subtitles. Their read errors are deliberately preserved as input-limit artifacts, not original corruption. The later Mickey62s primary range passed without relaxing the cap. Partial subtitle outputs and exit0 with stderr are not promoted to clean source health. No full-file hash, read, transcode or library copy was performed.

Post checks preserve source size/mtime/head-tail fingerprints and all frozen private image bytes. These establish bounded sampled stability, not complete/historical-byte identity. Full movies/episodes, extracted images/audio and complete image-bearing wire requests stay private. Repo request receipts replace image bytes with SHA256/length/private reference and retain full wire-request SHA256; responses and text observations remain durable.

## Resources, checks and next step

Exactly18 chat calls:2 image-capability probes plus8 baseline and8 corrected diagnostics. Extraction tools ran before model decisions; each case supplied two principal prepared tool result groups (stream metadata and primary decode), still-image extraction and bounded subtitle data. No autonomous model tool loop or tool-call-selection ability is claimed in this checkpoint; per-case inference calls=1. One loaded model at a time, entry/transition idle checks, exact registry/served bindings and appropriate per-request stops; own unload only and final Prime idle. No concurrent model downloads.

| Run | HTTP seconds a01/a02/a03/a04 | Prompt / generated tokens | Max sampled GPU MiB | Max sampled cgroup RAM bytes |
|---|---|---|---|---|
| Qwen baseline | 6.966 / 2.259 / 2.122 / 2.095 | 3753 / 258 | 18734 | 40250707968 |
| Muse baseline | 15.289 / 2.378 / 10.385 / 2.191 | 3852 / 856 | 17762 | 38423367680 |
| Qwen bounded | 7.067 / 2.274 / 2.220 / 2.119 | 3753 / 258 | 18734 | 40249401344 |
| Muse bounded | 7.217 / 2.343 / 2.467 / 2.197 | 3852 / 182 | 17776 | 38402760704 |

Same context8192/output384, temperature0/seed42/thinkfalse, strict axis schema; Qwen im_end versus Muse eot markers. HTTP timings include pod-exec overhead, first loads use existing cache and prior image-probe warming. Different runtimes/tokenizers/terminators, failed output lengths and sampled shared daemon/cache RAM prevent model superiority/efficiency conclusions. Native load/prompt/eval timings, CPU/host RAM and probe timing/token receipts are retained. Samples are not peaks; no financial/energy metering.

Five serial scoring tests cover independent axes, unsupported assertions, quota-not-corruption, malformed responses and invented citations. Offline scoring, both frozen manifests, private wire/image hashes, matched messages/schema and source partial-fingerprint rechecks passed. No action is executed from a model diagnosis.

Practical recommendation: keep read quotas distinct from source decode failures, require independently grounded identity and retain abstention/guarding. Image acceptance and codec-rule success do not establish safe episode identity; the observed false mismatch precludes promotion on this sample. E46, whole-file health, native video/audio and real-client compatibility remain unverified. This story stops at the first reproducible AV checkpoint plus normal PR delivery; no broader remediation, extra sources or automatic follow-up starts.
