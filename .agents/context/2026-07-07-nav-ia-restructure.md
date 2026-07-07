# Nav IA restructure — universal top row + role-gated user menu (2026-07-07)

Owner-directed (verbatim intent 2026-07-07): My Plex is user settings → the dropdown;
Ledger → the dropdown, role-gated, admin-only by default; Trash rules + settings are real
settings → a settings page under the dropdown. Keeps the top row consistent for all roles
while admins get more dropdown items; frees top-row space for larger touch targets on mobile.
This completes the 2026-07-05 UX-backlog item #1 direction (settings-only dropdown) in its
final form. Normative record: **ADR-032** + **DESIGN-004 D-16** (recorded as a dated design
note per the owner's call — no new plan doc).

## What shipped (branch `feat/nav-ia-restructure`)

- **Top row (universal):** Home · Library · Trash · Bulletin — same candidate set for every
  role; `disabled` still hides; routes stay server-gated. Ledger + My Plex left the row.
  Phone sizing scales UP now (13px labels / ≥44px targets at 375/390; the old six-link row
  forced 12px/5px). Wordmark still yields to the mark <600px.
- **User menu:** header → My Plex (everyone) → sep → Ledger (ledger ≠ disabled) · Trash
  settings (trash = edit) · Admin settings (admin) → sep → Sign out. Overlay popover
  (ADR-015-sanctioned).
- **Ledger default flip:** `SECTION_DEFAULT_LEVELS.ledger` read_only → disabled (amends
  ADR-021 C-01). CODE default only — no migration; the LIVE Default role's stored row (if
  any) is a one-click /admin/roles change, documented in the PR body (owner-managed grants,
  deliberately NOT a data migration).
- **/settings/trash:** the Rules tab + the Batches settings card moved verbatim (testids,
  wire calls, ADR-014 ceremony unchanged); server gate = trash section EDIT (admins
  implicitly). /trash keeps Movies · TV · Batches · Recently Deleted · Activity.
- e2e updated across specs + new journeys; full gate + full Playwright suite green.

## Watch-outs for later tasks

- A trash-READ-ONLY role no longer gets the read-only rules view (`/trash?tab=rules` is
  gone; the settings page gates at Edit) — ADR-032 C-05 accepted this.
- The sibling Movies/TV re-skin task must keep the five-tab /trash shell (`TRASH_TABS` in
  `trash-client.tsx`) — Rules is not a tab anymore.
- `capture-nav-ia.ts` (e2e/support) is the screenshot harness for this IA.
