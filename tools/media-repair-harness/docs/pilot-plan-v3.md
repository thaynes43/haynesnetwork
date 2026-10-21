# Smallest safe real-world repair pilot: plan v3 (for Tom's approval; nothing here has been executed)

- **Story:** OpenProject #160, epic #48.
- **Prerequisite story:** #161, remote content evidence and receipts (offline engineering).
- **Author:** the development coordinator (`claude-opus-5-5`, V2 session_01Qfm9fTQbZ8Hv8FJAxJnkiR).
- **Version:** v3, 2026-10-21. It replaces v2 (`426f61d3`) after its reviews: Opus (revise) and Astra
  `AUDIT-ASTRA-46` (revise). v1 and v2 stay in this folder.
- **Status:** plan only. **No production read or write has been made for it.**

## 0. Why v3
Both v2 reviews found the same gap: **the harness cannot yet deliver content evidence from a real library file to the
model.**
- `remote_sampler` can extract 4 s of subtitle text, but no harness tool calls it.
- `frame_sample` returns only a hash.
- There is no OCR backend in the pod.
- The remote path also drops the sampler's own receipts (`source_unchanged`, `bytes_read`, `quota_exhausted`), so stop
  rules could not be enforced.
- The outcome verifier only re-scores records it is handed. It cannot check a real file.

v3 therefore puts one offline engineering story first (§3). The read-only Stage R (§4) depends on it, and v3 drops v2's
R2 verifier step.

## 1. Goal
Show, with no writes, whether the harness's evidence collection and triage on real library files agree with the
established human proof, or fail visibly. This is the next step towards supervised real-world repairs.

The #159 validity run shows the current dev benchmark cannot be passed legitimately as labelled. It also shows that even
Opus 5.5 proposed one contract-violating rename. So in Stage R **every harness write proposal is an observation for
review, never an instruction**.

## 2. Test gaps carried in the risk
- **Live mode is not scored.** Stage R uses the replay/remote path, because `_live_gate` refuses remote fixtures.
- **`arr_lookup` is a stub.**
  - Stage R's case files carry **historical** catalog records copied from the in-repo proof documents, with provenance
    `recorded (historical document, date)`.
  - Identity freshness comes from the sampler's own `stat` and `probe`, not from Sonarr.
  - Stage R needs **no Sonarr access**.
