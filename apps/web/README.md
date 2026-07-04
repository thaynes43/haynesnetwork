# apps/web — the Next.js front door

Orientation for a bug-fix / UX agent. This is the only deployable app: a Next.js 16 App
Router app (`output: 'standalone'`, `next.config.ts`) that serves the authed dashboard,
media-ledger surfaces, and admin console. It renders UI and calls the tRPC API — all
domain logic lives behind `@hnet/api` in `packages/*`, not here.

Design references (do not duplicate them here): DESIGN-003 (tRPC/data), DESIGN-004
(routing, layout, gating), DESIGN-005 (media ledger UI), DESIGN-006 (brand/theme).

## Where things live

There is **no `apps/web/src`** — the App Router tree is `apps/web/app/` at the app root.

- `app/` — routes. Authed pages sit in the **`(app)` route group** (a URL-invisible group
  whose `layout.tsx` is the session gate + chrome frame). `app/login/` is the one public
  page. `app/api/` holds the three route handlers (`auth/[...all]`, `trpc/[trpc]`,
  `health`). `app/layout.tsx` is the root: fonts, the pre-paint theme script, and the
  `ThemeProvider` + `TRPCProvider` wrappers.
- `components/` — page-local React components (`top-bar.tsx`, `modal.tsx`, `brand-mark.tsx`,
  `kind-icon.tsx`). Reusable, tokenized primitives live in `@hnet/ui`, not here.
- `lib/` — shared, mostly-pure helpers (see below). Imported as `@/lib/*` (`@/*` → app root,
  per `tsconfig.json`).
- `dev/local.ts` — the hands-on local stack launcher (`pnpm dev:local`).
- `e2e/` — Playwright suite + its harness/stubs (embedded PG16, stub OIDC, stub *arr).
- `fonts/` — vendored Outfit variable woff2 (self-hosted; no external font fetch, CSP-safe).

### Route map (quick reference — authoritative inventory is DESIGN-004 D-11)

Keep the route table in **DESIGN-004 D-11** as the single source of truth; this is a
pointer, not a second copy.

| Path | Purpose | Gating |
| --- | --- | --- |
| `/login` | OIDC sign-in (single button, no password form) | public; existing session → `/` |
| `/` | Dashboard: the user's app tiles (`catalog.myApps`) | authed |
| `/library` | Media ledger browse/search | authed |
| `/library/[id]` | Item detail + Fix / Force-Search dialogs | authed |
| `/my-fixes` | The signed-in user's own fix requests | authed |
| `/admin` | User list (admin home) | Admin |
| `/admin/catalog` | App catalog CRUD + ordering | Admin |
| `/admin/tags` | Tag/bundle management | Admin |
| `/admin/fixes` | All fix requests + actioning | Admin |
| `/admin/restore` | Failsafe restore | Admin |
| `/admin/users/[id]` | Per-user access detail | Admin |

## Gating (always server-side)

Rules are pure functions in `lib/route-gate.ts` so layouts stay one-liners and the client
never receives markup it cannot use.

- `(app)/layout.tsx` calls `protectedRouteRedirect(session.user)` — anonymous → `/login`,
  no tRPC round-trip.
- `(app)/admin/layout.tsx` calls the same with `{ requireAdmin: true }` — authed non-Admin
  → `/`. (Roles are capitalized: `Member` / `Admin`; it fails closed on anything but
  `Admin`.)
- **A layout redirect does not abort the page render.** The dashboard page
  (`(app)/page.tsx`) re-checks the session itself before calling the caller — otherwise
  `getServerCaller()` would throw `UNAUTHORIZED` before the layout redirect settles. Any new
  authed page that fetches in the RSC body should do the same guard.
- `/login` is public but `loginRouteRedirect` server-redirects an existing session home.

## Data-fetching conventions

Two clients, one rule each. (These were tribal knowledge in HANDOFF; this is now the
written contract.)

- **First paint (RSC):** `await getServerCaller()` (`lib/trpc-server.ts`) and call the
  procedure directly. It builds the tRPC context from the incoming request `headers()`, so
  the Better Auth session cookie flows through. Use this for initial data in server
  components (e.g. `catalog.myApps` on the dashboard).
- **Interactive (client components):** the `trpc` react-query singleton
  (`lib/trpc-client.ts`) under `TRPCProvider` (`lib/trpc-provider.tsx`). QueryClient
  defaults: `staleTime: 5_000`, `refetchOnWindowFocus: false`.
- **No optimistic UI.** After **any** mutation the component MUST invalidate the affected
  query — `const utils = trpc.useUtils(); … utils.<router>.<query>.invalidate()` — or the UI
  silently goes stale. This is the deliberate correctness-over-snappiness choice (ADR-004
  C-02); don't add optimistic mutation state without revisiting that ADR.
- **Client error handling switches on `appCode`, never message text.** Use
  `lib/app-error.ts` (`appCodeOf` / `describeMutationError`): the server's errorFormatter
  attaches a stable `appCode` (e.g. `FIX_RATE_LIMIT_EXCEEDED`, `CATALOG_URL_FORBIDDEN_HOST`)
  and the copy map lives there. New user-facing error codes get their friendly copy added to
  `APP_CODE_COPY`, not inlined at the call site.

### lib helpers (all pure/unit-testable unless noted)

`route-gate.ts` (gating), `app-error.ts` (error → copy by appCode), `catalog-url.ts`
(client mirror of the R-14 `*.haynesnetwork.com`-only URL rule — server stays
authoritative; never allow `*.haynesops.com`), `media.ts` (ledger display: scopes,
season grouping, status/reason/event labels, `formatBytes`, `onDiskSummary`),
`provenance.ts` (recompute a user's effective app access + `default`/`direct`/`tag:` chips
client-side), `greeting.ts` + `initials.ts` (dashboard/avatar), `trpc-server.ts` /
`trpc-client.ts` / `trpc-provider.tsx` (the two tRPC clients above).

## Running it

```
pnpm dev:local        # from repo root — boots the full local stack on :3000
```

`dev/local.ts` boots the exact stack the e2e suite uses: embedded **Postgres 16** (real
migrations + catalog seed, throwaway temp dir), the **stub OIDC** provider with personas
(`admin` / `member` / `fresh-member` — type a name at the terminal to switch which the next
sign-in mints), and a stub *arr — **no Docker, no Authentik, no cluster, no real
credentials**. Plain `pnpm dev` runs `next dev` alone and needs a real DB + OIDC env, so
prefer `dev:local` for hands-on work.

For the full pre-push verification runbook (`lint`, `lint:css`, `typecheck`, `test`,
`build`, e2e on :3100) see **OPS-003** (`docs/ops/003-local-verification.md`).
