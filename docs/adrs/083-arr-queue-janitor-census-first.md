# ADR-083: Automated *arr queue janitor — census-first cleanup of errored grabs

- **Status:** Accepted
- **Date:** 2026-08-01
- **Deciders:** Tom Haynes

## Context and problem statement

The Sonarr/Radarr/Lidarr download queues accumulate **completed-but-unimported grabs** that sit
at 100% forever and need manual triage in three different UIs. At decision time the live estate
held 73 such items (exportarr `*_queue_total`, 2026-07-31): Sonarr **11** `importBlocked`,
Radarr **3** `importBlocked`, Lidarr **59** `importPending` — all `status: completed`,
`download_status: warning`. Nothing cleans these up today: the app's write-back surface is
deliberately confined to the user-facing failsafe restore and Fix / Force Search actions
(hard rule 4; ADR-007), the *arrs never expire a blocked import on their own, and the stuck
items hold download-client disk and indexer goodwill (re-grab loops) while the wanted media
stays missing.

The owner's requested behavior (session 2026-07-31) is a periodic janitor with this decision
tree: if the library already has the item at acceptable quality, remove the grab from the
download client and blocklist the release; if not, either resolve the import or blocklist +
re-search depending on the reason; where the reason is unclear, surface it rather than guess.
The owner also named the failure mode to design against: a "safe" observe-only mode that never
graduates — *"my only concern would be that we leave it in census mode and miss out on fine
tuning it to a point where it provides value."*

So the problem is twofold: (1) add a **new class of automated write-back** to the *arrs without
breaking the doctrine that the *arrs are the source of truth and every mutation is attributable
and audited; (2) roll it out so that early runs cannot destroy anything while the rollout
itself carries an explicit, dated path to full enforcement.

## Decision drivers

- **The *arrs are the source of truth** (hard rule 4): the janitor must only remove *failed
  transfer state*, never library content, and must leave wanted-status intact so the *arrs
  re-acquire what is genuinely missing.
- **Attribution + audit** (hard rule 6, DESIGN-005): every automated mutation must land as a
  ledger event with system attribution, in the same transaction as its bookkeeping.
