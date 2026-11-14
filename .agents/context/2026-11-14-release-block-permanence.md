# Story 845: Release Block permanence, read-only evidence and projection

Date: 2026-11-14. Source pinned by `git fetch origin main` and `git rev-parse origin/main`: `780fdeb178850c7b9f11941e9442ed09d1afe101`. Story: OpenProject 845, parent 814. Decision: ADR-122 / DESIGN-052 D-33. No live mutation, search, grab, configuration edit or deployment was performed. No release term, indexer identity or per-account viewing is included in this note.

**End state:** design/evidence prepared; implementation held by Q-37, because the story requires the design merged before code. Source behavior is unchanged. Tests of the proposed runtime behavior have not run, nothing is installed, and acceptance belongs to the coordinator after the required adversarial review. Migration 0115 is reserved but not created. No new glossary id.

## Measurement method and count rules

All observations below were measured on 2026-11-14. Replica SQL was executed with `kubectl exec -n database pod/postgres16-11 -c postgres -- psql -X -d haynesnetwork -P pager=off -c '<SELECT statements below>'`. The replica was selected from `kubectl get pods -n database -l cnpg.io/cluster=postgres16,cnpg.io/instanceRole=replica -o name`. PostgreSQL reported version 16.4. Queries ran between 07:40 and 07:43 UTC and are separate snapshots; matching totals were checked across them. All SQL was SELECT only.

A record is a row, a term occurrence is a non-null `term`, and a profile release-term count is the distinct set of non-null terms across the relevant records. A row stores at most one term. A title is `(arr_kind, external_id)`, using TMDB for Radarr and TVDB for Sonarr. The final replica audit at 2026-11-14T08:00:32Z re-ran the title histogram with that explicit kind-specific key, replacing the initial coalesced-key grouping: every distribution count stayed the same, and neither service had a missing title key. A live profile also has a sentinel, which is **excluded** from the app's cap. Character totals include that sentinel and exclude JSON punctuation/encoding overhead; they are not request byte sizes.

### Records and states (measured)

| Service | State                                          | Records | Non-null term occurrences | Distinct terms | Within 90 days of legacy expiry, including overdue |
| ------- | ---------------------------------------------- | ------: | ------------------------: | -------------: | -------------------------------------------------: |
| Radarr  | active                                         |    1170 |                      1170 |           1151 |                                                  0 |
| Radarr  | in_flight / abandoned / expired / pruned, each |       0 |                         0 |              0 |                                                  0 |
| Sonarr  | active                                         |     195 |                       195 |            195 |                                                  0 |
| Sonarr  | in_flight / abandoned / expired / pruned, each |       0 |                         0 |              0 |                                                  0 |

Terms-per-record distribution: Radarr has 1170 records with exactly one term and none with zero; Sonarr has 195 with exactly one and none with zero. The more useful growth distribution groups distinct terms by title:

| Distinct terms per title | Radarr titles | Sonarr titles |
| -----------------------: | ------------: | ------------: |
|                        1 |           341 |             2 |
|                        2 |           138 |             0 |
|                        3 |            76 |             1 |
|                        4 |            38 |             1 |
|                        5 |            20 |             0 |
|                        6 |             5 |             2 |
|                        7 |             2 |             0 |
|                        9 |             0 |             2 |
|                       10 |             1 |             2 |
|                       31 |             0 |             1 |
|                       39 |             0 |             1 |
|                       66 |             0 |             1 |
|             Total titles |           621 |            13 |
|      Weighted term total |          1151 |           195 |

Measured discrete median / 90th percentile / maximum are 1 / 4 / 10 for Radarr and 9 / 39 / 66 for Sonarr. There are 19 duplicate Radarr term occurrences (`1170 - 1151`, calculated), so record counts must not be used as profile term counts. The first recorded dates in UTC are 2026-09-28 for both services. Earliest legacy expiry is 2027-07-10T03:45:12.201Z for Radarr and 2027-08-05T12:45:13.801Z for Sonarr.

### Weekly additions since inception (measured)

