# PLAN-057: Estate play scoreboard — the dashboard Tautulli badge row

- **Status:** Completed (v0.66.0 live + label fix in v0.68.0; live-proven vs all three Tautullis). Was: BUILT (2026-07-16 — docs + full vertical + tests on
  `feat/plan-057-play-scoreboard`, local five-green gate; PR/deploy pending)
- **Owner spec (2026-07-16 eve, verbatim-in-intent):** "let's pull from all three Tautullis
  and have a semi-live display on the front page. Really show off. Have it above the button
  for About with a slim profile like the badges people have on GitHub readmes."
- **Docs:** ADR-068 (Accepted), DESIGN-040 (D-01..D-09), PRD-001 R-221 (R-215..R-220 are
  reserved by parallel tracks — the gap is deliberate).
- **Depends on:** nothing (read-only; reuses the ADR-018 Tautulli trio env contract).

## Scope

One vertical, no persistence:

1. `@hnet/arr` — `TautulliClient.getLibrariesTable()` (read-only) + the
   `get_libraries_table` row subset schema (`section_name/section_type/plays/duration`;
   ground truth probed live 2026-07-16 against HaynesTower).
2. `@hnet/metrics` — `plays.ts`: `aggregatePlayTotals` (allSettled + 3 s per-instance
   deadline; sums plays+duration by `movie/show/artist`, photo/unknown excluded;
   `unavailable` when nothing contributed) and `createPlayScoreboard` (single-flight
   ~10-min TTL memo, injectable clock; an unavailable result is never memoized).
3. `@hnet/api` — `metrics.playScoreboard` on `authedProcedure` (every member — NOT the
   metrics-section gate) via the ctx-injection idiom (`ctx.playScoreboard` /
   `resolvePlayScoreboardSource`, clients built with `timeoutMs: 3000`).
4. `apps/web` — `lib/scoreboard.ts` (`formatPlays` compact formatter + `scoreboardBadges`
   model), `components/scoreboard.tsx` (server component, two-segment shields pills +
   play glyph, `aria-label="Estate lifetime plays"`, `null` when unavailable),
   `.scoreboard*` tokens-only CSS in `app.css`, wired into `page.tsx` between
   `<Greeting/>` and the About tile (SSR-baked, zero client fetch).
5. Tests: metrics aggregation/cache unit tests (injected clock + fake timers), arr client
   test, web formatter/model + `renderToStaticMarkup` component render test. No e2e.

## Exit criteria

- [x] ADR-068 + DESIGN-040 + PRD R-221 authored in the same change as the behavior.
- [x] Aggregation degrades per instance; all-failed / unconfigured renders NOTHING.
- [x] Local merge gate: `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build` green.
- [ ] PR → squash-merge → staging deploy → owner eyeballs the front page.

## Deploy note (haynes-ops)

The **web Deployment** must carry the Tautulli env that today only the sync CronJobs get:
`TAUTULLI_API_KEY`, `TAUTULLI_K8PLEX_API_KEY`, `TAUTULLI_HAYNESTOWER_API_KEY`,
`TAUTULLI_HAYNESTOWER_URL` (the HaynesTower box has no cluster default). `TAUTULLI_URL` and
`TAUTULLI_K8PLEX_URL` default in code to `http://tautulli.media.svc.cluster.local:8181` and
`http://tautulli-k8plex.media.svc.cluster.local:8181` — no new secret keys needed. Missing
env is safe: the row is simply absent (ADR-068 C-03/C-06).
