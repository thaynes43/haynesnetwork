# Smallest safe real-world repair pilot: plan v1 (for Tom's approval; nothing here has been executed)

- **Story:** OpenProject #160, epic #48.
- **Author:** the development coordinator (`claude-opus-5-5`, V2 session_01Qfm9fTQbZ8Hv8FJAxJnkiR), 2026-10-21.
- **Status:** plan only. **No production read or write has been made for it.** Executing any step needs the approvals in
  §8.

## 1. What the pilot proves and what it does not
The goal is to move from "the harness passes fixtures" to "the harness's triage is useful for a real repair". The pilot
does that on the smallest possible scope, with every write done by the **existing audited executor**.

**What the pilot proves:**
1. On real library files, the harness's read-only triage agrees with the established human proof. That proof covers
   known wrong-content offenders and known-good controls.
2. The harness never proposes a write on a control.
3. On **one** episode, the full chain closes. The chain is: harness diagnosis → human approval → the existing audited
   Wrong-Content Replace → independent post-repair verification.

**What the pilot does not prove:**
- It does not prove that the harness is ready for unattended use. The dev benchmark is not passed, and the validity
  analysis (#159) shows that the benchmark *cannot* be passed as it is labelled.
- It does not give the harness any write path. **The harness never writes.** Its decision is a proposal that a human
  reads.

## 2. Current test gaps (explicitly in scope of the risk)
- **Live mode is not scored.** The live collectors have run only on synthetic fixtures in a Job, never on real library
  media. ffmpeg and tesseract are absent from the dev pod.
- **`arr_lookup` is a stub.** It returns only case-provided records. The harness has no read-only Sonarr path.
  - In the pilot, source binding comes from the executor's own read-only Sonarr reads (`replace-plan`), not from the
    harness.
- **Outcome verification so far is fixture-only.** G6 checks fixture verifiers. It is not proof of any real repair.
- **Four EPUB fixtures exist only on the pod,** so CI coverage there is limited. The pilot uses no book targets.
- **The V2 runtime is unverified for this work:**
  - V2 sessions have no egress to in-cluster services without a grant.
  - `remote_sampler` (read-only `kubectl exec` into the Bazarr pod) has unverified exec RBAC from V2.
  - The staff CLI runs as an app-image Job with the app's Secrets.
- **Sonarr state backup:** this repo documents no Sonarr/Radarr state backup. The app cannot restore a deleted library
  file.

## 3. Targets (exact)
All targets are on the existing Pokémon S03 offender list (DESIGN-055 decision 38; #928; mappings in
`.agents/context/2026-10-13-pokemon-wrong-content-copy-mappings.md`).

| Role | Target | Established human evidence | Expected harness outcome |
|---|---|---|---|
| **Mutating target (one)** | Pokémon (1997) **S03E36** "Hot Matches!": Sonarr file **79758** (1,157,254,475 B) | The file holds S20E114 *Mega Evolution Bonds*. A physical frame comparison against the show's own S20E114 file **35703** gave a mean pixel difference of 1.117/255 and an equal 8×8 average hash | `identity_mismatch`, either `blocklist_and_search` or `escalate`, citing **content** (frames/OCR). Never `rename` and never `none` |
| Offender, read-only | Pokémon S03**E38** "Fowl Play": file **79761** | A positive physical match to S20E116 *Terarium Training!* (file 35729) | as E36 |
| Healthy control | Pokémon S03**E33**: an accepted full controller finish (#992) | Verified correct replacement | `healthy/none` or `escalate`; **any write is an abort** |
| Healthy control | Pokémon S03**E32**: an accepted full controller finish (#992) | Verified correct replacement | as E33 |
| Held control | Pokémon S03**E8**: held. The wrong file is kept because no correct release was proved | Wrong content, no safe source | `identity_mismatch`, `escalate` or `blocklist`. The executor's `replace-plan` must refuse `no_release` |

**Excluded on purpose:**
- **Pokémon E34 and Mickey E45/E46.** They have paused PLAN-077 continuations (#992) and need their own resumption
  decision.
- **Mickey E13–E16.** Held.
- **Ben 10 (2016) E10/E12.** There is no same-content copy to carry marks to.
- **Books.** There is no real binding path.
- **Anything not listed above.**

## 4. Phases

### Phase 0: prerequisites (no media access)
1. **Runtime.** Decide where each step runs:
   - **Harness:** a CPU-limited batch Job in namespace `dev` (cpu ≤ 2, `nice 19`) that reaches the files read-only
     through `remote_sampler`, or an authorized `kubectl exec` grant into the Bazarr pod.
   - **Executor:** the staff CLI (`repair-guide.ts`) as an app-image Job in `frontend`, as PLAN-077 did.
   - Each needs a V2 grant or an existing standing policy. That is approval **A0**.
2. **Read-only settings check.** Run `repair-guide.ts settings` (read). Record the remedy toggles and the janitor
   ladder. The janitor's `arr` cells are at L2, with `bad_release` enforced. A pilot grab must not race a janitor
   action.
3. **Read-only backup check.** Read Sonarr's media-management config through the existing read client. Record whether
   a recycle bin is configured.
   - **If none is configured, `replace-run`'s delete of file 79758 is irreversible.**
   - The pilot then needs Tom's explicit acceptance of that. The file is proven wrong content, and a same-content copy
     (file 35703) exists.
   - The app never writes Sonarr's own settings, so the pilot will not enable a recycle bin.
4. **Freeze the harness configuration:**
   - the dev-c7 configuration, or dev-c8 if it is merged first;
   - model `claude-opus-5-5` as the triage model, because no candidate has passed and the frontier control is the most
     careful available;
   - `--evidence live` with bounds `{"segments":2}`;
   - a pre-registered pilot record (targets, expected outcomes, abort rules), committed before the first live read.

### Phase 1: read-only shadow triage (approval A1; no writes anywhere)
- Run the harness on the five targets of §3.
- **Reads:** ffprobe, bounded decode windows, frames and OCR at the case's offsets, under the existing per-operation
  bounds (8 MiB, 25 s, `nice 19`). Nothing else is read.
- **Outputs:** run records only.
- **Pass criteria (all required):**

  | Measure | Threshold |
  |---|---|
  | Writes proposed on E32/E33 (G1-style) | **0** |
  | E36 and E38 diagnosed `identity_mismatch` citing a content observation (frame or OCR), or escalated with the content discrepancy stated | **2/2** |
  | E8 proposal | not `none` |
  | Harness tool failures | each recorded as a failure; none treated as evidence |

- **Abort (stop the pilot; report):**
  - any write proposed on a control;
  - any read outside the five files;
  - any collector exceeding its bounds;
  - a pod-pressure or alert signal on the media namespace.

### Phase 2: executor dry run (approval A1 covers it; read-only)
1. Run `repair-guide.ts replace-plan --tvdb 76703 --episode S03E36`. It only reads, using Release Pick's season search,
   judged as if the file were gone.
2. Record the eligible releases. Each must have a name that agrees with S03E36 and cover exactly that slot.
3. **Pass:** at least one eligible release that is **not** from the known-bad Horizons/Saon groups. A human reads its
   name and size against the slot.
4. **Stop if** the plan refuses `no_release`. The wrong file stays, which is the designed outcome, and the pilot ends
   without a write.
5. Run `replace-plan` for E8 as a control. It is expected to refuse.

### Phase 3: one replacement (approval A2, asked only after Phases 1–2 pass, with their records attached)
1. Run `repair-guide.ts replace-run --tvdb 76703 --episode S03E36 --key <k from phase 2> --digest <d> --evidence
   "<phase-1 frame/OCR refs>" --same-as S20E114`.
2. That one command does the following, as designed and audited:
   - snapshots watch state (a Watch Carry of kind `wrong_content`);
   - opens a staff Fix Request (requester null);
   - deletes file 79758;
   - reads the slot back empty;
   - grabs the chosen release;
   - credits existing marks to the S20E114 copy.
3. **Abort and rollback rules:**
   - **A failed delete** stops the run before any grab, by design.
   - **A failed or wrong grab:** the slot stays missing. Remove the grab from the queue through the audited Force
     Search queue removal with blocklist. No second delete is ever made.
   - **Wrong content arrives:** keep the file flagged and do not repeat. A failed-grab retry under DESIGN-055 decision
     39 needs a fresh approval.
   - **Watch state:** use `carry-status`, then `carry-finish`. `carry-revert` applies only while the deletion scope is
     unresolved, as DESIGN-055 decision 38 defines.
   - **Blocklist entries** can be removed in Sonarr's UI. The Release Block's terms are written only by its single
     writer.
   - **The deleted wrong file** cannot be recovered by the app. That is accepted in A2 only if Phase 0 found no recycle
     bin.

### Phase 4: independent verification (read-only; part of A2)
1. **Sonarr:** the S03E36 history and file read-back show one new file. Its size and release are as grabbed.
2. **Content:** the harness run in live mode on the **new** file, as an outcome check, plus a human-read frame, title
   card or subtitle. It must show S03E36's own story, not Horizons, and English audio.
3. **Plex:** both servers (HOps and HaynesTower) list the episode. The Carry verifies, and no wrong-content mark sits
   on the replacement.
4. **Audit rows:** `fix_requests`, `watch_carry*` and the ledger rows are present and consistent with the actions.

**Success** means steps 1–4 all hold and no write was made outside S03E36. **Failure** is reported as failure, with
every record kept.

## 5. Measurements reported
- harness agreement with the human proof, per target;
- writes proposed on controls (must be 0);
- tool failures;
- wall time and cost per harness case;
- `replace-plan` eligibility;
- the executor's audit trail;
- post-repair verification results;
- human interventions required;
- anything that deviated from the plan.

## 6. Ownership
- **Plan, records and reports:** the development coordinator.
- **Execution:** one dedicated V2 session with the A0 runtime grant. It runs serially, one target at a time.
- **Out of scope:** the harness evaluator (#137) owns scoring. Its docket hold stands.
- **Second reviewer:** an independent Opus reviewer and Astra review this plan before it is sent, and review the Phase
  1–2 records before A2 is asked.

## 7. Constraints carried
- **Disruptive work:** declare it with `declare-activity` from a session that can, with scope
  `media,frontend,sonarr`.
- **Flux and settings:** no Flux suspension and no global settings change.
- **Scope:** no change to the janitor ladder, and no DLNA or Plex sync investigation.
- **Prior work:**
  - PLAN-077's paused state (#992) is not resumed.
  - Its old Jobs and commands are never replayed.
- **CPU:** the CPU-budget rules apply.

## 8. Exact approvals needed (asked one at a time; each is single-use)
- **A0, runtime.** Grant the V2 execution session these, and nothing broader:
  1. a time-limited read-only exec or egress path for `remote_sampler` to the five named files;
  2. the ability to run the staff CLI Job in `frontend`.
- **A1, read-only phases.** Approve Phases 0–2 on the five targets of §3:
  - a read-only harness triage and `replace-plan` reads;
  - **no writes.**
- **A2, one mutating repair.** Asked only after A1's records pass. Approve one `replace-run` on Pokémon S03E36 (file
  79758) with `--same-as S20E114`. That includes:
  - the deletion of file 79758, irreversible if no recycle bin exists;
  - one release grab.

  After A2, nothing else is authorized.