Weeks start Monday in UTC. Records and occurrences are grouped by `recorded_at`; distinct additions are grouped by each term's **first** `recorded_at`, never summed across overlapping weeks or origins. Zero weeks are shown. A backfill's record date is its insertion date, not its original deletion date. These are additions to the table, not the number of deletions in that week.

| UTC week            | Radarr records = term occurrences | Radarr first distinct terms | Sonarr records = term occurrences | Sonarr first distinct terms |
| ------------------- | --------------------------------: | --------------------------: | --------------------------------: | --------------------------: |
| 2026-09-28          |                               455 |                         436 |                                63 |                          63 |
| 2026-10-05          |                                42 |                          42 |                                 0 |                           0 |
| 2026-10-12          |                                48 |                          48 |                                 0 |                           0 |
| 2026-10-19          |                                16 |                          16 |                                 0 |                           0 |
| 2026-10-26          |                                 0 |                           0 |                                 0 |                           0 |
| 2026-11-02          |                                45 |                          45 |                                 0 |                           0 |
| 2026-11-09, partial |                               564 |                         564 |                               132 |                         132 |
| Total               |                              1170 |                        1151 |                               195 |                         195 |

Origin breakdown (measured): Radarr backfill 406 in the first week and 532 in the last; remediation 5 in the first week; sweeps 44, 42, 48, 16, 0, 45 and 32 respectively. Sonarr's records are backfill only, 63 then 132. There are no Expedite records. The ordinary sweep/Expedite subset is Radarr 227 records, distinct terms and titles; first 2026-09-28T02:45:14.802Z, last 2026-11-13T16:45:15.798Z. Last 28 days at the measurement cutoff: Radarr 93 sweep/Expedite records, distinct terms and titles; Sonarr zero. Do not treat the large last-week backfill as a recurring Trash pace.

### Live profile read-back (measured)

One profile GET per service ran inside its own pod, using its existing in-pod API-key variable as the `X-Api-Key` header. Output was reduced by `jq` inside the pod to counts and lengths before returning. No term was emitted. Pod selectors: `app.kubernetes.io/name=radarr`, `sonarr`, `lidarr` in namespace `media`. Calls were sequential and used `curl --fail --max-time 30`; `page=1&pageSize=100` was supplied. Source inspection confirms these particular endpoints return the complete list, not a paged resource; the parameters therefore do not limit that list. No per-title history crawl was run.

| Profile                      | Matching managed profiles | ignored entries, including sentinel | Release terms, sentinel excluded | Sum of entry characters |
| ---------------------------- | ------------------------: | ----------------------------------: | -------------------------------: | ----------------------: |
| Radarr Release Block         |                         1 |                                1152 |                             1151 |                  164738 |
| Sonarr Release Block         |                         1 |                                 196 |                              195 |                   39757 |
| Lidarr Janitor Release Block |                         1 |                                 204 |                              203 |                   34392 |
| Sonarr Mislabel Block        |                         1 |                                  36 |                               35 |                    5844 |

Release-term counts are the raw `ignored` length minus the canonical sentinel and agree with distinct database terms. An initial reducer helper field used an incorrect sentinel spelling; that helper field was discarded. The raw entry and character totals above were unaffected. The canonical sentinel definitions were checked in `release-terms.ts`, `janitor-release-block.ts` and `mislabel-block.ts`; no second live GET was made.

The command shape was:

```sh
kubectl exec -n media <pod> -c app -- sh -c '
  test -n "$RADARR__AUTH__APIKEY" || exit 3
  curl --silent --show-error --fail --max-time 30     -H "X-Api-Key: $RADARR__AUTH__APIKEY"     "http://localhost:7878/api/v3/releaseprofile?page=1&pageSize=100" |
    jq --arg name "haynesnetwork: deleted releases (managed, do not edit)"       "[.[] | select(.name == \$name) | {entries:(.ignored|length), characters:([.ignored[]|length]|add)}]"
'
```