- **We do not actually know the reason mix yet.** The metrics carry only coarse states; the
  per-item `statusMessages` (the classifier's real input) are unobserved at design time.
  Acting on day one would mean acting on guessed patterns.
- **Anti-stagnation is a requirement, not a nice-to-have** (owner, verbatim above): the
  observe-only phase needs explicit exit criteria, visible aging, and a standing obligation on
  future sessions to advance or record why not.
- **Owner-tunable without a release**: enforcement scope must be adjustable at runtime by the
  owner (the ADR-082 DB-backed audited-config precedent), because tuning cadence during
  stabilization will be much faster than the release train.
- Existing primitives should be reused: `@hnet/arr` already carries queue reads,
  `markHistoryFailed` (blocklist), the per-media search commands, and
  `ProcessMonitoredDownloads` (retry import) — all live-verified by earlier plans.

## Considered options

1. **Extend the haynesnetwork sync rail** with a `queue-cleanup` job: classifier + action
   classes in app code, DB-backed audited per-class enforcement config, census-first rollout,
   reporting through the existing failure-digest email.
2. **Deploy an off-the-shelf janitor** (Cleanuparr / Decluttarr) via haynes-ops GitOps.
3. **A dev-env agentic CronJob** (Shepherd-style) that reasons about the queue each run.
4. **Status quo** — manual cleanup in three UIs.

## Decision outcome

Chosen option: **1 — a `queue-cleanup` job on the existing sync rail, census-first** — because
the rail already carries the *arr credentials, the scheduling substrate, the audited
single-writer pattern, and the owner-facing digest channel; because the owner's decision tree
is app-domain logic (it consults the ledger's view of what the library already has); and
because an invisible third-party janitor (option 2) would mutate *arr state outside the
ledger/attribution model this app exists to provide — while its pattern-regex configs fit the
Lidarr `importPending` pile (the bulk of the problem) worst. Option 3 is disproportionate for
what is ~90% deterministic classification; it stays available for the unknown-reason tail that
rule D deliberately leaves standing. Option 4 is what the owner asked to end.

Shape of the decision (normative; mechanics in DESIGN-046):

- **Action classes.** Every queue item classifies into exactly one of: **A "have-better"**
  (import blocked because the library already holds equal/better quality) → remove from the
  download client + blocklist, **no** re-search; **B "retryable import"** (transient/stuck
  import) → bounded retry via `ProcessMonitoredDownloads`, escalate on repeat; **C "bad
  release"** (unparseable/failed/stalled) → blocklist + re-search via the owning *arr's search
  command; **D "unknown"** → never acted on, reported only. Classification patterns live in
  versioned, tested code; enforcement scope lives in config.
- **Census mode.** The job ships observing-only: every run classifies the full queue of all
  three *arrs and persists what it *would* do, per item with reasons, into the nightly digest.
  No mutation of any kind while a class is unenforced. Census output is the evidence that
  tunes the classifier before any action fires.
- **Promotion ladder.** Enforcement is enabled **per action class per *arr instance** through
  DB-backed, admin-editable, audited config (ADR-082 precedent) — default all-off. The ladder
  L0 (census) → L1 (A on Sonarr+Radarr) → L2 (A everywhere, B, C) → L3 (steady state) carries
  **explicit exit criteria and a staleness guard**: the digest prints the ladder state and its
  age every night, and once a level's criteria are met, the next session that reads the
  handoff must either promote or record a dated blocker. Observe-only is a phase, not a
  destination (owner requirement).
- **Safety rails** (apply at every level): per-run mutation cap; minimum item age before any
  action; class D and any item failing classification confidence never mutate; every action
  writes a system-attributed ledger event; blocklist-and-search fires only where the *arr
  still monitors the target.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the stuck-queue pile becomes self-clearing, with every removal blocklisted so the same release is never re-grabbed, and re-search only where the media is genuinely wanted. |
| C-02 | Good: the census phase converts "I'm not sure what the reasons are" into nightly evidence before anything acts; classifier tuning happens against real `statusMessages`, not guesses. |
| C-03 | Good: enforcement scope is owner-tunable at runtime (audited config + /admin surface), so stabilization tuning does not ride the release train. |
| C-04 | **Hard rule 4 is amended**: the app's write-back surface now includes the ADR-083 queue janitor (remove-from-client + blocklist, retry-import, re-search) alongside failsafe restore and Fix. CLAUDE.md is updated in the same change as this ADR. The janitor still never deletes library files. |
| C-05 | Bad: a misclassified class-A item deletes a completed download that would eventually have imported; mitigated by census-first tuning, the blocklist (the *arr can re-grab a different release), per-run caps, and per-class/per-instance rollout. |
| C-06 | Bad: new standing operational surface — the ladder obligation binds future sessions until L3; tracked in `.agents/HANDOFF.md` and PLAN-065 until stabilized. |
| C-07 | Neutral: the dev-env agentic option is not foreclosed — class D output is its natural work queue if a persistent unknown-reason class emerges. |

## More information

- PRD-001 R-40..R-47 (Fix/ledger doctrine this extends); ADR-007 (Fix primary path /
  `markHistoryFailed`); ADR-059 / DESIGN-030 (Activity / In-Flight, `ProcessMonitoredDownloads`,
  queue read model T-91); ADR-082 (DB-backed audited admin config precedent); DESIGN-046
  (mechanics of this decision); PLAN-065 (build + rollout plan, ladder bookkeeping).
- Glossary: T-237 Queue Janitor, T-238 Census Mode, T-239 Action Class, T-240 Promotion
  Ladder (`docs/domain-driven-design/001-ubiquitous-language.md`).
- Live evidence at decision time: exportarr instant query 2026-07-31 (11/3/59 split above);
  owner screenshots of all three queue UIs (session 2026-07-31).
