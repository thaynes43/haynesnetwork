# ADR-049: Bulletin sub-view visibility grants + the roles-grid section capability map

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Tom Haynes

## Context and problem statement

Two related roles-permission gaps surfaced (PLAN-027, owner-approved 2026-07-11):

1. **Dead dropdown options.** `/admin/roles` renders the same **Edit / Read-only / Disabled**
   select for **every** section, but for most sections "Edit" grants nothing — the owner asked
   "what does Edit do here?" three times in one day. Only **Ledger** (Edit = bulk
   monitor-and-search) and **Trash** (Edit = Maintainerr rule editing + the Trash settings page)
   have a distinct `edit` rung in the gating code; **Bulletin / Metrics / ytdl-sub / Books** only
   ever gate on `read_only` (their `edit` rung is a no-op — Metrics has a *separate* full|limited
   control; the others are read-only surfaces by design).

2. **Bulletin is all-or-nothing.** The Bulletin section (ADR-026) has two views — the aggregated
   third-party **Feed** and the user **Messages** board — but a role can only toggle the whole
   section. The owner wants the **Feed** (Seerr/Tautulli/Maintainerr ops chatter, Family/Friends
   flavour) OFF for the **Default** role while keeping **Messages** on, and BOTH on for Family +
   Friends. This must be a real server-side gate, not a client-only hide.

## Decision drivers

- The owner decides *what each control does at a glance*; the grid must not offer no-op choices.
- Server-authoritative access (AC-13): hiding a view in the UI is not enough — the endpoint must
  FORBID it. Reuse the established single-writer + same-tx audit pattern (hard rule 6).
- Extensibility: a section that later gains a real Edit (e.g. ytdl-sub per PLAN-025), or another
  multi-view section, should slot in without a grid rewrite.
- Do not silently strip anyone's Bulletin on deploy ("Bulletin is for everyone", ADR-026 C-02).

## Considered options

- **A — Per-section capability map + a new sub-view grant table** (mirror the message-action grant
  pattern in shape; resolution defaults ON). *Chosen.*
- **B — Annotate the no-op options inline** ("Edit (same as Read-only here)"). Zero-risk but keeps
  the clutter; doesn't address the Bulletin split.
- **C — A per-section boolean column on `roles`** for Feed/Messages. Rejected: diverges from the
  row-per-grant pattern every other fine-grained grant uses (trash/message actions), and can't
  express "unconfigured ⇒ default".

## Decision outcome

Chosen option: **A** — a per-section **capability map** drives the grid, and a new
**`role_bulletin_view_grants`** table (a clone of `role_message_action_grants` in shape) carries the
Feed/Messages sub-view visibility, enforced server-side.

- **Capability map (UI presentation).** A single source of truth (`apps/web/lib/role-sections.ts`)
  declares, per section, whether it renders a 3-state **Edit / Read-only / Disabled** control
  (`ledger`, `trash` — they distinguish a real `edit` rung) or a 2-state **Enabled / Disabled**
  control (`bulletin`, `metrics`, `ytdlsub`, `books` — no meaningful edit). The **stored**
  `SECTION_PERMISSION_LEVELS` enum + DB values are UNCHANGED: "Enabled" persists `read_only`,
  "Disabled" persists `disabled`. A section that later gains a real Edit just flips its map entry
  to `'tri'` — no grid rewrite. The map is DERIVED from the gating code (which procedures pass
  `minLevel: 'edit'`), documented inline, not guessed.

- **Bulletin sub-view grants (behaviour).** `role_bulletin_view_grants` is one row per granted view
  (`feed`, `messages`); written only by the `@hnet/domain` `setRoleBulletinViews` single-writer,
  which co-writes an `update_bulletin_views` permission_audit row in the same tx. The
  `communication.feed` endpoint gates on the `feed` grant and `communication.messages.*` on the
  `messages` grant (`bulletinViewProcedure`, composed on top of the coarse `bulletin` section gate);
  the Bulletin nav renders only granted sub-tabs. Admin implies both (no rows).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the grid offers only levels a section can act on — Bulletin/Metrics/ytdl-sub/Books become a plain **Enabled/Disabled** toggle; Ledger + Trash keep **Edit/Read-only/Disabled** (both have a verified `edit` rung). Driven by a documented capability map, so a future real Edit is a one-line flip. |
| C-02 | Good: Bulletin Feed vs Messages is separately grantable and **server-enforced** — a role without the `feed` grant gets FORBIDDEN from the feed endpoint (not a UI-only hide) and sees no Feed tab. **Resolution is default-ON**: a role with NO view rows resolves to BOTH views (the section-default pattern, since these gate VISIBILITY of a section that ships visible — unlike message-actions which default OFF). Present rows are the exact narrowing allowlist; the Admin role implies both. This means only the **Default** role needs a narrowing row (seeded to `messages`-only by migration 0039); Family/Friends/custom keep both with no backfill, so no one else silently loses the Feed. |
| C-03 | Good: reuses the proven grant machinery — `role_bulletin_view_grants` is guard-listed (writes only through `@hnet/domain`), the writer audits in-tx (hard rule 6), the session carries the resolved views so the gate needs no per-request query. |
| C-04 | Neutral: the sub-view resolution deliberately DIVERGES from `role_message_action_grants` (which treats absence as deny). Documented in both the enum and the schema so future readers don't "fix" it into a deny-by-default. Clearing all views (writing `[]`) RE-OPENS both (the default) — to hide Bulletin entirely, set the section level to Disabled. |
| C-05 | Bad: one more permission table + audit action to maintain; the roles-grid Bulletin cell grows a pair of checkboxes (kept reflow-free per ADR-015 — greyed, never removed, when Bulletin is Disabled). |

## More information

- PRD **R-159**; PLAN-027; glossary **T-143** (Bulletin View Grant), **T-144** (Section Capability
  Map).
- Builds on **ADR-026 / DESIGN-012** (Bulletin section + message-action grants), **ADR-021**
  (section-level permissions), **ADR-023** (`role_trash_action_grants` — the grant-table donor
  pattern). Roles-grid UX amends **DESIGN-004 D-18** (the D-11 `/admin/roles` grid); the sub-view model amends
  **DESIGN-012** (D-04/D-08).
- Migration **0039** creates the table, extends the permission_audit CHECK, and seeds the Default
  role's `messages`-only row.
