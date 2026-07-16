# DESIGN-040: Estate play scoreboard

- **Status:** Accepted
- **Last updated:** 2026-07-16
- **Satisfies:** PRD-001 R-221; governed by ADR-068 (read-only Tautulli aggregation,
  in-process TTL cache), ADR-015 (no re-orientation), ADR-018 (Tautulli env trio)

## Overview

A slim, GitHub-readme-badge row on the logged-in dashboard, between the greeting and the
About tile: lifetime estate play totals pulled from all three Tautulli instances
(`cmd=get_libraries_table`), summed by section type, server-rendered from a ~10-minute
in-process memo. Aggregate-only (never who watched), every-member, and absent — not empty —
when no instance answers.

## Detailed design

| ID | Decision |
|----|----------|
| D-01 | **Aggregate shape.** `EstatePlayTotals` (`@hnet/metrics` `plays.ts`): `{ moviePlays, episodePlays, trackPlays, hoursWatched, instances: [{ slug, ok }], unavailable }`. Sums `plays` and `duration` from every instance's `get_libraries_table` rows by `section_type`: `movie → moviePlays`, `show → episodePlays`, `artist → trackPlays`; `photo` and unknown types are EXCLUDED from both plays and duration. `hoursWatched = round(Σ duration / 3600)` across the three counted kinds. Numeric fields tolerate Tautulli's string-number looseness (non-finite ⇒ 0). `unavailable` is true iff no instance contributed (none configured, or every read failed). |
| D-02 | **Read path.** A structural `ScoreboardReader { slug; getLibrariesTable() }` (satisfied by `@hnet/arr` `TautulliClient`, which grows the read-only `getLibrariesTable()` — envelope-parsed subset schema `section_name/section_type/plays/duration`). `aggregatePlayTotals(readers)` runs all instances in parallel via `Promise.allSettled`, each read raced against a **3 s deadline** (`SCOREBOARD_DEADLINE_MS`) — a slow instance is marked failed and the render proceeds; the client itself is built with `timeoutMs: 3000` so the loser aborts rather than lingering through ArrHttp's GET retries. |
| D-03 | **The "semi-live" memo.** `createPlayScoreboard({ readers, ttlMs = 10 min, now = Date.now })` returns a single-flight, module-level-cached source: a fresh memo is served as-is; a stale/absent memo triggers ONE shared aggregation. An `unavailable` result is served but never memoized (recovery is next request). Injectable `now`/`ttlMs`/`deadlineMs` for tests. Per-pod, evaporates on restart — a memo, not a store (ADR-041 C-04 spirit). |
| D-04 | **Surface.** A tRPC query `metrics.playScoreboard` on `authedProcedure` (every signed-in member — the About-tile posture; deliberately NOT `metricsProcedure`, which gates the Metrics section). Wired through the ctx-injection idiom: `ctx.playScoreboard` (tests) or the env-built singleton from `resolveTautulliInstances(process.env)`. The dashboard RSC awaits it alongside `catalog.myApps`/`motd.getActive` — numbers are baked at SSR; ZERO client-side fetching, no post-load shift (ADR-015). |
| D-05 | **Badge anatomy (the shields idiom).** Each badge is a two-segment pill: a muted LABEL segment (tiny play-glyph SVG + text) and an accent VALUE segment, ~21 px tall, 11 px/600 type, tabular numerals in the value. Tokens only — `--color-text-muted`/`--color-accent` washes via the established `color-mix` tint idiom, `--color-border` outline; new `.scoreboard*` classes in `app.css`; no new tokens, no raw hex. |
| D-06 | **Placement + row.** One `.scoreboard` flex row between `<Greeting/>` and the About tile (`page.tsx`), `flex-wrap: wrap` so it stacks gracefully at 390 px — wrap is initial layout, not interaction, so ADR-015 holds. Badges in fixed order: **Movies · TV episodes · Music · Hours watched**. The row carries `aria-label="Estate lifetime plays"` (`role="group"`). Static — no links, no hover states, nothing moves. |
| D-07 | **Failure states.** Partial failure: the failed instance contributes nothing; the remaining sums render with no error chrome (honest smaller numbers beat a warning on every member's front page). Total failure or zero configured instances (`unavailable`): the component returns `null` — NO empty chrome, the greeting sits directly above the About tile exactly as before this feature. |
| D-08 | **Compact numbers.** `formatPlays` (pure, `apps/web/lib/scoreboard.ts`): `< 1000` verbatim; thousands/millions as one-decimal `k`/`M` with a trailing `.0` trimmed (`25238 → "25.2k"`, `3449 → "3.4k"`, `999951 → "1M"`). The lib module also owns `scoreboardBadges(totals)` (the ordered label/value model, `null` when unavailable) so the RSC component is a pure mapper — mirrors the `lib/metrics.ts` pure-helper precedent. |
| D-09 | **Privacy.** Totals only: no usernames, no titles, no per-server split in the UI (`instances` stays server-side diagnostics in the payload shape; the component never renders it). |

## Alternatives considered

- Persisted snapshot table + sync CronJob — rejected (ADR-068): ceremony for four numbers.
- Client-side poll for true liveness — rejected: post-load shift (ADR-015) and per-viewer
  fan-out to the Tautullis; "semi-live" is the owner's word and 10 minutes honors it.
- Gating behind the Metrics section — rejected: the owner wants the front page to show off
  to everyone; aggregate lifetime counts leak nothing personal (D-09).

## Test strategy

- `packages/metrics/__tests__/plays.test.ts` — summing across instances/kinds, string-number
  tolerance, photo/unknown exclusion, hours rounding, partial failure flags, all-failed ⇒
  `unavailable`, zero readers ⇒ `unavailable`, the 3 s deadline (fake timers), TTL memo
  behavior with injected clock (fresh hit, post-TTL refetch, unavailable-not-memoized).
- `apps/web/lib/__tests__/scoreboard.test.ts` — `formatPlays` cases, badge model order +
  `null` when unavailable, and a `renderToStaticMarkup` render of `<Scoreboard/>` (the
  motd-markdown test idiom): aria-label present, four badges, compact values baked,
  empty output when unavailable.
- `packages/arr/__tests__/metadata-clients.test.ts` — `getLibrariesTable` query params +
  envelope unwrap (the existing stub-fetch idiom).
- No e2e requirement (advisory tier); local dev without Tautulli env verifies the
  render-nothing path by construction.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Should the row deep-link anywhere (e.g. a future stats page)? | (open — ships static; a link target doesn't exist yet) |
