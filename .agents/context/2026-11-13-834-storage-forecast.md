# Story 834 — Capacity Forecast evidence

Recorded 2026-11-13 by the worker on `agent/haynesnetwork-1113-163908`. Normative method: DESIGN-013
D-08. Glossary: T-332.

## Source series

Measured by the coordinator, 2026-11-13T16:36Z, Prometheus query

`max by (__name__, path) ({__name__=~"(radarr|sonarr|lidarr)_rootfolder_freespace_bytes"})`,

90 days, 3-day step, GB = 1e9 bytes. This session did not query Prometheus. The comparison below
was computed the same day with Python 3, ordinary least squares, float64, on that recorded table.

## Choice

90-day least squares. When the latest sample is more than 4 residual standard deviations off the
line fitted to samples at least 6 days earlier, that earlier line is the rate and the latest
sample is the level. Under 8 points or a span under 21 days: too short. A slope within 2 standard
errors of zero: flat.

HaynesTower through 2026-11-06: slope −212.17118226600985 GB/day, σ = 571.14 GB. The 2026-11-12
sample is +10753.8 GB, 18.83σ, so the hold applies. From 88140.8 GB that rate reaches 0 at
2028-01-01T10:09:12Z.

Music: the 2026-11-12 sample is 2.21σ from its prefix, so the full 31-point slope stands,
−96.9971370967742 GB/day, reaching 0 from 110378.8 GB at 2029-12-23T23:01:29Z.

The 30-day HaynesTower window with the last six days included is 0.63 se (the flat rule would
refuse it). Its first-to-last slope is +114.33 GB/day, which has no 100% date.

## Hand arithmetic

HaynesTower prefix, x = 0, 3, …, 84 days from 2026-08-14, n = 29. Mean x = 42. Sxx = 18270.
Sxy = −3876367.5 GB·day. Slope = −3876367.5 / 18270 = −172283/812 GB/day. Days to 0 =
88140.8 / 212.17118226600985 = 415.423051606949 → 2028-01-01T10:09:12Z.

Music, x = 0, 3, …, 90, n = 31. Mean x = 45. Sxx = 22320. Sxy = −2164976.1 GB·day. Slope =
−2164976.1 / 22320 = −2405529/24800 GB/day. Days to 0 = 110378.8 / 96.9971370967742 =
1137.95935945898 → 2029-12-23T23:01:29Z.

The unit test asserts those two instants.

## Open questions

Q-03. The music drop of 6859.5 GB on 2026-10-31 is older than six days, so it stays in the slope.
Recommendation: leave it.

Q-04. A 12-hour step was not measured. Recommendation: keep the 3-day step. Estimated effect from
residual/slope: 571.14 / 212.17 ≈ 2.7 days.

## Out of scope, left undone

No chart, no change to targets, space policy, alerts, or `storage.trend`.
