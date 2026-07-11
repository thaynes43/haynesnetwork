# PLAN-027: Roles-grid clarity — stop rendering no-op permission levels

- **Status:** DISPATCHED + BUILT (2026-07-11) — ADR-049 / DESIGN-004 D-17 + DESIGN-012 D-09 / R-159 /
  T-143..T-144, migration 0039. Branch `feat/roles-grid-bulletin-views`. Moves to `completed/` in the
  bookkeeping PR once live-validated.
- **Problem (owner hit this three times in one day):** `/admin/roles` renders the shared
  Edit/Read-only/Disabled dropdown for every section, but for several sections "Edit" grants
  nothing, and the owner had to ask what each column actually does:
  - **Bulletin** — section level gates READ only; writing is entirely the `post`/`moderate`
    message-action grants (ADR-026 C-04). Edit ≡ Read-only.
  - **Library extras (ytdlsub)** — read-only surface by design (ADR-038); every route gates on
    `!= disabled`. Edit ≡ Read-only (until a write surface like poster overrides exists).
  - **Metrics** — levels are full|limited (separate dropdown); the section dropdown's Edit grants
    nothing (capacity edit is admin-gated separately, DESIGN-016 D-08).
- **Options to review with the owner:**
  1. Per-section level menus: each section declares which levels it distinguishes; the grid only
     offers those (e.g. Bulletin: Read-only/Disabled). Cleanest; needs a section-capability map.
  2. Keep all options but annotate no-ops inline ("Edit (same as Read-only here)") — zero risk.
  3. Tooltip/help column explaining each section's semantics (what Edit / the action chips do).
- **Also fold in:** the owner may later want Edit on Library extras (PLAN-025 gives it meaning —
  channel add/remove); design so a section can GAIN a distinguished Edit without a grid change.
- **Scope guess:** small UI + a static capability map; no schema change; one point-fix release.

## Owner decisions (2026-07-11) — DISPATCHED, scope expanded

Chose **Option 1 (per-section capability map)** + added **Bulletin sub-section visibility grants**:

1. **Dropdown cleanup:** each section declares what it distinguishes. Sections with NO edit
   semantics render a 2-state **"Enabled / Disabled"** dropdown (derive from the gating code —
   Bulletin, Metrics [level is a separate full|limited control], ytdlsub, Books, and Trash if its
   section level doesn't distinguish edit vs read-only — VERIFY per section). **Ledger** keeps
   **Edit / Read-Only / Disabled** (it genuinely distinguishes: edit = bulk monitor-and-search,
   read-only = browse). Don't offer a level a section can't act on.
2. **Bulletin sub-section visibility (NEW grant):** Bulletin has two views — **Feed** and
   **Messages** — separately grantable per role via **checkboxes** under the Bulletin
   Enabled/Disabled dropdown. The checkboxes are DISABLED (greyed) when Bulletin is Disabled.
   - **Default role → Messages only, NOT Feed** (owner: Feed shows cool info Family/Friends will
     like; keep it off Default). **Family/Friends → both.** Admin → both implicitly.
   - Model: a sub-part visibility grant set (mirror the message-action `post`/`moderate` grant
     pattern — a row per granted view: `feed`, `messages`). **ENFORCE SERVER-SIDE**: a role
     without `feed` gets 403/empty from the feed endpoints (communication.ts `feed` procedure) —
     NOT UI-only hiding. The Bulletin nav/tab shows only the granted views; if only Messages is
     granted, the Feed tab is absent.
   - Message actions (`post`/`moderate`) stay as-is, scoped to the Messages view.
3. **Design for extensibility:** the capability map + sub-part-grant pattern should let other
   multi-view sections (or a future Library-extras Edit per PLAN-025) slot in without a grid rewrite.

## Related finding (SEPARATE item, not this train) — Feed attribution
Feed "Who" shows **unattributed** for ~31/33 rows: external webhooks (Maintainerr/Seerr/Tautulli)
name a user in their payload (Seerr requester, Tautulli watcher, Plex username) but the ingestion
doesn't map that → `actor_user_id` stays NULL → "unattributed". Improve: parse the payload user
and either map to an app user or DISPLAY the external username (e.g. "Requested by <plex user>").
Own small plan — makes the Feed more valuable (the point of showing it to Family/Friends).