Sonarr used its own variable and port 8989 at the same API version, reducing both owned profiles from the same response. Lidarr used its own variable, port 8686 and `/api/v1/releaseprofile`; its owned profile is identified by the janitor sentinel. The actual calls performed only GETs. Images measured by targeted pod image jsonpaths: Radarr `6.4.4.10685`, Sonarr `4.0.20.3012`.

### Other blocks, question only (measured)

Replica aggregation agrees with the profiles: Lidarr has 203 rows and distinct unexpired janitor terms, first expiry 2027-09-29T15:25:02.924Z. Sonarr has 35 active Mislabel rows and distinct terms, first expiry 2027-10-13T02:38:16.282Z. Q-36 asks about permanence with the different implications of whole-release and series/group/name restrictions. Neither is changed.

## Projection, not a capacity measurement

**Estimated demand**, in distinct release terms excluding the sentinel, assuming the observed last-28-day **term addition** pace stays constant: Radarr `93 / 28` terms/day; Sonarr `0 / 28`. Multipliers are scenario assumptions, not changes to Trash. Future terms are assumed distinct, with no abandonment or overlap; existing terms use their measured latest expiry per distinct term. Existing cohorts and arrivals are evaluated by UTC date, so precise crossing dates are estimates with day-level resolution. Future terms live the former 365 days in the with-expiry counterfactual. No prune or cap is applied to demand: values over capacity mean titles would be kept, not that a profile would actually grow past the guard.

These are historical term arrivals, mostly under the old last-file scheme. They are **not a reliable forecast of all-name additions after ADR-117**, of a faster pace (story 852), or TV restarting. A zero Sonarr projection means the observed pool and sweep pace are zero, not that TV consumes no capacity. The raw pool snapshot was independently measured as **525 movies and 0 shows**, refreshed 2026-11-14T07:30:05.256Z. The coordinator's earlier **518 recordable movies / 994 fresh terms** was **not re-verified** in this partial design pass; it is not used as measured input. The web runtime did not contain the source reporter at `/app/packages/domain/src/release-block-pool.ts`, and no alternate credential or unsafe read/write CLI was used to recreate it. Exact current-pool term derivation remains a handoff item under Q-35.

A separate **estimated sensitivity**, using measured historical distinct terms per deleted movie (`1151 / 621`) as a proxy for future deletions, gives `50 * 1151 / 621 = 92.67` fresh terms/week for the work order's hypothetical full weekly movie batch of 50. At that rate, `(3000 - 1151) / 92.67 = 19.95` weeks, before the first legacy expiry. This is not a remeasurement of the pool's exact term fan-out and is not used for sizing a higher cap.

Each monthly row samples the same day of the month as 2026-11-14. Every forecast number in the following tables is **estimated**, rounded to the nearest whole term only for display. First-crossing dates below are calculated on unrounded daily demand, so they may precede a monthly sample.

### Radarr: estimated monthly demand

