# Identity findings report (`identity-report-1`)

- **Story:** OpenProject #160 (epic #48). Detection and reporting only.
- **Status:** offline command. It does not change runner defaults, prompt contracts, sampler behaviour, or evaluator-owned files.
- **Module:** `media_repair_harness.identity_report` (new). Recipe planning lives in `identity_recipe.py`. Cue parsing lives in `identity_cue.py`.

This is not the runner, not Stage R, and not the 8-second `subtitle_sample` window. Offline rendering never starts a child process, opens a socket, or calls a model.

## D-01 Command

```bash
python3 -m media_repair_harness.identity_report offline \
  --manifest sample.json --evidence-root DIR --out RUN
python3 -m media_repair_harness.identity_report plan-recipe \
  --stream-index N --style 'exact style name'
```

`offline` is the report. `plan-recipe` prints an allowlisted argv plan and does not open a source. There is no execute mode in `identity-report-1`.

Exit `0` means the manifest schema was valid and every referenced artifact hashed. Exit `2` means the manifest was rejected. Exit `3` means the schema was valid, a report was written, and at least one artifact was missing, drifted, or contradictory. A drifted artifact is not used as evidence.

The run directory is created only when `--out` does not already exist. Outputs are `manifest.json`, `findings.json`, `report.md`, `audit.html`, and `audit.pdf`. The HTML embeds retained frame bytes so one file is readable on a phone. Nothing in the renderer contacts the network.

The report is a pure function of the manifest bytes and the evidence files. It does not read the clock, the hostname, or git. A git sha is copied only when the manifest supplies one.

## D-02 Manifest `identity-sample-1`

The manifest names the sample. It does not discover files. Paths are relative to `--evidence-root`, with no absolute path and no `..`. Identity fields (`fileId`, `dev`, `ino`, `mtimeNs`, `size`, stream index) are JSON integers, never strings, floats, or booleans, and they round-trip as full decimal integers.

| Object | Role |
|---|---|
| `items[]` | Alias, file id, binding, catalog claim |
| `catalogSnapshot` | Retained catalog JSON (`series.title`, `files[]` with `id`, `seasonNumber`, `relativePath`, `size`, `episodes`) |
| `artifacts[]` role `sampled-frame` | Image bytes, sha256, integer `atSeconds` |
| `artifacts[]` role `embedded-title-cue` | Cue JSON plus the exact allowlisted `expectedStyle` |
| `artifacts[]` role `probe-metadata` | Retained ffprobe-shaped JSON. The cue's `streamIndex` must name one subtitle stream |
| `artifacts[]` role `collection-receipt` | Historical receipt for a frame or cue. Not re-executed |
| `comparisons[]` | `same-scene` or `distinct-scene` over frame ids |
| `dispositions{}` | Human `confirmed` / `contradicted` / `uncertain` / `notReviewed`, exactly one true |
| `citedNotes[]` | Text copied through and not re-fetched |
| `provenance.gitSha` | Optional. Omitted means null |

A catalog claim is consistent only when its series title and season equal the snapshot and its title (and episode code, when claimed) occur in that file's relative path. `episodes: null` stays null. A contradiction makes the catalog side unknown. The report does not substitute another file.

## D-03 Claims

Each claim has a machine `issueLikelihood` of `candidate`, `not-observed-in-sample`, `unknown`, or `tool-failed`; a separate observation state; an evidence grade; alternatives; and the four human disposition flags. `calibratedProbability` is null. Grades are ordinal labels, not percentages.

| Claim | Rule |
|---|---|
| `scene:<id>` | No image is matched algorithmically. A human disposition is cited only after the frame hashes match. |
| `embedded-title:<item>` | One exact-style ASS cue. The raw `Dialogue` line is reparsed and must agree with the structured fields. |
| `catalog-title-disagreement:<id>` | Emitted for a same-scene comparison. A `candidate` needs a confirmed scene disposition, one validated cue, a catalog title that still differs after D-04, and a consistent probe when a probe is linked. That grade is `strong-candidate` only with the probe. |
| `full-episode:<item>` | Unknown. A cue plus one scene does not identify the whole file. |
| `health:<item>` | Unknown. A distinct sampled comparison is not a health determination. Missing evidence is not health. |

Season numbers are recorded and are not mismatch evidence. Punctuation-ambiguous titles are not an automatic mismatch. An absent exact style, an empty cue, or a non-ASS codec is unavailable, not wrong content. Two disagreeing cues, or a raw line that disagrees with the structured text, stay unknown. An unexpected process exit marks the cue `tool-failed` and the text is not used. Exit 255 with a deliberate stop and the recorded `Broken pipe` stderr is `deliberate-post-cue-stop`, not a clean EOF, and the cue can still be used.

`sourceBytes` stays null. A process counter, including zero, is not a source or NFS total.

## D-04 Title text

Override blocks `{...}` are removed, `\N` and `\n` become spaces, and the ends are trimmed. That text is kept. A comparison fold then records its steps: strip, collapse whitespace, map dashes and colons to spaces, casefold, and strip trailing `.!?`. The fold is not a rewrite of the evidence. Equal folded titles are `ambiguous`, not a mismatch. Filename words are not required and are not a filter.

ASS times must match `[0-9]+:[0-5][0-9]:[0-5][0-9].[0-9]{2}`. Commas in the text field survive the ten-field split. The style compare is exact and case-sensitive. Any nonempty title is accepted.

## D-05 Recipe plan `identity-recipe-1`

`plan-recipe` returns one argv: `nice -n 19 ffmpeg` reading `/proc/self/fd/{fd}`, mapping absolute stream `0:N`, copying the subtitle, `-flush_packets 1`, `-ignore_readorder 1`, ASS on `pipe:1`. The style is not an ffmpeg filter. The plan names no hostname and does not open the descriptor. A later explicit collection has to supply the current target itself. This report never calls the plan as a process.

## D-06 What this command does not do

No library scan, no sample expansion, no ASR, no OCR, no model call, no repair, no rename, no download, and no catalog or watch write. Local-model interpretation stays staged until a separately verified GPU check exists. Evaluator held-out material is not an input.

## Test strategy

`tests/test_identity_report.py` uses synthetic files only. It covers full-width integers, malformed and drifted artifacts, exact style versus suffix, generic, and empty text, ASS overrides, commas, Unicode, timings, an arbitrary title, contradictory and missing cues, distinct scene versus health, exit 255 versus an unexpected exit, escaping, provenance, and the absence of subprocess, socket, and URL calls.
