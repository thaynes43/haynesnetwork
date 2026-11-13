# Story 834 — Capacity Forecast evidence

Recorded 2026-11-13 on `agent/haynesnetwork-1113-163908` (PR 1063). Two workers wrote to this
branch: the first delivered the function, the read and a first method; the second (the correction
ordered in story 834 comment 8018) replaced the method. This note is the evidence for the method
now in the code. Normative text: DESIGN-013 D-08. Glossary: T-332.

## Sources

1. **The recorded series.** Measured by the coordinator, 2026-11-13T16:36Z. Prometheus, 90 days,
   3-day step, GB = 1e9 bytes:
   `max by (__name__, path) ({__name__=~"(radarr|sonarr|lidarr)_rootfolder_freespace_bytes"})`.
   HaynesTower is `/data/haynestower/Media/Movies`; the music array is `/data/media/music`.
2. **The 12-hour series.** Measured by the correction worker, 2026-11-13, through the Grafana MCP
   server (`query_prometheus`, datasource `prometheus`, range 2026-08-05T00:00Z to
   2026-11-13T12:00Z, step 43200 s), one request per array:
   `round(max by (path) (radarr_rootfolder_freespace_bytes) / 1e9, 0.1)` and
   `round(max by (path) (lidarr_rootfolder_freespace_bytes) / 1e9, 0.1)`.
   A first request, the recorded query limited to Radarr and Lidarr and divided by 1e9, at the
   3-day step from 2025-11-11, returned nothing before 2026-08-08. The oldest 12-hour sample is
   2026-08-07T12:00Z: Prometheus holds about 98 days. No other Prometheus request was made. No
   `/diskspace` read was made.
3. **The comparison.** `2026-11-13-834-forecast-candidates.mjs` in this folder holds both series
   and every candidate. `node .agents/context/2026-11-13-834-forecast-candidates.mjs` prints the
   tables D-08 quotes. It has no dependency, makes no request, and seeds its random draws, so the
   output does not change between runs. Its resampling tables are estimates; the rest is
   arithmetic on the two measured series.

## The defect, reproduced

Commit `13d67e14` adds one test and nothing else: the recorded HaynesTower series continued from
its 2026-11-12 level at its own pre-jump rate (−172283/812 = −212.171 GB/day), read 90 days back
at each of the 61 samples from day 0 to day 180, with the rate required to stay within 38.2 GB/day
of the true rate. Against the first method it fails at the 26 samples from day 9 to day 84:
`pnpm exec vitest run __tests__/storage-forecast.test.ts --maxWorkers=2` in `packages/domain`,
2026-11-13, 1 failed and 11 passed. The reported rates run from −127.2 GB/day at day 9 down to
−42.0 and back to −173.5 at day 84. They match the coordinator's table at every row it lists.

## What the 12-hour series shows

- HaynesTower free space rises by more than 400 GB between two 12-hour samples 13 times. Eleven
  are 428.3 to 1208.7 GB; nine of those are about a week apart, 2026-08-16 to 2026-10-12. The
  other two are **+3105.0 GB** at the 2026-11-07T00:00Z sample and **+8724.5 GB** at the
  2026-11-12T00:00Z sample. So the "rise of about 10 TB in six days" in the 3-day series is two
  instants, each inside one 12-hour interval, with the usual fall between them. What removed that
  space is not established here; the intake inventory on main (its Q-04) has the same question
  open, and these two instants narrow where to look.
- The music array fell from 119434.7 GB (2026-10-25T00:00Z) to 106193.8 GB (2026-11-13T12:00Z):
  13240.9 GB in 19.5 days, −679.0 GB/day, against −27.5 GB/day over the 72 days before. It is not
  one drop: 2026-10-25 to 2026-11-06, a pause to 2026-11-10, then falling again, with one rise of
  8044.1 GB at the 2026-11-11T00:00Z sample. One sample, 2026-10-28T00:00Z, sits 2179.7 GB above
  its neighbours; it is on the 3-day grid, so it is in the recorded series.
- Between 2026-11-12T00:00Z (the last 3-day sample) and 2026-11-13T12:00Z, HaynesTower fell
  537.5 GB and the music array 4185.0 GB. That is how far behind a level taken from the aligned
  grid was on the day of this work.
- HaynesTower's 28 three-day steps before the rise have a lag-1 autocorrelation of −0.45: a
  heavy step is usually followed by a light one. The weekly rises are the visible cause.

## Choice

The rate is the interquartile mean of the 3-day steps: sort the steps, set aside 7 of 30 at each
end, average the middle 16. The level is the live free space, else the last sample. Fewer than 13
samples or under 36 days is too short. A rate within 2 standard errors of zero is flat. The
comparison of ten candidates, the reasons, the trade and the limits are in D-08 and are not
repeated here.

Recorded series, as of 2026-11-12:

| Array | Rate (GB/day) | Standard error | Rate / se | 100% |
| ----- | ------------: | -------------: | --------: | ---- |
| HaynesTower | −212.24375 | 38.18 | 5.56 | 2028-01-01T06:44:40Z |
| Music | −39.3 | 11.25 | 3.49 | 2034-07-21T14:54:03Z |

The music rate as its fall unfolded (all recorded samples up to each date): −36.5 (2026-10-25),
−34.6, −37.8, −41.0, −43.2, −41.2, −39.3 (2026-11-12). Least squares over the same samples went
from −17.8 to −97.0.

## Hand arithmetic

HaynesTower: the middle 16 steps sum to −10187.7 GB per 3 days. −10187.7 / 16 / 3 = −212.24375
GB/day. 88140.8 / 212.24375 = 415.281015342 days after 2026-11-12T00:00:00Z → unix 1830321880,
2028-01-01T06:44:40Z. A 50000 GB floor: 38140.8 / 212.24375 = 179.702818104 days → unix
1809967923, 2027-05-10T16:52:03Z.

Music: the middle 16 sum to −1886.4. −1886.4 / 16 / 3 = −39.3 GB/day. 110378.8 / 39.3 =
2808.62086514 days → unix 2037106443, 2034-07-21T14:54:03Z.

The sorted steps and which are set aside are listed in D-08. The unit tests assert these instants.

## Checks on the tables

Each count was checked against the rule written for it.

- 30 steps from 31 samples; `floor(30 × 0.25) = 7` set aside at each end; `30 − 14 = 16` kept.
- Steps more than 3 scaled median deviations from the median step: HaynesTower 0 low and 2 high,
  music 3 low and 3 high. Eight in all, the smallest at 4.42; the largest ordinary step is 1.96.
- The continuation has 61 samples (day 0 to day 180 in 3-day steps). The first method fails 26
  of them (day 9 to day 84 inclusive: (84 − 9) / 3 + 1 = 26).
- The too-short floor: `floor(12 × 0.25) = 3`; `floor(11 × 0.25) = 2`. 12 steps are 13 samples
  and 36 days at the 3-day step.
- One count does not follow from a rule: "eleven weekly-sized rises" uses a 400 GB cut chosen by
  eye to separate them from the 12-hour noise. The next largest 12-hour rise is 377.2 GB, so the
  count would be twelve at a 350 GB cut.

## Open questions

Recorded in DESIGN-013: Q-03 (is the music fall a new rate), Q-05 (deletion in batches moves the
level and not the rate, for stories 819 and 820), Q-06 (the level and the history are assumed to
be one filesystem; not compared). Q-04 (the sample step) is answered there.

## Out of scope, left undone

No chart, no change to targets, the space policy, alerts, or `storage.trend`. The result does not
carry the standard error; a consumer that wants a band can ask for it.