| Sample date | 1× permanent | 1× expiry | 2× permanent | 2× expiry | 4× permanent | 4× expiry |
| ----------- | -----------: | --------: | -----------: | --------: | -----------: | --------: |
| 2026-12-14  |         1251 |      1251 |         1350 |      1350 |         1550 |      1550 |
| 2027-01-14  |         1354 |      1354 |         1556 |      1556 |         1961 |      1961 |
| 2027-02-14  |         1457 |      1457 |         1762 |      1762 |         2373 |      2373 |
| 2027-03-14  |         1550 |      1550 |         1948 |      1948 |         2745 |      2745 |
| 2027-04-14  |         1653 |      1653 |         2154 |      2154 |         3157 |      3157 |
| 2027-05-14  |         1752 |      1752 |         2353 |      2353 |         3556 |      3556 |
| 2027-06-14  |         1855 |      1855 |         2559 |      2559 |         3968 |      3968 |
| 2027-07-14  |         1955 |      1935 |         2759 |      2739 |         4366 |      4346 |
| 2027-08-14  |         2058 |      1790 |         2965 |      2697 |         4778 |      4510 |
| 2027-09-14  |         2161 |      1505 |         3170 |      2514 |         5190 |      4534 |
| 2027-10-14  |         2260 |      1291 |         3370 |      2401 |         5588 |      4619 |
| 2027-11-14  |         2363 |      1212 |         3576 |      2425 |         6000 |      4849 |
| 2027-12-14  |         2463 |      1212 |         3775 |      2425 |         6399 |      4849 |
| 2028-01-14  |         2566 |      1212 |         3981 |      2425 |         6811 |      4849 |
| 2028-02-14  |         2669 |      1212 |         4187 |      2425 |         7223 |      4849 |
| 2028-03-14  |         2765 |      1212 |         4379 |      2425 |         7608 |      4849 |
| 2028-04-14  |         2868 |      1212 |         4585 |      2425 |         8020 |      4849 |
| 2028-05-14  |         2968 |      1212 |         4785 |      2425 |         8418 |      4849 |
| 2028-06-14  |         3071 |      1212 |         4991 |      2425 |         8830 |      4849 |
| 2028-07-14  |         3170 |      1212 |         5190 |      2425 |         9229 |      4849 |
| 2028-08-14  |         3273 |      1212 |         5396 |      2425 |         9641 |      4849 |
| 2028-09-14  |         3376 |      1212 |         5602 |      2425 |        10052 |      4849 |
| 2028-10-14  |         3476 |      1212 |         5801 |      2425 |        10451 |      4849 |
| 2028-11-14  |         3579 |      1212 |         6007 |      2425 |        10863 |      4849 |

### Sonarr: estimated monthly demand

| Sample date | 1× permanent | 1× expiry | 2× permanent | 2× expiry | 4× permanent | 4× expiry |
| ----------- | -----------: | --------: | -----------: | --------: | -----------: | --------: |
| 2026-12-14  |          195 |       195 |          195 |       195 |          195 |       195 |
| 2027-01-14  |          195 |       195 |          195 |       195 |          195 |       195 |
| 2027-02-14  |          195 |       195 |          195 |       195 |          195 |       195 |
| 2027-03-14  |          195 |       195 |          195 |       195 |          195 |       195 |
| 2027-04-14  |          195 |       195 |          195 |       195 |          195 |       195 |
| 2027-05-14  |          195 |       195 |          195 |       195 |          195 |       195 |
| 2027-06-14  |          195 |       195 |          195 |       195 |          195 |       195 |
| 2027-07-14  |          195 |       195 |          195 |       195 |          195 |       195 |
| 2027-08-14  |          195 |       147 |          195 |       147 |          195 |       147 |
| 2027-09-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2027-10-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2027-11-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2027-12-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-01-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-02-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-03-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-04-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-05-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-06-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-07-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-08-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-09-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-10-14  |          195 |         0 |          195 |         0 |          195 |         0 |
| 2028-11-14  |          195 |         0 |          195 |         0 |          195 |         0 |

### Estimated first month reaching the cap

| Service | Pace scenario                | Without expiry                           | With former expiry                                                           |
| ------- | ---------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| Radarr  | observed term arrivals       | May 2028 (daily model: 2028-05-24)       | Does not reach; first-horizon daily peak 1944.75, then steady demand 1212.32 |
| Radarr  | twice observed arrivals      | August 2027 (2027-08-20)                 | Does not reach; first-horizon daily peak 2762.50, then steady demand 2424.64 |
| Radarr  | four times observed arrivals | April 2027 (2027-04-03)                  | April 2027 (2027-04-03)                                                      |
| Sonarr  | observed, twice, four times  | Does not reach at observed zero arrivals | Does not reach at observed zero arrivals                                     |

The steady demands above are calculated as `365 * rate * multiplier`; existing cohorts all leave in the first year of the counterfactual. These projections demonstrate that expiry cannot solve the faster-growth case, not that expiry is acceptable in the slower case. The owner requires permanence in either case.

## Where the cap came from and what upstream does

Repository source inspection on 2026-11-14:

