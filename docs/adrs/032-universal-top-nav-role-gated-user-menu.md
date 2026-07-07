# ADR-032: Universal top nav + role-gated user menu (My Plex, Ledger, Trash settings)

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Tom Haynes (owner-directed IA, 2026-07-07) · ratified by Fable 5

## Context and problem statement

The topbar's primary nav had grown to six links (Home · Library · Ledger · Trash · Bulletin ·
My Plex), three of them role-gated — so different roles saw different rows, and at phone widths
(390px) the six-link row forced 12px labels and 5px link padding to fit at all (the ≤479px
squeeze DESIGN-004 D-08 documents). Two of the links are not really *sections*:

- **My Plex** is the user's own Plex library management — personal settings, not a shared
  section (there is no section permission for it; everyone has it).
- **Ledger** is operator tooling (the whole-ledger spreadsheet, exports, bulk Add-&-search)
  that in practice only the admin uses; the `read_only` default (ADR-021 C-01 / Q-03) put it
  in every member's top row anyway.

Separately, the Trash section carried two surfaces that are *settings*, not user-facing
deletion surfaces: the **Rules** tab (Maintainerr rule arm/disarm/delete) and the **Trash
settings** card (skip-gate + default save window) at the bottom of the Batches tab. Owner
direction (2026-07-07): keep the top row consistent for all roles, move the personal/tooling
items into the username dropdown (role-gated, admin-only by default), and re-home the Trash
settings surfaces onto a real settings page — freeing top-row space for larger touch targets
on mobile.

## Decision drivers

1. **A consistent top row across roles** — members and admins see the same section rail;
   admins get *more dropdown items*, not a wider row.
2. **Mobile breathing room** — fewer top-level items ⇒ larger type + touch targets at 390px
   (the wordmark-hides-under-600px fix stays).
3. **Settings live behind the identity, not in the section** — My Plex is personal; Ledger and
   Trash settings are tooling; the avatar menu is the natural place for both groups.
4. **Reuse the existing permission primitives** — section levels (ADR-021) and the implicit
   admin rule; no new tables, enums, or grant kinds.
5. ADR-015 stays intact: the menu is an overlay popover (sanctioned — opening it never
   reflows the page).

## Considered options

1. **Universal top row + role-gated user menu** (chosen).
2. Keep the six-link row and shrink type further on phones — rejected: 390px was already at
   12px/5px and another item would break it; the row also stayed inconsistent across roles.
3. A hamburger/drawer nav on mobile — rejected: two nav paradigms to maintain, and the owner
   explicitly wants the dropdown to carry the role-gated tooling on desktop too.
4. `/admin/trash-settings` for the relocated Trash settings — rejected: the `/admin/*` layout
   requires `is_admin`, but rule management is granted by **trash section Edit** (+
   `edit_rules`), which a non-admin role can hold; `/settings/trash` keeps that reachable.

## Decision outcome

Chosen option: **universal top row + role-gated user menu**, with the Ledger default flipped
to `disabled` and the Trash settings surfaces re-homed to `/settings/trash`.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **The top row is the universal section rail: Home · Library · Trash · Bulletin** — the same candidate set for every role. A section at `disabled` still hides its entry (and its route stays server-gated), but no role sees an item another role's row lacks *by kind*. Ledger and My Plex leave the row. With at most four links, the row's type/padding scale UP at phone widths (13–14px labels, ≥44px targets) instead of down. |
| C-02 | **The user menu (avatar popover) becomes the structured personal/tooling menu**: identity header, then **My Plex** (`/library/plex` — everyone; it is personal), then a separator-delimited tooling group — **Ledger** (`/ledger`, only when the session's ledger level ≠ `disabled`), **Trash settings** (`/settings/trash`, only at trash level `edit`), **Admin settings** (`/admin`, admin only) — then **Sign out**. The popover is an overlay (ADR-015-sanctioned); every destination remains server-gated — menu hiding is courtesy, not enforcement. |
| C-03 | **The Ledger no-row default flips `read_only` → `disabled`** (`SECTION_DEFAULT_LEVELS.ledger`; amends ADR-021 C-01 / Q-03). Members see no Ledger anywhere out of the box; a role row (`read_only`/`edit`) opts a role back in via the existing `/admin/roles` select; admins imply `edit` (ADR-021 C-03) and always see it. This is a **code default** (the no-row fallback) — no SQL default exists, so **no migration**; a live role holding a stored `ledger` row keeps its stored level (the live Default role is owner-managed — flipping it, if it has a stored `read_only` row, is a one-click `/admin/roles` change, deliberately NOT a data migration). |
| C-04 | **Trash settings re-home to `/settings/trash`**: the Rules tab (arm/disarm/delete — DESIGN-010 D-09 scope) and the Batches tab's settings card (skip-gate + default save window — ADR-025 C-06/C-07) move there verbatim (same controls, testids, wire calls, ADR-014 ceremony). The page is server-gated at **trash section `edit`** (admins implicitly); `trash.settings.*` stays `adminProcedure`, so the pipeline card renders for admins only. `/trash` keeps Movies · TV · Batches · Recently Deleted · Activity. |
| C-05 | Bad: a role at trash `read_only` with the (moot) `edit_rules` grant loses the *read-only view* of the rules list it used to get on `/trash?tab=rules` — the settings page gates at Edit. Accepted: viewing rules is operator context, not a member surface, and the grant never worked below Edit anyway (ADR-023 C-03). |
| C-06 | Bad: existing deep links to `/trash?tab=rules` fall back to the Movies tab (the tab key no longer resolves). Accepted: tab params are not durable URLs; the settings page is one menu click away. |

## More information

- Supersedes **in part**: ADR-021 C-01 (the `ledger` no-row default only — the model,
  single-writer, session hydration, and `sectionProcedure` gate are untouched); ADR-021
  carries an "Amended by ADR-032" status link.
- Amends the shipped nav/menu IA of DESIGN-004 D-08 (Primary nav, User menu) — DESIGN-004
  **D-16** carries the new normative IA + the `/settings/trash` page; DESIGN-009 D-01 (Ledger
  nav entry), DESIGN-010 D-09 (Rules tab), and DESIGN-011 D-07 (settings card) carry pointer
  notes.
- PRD-001: AC-13's "nav entry" now means the user-menu entry; R-43 (Library for every user)
  unchanged.
- Related: ADR-012 (roles), ADR-021 (section levels), ADR-023 (trash actions), ADR-025
  (curation pipeline settings), ADR-015 (no reorientation — the popover overlay is the
  sanctioned pattern).
