# ADR-120: Dynamic Pace sizes each Trash batch from the gap and the intake

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** the owner, for the direction of 2026-11-13: size each Trash batch from the capacity
  target, and ship that sizing switched off (story 820). The under-target pace, the dropping of the
  per-kind caps, and the ceiling and the horizon are open questions in
  [DESIGN-014](../designs/014-rules-tuning-space-policy.md) (Q-12, Q-13, Q-14, Q-15). This record
  states the behavior the code has, so a later ruling can change it before the switch is turned on.
- **Amends:** [ADR-073](073-autonomous-trash-cycle.md) C-04, only while Dynamic Pace is switched on and
  the series can be sized. [ADR-031](031-space-driven-batch-policy.md) C-01 stands: the policy still
  never deletes. Accepted ADRs are not edited; this record is the amendment.
- **Relates:** [DESIGN-014](../designs/014-rules-tuning-space-policy.md) D-16,
  [DESIGN-013](../designs/013-disk-and-reclaim-metrics.md) D-08 (`forecastFreeSpace`).

This file is ADR-120. An earlier draft of this change was numbered ADR-117. That number is reserved
by another open change. Main does not have ADR-117.

## Context and problem statement

The live space policy proposes a movie batch of at most 50 titles every save window (7 days), largest
first, and a TV batch of at most 5, and only while HaynesTower is over its 75% target. That ask does
not change when the array is falling further behind, and it does not change when the array is under
the target. The owner asked for the batch to grow when use is gaining on the target and to hold a
steady pace when the array is already under it. The owner asked for a pace that can be back at the
target in a month or two, rather than in a single week.

The decision is deletion-sensitive: it chooses how many bytes each batch proposes. Which titles may
be chosen does not change.

The adversarial review of this change (2026-11-13, recorded on PR 1071) measured what the shipped
defaults do. At the default ceiling, with an unlimited pool, the gap at day 60 is 39.4 TB and the
target is reached after about a year. With no ceiling, the rolling 60-day horizon still leaves
19.8 TB at day 60, because the horizon is a time constant and not a deadline. Those figures are the
review's simulation (intake 329.8 GB/day, yield 0.8805). This correction did not re-run it.

## Decision drivers

- The switch ships off. Turning it on is a later story. A row written before this change must behave
  exactly as it does today.
- Intake has to be separable from Trash. The chart's rate is free space after sweeps have already
  put bytes back.
- A level jump is not a new intake. DESIGN-013 D-08 already sets one step aside; the pace uses that
  function and does not invent a second method.
- Where the evidence is thin, the smaller batch is the one that ships, and the shortfall is reported.
- No new deletion path, no new protection, no new layout on the settings card.
- A window longer than the horizon must not multiply one window's requirement by more than one.

## Considered options

1. **Keep the static caps and only document a formula.** The live 50-title cap would still decide
   the batch. The story's acceptance is a size the policy actually computes.
2. **Replace the caps with a byte ask from the gap and the intake, behind an audited switch that
   ships off.** Today's behavior remains while the switch is off. While it is on, the ask replaces
   `maxItems` and `targetBytes`. The existing selector still chooses the titles.
3. **Always apply the formula, with no switch.** A bad series or a bad bound would change production
   batches on deploy. Rejected.

## Decision outcome

Chosen option: **2**. `space_policy.dynamicPace` is `{ enabled, horizonDays, floorBytes, ceilingBytes }`.
`enabled` defaults to false. Horizon defaults to 60 days. The floor is 130,604,353,957 bytes and the
ceiling is 3,591,025,375,575 bytes, the smallest and largest proposed-byte totals of a completed
HaynesTower batch in the window the review checked (the same 13 batches; D-16). The save rate is
measured at run time, not stored.

Intake is `forecastFreeSpace` on the chart's series after recorded sweep deletions are subtracted
from later samples. The live free-space reading is the level for the gap and does not enter the
rate. A too-short series, a missing series, a ceiling below the floor, or a failed preload keeps
today's caps. A flat rate omits intake and still closes a measured gap.