- ADR-093 C-09 and DESIGN-052 D-13 chose the existing cap and former lifetime as a bounded-growth policy. They originally assumed roughly one term per movie and a near-yearly steady total of 2600 at a full weekly batch. Those are historical estimates, superseded by all-name coverage.
- [PLAN-072's 2026-09-29 addendum](../plans/completed/072-watchlist-protection.md) reports an earlier measurement at 437 Radarr entries and 64 Sonarr entries, not at the cap. Radarr's measured decision-phase increase was 0.74 ms/release; the projected increase at 3000 was about 5 ms/release. DESIGN-052 Q-04 retained the cap from that extrapolation. This worker inspected the recorded evidence, not the old logs themselves. Those historical timings are not a present capacity validation.
- Current app source counts distinct release terms before adding the sentinel. Delete paths and the backfill opt out of pruning, but scheduled upkeep still uses the default prune behavior. Removing only age expiry would leave that other path able to forget a release.

Public source was read at tags corresponding to the measured installed images. Pinned revisions are Radarr `a96bf7c3ecb23cb76993770727285dc17a613fbc` and Sonarr `cab419ade8ac7fcab5bf80394ee492abd35d5f5a` (measured via GitHub tree responses on 2026-11-14). The official settings documentation was also read on that date. References below are primary sources; no live write experiment was run.

| Concern          | Radarr pinned source                                                                                                                                                                                                                                                                                                            | Sonarr pinned source                                                                                                                                                                                                                                                                                             | Finding from inspected code                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage/model    | [migration](https://github.com/Radarr/Radarr/blob/a96bf7c3ecb23cb76993770727285dc17a613fbc/src/NzbDrone.Core/Datastore/Migration/229_update_restrictions_to_release_profiles.cs), [model](https://github.com/Radarr/Radarr/blob/a96bf7c3ecb23cb76993770727285dc17a613fbc/src/NzbDrone.Core/Profiles/Releases/ReleaseProfile.cs) | [migration](https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Datastore/Migration/162_release_profile_to_array.cs), [model](https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Profiles/Releases/ReleaseProfile.cs) | Required and ignored terms are serialized as JSON arrays in profile columns and loaded as string lists.                                                                                                            |
| API validation   | [controller](https://github.com/Radarr/Radarr/blob/a96bf7c3ecb23cb76993770727285dc17a613fbc/src/Radarr.Api.V3/Profiles/Release/ReleaseProfileController.cs)                                                                                                                                                                     | [controller](https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/Sonarr.Api.V3/Profiles/Release/ReleaseProfileController.cs)                                                                                                                                                      | Validates nonempty restrictions and individual terms, and scope validity. No explicit term-count limit appears here. List GET returns all profiles.                                                                |
| Per-release work | [specification](https://github.com/Radarr/Radarr/blob/a96bf7c3ecb23cb76993770727285dc17a613fbc/src/NzbDrone.Core/DecisionEngine/Specifications/ReleaseRestrictionsSpecification.cs)                                                                                                                                             | [specification](https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/DecisionEngine/Specifications/ReleaseRestrictionsSpecification.cs)                                                                                                                              | Selects enabled profiles for the title's tags and indexer. It materializes all matching ignored terms within each profile; any match rejects. A clean release visits all ignored terms across applicable profiles. |
| Matcher/cache    | [service](https://github.com/Radarr/Radarr/blob/a96bf7c3ecb23cb76993770727285dc17a613fbc/src/NzbDrone.Core/Profiles/Releases/TermMatcherService.cs), [regex factory](https://github.com/Radarr/Radarr/blob/a96bf7c3ecb23cb76993770727285dc17a613fbc/src/NzbDrone.Core/Profiles/Releases/PerlRegexFactory.cs)                    | [service](https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Profiles/Releases/TermMatcherService.cs), [regex factory](https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Profiles/Releases/PerlRegexFactory.cs)     | Matcher cached by term for the configured 24-hour period; regex matchers use compiled .NET patterns, otherwise case-insensitive string matching. More profiles retain the same total matcher work.                 |

[Official Radarr settings](https://github.com/Servarr/Wiki/blob/master/radarr/settings.md#release-profiles) and [official Sonarr settings](https://github.com/Servarr/Wiki/blob/master/sonarr/settings.md#release-profiles) describe restriction matching and scope; neither documents a supported maximum count. **Inference:** a longer list increases work and memory; the inspected code does not prove unlimited capacity or rule out limits elsewhere in HTTP, serialization, database or hosting. A higher safe total and actual larger-profile acceptance require the isolated experiment in Q-35.

Recommendation: permanence and no pruning now, same cap/refusal; investigate additional stable owned profiles next. It preserves release identity, unlike unproved shortening. It requires ownership and partial-write/read-back tests and a measured total workload budget, so it is not a small fully proven extension to this story.

## Reproduce the aggregate SQL

The state query emits every present state; absence of other states gives their zero totals above. The grouped title distribution is complete, rather than only a mean. First-seen weekly terms avoid cross-week duplicate counting; expiry cohorts use **maximum** expiry per term so an earlier duplicate row cannot expire a still-protected term in the counterfactual.

```sql
SELECT now(), version();
SELECT arr_kind, state, count(*) AS records, count(term) AS occurrences,
       count(DISTINCT term) AS distinct_terms,
       min(recorded_at), min(expires_at),
       count(*) FILTER (WHERE expires_at <= now() + interval '90 days') AS within_90_days
FROM trash_deleted_releases GROUP BY arr_kind, state ORDER BY 1,2;
SELECT arr_kind, (term IS NOT NULL)::int AS terms_per_record, count(*)
FROM trash_deleted_releases GROUP BY 1,2 ORDER BY 1,2;
SELECT arr_kind, term_count, count(*) AS titles FROM (
  SELECT arr_kind, CASE WHEN arr_kind='radarr' THEN tmdb_id ELSE tvdb_id END AS external_id,
         count(DISTINCT term) AS term_count
  FROM trash_deleted_releases WHERE state='active' GROUP BY 1,2
) g GROUP BY 1,2 ORDER BY 1,2;
SELECT arr_kind, origin, date_trunc('week',recorded_at AT TIME ZONE 'UTC')::date AS week,
       count(*) AS records, count(term) AS occurrences, count(DISTINCT term) AS terms
FROM trash_deleted_releases GROUP BY 1,2,3 ORDER BY 1,3,2;
WITH first_seen AS (
  SELECT arr_kind,term,min(recorded_at) AS first_recorded
  FROM trash_deleted_releases WHERE term IS NOT NULL GROUP BY 1,2
) SELECT arr_kind,date_trunc('week',first_recorded AT TIME ZONE 'UTC')::date,count(*)
  FROM first_seen GROUP BY 1,2 ORDER BY 1,2;
SELECT arr_kind,count(*),count(DISTINCT term),count(DISTINCT CASE WHEN arr_kind='radarr' THEN tmdb_id ELSE tvdb_id END)
FROM trash_deleted_releases
WHERE origin IN ('sweep','expedite') AND state='active'
  AND recorded_at >= now() - interval '28 days' GROUP BY arr_kind;
WITH terms AS (
  SELECT arr_kind,term,max(expires_at) AS last_expiry
  FROM trash_deleted_releases WHERE state IN ('active','in_flight') AND term IS NOT NULL
  GROUP BY 1,2
) SELECT arr_kind,to_char(last_expiry AT TIME ZONE 'UTC','YYYY-MM-DD'),count(*)
  FROM terms GROUP BY 1,2 ORDER BY 1,2;
SELECT media_kind,refreshed_at AT TIME ZONE 'UTC',item_count
FROM trash_candidates_state ORDER BY 1;
SELECT instance,count(*),count(DISTINCT term),
       count(DISTINCT term) FILTER (WHERE expires_at > now()),
       min(expires_at) FILTER (WHERE expires_at > now())
FROM arr_queue_cleanup_block_terms GROUP BY instance;
SELECT instance,state,count(*),count(DISTINCT term),min(expires_at)
FROM mislabel_block_terms GROUP BY instance,state;
```

## Projection input and calculation

The following standard-library Python, run locally on 2026-11-14, reconstructs every monthly forecast and daily cap date from the aggregate-only measurements. No live request is made by this calculation. Counts are not truncated at capacity.

```python
from datetime import date, timedelta
start = date(2026, 11, 14)
cohorts = {
    'radarr': [('2027-07-10', 20), ('2027-07-18', 60), ('2027-07-25', 29), ('2027-08-01', 68), ('2027-08-08', 91), ('2027-08-15', 68), ('2027-08-22', 80), ('2027-08-29', 90), ('2027-09-06', 92), ('2027-09-13', 58), ('2027-09-20', 61), ('2027-09-28', 92), ('2027-10-05', 75), ('2027-10-12', 85), ('2027-10-19', 25), ('2027-11-06', 125), ('2027-11-13', 32)],
    'sonarr': [('2027-08-05', 30), ('2027-08-12', 18), ('2027-09-14', 147)],
}
for kind, rows in cohorts.items():
    rate = 93 / 28 if kind == 'radarr' else 0
    def demand(day, factor, expiry):
        retained = sum(n for d, n in rows if not expiry or date.fromisoformat(d) > day)
        elapsed = (day - start).days
        return retained + rate * factor * min(elapsed, 365 if expiry else 100000)
    for month in range(1, 25):
        day = date(2026 + (10 + month) // 12, (10 + month) % 12 + 1, 14)
        print(kind, day, [int(demand(day, f, e) + 0.5)
                         for f in (1, 2, 4) for e in (False, True)])
    for factor in (1, 2, 4):
        for expiry in (False, True):
            days = [start + timedelta(days=i) for i in range(731)]
            first = next((d for d in days if demand(d, factor, expiry) >= 3000), None)
            print(kind, factor, expiry, first, max(demand(d, factor, expiry) for d in days))
```

## Count audit and handoff

Checked on 2026-11-14 by local arithmetic against the SQL aggregates: title histograms conserve 621/13 titles and weighted totals 1151/195 terms; weekly rows conserve 1170/195 records and 1151/195 first distinct terms; origins conserve the weekly record totals; latest-expiry cohorts conserve distinct terms. Live profile totals equal distinct terms plus the sentinel for every profile. Forecast rows were regenerated from the embedded calculation. The unverified pool fan-out is explicitly excluded, rather than presented as measured.

Next safe step: coordinator resolves Q-37 and reviews/merges the design in the sequence the story requires; obtain the independent adversarial review before merge. Then implement D-33, migration and regression tests, remeasure exact pool term fan-out through an approved read-only reporter, and keep built/tested/installed/accepted evidence separate. Q-35 keeps capacity changes held; Q-36 keeps the other writers unchanged. No implementation, fixture edit or runtime test coverage is claimed by this design-only checkpoint.

## Local validation (measured 2026-11-14)

- `pnpm -r --workspace-concurrency=2 typecheck`: passed. This is the root `typecheck` script's recursive command with the work order's concurrency bound made explicit.
- `pnpm -r --workspace-concurrency=2 lint`: passed with the existing unused-import warnings in untouched `book-fix.test.ts` and `pool-refresh.test.ts`; no lint errors. This is the root `lint` script's command with the same bound.
- Standard-library count audit: passed for histogram totals, weighted terms, origin/week totals, sentinels, expiry cohorts and every monthly projection cell; embedded projection calculation was re-evaluated after formatting.
- `git diff --check`: passed. New ADR and measurement note checked with the repository's Prettier.
- No package source or test is touched, so no package test suite or PostgreSQL runtime-regression result is claimed. The required regression cases are specified in D-33 and await Q-37. Build, installation and acceptance remain pending.

Dependencies were installed with the frozen lockfile. Disk headroom was measured before installation (`df -h`, `df -i`, `du -sx /tmp`): 18 GiB available on the session volume and no temporary-directory usage; installation budget estimated at 4 GiB with an 8 GiB reserve. Unpushed source was exported before that job. No dependency manifest or lockfile was changed.
