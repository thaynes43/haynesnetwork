# CLAUDE.md — haynesnetwork

Agent/contributor guide. Read this before touching anything.

## What this project is

**haynesnetwork** is the SSO front door for `*.haynesnetwork.com` — a responsive web app
(phones, tablets, PCs) where users of the Haynes Plex ecosystem log in through
**Authentik (with Plex)** and get a permissioned dashboard of the self-hosted apps they may
use, self-service Plex library management, and media "fix"/ledger tooling backed by the
*arr stack (Sonarr/Radarr/Lidarr). Requirements live in `docs/prds/001-haynesnetwork.md`.

Two sibling repos are normative references (both in the VS Code workspace):

- `../todos-for-dues` — architecture donor: pnpm monorepo, Next.js App Router, Better Auth,
  Drizzle + Postgres, tRPC, docs-first process, CI/PR flow, release-please, Dockerfile.
- `../demo-console` — UI donor: CSS-token theming via `data-theme` on `<html>`, viewport-fit
  layout primitives, hex-lint guard, Playwright resize matrix.
- `../../haynes-ops` — the Flux GitOps repo this app deploys into (cluster context `haynes-ops`).

## Documentation-first process

**No code before docs.** The pipeline is `PRD → ADR → DDD → design → plan → code → tests`
(see `docs/PROCESS.md`). Keep docs current in the same change that alters behavior.

- Every docs folder has a `000-template.md`; **copy it to start a new doc**.
- 3-digit numbering, IDs are stable and never renumbered (`R-NN`, `US-NN`, `AC-NN` in PRDs;
  `C-NN` in ADRs; `D-NN` in designs).
- ADRs are MADR 3.0 and **immutable once Accepted** — supersede, don't edit.
- Status lifecycle: `Draft → Proposed → Accepted → (Superseded by NNN | Deprecated)`.
- The glossary `docs/domain-driven-design/001-ubiquitous-language.md` is normative — new
  domain terms must be added there in the same change that introduces them.
- **Ask rather than invent**: unknowns become explicit `Q-NN` open questions in the doc,
  not assumptions.

Agent working state lives in `.agents/` (`HANDOFF.md` is the resume point; dated notes in
`.agents/context/`; executable plans in `.agents/plans/`).

## Hard rules

1. **PostgreSQL 16 only** — never SQLite/MySQL substitution, in code or tests. Tests use an
   embedded Postgres binary (no Docker available in this WSL distro).
2. **No raw hex colors** outside `tokens.css` files — enforced by `scripts/lint-css-hex.mjs`.
   All UI color goes through `--color-*` CSS custom properties themed by `data-theme`.
3. **Catalog links are admin-curated, arbitrary URLs** — the catalog accepts any normalized
   `http(s)` URL an admin enters (any domain, including `*.haynesops.com` and external sites);
   the old `*.haynesnetwork.com`-only restriction was retired by ADR-013. (Server-side code
   may talk to in-cluster services via `*.svc.cluster.local` — that's fine and unrelated to
   user-facing catalog links.)
4. **The *arrs are the source of truth** for media lists. This app's ledger is a synced copy
   plus attribution/audit — sync flows in from the *arrs; the only write-back is the explicit
   failsafe restore and fix actions.
5. **Auth is Authentik OIDC only.** No email/password, no invite tokens. Admin role is
   bootstrapped by matching the OIDC email against the `BOOTSTRAP_ADMIN_EMAILS` allowlist.
6. Role/permission mutations must write audit rows in the same transaction (see
   `packages/domain` — single-writer helpers; `packages/domain/README.md` — pattern
   borrowed from todos-for-dues).
7. Secrets never land in git: local dev uses `.env.local` (gitignored); cluster uses
   External Secrets + 1Password (`HaynesKube` vault). See `docs/ops/`.
8. **Destructive actions use the `@hnet/ui` `ConfirmButton` inline two-step confirm — never
   `window.confirm`** (ADR-014 / DESIGN-004 D-13). Explanatory / multi-field confirms (failsafe
   restore, Fix, Force-search) use a `Modal` instead.
9. **Page contents must not re-orient on interaction** (ADR-015 / DESIGN-004 D-14). An
   interaction may change color/emphasis but must NOT reflow or reposition neighbors. The only
   exceptions are deliberate in-place expansions (e.g. the catalog inline editor) and
   drag-and-drop reordering. The two-step confirm reserves width for the widest (armed) label so
   the label swap can't shift the row; armed state deepens color, never layout.

## Workflow

- **Until GATE A** (recorded in `.agents/plans/`), bootstrap work lands directly on `main`.
- **After GATE A**: branch `<type>/<slug>` off `main` → PR → required checks
  `lint-and-typecheck`, `test`, `build` green → squash-merge. `e2e` is advisory until
  hardening. Conventional commits (`feat:`/`fix:`/`feat!:`) drive release-please versioning.
- Images build to `ghcr.io/thaynes43/haynesnetwork` on `v*` tags; deployment manifests live
  in `haynes-ops` under `kubernetes/main/apps/frontend/haynesnetwork/`.

## Commands

pnpm 11.9 workspace (Node >= 22). Apps live in `apps/*`; internal packages in `packages/*`
are scoped **`@hnet/*`** and export raw TS — no per-package build step. There are nine:

- `@hnet/db` — Drizzle schema + migrations against Postgres 16.
- `@hnet/domain` — single-writer domain logic; audit/ledger rows written in the same
  transaction as the mutation they record.
- `@hnet/arr` — Sonarr/Radarr/Lidarr client; `@hnet/arr/write` (the write-back surface) is
  import-confined to `packages/domain`.
- `@hnet/plex` — Plex server + plex.tv sharing client (XML ACL); `@hnet/plex/write` (the
  share-mutation surface) is import-confined to `packages/domain` (ADR-017).
- `@hnet/sync` — one-way *arr → ledger sync jobs (run by the cluster CronJobs).
- `@hnet/auth` — Better Auth + Authentik OIDC wiring.
- `@hnet/api` — tRPC routers.
- `@hnet/ui` — token-themed components (`data-theme`); `tokens.css` is the only place for hex.
- `@hnet/test-utils` — embedded-Postgres + stub harness helpers.

- `pnpm install` — install workspace deps.
- `pnpm dev` — Next.js dev server (`apps/web`) on http://localhost:3000. Needs a real
  `DATABASE_URL`/OIDC env in `apps/web/.env.local`.
- `pnpm dev:local` — the primary no-Docker way to boot the whole app: embedded Postgres 16
  (migrated + seeded), a stub OIDC provider, and stub Sonarr/Radarr/Lidarr/Seerr, all on
  http://localhost:3000. See `docs/ops/003-local-verification.md` (local verify) and
  `docs/ops/004-deploy-runbook.md` (merged PR → live staging).
- `pnpm build` — `pnpm -r build` (`next build`, standalone output).
- `pnpm typecheck` — `tsc --noEmit` in every workspace package.
- `pnpm lint` — ESLint 9 flat config in every workspace package.
- `pnpm lint:css` — hex-color guard (`scripts/lint-css-hex.mjs`; stub until the theme port).
- `pnpm test` — Vitest across packages (`@hnet/domain` has the first real test; others
  run `vitest run --passWithNoTests`).
- `pnpm format` — Prettier write across the repo.

Arriving with later tasks: `pnpm --filter web e2e` (Playwright),
`pnpm --filter @hnet/db generate|migrate` (Drizzle).
