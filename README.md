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

Populated once the scaffold lands. Target: `pnpm install && pnpm dev` → http://localhost:3000.

## Contributing — pull-request flow

Until GATE A (the PR cutover, tracked in `.agents/plans/`), bootstrap commits land directly
on `main`. After GATE A: branch off `main`, open a PR, required checks
(`lint-and-typecheck`, `test`, `build`) must pass, squash-merge only. Conventional commits
drive versioning via release-please; `v*` tags publish `ghcr.io/thaynes43/haynesnetwork`.

## Related repositories

- [todos-for-dues](../todos-for-dues) — architecture reference (Better Auth, Drizzle, tRPC).
- [demo-console](../demo-console) — theming & responsive layout reference.
- [haynes-ops](../../haynes-ops) — Flux GitOps repo; this app deploys to
  `kubernetes/main/apps/frontend/haynesnetwork/`.