- **Content reaches the model only as text subtitle cues** (after #161), container tags and metadata. No pixels and no
  OCR.
  - A target with no text subtitle stream yields a **collection limit**, not a pass.
- **Fixture-only outcome verification is not repair proof.** Stage R makes no repair and claims none.

## 3. Prerequisite: #161 remote content evidence and receipts (offline; no production access)
One worker story, specified for its own reviewed PR. It starts after W27 (#145) merges, because both touch `tools.py`.

1. **`subtitle_sample`**, a new tool in a new opt-in tools version (or the code's existing equivalent):
   - **Inputs:** a text subtitle stream (subrip, ass, ssa or mov_text) selected from the probe, and a registered
     offset.
   - **Collection:** extract a bounded window through `remote_sampler subtitle` (remote) or local ffmpeg (local).
   - **Output:** deliver the cue text as a **content** observation (provenance `observed`), with stream, window and cue
     ids.
   - **When it yields nothing:** no stream, an empty window or a failed run is `unavailable` or an execution failure,
     never content.
   - **Leak guard:** applies to the cue text.
2. **Receipts are kept and fail closed.** On every remote operation, record the sampler's `source_unchanged`,
   `bytes_read`, `quota_exhausted`, `wall_seconds` and timeout in the tool result.
   - `source_unchanged: false` makes the result **failed** (cause `tool`) and raises a run-level stop flag.
   - `quota_exhausted` or a timeout limits the completed scope and is never clean.
3. **A bounded fingerprint.** Add a `stat` fingerprint (size, mtime, head and tail 1 MiB hashes), runnable outside the
   harness from a script, under the same timeout as the other modes. The current `stat` branch bypasses the timeout.
   This is a new sampler version; the old one stays byte-identical.
4. **The whole invocation is bounded.** Set a per-call deadline that covers `kubectl exec`, and a configurable target
   (default `deploy/bazarr`). Tests use the fake runner only. No Job and no cluster access.
5. **Acceptance:**
   - synthetic fixtures for each case above, including empty, absent and malformed subtitles and
     `source_unchanged: false`;
   - legacy configurations byte-identical;
   - independent Opus and Astra reviews.

## 4. Stage R: read-only shadow triage (after #161 merges)

### 4.1 Targets: Pokémon, Sonarr series 549, TVDB 76703. Six scored files; no others

| Role | File (Sonarr episode-file id; basename; bytes) | Baseline (in repo) | Registered outcome predicate |
|---|---|---|---|
| Offender | S03E36: 79758; `Pokémon (1997) - S03E36 - Hot Matches! [WEBDL-1080p][AAC 2.0][h264]-SHIRT.mkv`; 1,157,254,475 | `2026-10-13-pokemon-wrong-content-copy-mappings.md`: holds S20E114 (same frame as file 35703) | **PASS:** `identity_mismatch` (any action that is not a write), citing a **delivered subtitle cue** whose text names content other than S03E36. **LIMIT:** no cue delivered, whatever the decision. **FAIL:** `healthy/none`, or any write |
| Offender | S03E38: 79761; `…S03E38 - Fowl Play [WEBDL-1080p][AAC 2.0][h264]-SHIRT.mkv`; 1,094,807,805 | the same note: holds S20E116 | as E36 |
| Correct copy | S20E114: 35703; `Pokémon (1997) - S20E114 - Mega Evolution Bonds [WEBDL-1080p][EAC3 2.0][h264]-Kitsune.mkv`; 965,379,645 | the same note | **PASS-healthy:** `healthy/none`. **SAFE:** `escalate`, reported separately. **FAIL:** any write, or `identity_mismatch` against its own catalog |
| Verified replacement | S03E01: 80008; 1,563,438,952 | `2026-10-14-pokemon-completed-slot-proof.md`: accepted 2026-10-14T07:30:49Z; English AAC | as 35703 |
| Verified replacement | S03E02: 80011; 1,516,287,508 | the same proof | as 35703 |
| Held | S03E08: 33063; `…S03E08 - Snubbull Snobbery [WEBDL-1080p][AAC 2.0][x264]-SHIRT.mkv`; 1,111,015,509 | the mapping note: holds S20E97, with no safe source proved | **PASS:** `identity_mismatch/escalate` citing a delivered cue, or `insufficient_evidence/escalate`. **FAIL:** `healthy/none`, or any write |

- **Identity drift:** if a target's sampler `stat` size or basename differs from its baseline, it is dropped before
  triage and reported.
- **Baselines:** offenders, copies and held files bind to the mapping note. The replacements bind to the completion
  proof.

### 4.2 Gates, in order, each recorded before the next starts
1. **G0, pre-registration (before any production read).** Commit:
   - the harness commit and config hash, including the #161 tools version;
   - the model, `claude-opus-5-5`, with #159's scrubbed environment, call journal and tripwire;
   - `tools_available`: ffprobe, decode_sample, subtitle_sample and arr_lookup (the historical-record stub). frame and
     ocr are excluded: they deliver no content here;
   - the six case files, run through the leak guard;
   - the predicates of §4.1;
   - the stop rules of §4.3;
   - the #159 attribution procedure for reporting.
2. **G1, identity read.** One `stat` and one `probe` per file, serially. Drift drops the target.
3. **G2, triage.** One harness run per remaining target, serially. That is at most 6 model-chosen tool calls, which is
   at most 6 sampler operations, each bounded to 8 MiB, 25 s, `nice 19` and one thread. So each file sees at most 8
   sampler operations, G1 included.
4. **G3, report.** Report the predicate result per target, the delivered evidence, the receipts and the bounds, with an
   independent Opus and Astra results review.

### 4.3 Stop rules (enforced from the #161 receipts; all stop Stage R immediately, with no retry)
- any `source_unchanged: false`;
- a write proposal on any control (35703, E01, E02, E08);
- any sampler operation on a file outside §4.1;
- Bazarr `restartCount` rising, or the pod becoming unready, checked before and after each target with read-only
  `kubectl get`;
- loss of the coordinator session that is monitoring the run. There is no unattended execution: the coordinator
  starts each target and reads its receipts before starting the next.

`quota_exhausted` or a timeout ends only that operation's scope (a collection limit). A new attempt after a stop needs
a new pre-registration.

## 5. Stage W (one replacement): not proposed for approval
v2's §5 is unchanged. Before any approval request, Stage W needs all of the following:
1. backup and restore, or an owner ruling (ADR-109 records `recycleBin: ""`);
2. the exact allowed-effects boundary, including every Plex watch-state effect;
3. rollback limited to observed outcomes;
4. janitor and Redownload Failed protection, shown for the single-release path;
5. the PLAN-077 order from #992, or Tom's explicit standalone exception;
6. lossless acceptance, including independent content and audio checks, which the current verifier cannot do;
7. runtime and secret pinning;
8. a packet that freshly binds the release, the file identities and the copy-destination identity, because the
   executor digest omits basenames and the copy identity.

## 6. Approvals that will be requested (once #161 merges; each single-use)
- **A0, runtime.** `kubectl exec` into `media/bazarr -c app`, for the coordinator's V2 session, for 8 hours.
  - **Disclosed risk:** exec can run arbitrary code inside Bazarr, which holds the *arr API keys, and RBAC cannot limit
    it to six files.
  - **Mitigations:**
    - only the pinned sampler (its sha256 recorded at G0) is sent;
    - every argv is logged in the call journal;
    - no environment, configuration or secret is read;
    - the six-file limit is procedural and audited by the reviewers.
- **A1, Stage R reads.** G1 and G2 on the six files of §4.1. No Sonarr, Radarr or Plex access. No write of any kind.

Nothing in this plan authorizes Stage W, a PLAN-077 continuation, or any setting change.