Over target, one window's required deletion is
`max(0, gap − rate × horizon) × min(1, window / horizon)`. If that trend already reaches the floor
inside the horizon, no batch is posted. The `min(1, …)` clamp is the review's correction M4: a
90-day window on a 60-day horizon must not ask for one and a half times the horizon's requirement.
Saving the space policy refuses a horizon shorter than `trash_default_window_days`.

Under target, and only while the pace applies, the code's requirement is the intake over one window,
the same amount at any level under the target and at a target of 100 percent, and the surplus is not
spent. That rule is Q-12. It is the code that shipped behind the switch. It is an open question for
the owner.

The ask is that requirement divided by `(1 − saveRate)` when the rate is in `[0, 1)`, then clamped
to the floor and the ceiling and to the eligible pool. A zero requirement is not lifted to the
floor. The ceiling is one number for the array. Movie and TV share it in proportion to their
eligible bytes. While the pace applies, the code does not also apply the per-kind `maxItems` and
`targetBytes` caps, and nothing bounds the title count. That drop is Q-14 and Q-15.

`storage.policy.status` returns the reasoning. The settings card does not gain a layout; showing
the figures there is a follow-up for a Fable worker.

### What this record does not decide

The owner has not ruled the following. They stay open in DESIGN-014, with the review's
recommendations:

- **Q-12.** The pace under target. As built, the ask is the same at any level under the target, and
  at a target of 100 percent.
- **Q-13.** The horizon. The shipped 60 days is a time constant. The review's simulation is the one
  in the context section above.
- **Q-14.** The largest batch in one window, in bytes and in titles. The ceiling above is the
  measured largest batch, kept as the code's default until that question is ruled.
- **Q-15.** Whether TV keeps its 5-title cap while the pace is on.

The review's findings 5 to 10 are work required before the switch may be turned on. They are listed
in D-16. This change does not build them. The switch stays off.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: while the switch is off, the proposal path does not read Prometheus and a test shows the batch is the one today's caps would build. |
| C-02 | Good: the rate the pace uses is intake. Frequent small sweeps stay in the rate until they are added back; one level jump stays set aside. |
| C-03 | Good: the one-window shortfall is a returned field when the pool or the ceiling cannot meet that window's requirement. The 60-day projection is recorded on the story, not stored as a forecast. The status read's pool and its horizon shortfall are finding 5, still open. |
| C-04 | Open (Q-12): while the pace applies, the code asks for one window of intake at any level under the target, including a target of 100 percent. While the switch is off, ADR-073 C-04 still skips a new batch under target. Over target, the code posts nothing when the drain reaches the floor inside the horizon. Self-heal of a stuck batch is unchanged and does not depend on this gate. |
| C-05 | The selector still takes the one title that crosses the ask, so a batch can land a little over the ask. That rule already applied to `targetBytes`. |
| C-06 | The status pool is the candidate snapshot and can lag the live set the proposal reads. The read says so. The snapshot never feeds a delete. |
| C-07 | Open (Q-14, Q-15): while the pace applies, the per-kind `maxItems` and `targetBytes` caps are not also applied, and nothing bounds the title count. |
| C-08 | Open (Q-13, Q-14): the default horizon is 60 days and the default ceiling is the largest observed batch. The review measured that those defaults, with an unlimited pool, leave a 39.4 TB gap at day 60 and reach the target after about a year. With no ceiling the rolling horizon still leaves 19.8 TB at day 60. |
| C-09 | The over-target multiplier is `min(1, window / horizon)`. `storage.policy.set` refuses a horizon shorter than the save window. |

## More information

DESIGN-014 D-16 has the formula, the measurements, the corrected projection, and questions Q-07 to
Q-15. Q-01 to Q-06 belong to earlier decisions, including the TV rule (D-15). Story 823 is the
switch. This ADR does not turn it on. Findings 5 to 10 of the 2026-11-13 adversarial review are work
required before that switch.
