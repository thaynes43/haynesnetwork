# PLAN-010: Message-of-the-Day dashboard banner

- **Status:** Executing (Fable 5, 2026-07-07)
- **Satisfies:** PRD-001 **R-105** (Dashboard & app catalog), **ADR-027** (Dashboard MOTD banner,
  Accepted), DESIGN-004 **D-15**, glossary **T-89**.

> **EXECUTION NOTE (Fable 5, 2026-07-07).** Reconciled IDs to next-free at authoring time (ADR-027,
> R-105, D-15, T-89). Per the Fable 5 rulings, the MOTD **reuses the shipped `app_settings` audited
> store** (ADR-025 C-06) under a new key `motd` (jsonb record `{ message, severity, enabled, startsAt,
> endsAt, updatedBy }`) — **NOT** a bespoke `motd` table (this plan's Open decision #1 → reuse). So the
> data-model section below (bespoke `motd` table + `set_motd`/`clear_motd` audit actions + a
> `motd_severity` CHECK + guard-list additions) is **SUPERSEDED**: the only migration is
> `0019_motd_app_setting.sql`, a one-line CHECK relax admitting the `motd` key; writes reuse the
> existing `update_app_setting` audit action; `app_settings` is already guarded. Severity =
> `MOTD_SEVERITIES=['info','warning']`; dismissal = per-user localStorage keyed by a content version;
> tokens reused via `color-mix` (no new token/hex). API = a dedicated `motd` router (`getActive`
> authed; `get`/`set`/`clear` admin). Everything else (mount above `<Greeting>`, ADR-015 collapse,
> ConfirmButton Clear, the compose page + "MOTD" sub-nav) is implemented as written.
- **Depends on:** none — self-contained. **Optionally coordinates with PLAN-009 (Bulletin/Feed)**
  if that plan exists by the time this runs (soft tie-in only, see "Optional PLAN-009 tie-in").
- **TODO source:** owner stretch request 2026-07-05 (not in `TODO.md` #1..#5).

> **STRETCH — not part of the core commitment.** A small, low-risk, independent feature to run
> **after** the core queue (002–008) and after 009 if present. Fable 5 **MAY pull it forward as a
> quick win** if it is ahead of schedule — it touches no *arr/Plex/Maintainerr integration, adds
> no external system, no new secret, and no e2e stub. It is a single vertical slice (one table,
> one single-writer, one small router, one admin page + one banner) that mirrors the Restore/Fix
> and catalog patterns already in the repo.

## Goal

Give admins an **optional Message-of-the-Day (MOTD)** — a single, token-styled banner at the top
of the dashboard / front page used to broadcast important events (server downtime, newly-added
apps, notices) to every signed-in user. An admin composes / enables / clears the MOTD from
`/admin`; the write is audited in the same transaction. Every authed user's dashboard shows the
**active** MOTD (enabled AND within its optional time window), color-coded by severity via
`--color-*` tokens (no raw hex). A dismissible MOTD can be hidden per-user and stays hidden until
the admin edits or re-enables it (a new version). The banner is **present-when-set** and
**collapses cleanly on dismiss** — it never reflows or repositions the tiles below on interaction
(ADR-015 / hard rule 9).

Reference vertical (mirror it): the catalog admin slice — `packages/domain/src/catalog.ts`
`createApp`/`updateApp` (single-writer: `inTransaction` → mutate row → `permissionAudit` insert in
ONE tx, lines 51–160) → `catalog` tRPC router `adminProcedure` writes + one `authedProcedure`
read (`packages/api/src/routers/catalog.ts:35,61`) → `'use client'` admin page
(`apps/web/app/(app)/admin/catalog/page.tsx`) + the server-rendered dashboard
(`apps/web/app/(app)/page.tsx`).

## Docs-first artifacts to author (same PR as behavior)

> **IDs below are INDICATIVE placeholders** (per `.agents/plans/README.md` reconciliation rule).
> Re-grep `docs/adrs/`, `docs/designs/`, the PRD, the glossary, and `packages/db/migrations/`
> and allocate the **next-free** number at authoring time. v0.4.0 ceilings were ADR-015,
> DESIGN-006, migration 0008, R-66, T-49; plans 002–009 consume some first.

### ADR-0NN — Dashboard MOTD banner (indicative ADR-024)
`docs/adrs/0NN-dashboard-motd-banner.md` (copy `docs/adrs/000-template.md`; MADR 3.0; **Fable 5
authors AND ratifies → Status: Accepted**). Decisions to record (see Open decisions for the
choices Fable makes):
- A **single active MOTD**, stored as a **`motd` singleton row** (fixed sentinel id, upserted by
  the compose action) rather than an app-settings blob — recommended. "Active" =
  `enabled AND (starts_at IS NULL OR now >= starts_at) AND (ends_at IS NULL OR now < ends_at)`.
- **Sanitized plain text** message (recommended; short, `<= 280` chars, rendered as text — no HTML
  injection surface) over limited markdown. Record the choice + the sanitization boundary.
- **Severity** enum `info | warning` (recommended; `critical` optional) → `--color-info` /
  `--color-warning` tokens only. No raw hex anywhere (hard rule 2).
- **Dismiss** = per-user `localStorage` keyed by an MOTD **version** (the row's `updated_at`, or a
  content hash) so an edited / re-enabled MOTD re-shows — recommended (no extra table). Alternative
  `motd_dismissals` table (user_id + version) recorded as the durable/cross-device option.
- MOTD mutations are **audited in `permission_audit`** with new actions `set_motd` / `clear_motd`
  (snapshot in the jsonb `detail`; no new FK — `permission_audit.detail` already carries
  denormalized snapshots, e.g. the reorder row at `catalog.ts:196`).
- Consequences: good (owner broadcast channel, zero new deps); bad (one more admin surface + one
  CHECK-relax migration on `permission_audit`); neutral (dismissal is client-only in v1 — not
  audited/cross-device).

### DESIGN-004 — new D-NN (Dashboard MOTD) (indicative D-15)
`docs/designs/004-ui-shell-and-dashboard.md` (append `### D-NN`, do not renumber D-01..D-14). Cover:
where the banner mounts (top of the dashboard `page.tsx`, above `<Greeting>` — D-07 neighbor); the
`role="status"` (info) / `role="alert"` (warning) semantics; severity→token mapping; the
present-when-set + clean-collapse-on-dismiss rule and why it is an ADR-015-sanctioned deliberate
removal (like the catalog inline-editor / drag exceptions — NOT an interaction reflow of
neighbors); the admin compose page (`/admin/motd`) mirroring the `/admin/catalog` D-11 form; and
the token additions if any (see UI → Tokens). Note the admin sub-nav gains a **"MOTD"** entry
(`admin/layout.tsx:18`).

### DDD glossary — `docs/domain-driven-design/001-ubiquitous-language.md`
Add (next id is **T-NN**, indicative **T-58**; T-49 was the v0.4.0 ceiling — earlier plans consume
some first):
- **T-NN MOTD (Message of the Day)** — the optional single admin-set dashboard banner broadcast to
  every authed user; **active** when `enabled` and within its optional `starts_at`/`ends_at`
  window. Severity `info | warning`; dismissible per user. `motd` table; `getActiveMotd`;
  audited via `permission_audit` `set_motd`/`clear_motd`. Written only by the `packages/domain`
  single-writer (like every guarded table — T-39 Audit Row).
- Add a Change-log row dated 2026-07-0N (ADR-0NN).

### PRD note — `docs/prds/001-haynesnetwork.md`
Add a new **R-NN** (indicative **R-73**) under **Dashboard & app catalog** (after R-14, line 70):
"Admins may set an optional Message-of-the-Day banner (severity-coded, optionally time-windowed,
per-user dismissible) shown at the top of the dashboard to every signed-in user (ADR-0NN /
DESIGN-004 D-NN)." Do not renumber existing R-IDs.

## Data model — `packages/db`

- **New enum(s) — `packages/db/src/schema/enums.ts`.**
  - `export const MOTD_SEVERITIES = ['info', 'warning'] as const;` + `type MotdSeverity` — the
    single source of truth for the TS type AND the `motd_severity_enum` CHECK (built via a
    `MOTD_SEVERITIES_SQL_LIST`, mirroring `FIX_PATHS`→`fix_requests_path_enum`). (`critical` is
    Open decision #4 — additive if chosen.)
  - **Extend `PERMISSION_AUDIT_ACTIONS`** (line 10) with `'set_motd'`, `'clear_motd'`. This array
    is the single source for the TS `PermissionAuditAction` type AND the
    `permission_audit_action_enum` CHECK (`schema/permission-audit.ts:8,30` builds it from the
    array) — so the append updates both, but the existing DB CHECK needs a relax migration (below).
- **New table — `packages/db/src/schema/motd.ts`** (register in `schema/index.ts`). Singleton row
  (fixed sentinel id, e.g. a `SEEDED_MOTD_ID`, upserted by `setMotd`):
  - `id uuid pk` (sentinel), `message text notNull` (`<= 280`, plain), `severity text
    $type<MotdSeverity>() notNull default 'info'` + CHECK from `MOTD_SEVERITIES_SQL_LIST`,
    `enabled boolean notNull default false`, `startsAt timestamptz` (nullable),
    `endsAt timestamptz` (nullable), `dismissible boolean notNull default true`,
    `updatedBy uuid references(users.id, onDelete: 'set null')`, `createdAt`/`updatedAt timestamptz
    notNull defaultNow()`. (Add a `version`/hash only if Open decision #3 picks the table-based
    dismissal — the singleton's `updatedAt` already serves as the client dismiss version.)
- **Migration `NNNN_motd_banner.sql`** (indicative **0016**; next-free after the 0008 ceiling —
  earlier plans consume 0009+). Two statements: (1) `CREATE TABLE motd (...)` with the
  `motd_severity_enum` CHECK; (2) **CHECK-relax** on `permission_audit` — drop + re-add
  `permission_audit_action_enum` to admit `set_motd`/`clear_motd`, **mirroring
  `0004_search_requested_event.sql`** exactly (drop constraint → re-add with the full ARRAY of
  values incl. the two new ones). Existing rows unaffected (additive). Optionally seed the
  singleton row **disabled** so `setMotd` is always an UPDATE (or upsert on the sentinel id).
- **Guard list — `packages/domain/__tests__/no-direct-state-writes.test.ts`.** Add `motd` to the
  four SQL/Drizzle `FORBIDDEN_PATTERNS` groups (lines 41,46,51,56,61,66): SQL
  `INSERT INTO motd` / `UPDATE motd SET` / `DELETE FROM motd`, and Drizzle
  `.insert(motd)` / `.update(motd)` / `.delete(motd)`. (`permission_audit` is already guarded.) If
  Open #3 adds `motd_dismissals`, add it too — but recommended dismissal is localStorage (no table,
  no guard change).

## Domain — `packages/domain`

- **`packages/domain/src/motd.ts`** — single-writers + reader, mirroring `catalog.ts`:
  - `setMotd(input)` — `inTransaction` (`db-client.ts`, as `catalog.ts:5,53`): **upsert the
    singleton `motd` row** with the composed fields (validate/trim message, clamp length, coerce
    the optional window), then **insert one `permissionAudit` row `action: 'set_motd'`** with a
    jsonb `detail` snapshot `{ enabled, severity, message, starts_at, ends_at, dismissible }` and
    `actorId` — in the SAME tx (hard rule 6 / T-39). Returns the new row.
  - `clearMotd(input)` — flips `enabled=false` (does not delete the row) + one
    `permissionAudit` `action: 'clear_motd'` in the same tx.
  - `getActiveMotd(db, now = new Date())` — read helper returning the active MOTD or `null`,
    applying the **enabled + time-window** predicate. This is the unit-testable core (below). No
    audit (read-only). Also a plain `getMotd(db)` returning the raw singleton (admin prefill).
  - Export all from `packages/domain/src/index.ts` (append, like `export * from './catalog';`).
- No `@hnet/arr` / write-back involvement — MOTD is app-owned config, not media (T-38). No Restore
  interaction.

## API — `packages/api`

- **New router — `packages/api/src/routers/motd.ts`** (recommended over folding into
  `profile`/settings — clearer surface; note the RESERVED-names convention in
  `routers/index.ts:22`). Imports `authedProcedure, mapDomainErrors, router` from `../trpc` and
  `adminProcedure` from `../middleware/role` (as `catalog.ts:15-16`):
  - `getActive: authedProcedure.query` → `getActiveMotd(ctx.db)` mapped to a wire shape (timestamps
    as ISO strings, per D-03) or `null`. **Every authed user** (the dashboard reads this).
  - `get: adminProcedure.query` → `getMotd(ctx.db)` for the compose-form prefill.
  - `set: adminProcedure.input(MotdInput).mutation` → `mapDomainErrors(() => setMotd({ db: ctx.db,
    ...input, actorId: ctx.user.id }))`.
  - `clear: adminProcedure.mutation` → `clearMotd({ db: ctx.db, actorId: ctx.user.id })`.
- **`MotdInput` zod schema** (in `packages/api/src/schemas`): `message` (trimmed, 1..280),
  `severity: z.enum(MOTD_SEVERITIES)`, `enabled: z.boolean()`, `dismissible: z.boolean()`,
  `startsAt`/`endsAt` optional nullable ISO datetimes (with a `startsAt <= endsAt` refine).
- **Register** in `packages/api/src/routers/index.ts` (`motd: motdRouter` in the root router).

## UI — `apps/web`

- **Admin compose page — `apps/web/app/(app)/admin/motd/page.tsx`** (`'use client'`, mirroring
  `admin/catalog/page.tsx`): a single form — message `<textarea maxLength={280}>`, severity
  `<select>` (from `MOTD_SEVERITIES`), `enabled` + `dismissible` checkboxes, optional
  `starts_at`/`ends_at` `<input type="datetime-local">`. **Save** → `trpc.motd.set` (prefilled via
  `trpc.motd.get`); **Clear** → `trpc.motd.clear` behind a `@hnet/ui` **`ConfirmButton`** (inline
  two-step — clearing removes something users see; never `window.confirm`, hard rule 8). Fields are
  static — selecting a severity changes only the live preview's color/emphasis, never layout
  (ADR-015). Add a **"MOTD"** `<Link href="/admin/motd">` to the admin sub-nav
  (`admin/layout.tsx:18-24`).
- **Front-page banner — `apps/web/components/motd-banner.tsx`** (`'use client'`), mounted at the
  **top of the dashboard** in `apps/web/app/(app)/page.tsx` **above `<Greeting>`** (line 24).
  `page.tsx` is a server component — **server-fetch** the active MOTD via
  `caller.motd.getActive()` (next to `caller.catalog.myApps()`, line 20) and pass it as a prop to
  `<MotdBanner motd={...} />` (no loading flash). The client component:
  - Renders nothing when `motd` is null.
  - Renders a `.motd` callout with `role="status"` (info) / `role="alert"` (warning), a severity
    modifier class (`.motd--info` / `.motd--warning`) mapping to `--color-info` / `--color-warning`
    tokens, the message text, and — when `dismissible` — a dismiss button.
  - **Dismiss** writes `localStorage['hnet-motd-dismissed'] = <version>` (the MOTD `updatedAt`, or a
    hash of message+severity+updatedAt) and unmounts the banner. On mount it reads the key and
    hides only if the stored version equals the current one — so an admin edit / re-enable
    (new `updatedAt`) **re-shows** it. Collapsing the banner is a **deliberate removal** (the tile
    grid simply occupies the reclaimed space) — sanctioned under ADR-015 like the catalog inline
    editor, NOT an interaction reflow of neighbors. The banner reserves no width games; it is
    full-width above the grid.
- **Tokens — `packages/ui/src/theme/*`.** `--color-info` and `--color-warning` already exist in
  `tokens.css` (lines 43/66, 42/65) and `tokenContract.ts` REQUIRED_TOKENS. **Recommended:** style
  the banner from those existing tokens (token border + a `color-mix()` tint for the fill, text on
  `--color-accent-contrast` / `--color-text`) so **no new REQUIRED_TOKEN and no new hex** are
  needed. If the design wants a distinct soft fill, add `--color-info-surface` /
  `--color-warning-surface` to **both** theme blocks in `tokens.css` (the ONLY hex file) AND to
  `REQUIRED_TOKENS` in `tokenContract.ts` — the `tokenContract.test.ts` then proves both themes
  define them (Open decision #5). Either way: **zero raw hex outside `tokens.css`**.

## Ops

- **No new external system, no new secret, no e2e stub, no helmrelease env.** MOTD is DB-only —
  works under `pnpm dev:local` (embedded PG16, migrated) with no extra wiring. The only migration
  is additive (`motd` table + `permission_audit` CHECK relax).
- **Deploy** as any other plan: local merge gate → PR → squash-merge → bump the image tag in
  `haynes-ops/kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml` + `flux reconcile`
  (`docs/ops/004-deploy-runbook.md`). No secret/ExternalSecret change.

## Optional PLAN-009 tie-in (soft — not a dependency)

If PLAN-009 (Bulletin/Feed) has landed, `setMotd` **MAY** also emit a Bulletin "announcement"
notification into the Feed so an MOTD is both a transient banner AND durable history. Keep MOTD
**standalone and fully functional without it**; gate any emission behind a presence check of the
Bulletin surface. Do **not** block this plan on PLAN-009, and do not invert the coupling (the Feed
does not own the MOTD). Record the tie-in as a `Q-NN` note in ADR-0NN if pursued.

## Open decisions Fable 5 must make (authorized to decide + record as ADR-0NN / Q-NN)

1. **Storage shape:** `motd` singleton row (recommended) vs an app-settings singleton blob. If the
   table, confirm sentinel-id-upsert vs a "latest enabled" multi-row model (recommended: singleton).
2. **Message format:** sanitized **plain text** (recommended — no injection surface) vs limited
   markdown (then pick + wire a sanitizer/renderer; note the CSP/XSS boundary).
3. **Dismiss mechanism:** per-user **localStorage** keyed by MOTD version (recommended, no table) vs
   a `motd_dismissals` table (user_id + version — durable/cross-device; then add it to the guard
   list). Define the "version" (recommended: row `updated_at`).
4. **Severity set:** `info | warning` (recommended) vs adding `critical` (additive to
   `MOTD_SEVERITIES` + a third token/style).
5. **New tokens?** reuse existing `--color-info`/`--color-warning` via `color-mix()` (recommended,
   no contract change) vs add `--color-*-surface` tokens (then update `tokenContract.ts` +
   `tokens.css` both themes + the contract test).
6. **API placement:** dedicated `motd` router (recommended) vs fold `getActive`/`set`/`clear` into
   `profile`/a new `settings` router.
7. **PLAN-009 tie-in:** emit a Bulletin announcement on `setMotd` or not (only if 009 exists).

## Verification

**Unit (`@hnet/domain`, embedded PG16 via `@hnet/test-utils`; mirror `catalog.ts` audit-in-tx
tests):**
- `getActiveMotd` **resolution matrix**: enabled + no window → active; disabled → null; enabled but
  `now < starts_at` → null; enabled but `now >= ends_at` → null; enabled and inside the window →
  active; open-ended windows (only `starts_at`, only `ends_at`) → correct. Assert the boundary
  conditions (inclusive start, exclusive end per the ADR predicate).
- `setMotd` writes the `motd` row **and** a `permission_audit` `set_motd` row **in one tx** (assert
  both present, `actorId` set, `detail` snapshot correct); `clearMotd` flips `enabled=false` +
  writes `clear_motd`. (A failed tx leaves neither — crash-safety.)
- Dismiss-versioning logic (if extracted to a pure helper): a stored version equal to the current
  hides; a changed version (edited MOTD) shows.
- Guard test: `no-direct-state-writes.test.ts` still green with `motd` on the watched list (no
  direct writes outside `packages/domain`).

**API (`packages/api/__tests__`):** `motd.getActive` returns the active MOTD for a member and
`null` when disabled/out-of-window; `motd.set`/`motd.clear` require admin (member → `FORBIDDEN` via
`adminProcedure`); `MotdInput` rejects `message` > 280 and `starts_at > ends_at`.

**e2e (`apps/web/e2e`, no stub — DB only):**
- Admin composes + enables an MOTD at `/admin/motd` → a **member's** dashboard `/` shows the banner
  with the right severity color and message.
- Admin **clears** (or sets an `ends_at` in the past) → the member's dashboard shows **no** banner.
- **Dismiss**: member dismisses a dismissible MOTD → banner hides and **stays hidden on reload**;
  admin **edits** the MOTD → it **re-shows** for that member (new version).
- Assert the banner mounting/dismiss does not shift the tile grid on interaction (ADR-015) — the
  grid position is unchanged by hover/arm; only presence toggles it.

**LIVE Playwright on real staging (`https://haynesnetwork.haynesops.com`)** after deploy: as an
admin, set an `info` MOTD → confirm it renders for a member account; edit it to `warning` → confirm
color + re-show; set `ends_at` in the near past (or Clear) → confirm it disappears; dismiss as the
member → confirm it stays gone until the admin edits again.

## Definition of Done

Docs authored + ADR-0NN Accepted; local merge gate green
(`pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`); branch
`feat/motd-dashboard-banner` → PR → required checks (`lint-and-typecheck`, `test`, `build`) green →
squash-merged; deployed to staging; the LIVE Playwright journeys above pass against real staging.
Then flip Status → Completed and `git mv` this plan to `.agents/plans/completed/`.

## Out of scope

- Multiple concurrent MOTDs / per-role or per-user targeting (single global banner only).
- Rich media / markdown-with-HTML, links styling beyond plain text (unless Open #2 opts into
  limited markdown).
- Cross-device / audited dismissals (v1 dismiss is client-only localStorage — Open #3).
- A durable notification Feed — that is PLAN-009's surface; MOTD only optionally emits into it.
- Scheduling recurrences / multiple future MOTDs queued (a single window only).

## Rollback

Revert the squash-merge PR and redeploy the prior image tag (`docs/ops/004-deploy-runbook.md`). The
migration is **additive** (a new `motd` table + a `permission_audit` CHECK relax) — harmless to
leave in place on rollback (no `motd` rows show a banner unless one is enabled; the two new audit
actions are simply unused). Disabling the feature at runtime needs no deploy: an admin `Clear`
(or an expired window) removes the banner immediately.
