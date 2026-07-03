# haynesnetwork

The SSO front door for `*.haynesnetwork.com`: log in once through Authentik (with your
Plex account) and get a personal dashboard of the Haynes self-hosted apps you're allowed
to use — plus self-service Plex library management and media lookup/"fix" tooling backed
by the Sonarr/Radarr/Lidarr stack.

Works in any browser on phones, tablets, and PCs.

## Status

Bootstrapping. See [`.agents/HANDOFF.md`](.agents/HANDOFF.md) for the current build state.

## Documentation map

This repo is documentation-first — read [`docs/PROCESS.md`](docs/PROCESS.md) first.

| Area | Where |
|------|-------|
| Product requirements | [`docs/prds/`](docs/prds/) |
| Architecture decisions (MADR) | [`docs/adrs/`](docs/adrs/) |
| Domain language & contexts | [`docs/domain-driven-design/`](docs/domain-driven-design/) |
| Technical designs | [`docs/designs/`](docs/designs/) |
| User/system flows | [`docs/flows/`](docs/flows/) |
| Implementation & validation plans | [`docs/plans/`](docs/plans/) |
| Release scopes | [`docs/releases/`](docs/releases/) |
| Operator runbooks | [`docs/ops/`](docs/ops/) |
| Agent guide & hard rules | [`CLAUDE.md`](CLAUDE.md) |

## Running locally

Three modes, all WSL-friendly (no Docker required anywhere):

| Command | What it gives you |
|---------|-------------------|
| `pnpm dev` | Plain Next dev server. Needs a real `DATABASE_URL`/OIDC env in `apps/web/.env.local` — pages that touch the DB or auth fail without one. |
| `pnpm dev:local` | **The local test environment**: embedded Postgres 16 (migrated + seeded, throwaway), a stub OIDC provider standing in for Authentik, and the dev server on http://localhost:3000. Sign in with the normal button; switch persona (`admin` \| `member` \| `fresh-member`) by typing its name in the terminal. Use the browser devtools device toolbar for phone/tablet vetting. |
| `pnpm --filter web e2e` | The Playwright suite against the same stack: full stub-OIDC login round trips, role-gated dashboards, admin grant flows, theme persistence, and the 8-size phone/tablet/PC resize matrix (~30s locally). |

`admin` (bootstrap-admin@example.test) is promoted to Admin on first sign-in via the same
`BOOTSTRAP_ADMIN_EMAILS` mechanism production uses; `fresh-member` always shows the
first-login experience. Data is deleted on Ctrl-C.

## Contributing — pull-request flow

GATE A is done ([`.agents/plans/001-gate-a-pr-cutover.md`](.agents/plans/001-gate-a-pr-cutover.md)):
branch off `main`, open a PR, required checks (`lint-and-typecheck`, `test`, `build`) must
pass, squash-merge only. Conventional commits drive versioning via release-please; `v*`
tags publish `ghcr.io/thaynes43/haynesnetwork`.

## Related repositories

- [todos-for-dues](../todos-for-dues) — architecture reference (Better Auth, Drizzle, tRPC).
- [demo-console](../demo-console) — theming & responsive layout reference.
- [haynes-ops](../../haynes-ops) — Flux GitOps repo; this app deploys to
  `kubernetes/main/apps/frontend/haynesnetwork/`.
