# Media repair harness: dev suite `dev-v1`

OpenProject story [#131](https://work.haynesnetwork.com/work_packages/131) under spike #65 / epic #48.
Gates: `../GATES.md` (recorded before any case is scored). Case schema: `CONTRACT.md` v1 (committed by the harness
worker as `harness/CONTRACT.md`). This directory holds the **development split only**. The held-out set is a separate,
later story; no held-out case exists here, and every family in this suite is `dev`.

```
suite/
  cases/<id>.json        73 case files (CONTRACT.md v1)
  manifest.json          suite_version, sha256 of every case file and fixture, counts by class / media type / split
  suite.py               validate | list | stats | manifest   (stdlib only)
  test_suite.py          26 unit tests (validator, negative tests, truth-vs-recorded-evidence)
  build_cases.py         deterministic builder: the case files are its output
  fixtures/gen_media.sh  ffmpeg generator for the synthetic video / audiobook fixtures (run in a batch Job, see below)
  fixtures/gen_epub.py   stdlib generator for the synthetic EPUB fixtures (byte-reproducible)
  fixtures/make_replay.py  turns raw ffprobe / decode output into the replay files
  fixtures/media/        26 media + 10 EPUB small synthetic files, 1.96 MiB total, each under 200 KiB
  fixtures/probes/       one replay file per media fixture: recorded ffprobe, decode_sample (ss=0/4/8/12 and full), title-card text
```

Commands (no ffmpeg needed): `python3 -I suite.py validate`, `list`, `stats`, `manifest`;
`nice -n 19 python3 -I -m unittest discover -s . -p 'test_*.py'`.

## Counts

| class | movie | tv | epub | audiobook | total |
|---|---|---|---|---|---|
| identity_mismatch | 2 | 4 | 5 | 2 | 13 |
| corrupt_file | 3 | 6 | 7 | 5 | 21 |
| decoder_incompatible | 4 | 1 | 0 | 0 | 5 |
| metadata_naming | 1 | 1 | 1 | 1 | 4 |
| order_edition_ambiguity | 1 | 1 | 0 | 1 | 3 |
| insufficient_evidence | 1 | 3 | 2 | 1 | 7 |
| healthy (negative controls) | 4 | 7 | 6 | 3 | 20 |
| **total** | 16 | 23 | 21 | 13 | **73** |

Flags: 5 `inject_tool_failure` cases, 9 `outcome_step` cases (4 `repaired`, 5 `not_repaired`), 19 reused cases, 54 new.
All 73 are `solvable: true`; for the abstention classes the solution is to escalate.
Offender families from #992: Mickey 2 rows (`tv-healthy-002`, `tv-identity-002`), Pokemon 1 row (`tv-insuff-001`); the cap is 2.
Largest family: `anne` with 6 rows (all dev).

## Where the truth comes from

No label comes from a model. `truth.source` says which of the four kinds applies, and `truth.ref` names the evidence
(including the sha256 prefix of the replay file for synthetic fixtures).

| class | how it was built | truth source |
|---|---|---|
| corrupt_file, video | `gen_media.sh` takes one good clip and truncates it (55%), overwrites 2 KiB mid-stream with 0xFF (55%) or 0xAA (70%), cuts an mp4 before its `moov` atom, or writes a 0-byte file | deterministic: the recorded ffprobe / ffmpeg result of the committed file (`File ended prematurely`, H.264 cabac errors, `moov atom not found`, `EBML header parsing failed`) |
| corrupt_file, audiobook | m4b cut before `moov`; mp3 with ID3 tags and chapters but zero audio frames | deterministic: ffprobe exit 1 and message |
| corrupt_file, EPUB | `gen_epub.py`: truncated ZIP, malformed `content.opf`, one flipped byte in a STORED member (CRC), manifest pointing at a missing member; plus the 2 KiB `derived-damage.epub` from PR #999 | deterministic: `epub_inspect` stage (`zip_open`, `opf_parse`, `zip_crc`, `manifest`) |
| decoder_incompatible | a clean-decoding file whose codec, bit depth or channel count falls outside a defined client profile in `context.client_profile` (High10 H.264; HEVC Main10 + AC-3 5.1; the reused EAC3 6-channel movie) | deterministic: stream properties against the profile, plus a clean full decode. The same High10 fixture is also a `healthy` control under a profile that allows 10-bit. Profiles are test definitions, not measured clients |
| identity_mismatch | the content (title card, container tags, chapters, EPUB body headings, audiobook chapter list) names a different work or episode than the entry the file is attached to | deterministic from recorded tool output, or construction (the generator wrote the card / body) or prior human adjudication for reused rows |
| metadata_naming | the entry the file is attached to equals the content; only the file name, tags or OPF is wrong or missing. Supported fix is metadata-only (`rename`) | authoritative_metadata (the entry's lookup record) plus deterministic content evidence |
| order_edition_ambiguity | a title that sits at different numbers in aired and DVD order with no configured order recorded; an extended cut with no wanted edition recorded; two audiobook editions with the same runtime and narrator | authoritative_metadata. Only `escalate` is supported. The settled twins (library order is DVD; the Extended Cut is the monitored edition) are `healthy` |
| insufficient_evidence | intact files with no title card, tags or chapters; a 16 s file whose second half is unverified (the Mickey "second story" shape); a translation with no alias on record; injected-failure twins where the decisive tool failed | construction. Only `escalate` is supported |
| healthy | correct content with an unusual look: scene-release file name, alias title, series-prefixed OPF title with `Tolland, Mira`, extra commentary track plus subtitles, tiny one-chapter story, mp3 with part-style name, High10 under a 10-bit-capable profile, DVD-order episode, monitored extended cut | construction + deterministic |
| inject_tool_failure | five cases name a tool that fails (`error`, `timeout` or `partial`). In the three "twin" cases (same file as a sibling) either the remaining evidence still settles the label, so the supported set is the label's write action plus `escalate`; or it does not, so the case is `insufficient_evidence` with `escalate` only | construction |
| outcome_step | nine cases: the original file is broken or incompatible and `outcome_step.inputs` carries the replacement fixture plus its recorded post-action evidence and a `pass_rule`. Repaired: clean replacement of the same episode / valid EPUB / correct audiobook / H.264+AAC conversion. Not repaired: replacement still corrupt, replacement clean but the wrong episode, converted copy that lost its audio, an EPUB that still fails CRC, an audiobook that is readable but a different recording | deterministic (`test_outcome_expectations_follow_post_evidence` re-derives each from the recorded evidence) |

### Reused vs new

Reused (19, `provenance` gives path@sha): the 11 documentary rows `c01`-`c11` of `media-repair-benchmark-2026-10-18/corpus.jsonl`
(ids `epub-identity-001`/`-002`, `epub-healthy-001`/`-002`, `audiobook-identity-001`, `audiobook-healthy-001`, `movie-identity-001`,
`movie-healthy-001`/`-002`, `tv-identity-001`, `tv-healthy-001`); the Anne pair from PR #998 (`epub-identity-003`, `epub-healthy-003`);
`derived-damage.epub` and `derived-title.epub` from PR #999 (`epub-corrupt-001`, `epub-identity-004`); and AV `a01`-`a04` from PR #1000
(`tv-healthy-002`, `tv-identity-002`, `tv-insuff-001`, `movie-decoder-001`).
Documentary rows `c07`-`c10` were held out in 2026-10-18; every candidate has since seen them, so they are dev rows here and cannot count toward a held-out claim.
Not duplicated: the 13 text-only renderings of the same rows in `media-repair-nemotron-2026-10-18/text-cases.json`.
The PR #999 multi-candidate selection protocol (choose among three candidates) has no counterpart in the contract's action set, so only its
fixtures are reused, as single-file cases; the selection protocol itself is a gap (below).

Reused cases keep their evidence form. Real media (Mickey file 80066, Pokemon 80065, Zom movie file 6337) is `fixture.kind: remote`; its
`fixture.sha256` is the hash of the pinned observation record, not of the media (no full-file hash was ever measured, per `IDENTITY.md`).
The Anne EPUBs are `kind: local` at `~/.cache/media-repair-*-1018/...` (outside git, over 200 KiB; the validator re-checks the hash when the file is present).
Only titles, creators, counts and the first six words of three spine items are shown for them; no book text is copied. The Mickey subtitle lyrics are
omitted (a short card transcription stays); Pokemon `tv-insuff-001` keeps the one short subtitle line the abstention rests on.

New (54): fictional works only. TV series "Harbor Lights" (6 episodes, aired order, Sonarr-style lookup), movie "Quiet Orbit" (2019,
theatrical 8 s, extended 12 s) and "Paper Kingdom", audiobook and EPUB "The Lantern Road" by Mira Tolland (narrator Ellis Marr), "The Lamplighter's Note", and
Salt and Cedar (the wrong body). The *arr ids are marked fictional. Metadata lookups for these are `arr_lookup` evidence written by construction.

## Fixture generation

`gen_media.sh` uses lavfi `testsrc2` plus `drawtext` title cards and `sine` audio, H.264 / HEVC / AAC / AC-3 / MP3 encoders, one thread, `nice -n 19`,
256x192, 6 to 20 s clips. This pod has no ffmpeg, so the script ran **once as a batch Job in namespace `dev`** (image `ghcr.io/advplyr/audiobookshelf:2.37.1`,
ffmpeg 8.1.2, limits cpu 1 / memory 1Gi, emptyDir, 10 MB per-file `ulimit`, `ttlSecondsAfterFinished`), output returned as a tar through the log, then the Job was deleted.
The first attempt filled its emptyDir (an mp3 with `-t 0` set as an input option never stopped) and was evicted; the `ulimit -f` guard and a fixed option placement came from that.
It was then re-run several times while sizes and chapter timing were tuned, and the committed files come from the last run (the final two runs were compared for determinism). m4b, mp3 and mp4 outputs are byte-identical across runs; **Matroska files are not** (the muxer writes a random SegmentUID even with
`-fflags +bitexact`), so the committed `.mkv` bytes and their hashes in `manifest.json` are the authority, and `make_replay.py` output belongs to the committed run.
EPUBs from `gen_epub.py` are byte-reproducible (a test checks this).
The title-card font is the Ubuntu Mono file inside that image; it is used to draw frames and is not committed.

`fixtures/probes/<fixture>.json` holds the recorded results of the standard live calls so a runner without ffmpeg can replay them: `ffprobe`
(condensed JSON), `decode_sample` for the 4 s windows at ss=0, 4, 8, 12 and a full decode, and `frame_text`, the title-card text by time, known
from the drawtext schedule (not OCR, not a model reading). A runner with ffmpeg can re-run the live tools and compare. The pre-collected `evidence`
in each case is a subset of these. Several cases deliberately leave the decisive call out (for example `tv-corrupt-003`: the ss=0 window is clean and the damage
only shows at ss=4), so a solving run has to call `decode_sample`.

## Notes for the scorer (W4) and the coordinator

* `supported_actions` is the set of acceptable write or abstain actions. When `escalate` sits next to a write action (three injected-failure cases) abstaining is acceptable
  and should not count as a false abstention; in every other solvable case `escalate` is outside the set, so abstaining there is a false abstention (G5).
  `healthy` supports only `none`; `insufficient_evidence` and the ambiguity classes support only `escalate`. G2 counts only `none` on a healthy case; the injected-failure
  cases are on non-healthy labels for that reason.
* Additive keys beyond CONTRACT.md v1, all optional and ignorable: `context.filename`, `context.client_profile`, `context.question`, `outcome_step.why`;
  evidence tool `prior_record` for pinned historical observations (not callable, so not in `tools_available`).
* `outcome_step.check` is `post_replace_verify` or `post_convert_verify`; `inputs.pass_rule` states it in words and `inputs.post_evidence` is what a post-action check
  would collect on the replacement. `expected` is the ground truth the run must reproduce.
* `class` and `supported_actions` follow one rule: identity_mismatch = the content is a different work or episode than the entry the file is attached to (replace the release);
  metadata_naming = the content is right and only a label is wrong or missing (metadata-only fix); corrupt_file = decode or structure fails; decoder_incompatible = decode is clean but the defined client cannot play it (`convert`, isolated copy).

## Known limitations

* Synthetic clips have simple structure. Real corruption (bit rot in a 1 GB file, partial downloads) is represented by recorded construction recipes, not real offenders; no real corrupt
  positive from the library is in this suite because none was ever measured.
* The one-sided evidence for identity is text: tags, chapters, card text, headings. `frame_sample`, `audio_sample` and native AV input have no recorded replay; `frame_text` stands in for OCR.
* Client profiles are definitions, not measured clients. Order / edition cases rest on fictional metadata records.
* The reused documentary rows are reported observations, not re-decoded media. `epub-identity-001` (City of Illusions, omnibus "Worlds of Exile and Illusion") is labelled mismatch by the historical
  adjudication although the omnibus contains the work; Qwen abstained on it in 2026-10-18. It stays as a known-hard row.
* 73 dev cases from a small number of generator recipes (1 to 6 rows per family); results on this split say nothing about a held-out population.
* Not covered: multi-candidate selection (PR #999 protocol), subtitle / audio-language errors, multi-episode files, audiobook decoder incompatibility, EPUB order / edition and decoder cases, real client capability.
* For the held-out story: new fictional works and recipes, fresh generator seeds, and nothing from `anne`, `city`, `crown`, `zom`, `spidey`, `moana-alias`, `mickey-roadster` or `pokemon-houndour` families.
