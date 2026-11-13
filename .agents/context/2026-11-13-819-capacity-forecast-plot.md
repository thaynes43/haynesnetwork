# Story 819 — the Capacity Forecast plot: evidence

Recorded 2026-11-13 on `agent/haynesnetwork-1113-191129`. Normative text: DESIGN-013 D-09.
Glossary: T-337 (Forecast Jump); T-332 (Capacity Forecast) is the read this draws. This note holds
what was measured, how each number on the page is derived, and what was left undone.

## What was built

A **Capacity forecast** card on the Storage tab (`/settings/trash?tab=storage`), above
**Free-space trend**, one panel per media array: two tiles (the space target, 100% full), one
sentence (the pace, or why there is no forecast), a plot of the history and the projection with
marks where it meets the target floor and zero, and notes that qualify it. The exact words for
every state are the table in D-09.

The read (`storage.forecast`) gained `now`, `minPoints`, `minSpanSeconds`, and per array `points`
and `jumps`. `forecastFreeSpace` and the method (D-08) were not touched.

## Sources

1. **The recorded series** (D-08; coordinator, 2026-11-13T16:36Z): 31 samples per array at a 3-day
   step, 2026-08-14 to 2026-11-12. Already in the repository as the `forecastFreeSpace` fixture.
   This session copied it into the jump-rule test and the stub Prometheus. No Prometheus request
   and no `/diskspace` read was made by this session.
2. **The local stack** (`pnpm dev:local`, embedded Postgres and stubs, 2026-11-13): every
   screenshot and every layout measurement below. Nothing here read a live service.
3. **The dataviz validator** (`validate_palette.js` from the session's dataviz skill), run
   2026-11-13 on the page's two direction tones against each theme's `--color-surface`.

## Measured

| What | Value | How |
| ---- | ----- | --- |
| Plot width at a 390px viewport | 278px | `getBoundingClientRect` of `.storage-forecast__plotarea`, local stack, Playwright |
| Plot width at 360px and 1280px | 248px, 832px | same |
| Axis label width | 4.75 to 6.49px a character (six labels on the two plots, five different texts: "Today" twice, "Jul 2027", "Apr 2028", "2030", "2035") | `getBoundingClientRect` of each label |
| Tile height | 88px, all four tiles, at 360, 390 and 1280px | same |
| Sideways scroll at 360 and 390px | none (`scrollWidth` = `innerWidth`) | `document.documentElement.scrollWidth` |
| Colour-vision separation of the two tones | ΔE 10.1 dark, 17.8 light (target 8) | validator, deuteranopia the worse case |
| Normal-vision separation | ΔE 31.3 dark, 33.9 light (floor 15) | validator |
| Accent contrast on the light surface | 2.29:1 (under 3:1) | validator |
| Accent lightness against the validator's dark band | 0.727 against 0.48 to 0.67 | validator |

The two validator shortfalls belong to `--color-accent`, the brand green the trend line already
uses. The owner asked for the page's own colours, so the token stays; the words carry every
reading (the chip's word, the tiles, the sentence, the card's key).

## Derived, and from what

- **Jump totals on the recorded series** (arithmetic on source 1; the unit test asserts them).
  HaynesTower rises: 801383 − 782770 = 18613 tenths and 881408 − 801383 = 80025 tenths of a GB,
  9863.8 GB. Music falls: 68595 + 38438 + 11834 = 118867 tenths, 11886.7 GB. Music rises:
  9583 + 12198 + 16511 = 38292 tenths, 3829.2 GB.
- **Read with care** (arithmetic). Music: |3829.2 − 11886.7| = 8057.5 GB against 39.3 × 90 =
  3537 GB of pace: flagged. HaynesTower: 9863.8 GB against 212.24375 × 90 = 19101.9 GB: not
  flagged.
- **The date-precision cuts (60 days, 2 years)** are estimates, not measurements. D-08 measured
  the rate's standard error at 18% (HaynesTower, 38.18 of 212.24 GB/day) and 29% (music, 11.25 of
  39.3). One standard error moves a date by that share of its distance: 15 days at 15 / 0.18 = 83
  days out and 15 / 0.29 = 52; 183 days at 183 / 0.18 = 1017 days out and 183 / 0.29 = 631. 60 and
  730 sit between each pair.
- **"About half of it after six weeks, all of it within three months"** restates D-08's table: a
  change of rate is 50% reported after 15 of 30 steps (45 days) and 100% by the 30th (90 days).
- **The stub's default numbers** (arithmetic on the stub's own values, used by the e2e spec).
  HaynesTower falls 120 − 112.4304 = 7.5696 TB in 90 days, 84.1 GB a day, 588.7 GB a week ("84 GB",
  "590 GB"). To the 105.992 TB floor: 6.4384 TB / 84.1 GB = 76.6 days. To zero: 112.4304 TB /
  84.1 GB = 1336.8 days, 3.66 years ("in about 3.5 years"). A 75% target is a 132.49 TB floor:
  20.06 TB over ("by 20.1 TB").

## Checks on the counts

Each count was checked against the rule written for it.

- Far steps on the recorded series: HaynesTower 0 low and 2 high, music 3 low and 3 high, the
  eight D-08 lists. All eight are named (free space moved the way of each, and each departs from
  the median step by more than a day of the rate). The test asserts counts and byte totals.
- 30 steps; `floor(30 × 0.25) = 7` set aside at each end; `partlyCounted` needs 8 or more far
  steps one way. The test builds 7 (not partly counted) and 8 (partly counted).
- The D-09 table has 13 rows: 5 with a forecast (use rising under and over target and with
  nothing left; use falling over and under target), 1 for no target, 4 for no forecast (flat, too
  few days, readings missing, no reading), 3 for the read being away (Prometheus down, failed,
  loading). The unit test file covers each.
- The card's key has 5 entries: the history, today, the two directions, the target.
- One number does not follow from a rule: the 46px axis gutter was chosen to fit the widest tick
  label drawn in the local stack ("100 TB", "150 TB") with 8px to spare. A label wider than that
  (a value over 999.9 of its unit cannot occur with `formatCapacity`) would be the case to check.

## Screenshots

In `~/.shared/op819/` (not in the repository). Listed in the story comment.

## Left undone, and why

- **No error band.** The read does not carry the rate's standard error and the function was
  outside this story (D-09 Q-08).
- **The trend chart does not refetch on a target save** (D-09 Q-09): its behaviour was outside
  this story, and its legend can rewrap when the target value changes length.
- **Nothing was checked against production.** The page was only run against the local stubs; the
  first live read is after deploy. D-08 Q-06 (the level and the history being two readings of one
  filesystem) is still open and would show on this plot as a step between the last sample and
  today's dot.
- **`installed` and `accepted` are not claimed.** This note records source and tested only.
