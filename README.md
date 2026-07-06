# haynesnetwork

The SSO front door for `*.haynesnetwork.com`: log in once through Authentik (with your
Plex account) and get a personal dashboard of the Haynes self-hosted apps you're allowed
to use — plus self-service Plex library management and media lookup/"fix" tooling backed
by the Sonarr/Radarr/Lidarr stack.

Works in any browser on phones, tablets, and PCs.

## Status

GATE A is done, so all work now flows through PRs (see below). Phase 1 (auth + permissioned
app dashboard) and Phase 2 (media ledger with fix / force-search / restore write-back and
one-way *arr sync) are complete and deployed to live staging at
`https://haynesnetwork.haynesops.com`. Seven release-please releases have shipped, latest
**v0.3.1**. Phase 3 (Plex library self-service) is not yet built. See
[`.agents/HANDOFF.md`](.agents/HANDOFF.md) for the current build state.

## Documentation map

This repo is documentation-first — read [`docs/PROCESS.md`](docs/PROCESS.md) first, then
the doc index at [`docs/README.md`](docs/README.md).

| Area | Where |
|------|-------|
| Doc index | [`docs/README.md`](docs/README.md) |
| Product requirements | [`docs/prds/`](docs/prds/) |
| Architecture decisions (MADR) | [`docs/adrs/`](docs/adrs/) |
| Domain language & contexts | [`docs/domain-driven-design/`](docs/domain-driven-design/) |
| Technical designs | [`docs/designs/`](docs/designs/) |
| Operator runbooks | [`docs/ops/`](docs/ops/) |
| Executable plans (incl. GATE A) | [`.agents/plans/`](.agents/plans/) |
| Agent guide & hard rules | [`CLAUDE.md`](CLAUDE.md) |

Executable plans live in [`.agents/plans/`](.agents/plans/), not `docs/plans/`.
`docs/flows/` and `docs/releases/` are template scaffolding only — flows fold into the
design docs and releases are handled by release-please, so neither is a required per-feature
stage.

## Running locally

Three modes, all WSL-friendly (no Docker required anywhere):

| Command | What it gives you |
|---------|-------------------|
| `pnpm dev` | Plain Next dev server. Needs a real `DATABASE_URL`/OIDC env in `apps/web/.env.local` — pages that touch the DB or auth fail without one. |
| `pnpm dev:local` | **The local test environment**: embedded Postgres 16 (migrated + seeded, throwaway), a stub OIDC provider standing in for Authentik, stub Sonarr/Radarr/Lidarr/Seerr *arr services, and the dev server on http://localhost:3000. Sign in with the normal button; switch persona (`admin` \| `member` \| `fresh-member`) by typing its name in the terminal. Use the browser devtools device toolbar for phone/tablet vetting. |
| `pnpm --filter web e2e` | The Playwright suite (port 3100) against the same stack: full stub-OIDC login round trips, role-gated dashboards, admin grant flows, theme persistence, and the 8-size phone/tablet/PC resize matrix (~30s locally). |

`admin` (bootstrap-admin@example.test) is promoted to Admin on first sign-in via the same
`BOOTSTRAP_ADMIN_EMAILS` mechanism production uses; `fresh-member` always shows the
first-login experience. Data is deleted on Ctrl-C.

### Pre-push merge gate

Run these before pushing — they mirror the CI checks that gate every PR. Full runbook:
[`docs/ops/003-local-verification.md`](docs/ops/003-local-verification.md).

| Command | CI check |
|---------|----------|
| `pnpm lint` + `pnpm lint:css` + `pnpm typecheck` | `lint-and-typecheck` (one job runs all three) |
| `pnpm test` | `test` (Vitest, embedded Postgres 16) |
| `pnpm build` | `build` (`next build`, standalone output) |

`pnpm --filter web e2e` maps to the advisory `e2e` check (not yet a required gate).

## Contributing — pull-request flow

GATE A is done ([`.agents/plans/completed/001-gate-a-pr-cutover.md`](.agents/plans/completed/001-gate-a-pr-cutover.md)):
branch off `main`, open a PR, required checks (`lint-and-typecheck`, `test`, `build`) must
pass, squash-merge only. Conventional commits drive versioning via release-please; `v*`
tags publish `ghcr.io/thaynes43/haynesnetwork`.

## Related repositories

- [todos-for-dues](../todos-for-dues) — architecture reference (Better Auth, Drizzle, tRPC).
- [demo-console](../demo-console) — theming & responsive layout reference.
- [haynes-ops](../../haynes-ops) — Flux GitOps repo; this app deploys to
  `kubernetes/main/apps/frontend/haynesnetwork/`.
