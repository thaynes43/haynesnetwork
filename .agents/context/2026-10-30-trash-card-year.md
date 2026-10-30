# 2026-10-30 — Trash card facts and watchlist visibility

Canonical work: OpenProject **#300**, Epic **#293**. Tom's screenshot shows the year
being ellipsized with the title; hover cannot solve the phone case. His follow-up
confirmed hiding watchlisted titles by default with a Show protected option.

## Plan and boundaries

1. Amend DESIGN-052 D-10 before code; retain the existing shared-card family.
2. Render fixed Size · Year · Rating facts and compact poster status icons; preserve
   title detail, action errors, corner actions, protections and fixed geometry.
3. Filter known watchlisted candidates before server pagination, wire the view
   preference to both candidate walls, and preserve full-set deletion previews.
4. Verify long titles and all statuses at desktop and 390/360/320px touch widths,
   and verify filtered pagination/counts against embedded PostgreSQL 16.
5. Independent review, required CI, PR merge and a truthful delivery checkpoint.

No media/download writes, policy changes, cleanup, network/security changes or
unapproved downtime. The downloads investigation #299 is independent. Proposed
35-minute implementation/delivery checkpoint; one test suite at a time, low worker
counts, no load loops. Source and runtime status will be recorded after validation.

## Verification checkpoint

- Embedded PostgreSQL 16 watchlist/guardian suite: 20 passed. The added regression
  checks visibility filtering before pagination/counts and preserves the full-set
  Expedite preview and actionable-id snapshot.
- Card/watchlist render suite: 10 passed; web typecheck and targeted ESLint passed.
- Independent native review found the old E2E navigation helper assumed a title
  hidden by the new default was visible. The helper now accepts expected visibility
  and waits for the wall; no other correctness finding was reported.
- Focused touch/browser checks initially could not launch because the pinned
  Playwright browser was absent. The matching browser was installed under the agent
  home; runtime and system packages were unchanged. Touch geometry passed at desktop,
  390, 360 and 320px, with long titles and all status icons; the 390px screenshot was
  visually reviewed. The watchlist browser case caught URL-controlled checkbox lag;
  local view state now updates immediately and synchronizes with URL navigation.
  That browser case is being rechecked before delivery.
- Deletion/protection settings and media files are unchanged. Runtime delivery is
  pending PR CI and the normal release/GitOps path.
