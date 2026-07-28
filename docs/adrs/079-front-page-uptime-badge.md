# ADR-079: Front-page uptime badge — app-rendered from the in-cluster Gatus SLI

- **Status:** Accepted (haynes-ops saga `haynesnetwork-ha` Decisions 3 + 4, owner 2026-07-28;
  executed by an autonomous run)
- **Date:** 2026-07-28
- **Deciders:** Tom Haynes (owner, via the saga decision log) · executed by an autonomous run

## Context and problem statement

Uptime is the owner's headline metric for this app, and the haynes-ops saga `haynesnetwork-ha`
made it measurable: Gatus (ns `observability`, single replica, LAN-only ingress) now runs the
**external apex check** `external_haynesnetwork` — the through-the-Internet SLI of
`haynesnetwork.com`, with history, uptime math, and its own Pushover alerting (saga plan 03,
DONE; saga Decision 3 runs a blackbox-exporter probe in parallel as the second alarm path —
that half never touches this app). Saga plan 04 asks the front page to **wear** that number: a
small badge on the Home screen showing current status + uptime percentage, for every signed-in
user.

How should the app obtain and render a number that lives in a LAN-only observability service,
without exposing that service publicly, without faking health when the measurement plane is
down, and without letting a monitoring outage break the dashboard?

Live-verified wire contract (2026-07-28, in-cluster):

- `GET /api/v1/endpoints/external_haynesnetwork/uptimes/{1h|24h|7d|30d}` → a **plain-text
  float 0..1** (e.g. `0.999783`, `Content-Type: text/plain`).
- `GET /api/v1/endpoints/external_haynesnetwork/statuses` → JSON whose per-check
  `results[last].success` is the current status; the JSON's **top-level `uptime` is `null`**
  and must never be parsed for uptime.

## Decision drivers

- **No public exposure of the status plane** (saga Decision 4): gatus/kromgo/grafana stay
  LAN-only; nothing new becomes Internet-reachable for a homepage ornament.
- **Honesty over green** (saga plan 04 acceptance): when Gatus is unreachable the badge must
  say "unmeasured" — never a cached-forever number presented as live, never a default-up.
- **The badge must never break the dashboard**: Home renders for every signed-in user; a
  monitoring outage or slow Gatus cannot become a Home error or a slow SSR.
- The measurement plane is **not HA** (Gatus is one replica, accepted in the saga README) —
  measurement gaps ≠ serving gaps, and the badge design must tolerate them as routine.
- Repo doctrine: token-only color (hard rule 2), no reorientation on state change (ADR-015 /
  hard rule 9), owner copy rules (no em-dashes, no time-grounding, friendly + concise).
- The app already has an exact precedent for "semi-live upstream aggregate on Home": the
  estate play scoreboard (ADR-068) — read client in `@hnet/arr`, structural read model +
  in-process TTL memo in `@hnet/metrics`, `authedProcedure` on the metrics router, SSR-baked
  server component. Per-replica memo skew is accepted at household scale (ADR-068 C-05).

## Considered options

1. **App-rendered badge from the in-cluster Gatus API** — server-side read client →
   tRPC (short in-process cache) → token-themed `@hnet/ui` component, SSR-baked on Home.
2. Embed a Gatus/kromgo badge image or iframe — requires exposing a status service publicly
   (violates Decision 4) and its look can't ride the app's tokens/themes.
3. Compute uptime app-side from Prometheus (`probe_success` via the existing blackbox probe) —
   duplicates uptime math Gatus already owns, couples the badge to the second alarm path, and
   contradicts Decision 3's division (Gatus is the uptime **source of record**).
4. No badge / link to the LAN status page — fails the saga goal outright (members can't reach
   LAN-only ingresses).

## Decision outcome

Chosen option: **1 — app-rendered from the in-cluster Gatus API**, the play-scoreboard
vertical repeated (this is saga Decision 4 made concrete in this repo):

