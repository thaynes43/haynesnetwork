# Media repair harness: sealed held-out suite `heldout-v1`

OpenProject story [#134](https://work.haynesnetwork.com/work_packages/134) under epic [#48](https://work.haynesnetwork.com/work_packages/48).
Gates: [`../GATES.md`](../GATES.md) (recorded before any v1 case was scored). Case schema: `../harness/CONTRACT.md` v1.

**Status: sealed.** Only [`SEALED.json`](SEALED.json) and this file are in git. No case, fixture, replay record, evidence or generator output is committed
or pasted anywhere. The suite lives in a private directory on the dev-env pod's volume and is opened once, for the frozen readiness run
(GATES.md checkpoint 3). It was built by a separate worker (`claude-sonnet-5-5`) that did not read the dev cases' evidence or answers, the
baseline directory or any run record. Anything a developer sees from it afterwards is dev material, and the held-out claim needs a fresh set.

## What it is

47 cases (movie, tv, epub, audiobook) in the same seven classes as the dev suite, with the same case schema, so the unmodified harness runner and scorer
read it. Counts by class, media type and the special groups (healthy, abstain classes, injected tool failures, outcome steps, offender-family rows, library-sampled
cases) are in `SEALED.json`, together with a SHA-256 of every case file under an opaque index, the tarball hash and size, the family names and the hashes of the
generator scripts. The counts meet or exceed every minimum in GATES.md "Suite shape".

## How it was built

- **Two sources.** Most cases are synthetic: small fictional works generated deterministically (lavfi sources and a stdlib EPUB writer; ffmpeg ran once per
  generation in a CPU-limited batch Job in namespace `dev`, serial, `nice 19`, and each Job was deleted). A group of cases are real library items, sampled read-only
  through the existing Bazarr-pod path (`sample_remote.py` from the AV increment, extended to also return format tags and chapters), plus a read-only look at Bazarr's
  mirror of the *arr records for file ids. Real cases reference the *arr file id and a SHA-256 of the sealed observation record only; their probe and bounded-decode
  evidence is stored in the private directory. Nothing was written to Sonarr, Radarr, Plex, Seerr or the library.
- **Truth never comes from a model.** Each case names its source: `construction` (the generator wrote the defect or the content), `deterministic` (a recorded probe or
  decode result, or a structure check with the harness' own EPUB tool), `authoritative_metadata` (the entry's lookup record, written by construction for fictional
  works), or `human_adjudication` (a staff record, cited with the SHA-256 of the issue text it comes from). Abstention classes are built so that nothing in the file or
  the record settles the answer. Every case is marked solvable; for the abstention classes the solution is to escalate.
- **Replay-ready.** Every local fixture has a recorded replay file in the harness' replay format, so a runner without ffmpeg serves the same probe, bounded decode and
  title-card results a live run would. Evidence that settles a case is sometimes left for the model to collect with a tool call, and sometimes pre-collected.
- **Injected failures and outcome steps.** Some cases name a tool that fails on purpose (error, timeout, partial). Either the remaining evidence still settles the case
  (the supported set then lists the write action and `escalate`) or it does not (the case is an abstention case). Outcome-step cases carry a replacement or conversion
  fixture with its recorded post-action evidence, a mix of `repaired` and `not_repaired`; the harness' own outcome checks reproduce every expected result.

## How bias was kept out

1. **File names do not carry the class.** Four or five name styles (library-manager format, scene release, plain, edition-tagged for movies, odd or underscored)
   are used with a similar share in healthy and defective cases, and a name is only ever wrong where the case is about the name. No name contains a hint such as "sample" or "bad".
   A private style-by-class table was checked before sealing.
2. **Clip lengths, codecs and containers are varied inside every class** (several containers and video and audio codecs, synthetic clips from about 10 s to 30 s), so none of them identifies a class.
3. **No dev recipe is reused.** Different fictional works, fonts, test sources, resolutions, damage operations and offsets, and a different EPUB layout. No family appears in the dev
   manifest (checked, see `SEALED.json`); family names are opaque except the two #992 offender families.
4. **Offenders.** Two rows each from the #992 families (Pokémon, Mickey), at different episodes and with different evidence than the dev rows. The three named offenders themselves are not in
   the suite, and all offender-family rows together stay under 10 percent.
5. **Leak guard.** The harness' leak guard was run over the first request and every replay tool result for every case, with no model: no case id, family, class, action name, truth
   reference or fixture name reaches a model-bound message, and the guard is not vacuous (the unredacted view leaks for every case).

## Verifying and opening it (readiness run only)

```bash
sha256sum /home/dev/.cache/media-repair-harness-1019/heldout-v1/heldout-v1.tar.gz     # must equal tarball.sha256 in SEALED.json
mkdir -p ~/.cache/media-repair-harness-1019/ho-open && tar -xzf <tarball> -C ~/.cache/media-repair-harness-1019/ho-open
python3 -I ho-open/heldout-v1/suite/suite.py validate                                  # patched copy of the origin/main validator: 0 errors expected
python3 .agents/context/media-repair-harness-2026-10-19/harness/run.py --suite ho-open/heldout-v1/suite --adapter <a> --model <full id> --out <run dir>
```

The validator copy in the tarball changes constants only (version, the GATES.md minimums, the offender-family and dev-overlap checks, the size cap); its diff is in the tarball.
Each case SHA-256 in `SEALED.json` can be matched to the extracted file before scoring.

## Limits

- 47 cases from a small number of generator recipes plus 9 library files: the result is a readiness screen, not a population estimate (see GATES.md "Sample limits").
- Synthetic clips are tiny and simple; real corruption in a large file is represented by recorded construction recipes. The library files are known only through bounded
  samples (some windows hit the 8 MiB read quota, and the cases say so), and the file hash is that of the observation record, not of the media.
- Client profiles and lookup records for fictional works are test definitions, not measured clients or live *arr data. `arr_lookup` is still the harness' stub.
- One builder wrote every case. The independence is from the development and tuning work, not a second reviewer.

## `heldout-v1.1` (evaluator construction corrections, 2026-10-20)

[`SEALED-v1.1.json`](SEALED-v1.1.json) seals a corrected copy of this suite. Tom authorized it on 2026-10-20: the evaluator audited `heldout-v1` privately and applied only the
general construction rules C1 (managing app: LazyLibrarian for EPUB and audiobook cases), C2 (healthy controls with no integrity evidence) and C5 (tools offered with no recorded
data). Counts: C1 changed 20 cases, C2 changed 0, C5 changed 0 (an offline test of the current harness showed every tool offered on the real-library cases can return recorded data, so none was removed). Labels, supported sets, fixtures and case counts are unchanged, so every count in
`SEALED.json` still holds. `heldout-v1` is retained unchanged (tarball hash above), nothing from it was moved or edited, and no candidate has been scored on either version.
The dev-case-specific rulings (C3, C6, `ADJUDICATION-dev-v1.md`) were not applied. The disclosure level is the same as for v1: hashes by opaque index, counts, no case contents.
