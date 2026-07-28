# PLAN-064: Front-page uptime badge — the Home page wears the real Gatus SLI

- **Status:** ✅ Completed — coordinator UX-reviewed (screenshot matrix), merged PR #502,
  released **v0.91.0**, deployed; the badge is live on Home fed by the real SLI. App-side leg of
  the **haynes-ops saga `haynesnetwork-ha`**,
  [backlog plan 04](../../../haynes-ops/.agents/sagas/haynesnetwork-ha/backlog/04-front-page-uptime-badge.md)
  (saga Decisions 3 + 4).
- **Docs:** ADR-079 (the app-rendered badge from in-cluster Gatus, the honest unmeasured
  state, the read-client home), DESIGN-004 **D-25** (Home gains the badge element),
  PRD **R-235**, glossary **T-230** (Uptime Badge).
- **Number note:** 064 is assigned by the coordinator; plan numbers are stable and never
  reused (this folder's README).
- **Depends on:** saga plan 03 (DONE — the Gatus `external_haynesnetwork` endpoint exists
  and has history). **Cross-repo touch:** none required — no CiliumNetworkPolicy or
  NetworkPolicy exists in `frontend` or `observability`, so app-pod egress to
  `gatus.observability.svc.cluster.local:80` is unrestricted today (verified read-only
  2026-07-28); the production env addition (if any) is the coordinator's follow-up.

## Goal

The Home page wears its own uptime: a small token-themed shields-style badge under the
greeting showing current status (dot) + the 30d uptime percentage from the real external
SLI (Gatus's `external_haynesnetwork` apex check), visible to every signed-in user. When
Gatus is unreachable the badge says so honestly ("unmeasured") — never fake green, never
a dashboard-breaking error.

## Approach (as built)

Server-side only, the play-scoreboard vertical repeated one-for-one:

1. **Read client** — `GatusClient` in `packages/arr/src/gatus.ts` (the MaintainerrClient
   keyless-read pattern): `getUptime(window)` parses the **plain-text float 0..1** the
   uptime endpoint returns (zod-piped, empty/NaN/out-of-range ⇒ `ArrParseError`);
   `isUp()` reads `/statuses` and uses **`results[last].success`** (the top-level `uptime`
   is null on the wire and is never parsed). Env: `GATUS_URL` (default
   `http://gatus.observability.svc.cluster.local:80`) + `GATUS_UPTIME_ENDPOINT_KEY`
   (default `external_haynesnetwork`) via `resolveGatusEnv` — zero-config in-cluster.
   Read-only; no write surface.
2. **Read model + memo** — `packages/metrics/src/uptime.ts` (the `plays.ts` idiom): a
   structural `UptimeReader` seam, `readUptimeSnapshot` (allSettled + 3s deadline race,
   never rejects; `measured` requires the status AND 30d reads; 24h/7d degrade to null
   individually) and `createUptimeSource` — a **60s single-flight TTL memo** (ADR-068
   per-replica-skew precedent; an unmeasured result is served but NOT memoized, so
   recovery is next-request). `UPTIME_BADGE_TTL_MS` is the e2e test hook (set `0` by the
   harness, the `ACTION_FOUND_NOTHING_WINDOW_MS` idiom).
3. **API** — `metrics.uptime` (`authedProcedure`, the `playScoreboard` posture: every
   signed-in user, aggregate-only payload, never throws), resolved through
   `resolveUptimeSource` in `packages/api/src/trpc.ts` (env singleton / injected fake).
4. **UI** — `UptimeBadge` in `@hnet/ui` (structure only, the PhaseChip contract): a
   two-segment shields pill (muted "Uptime" label + toned value segment with status dot,
   percent, small "30d" qualifier), tones via `uptime-badge--up|down|unmeasured` classes
   over the token palette in `apps/web/app/app.css`. ADR-015: the percent span reserves
   6ch of tabular-numeral width so 100% ⇄ 99.98% never moves the qualifier; states swap
   color/text only. Tooltip `title` carries 24h/7d/30d. Rendered on Home between the
   greeting and the play scoreboard (DESIGN-004 D-25).
5. **Stubs + e2e** — `stub-gatus.ts` wired into `harness.ts`/`env.ts` (so
   `pnpm dev:local` and Playwright both boot it); `uptime-badge.spec.ts` drives the three
   states via `POST /_stub/state` (up / down / unreachable). The Home resize matrix
   already covers the badge's fit (`resize-matrix.spec.ts` asserts `/` at all eight
   viewports).
6. **Unit tests** — client parse (plain-text float, invalid/empty/out-of-range, last-result
   status) in `packages/arr/__tests__/gatus.test.ts`; snapshot + memo semantics in
   `packages/metrics/__tests__/uptime.test.ts`; router query (injected source, authed
   gate) in `packages/api/__tests__/metrics.test.ts`; component states + percent
   formatting in `packages/ui/__tests__/UptimeBadge.test.tsx`.

## Acceptance

- Home shows the badge for all signed-in users; up = accent dot + percent, down = danger
  dot + percent, Gatus unreachable = muted "unmeasured" — never a throw, never fake
  numbers (`uptime-badge.spec.ts`, three states).
- `pnpm typecheck && pnpm lint && pnpm lint:css && pnpm test && pnpm build` green; the
  touched e2e specs pass locally.
- Badge reflects a real Gatus outage window — verified later during saga plan 07's drill
  (not this PR).