- **Read client home:** `GatusClient` lives in `packages/arr/src/gatus.ts`, beside the other
  keyless upstream read clients (the MaintainerrClient pattern): zod-validated reads, no write
  surface, env-configured via `resolveGatusEnv` — `GATUS_URL` defaulting to
  `http://gatus.observability.svc.cluster.local:80` (the cluster-URL-defaults idiom, so the
  deployed app is zero-config) and `GATUS_UPTIME_ENDPOINT_KEY` defaulting to
  `external_haynesnetwork`. The uptime read parses the plain-text float through a zod pipe
  (empty/NaN/out-of-range ⇒ `ArrParseError`); the status read uses `results[last].success`
  and never touches the top-level `uptime`.
- **Read model + cache:** `packages/metrics/src/uptime.ts` (the `plays.ts` seam): a
  structural `UptimeReader`, a never-rejecting `readUptimeSnapshot` (allSettled + a 3s
  deadline race), and `createUptimeSource` — a ~60s single-flight in-process TTL memo. An
  unmeasured result is served but **not memoized**, so recovery is next-request. The memo is
  per-replica (ADR-068 C-05 precedent — accepted skew).
- **API:** `metrics.uptime`, an `authedProcedure` (the `playScoreboard` posture — every
  signed-in user; public pride, not admin telemetry) returning
  `{ measured, up, uptime24h, uptime7d, uptime30d }`. It resolves through
  `resolveUptimeSource` (env singleton in production, injected fake in tests) and never
  throws for upstream weather.
- **UI:** `UptimeBadge` in `@hnet/ui` (structure only, the PhaseChip contract — tones map to
  app classes over the token palette). Rendered on Home under the greeting (DESIGN-004 D-25).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the status plane stays LAN-only — the only new network edge is app-pod → `gatus.observability.svc.cluster.local:80`, in-cluster (verified: no netpol in `frontend`/`observability` restricts it today). |
| C-02 | Good: the **unmeasured state is a first-class UI state** (muted tone, "unmeasured" copy) — a Gatus outage degrades the badge honestly instead of faking green or erroring Home; `measured` requires BOTH the current-status read and the 30d ratio (the two things the badge headline renders); 24h/7d degrade to null individually (tooltip-only loss). |
| C-03 | Good: the read is bounded — a 3s deadline race + the 60s memo caps SSR cost at one bounded probe per replica per minute; concurrent SSRs coalesce (single-flight). |
| C-04 | Accepted: **when the app is down the badge is down with it** — the badge is a trophy on the page, not the outage detector (Gatus + Pushover + the blackbox probe are the detectors; saga README "Hard news"). |
| C-05 | Accepted: per-replica memo skew (up to the TTL) between pods, the ADR-068 C-05 precedent; and the badge may lag reality by up to ~60s + Gatus's own check interval. |
| C-06 | Accepted: parsing a plain-text body is a one-off in the `@hnet/arr` package (every other client is JSON) — confined to `GatusClient.getUptime`, schema-guarded, documented at the call site. |
| C-07 | Bad (bounded): a NEW badge on Home for all users adds one upstream dependency to the most-visited page; mitigated by C-02/C-03 (never throws, bounded latency, cached). |
| C-08 | The env contract grows by two non-secret vars (`GATUS_URL`, `GATUS_UPTIME_ENDPOINT_KEY`, both defaulted) + one test hook (`UPTIME_BADGE_TTL_MS`, harness-only). No secret: Gatus reads are keyless. The production helmrelease needs no change for zero-config operation (defaults hit the in-cluster Service); any explicit env pinning is the haynes-ops coordinator's follow-up. |

## More information

- PRD R-235 (the badge requirement), DESIGN-004 D-25 (Home placement + anatomy), glossary
  T-230 (Uptime Badge), PLAN-064 (execution).
- haynes-ops saga: `.agents/sagas/haynesnetwork-ha/` — README Decisions 3/4, backlog plan 04;
  the Gatus check itself is saga plan 03 (`kubernetes/shared/components/gatus/external/`).
- Precedents: ADR-068 (estate play scoreboard — the vertical this repeats), ADR-023
  (MaintainerrClient — the keyless read-client pattern), ADR-015 (no reorientation).
- The saga's plan 07 failure drill later verifies the badge reflects a real outage window.
