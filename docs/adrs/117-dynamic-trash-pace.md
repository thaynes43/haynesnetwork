# ADR-117: Dynamic Pace sizes each Trash batch from the gap and the intake

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** the owner (direction of 2026-11-13: size Trash from the capacity target, back to target
  in a month or two rather than in one week; story 820)
- **Amends:** [ADR-073](073-autonomous-trash-cycle.md) C-04, only while Dynamic Pace is switched on and
  the series can be sized. [ADR-031](031-space-driven-batch-policy.md) C-01 stands: the policy still
  never deletes. Accepted ADRs are not edited; this record is the amendment.
- **Relates:** [DESIGN-014](../designs/014-rules-tuning-space-policy.md) D-15,
  [DESIGN-013](../designs/013-disk-and-reclaim-metrics.md) D-08 (`forecastFreeSpace`).

## Context and problem statement

The live space policy proposes a movie batch of at most 50 titles every save window (7 days), largest
first, and a TV batch of at most 5, and only while HaynesTower is over its 75% target. That ask does
not change when the array is falling further behind, and it does not change when the array is under
the target. The owner asked for the batch to grow when use is gaining on the target and to hold a
steady pace when the array is already under it, able to return to the target in a month or two
rather than in a single week.

The decision is deletion-sensitive: it chooses how many bytes each batch proposes. Which titles may
be chosen does not change.

## Decision drivers

- The switch ships off. Turning it on is a later story. A row written before this change must behave
  exactly as it does today.
- Intake has to be separable from Trash. The chart's rate is free space after sweeps have already
  put bytes back.
- A level jump is not a new intake. DESIGN-013 D-08 already sets one step aside; the pace uses that
  function and does not invent a second method.
- Where the evidence is thin, the smaller batch is the one that ships, and the shortfall is reported.
- No new deletion path, no new protection, no new layout on the settings card.

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
`enabled` defaults to false. Horizon defaults to 60 days (the owner's bound, not a disk statistic).
The floor is 130,604,353,957 bytes and the ceiling is 3,591,025,375,575 bytes, the smallest and
largest proposed-byte totals of a completed HaynesTower batch in the 90 days ending 2026-11-13
(D-15). The save rate is measured at run time, not stored.

Intake is `forecastFreeSpace` on the chart's series after recorded sweep deletions are subtracted
from later samples. The live free-space reading is the level for the gap and does not enter the
rate. A too-short series, a missing series, a ceiling below the floor, or a failed preload keeps
today's caps. A flat rate omits intake and still closes a measured gap.

Over target, one window's required deletion is `max(0, gap − rate × horizon) × (window / horizon)`.
If that trend already reaches the floor inside the horizon, no batch is posted. Under target, and
only while the pace applies, the requirement is the intake over one window and the surplus is not
spent. The ask is that requirement divided by `(1 − saveRate)` when the rate is in `[0, 1)`, then
clamped to the floor and the ceiling and to the eligible pool. A zero requirement is not lifted to
the floor. The ceiling is one number for the array. Movie and TV share it in proportion to their
eligible bytes.

`storage.policy.status` returns the reasoning. The settings card does not gain a layout; showing
the figures there is a follow-up for a Fable worker.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: while the switch is off, the proposal path does not read Prometheus and a test shows the batch is the one today's caps would build. |
| C-02 | Good: the rate the pace uses is intake. Frequent small sweeps stay in the rate until they are added back; one level jump stays set aside. |
| C-03 | Good: the shortfall is a returned field when the pool or the ceiling cannot meet the requirement. The 60-day projection is recorded on the story, not stored as a forecast. |
| C-04 | Bad, accepted: while the pace applies, ADR-073 C-04 no longer decides a new batch. Under target can still propose (the steady pace). Over target can propose nothing when the drain reaches the floor inside the horizon. Self-heal of a stuck batch is unchanged and does not depend on this gate. |
| C-05 | Bad, accepted: the selector still takes the one title that crosses the ask, so a batch can land a little over the ask. That rule already applied to `targetBytes`. The ask itself is what the ceiling caps. |
| C-06 | Bad, accepted: the status pool is the candidate snapshot and can lag the live set the proposal reads. The read says so. The snapshot never feeds a delete. |

## More information

DESIGN-014 D-15 has the formula, the measurements, the open questions Q-04..Q-08, and the projection.
Story 823 is the switch. This ADR does not turn it on.
