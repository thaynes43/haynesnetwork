# ADR-052: Server-side per-user library preferences (last view + last sort), URL-override precedence

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Tom Haynes (owner ruling 2026-07-11 — PLAN-029 **R1** persistence SERVER-SIDE per user; **R6**
  remember last-used sort per user) · ratified by Fable 5 (PLAN-029 design phase)
- **Relates:** persists the view/sort choices defined by **ADR-051** (the registry model) and rides the
  [DESIGN-004](../designs/004-ui-shell-and-dashboard.md) **D-19** URL/history contract (the URL is the shareable
  override; the store is the personal default). Uses the [ADR-003](003-database-and-orm.md) Postgres/Drizzle
  stack; written through a `@hnet/domain` single-writer (CLAUDE.md rule 6 pattern — though this is descriptive
  UI-state, not an audited mutation, see C-04). Coordinated with **ADR-053** (both introduce the first per-user
  tables — the recon flagged "design them together"). Realized by **DESIGN-026** (D-06). Implements PRD **R-169**;
  glossary **T-153**.

## Context and problem statement

PLAN-029 makes a Library wall's presentation a real choice: which **view** (flat / grouped / hierarchy), which
**sort** (+ direction), and — for grouped walls — which **group-by dimension**. The owner ruled (R1) that these
choices **persist per user, server-side**, so the owner's phone and laptop agree and a chosen view survives a
reload; and (R6) that the **last-used sort is remembered per user** with a sensible per-kind default the first
time. Two facts frame the decision:

1. **No per-user store exists at all** — live-verified this session (no prefs/state/settings table in the
   schema). R1 is a genuinely new table, not an extension.
2. **The URL is already authoritative for shareable state** (D-09/D-19): a Library URL carries `?tab`, filters,
   and sort so a link reproduces a view. R1's "URL overrides for shared links" means the stored preference is the
   PERSONAL DEFAULT, and an explicit URL param WINS (so a shared link shows what the sharer meant, not the
   recipient's saved preference).

The question: **where do per-user view/sort preferences live, and how do they interact with the URL?**

## Decision drivers

- **Owner ruling is normative** — SERVER-SIDE, per user (R1); remember last sort (R6). Not localStorage, not a
  cookie.
- **Cross-device** — the value of server-side over localStorage is exactly that the same account gets the same
  default on any device (the owner's stated reason).
- **The URL stays the shareable source of truth** — a preference must never override an explicit link, or shared
  links silently break (D-19 already makes the URL reproduce a view; the store must defer to it).
- **Economical** — one small table + one tiny tRPC read/write pair, not a settings framework. This is
  descriptive UI state, not a domain mutation needing an audit trail.

## Considered options

1. **`localStorage` / cookie (client-only).** Rejected by R1 (owner wants SERVER-SIDE): localStorage does not
   cross devices, a cookie bloats every request, and neither is queryable server-side. The owner explicitly did
   not want this.
2. **URL-only (no store) — every choice lives in the URL.** Rejected: the URL is transient (a fresh visit to
   `/library` with no params must fall back to SOMETHING), and R1/R6 explicitly want a remembered personal
   default. URL-only cannot "remember my last sort."
3. **A dedicated per-user preferences table, read on load, written on change, with URL params taking
   precedence** (chosen). A `library_preferences` row per `(user, wall)` carrying the last view, group-by, sort
   field + direction. Read when a wall loads with no explicit URL override; written (upsert) when the user
   changes a view/sort. An explicit URL param always wins over the stored value (shareable links intact).
4. **Overload the existing generic `app_settings` key/value store (T-80).** Rejected: `app_settings` is a
   GLOBAL admin-scoped store (MOTD, space targets, notify window) — it has no per-user dimension and mixing
   per-user rows into it would corrupt that model. Per-user prefs want their own keyed table.

## Decision outcome

Chosen option **3**: a **dedicated per-user `library_preferences` table**, read on wall load, written on change,
with **explicit URL params taking precedence** over the stored default.

- **The store** (DESIGN-026 D-06). A per-user, per-wall preferences table keyed by `(user_id, wall)` (`wall` ∈
  the Library kind tabs — movies, tv, music, peloton, youtube, books, audiobooks, comics), carrying the last
  `view`, `group_by` (nullable — only grouped views have one), `sort_field`, `sort_dir`. Upsert-on-write, cascade
  on user delete. Small, bounded (≤ one row per user per wall).
- **The precedence** (D-06/D-10). On a wall load: if the URL carries an explicit `view`/`group`/`sort` param, it
  WINS (shared-link fidelity, R1) and is NOT written back (a shared link must not overwrite the recipient's saved
  default); if the URL is bare, the stored preference fills it, falling back to the ADR-051 R2/R6 default when no
  row exists. A user CHANGING a view/sort writes the new value AND updates the URL (a `router.push`/`replace`
  per D-19) — so their own navigation both persists and stays shareable.
- **The surface.** A `library.preferences.get`/`set` (or equivalent) tRPC pair, session-gated (a user reads and
  writes only their own row — no admin surface, no cross-user read). No audit rows (C-04).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: cross-device — the same account gets the same default view/sort on any device (the owner's stated R1 reason), which localStorage/cookie cannot deliver. |
| C-02 | Good: shared links keep working — an explicit URL param always beats the stored default and is never written back, so a link shows the sharer's intent, not the recipient's saved preference (R1 "URL overrides for shared links"). |
| C-03 | Cost: a new per-user table (migration next-free at build) + a tiny tRPC read/write pair. Guard-listed as a state write, single-writer-confined for consistency, even though it is descriptive not audited. |
| C-04 | Neutral: NO audit rows — this is descriptive UI state (like a sort choice), not a role/permission/ledger mutation. CLAUDE.md rule 6 (audit-in-same-tx) applies to domain mutations; a per-user sort preference is not one. The single-writer discipline is kept for the guard; the audit aggregate is not. |
| C-05 | Good: coordinated with ADR-053's mapping table (both are new per-user tables) — designed together in DESIGN-026 D-06/D-07 so the two per-user surfaces share conventions and neither is a settings framework. |

## More information

- Realized by **DESIGN-026 D-06** (schema + tRPC + the URL-precedence resolution).
- Numbering: **ADR-052**; the table migration takes the next-free number at build (see ADR-051 More-information
  numbering note — PLAN-034 claimed 0040; the plan tracks the actual number).
- The exact table/column names are prescriptive (DESIGN-026 D-06) and may be refined in the build's UX pass —
  the DECISION (server-side, per-user, URL-precedent) is fixed here.
