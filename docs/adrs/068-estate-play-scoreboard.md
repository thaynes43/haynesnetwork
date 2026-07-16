# ADR-068: Estate play scoreboard — read-only Tautulli aggregation on the dashboard

- **Status:** Accepted
- **Date:** 2026-07-16
- **Deciders:** Tom Haynes

## Context and problem statement

Owner spec (2026-07-16 eve): *"let's pull from all three Tautullis and have a semi-live
display on the front page. Really show off. Have it above the button for About with a slim
profile like the badges people have on GitHub readmes."*

The estate runs three Tautulli instances (HaynesOps/PlexOps, HaynesKube/K8Plex,
HaynesTower — the ADR-018 harvest trio, env contract already in
`@hnet/arr` `resolveTautulliInstances`). Each exposes lifetime per-library play totals via
`cmd=get_libraries_table` (verified live 2026-07-16 against HaynesTower:
`response.data.data[]` rows carry `section_name`/`section_type`/`plays`/`duration` seconds;
`section_type ∈ movie|show|artist|photo`). The dashboard needs a slim, every-member,
show-off surface for those totals without adding a store, a poller, or a slow render.

## Decision drivers

- "Semi-live", not live: the numbers move on the scale of days — freshness within minutes
  is more than enough, and the dashboard must never wait on three HTTP round trips per view.
- The dashboard renders for EVERY signed-in member on every visit — a failed or slow
  Tautulli must never block or shift it (ADR-015).
- Hard rule 4 posture: external systems are the source of truth; this app displays, never
  stores, watch statistics it doesn't own.
- Privacy: household members see each other's dashboards — aggregate totals only.

## Considered options

1. **Read-through with an in-process TTL cache** (the ThumbLruCache/ADR-059 short-cache
   spirit): SSR reads a module-level memo; a stale memo triggers one guarded re-read of all
   three instances with a short deadline.
2. Persist totals via a sync job (new table + CronJob) and read the DB.
3. Client-side fetch/poll after load.

## Decision outcome

Chosen option: **read-through + in-process TTL cache** — because a snapshot table for four
numbers is ceremony without benefit (option 2), and a post-load client fetch shifts the page
and violates the SSR-baked-numbers discipline (option 3, ADR-015).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: **read-only, no persistence.** The scoreboard reads `get_libraries_table` on all three Tautullis via the existing `@hnet/arr` `TautulliClient` (a new read method) and `resolveTautulliInstances` env contract. No migration, no table, no CronJob, no write surface. |
| C-02 | Good: **the "semi-live" contract is an in-process TTL memo (~10 min).** One aggregation per server process per TTL window (single-flight — concurrent renders share one in-flight read); numbers are baked at SSR. An all-instances-failed result is NOT memoized, so recovery is next-request, not next-window. |
| C-03 | Good: **per-instance graceful degradation.** `Promise.allSettled` + a short per-instance deadline (~3 s): a failed/slow instance contributes nothing and never blocks the render; partial totals render honestly. When ALL instances fail (or none is configured — local dev), the dashboard renders NOTHING in the slot: no empty chrome, no error. |
| C-04 | Good: **privacy by shape.** The aggregate carries per-kind play counts and an hours-watched total only — no user, no title, no per-instance breakdown in the UI. Visible to every signed-in member (the About-tile posture: auth-only, no section gating). |
| C-05 | Bad: per-pod memo — each web replica warms its own cache and totals may differ across pods within a TTL window. Accepted: the numbers are lifetime counts in the tens of thousands; a sub-window skew is invisible. |
| C-06 | Bad: the web Deployment must now carry the Tautulli env (the three `*_API_KEY`s + `TAUTULLI_HAYNESTOWER_URL`) that previously only the sync CronJobs needed. Missing env degrades to C-03's render-nothing, never an error. |

## More information

PRD-001 R-221. DESIGN-040 (aggregate shape, cache, badge anatomy). Kin: ADR-018 /
DESIGN-008 (the Tautulli trio + per-source degradation), ADR-059 Q-01 (live poll-through +
short in-process cache), ADR-041 C-04 (in-process cache, not a store), ADR-015 (no
re-orientation), ADR-063 (the About tile's every-member dashboard posture).
