# UX backlog — planned 2026-07-05 (NOT started; deferred until confirm/reorder work is tested)

Owner-requested UX improvements to implement AFTER the ConfirmButton anti-shift/color fix +
Catalog drag-and-drop land and are tested. Golden rule in force: page contents must not
re-orient on interaction (expansions + drag-drop reordering excepted).

## 1. Username dropdown → boring settings only

Today the user-menu dropdown is a grab-bag: identity header, **Library**, **My fixes**,
**Admin**, **Sign out**. Users expect this menu to be low-traffic *settings*, not primary
functionality. New contents:

- identity header (name + email) — keep.
- **User settings** — NOT built yet (was told to the initial agent; add later). **Omit
  entirely for now — no "coming soon" placeholder** (owner decision 2026-07-05).
- **Admin settings** — the existing `/admin` console link, reframed as "Admin settings"
  (admins only).
- **Sign out**.

Remove **Library** and **My fixes** from the dropdown (they move into the top nav / Library
sub-tabs below). Primary nav (Home / Library) already lives in the top bar.

## 2. Library sub-tabs (replace the filter pills; narrow the search)

Library currently has filter *pills* `All | TV | Movies | Music`. Convert to **sub-tabs** like
demo-console / the Admin console section tabs:

- Tabs: **Movies | TV | Music | My Fixes** — **no "All" tab** (owner decision 2026-07-05).
  Default to the first tab (**Movies**). Selecting a media tab **scopes the search/results to
  just that category** so the list is less overwhelming (the point of the change).
- **My Fixes** becomes a Library sub-tab (moved out of the username dropdown) — the user's own
  fix ledger.

Reference: demo-console "Order Builder" / "Replenishment Builder (inventory selection)" sub-tab
pattern; and haynesnetwork's own Admin console section tabs.

## Resolved (owner, 2026-07-05)
- No "All" tab; Library defaults to the Movies tab.
- No "coming soon" placeholder; User Settings simply absent until built.

## Open (minor, resolve at implement time)
- My Fixes tab visibility for users with no fixes (likely always shown, empty state).
