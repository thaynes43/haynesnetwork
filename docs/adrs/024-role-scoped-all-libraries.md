# ADR-024: Role-scoped all-libraries Plex self-service

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Tom Haynes (owner, decision of record 2026-07-06) · ratified by Fable 5
- **Amends:** [ADR-017](017-plex-library-sharing.md) (Plex library sharing) — extends the
  role-library-grant model with a per-server all-libraries grant; supersedes ADR-017 C-14.

## Context and problem statement

ADR-017 shipped per-library self-service: an admin grants a Role a set of specific Plex libraries
(`role_library_grants`), and a member self-adds/removes exactly those on their own account via the
plex.tv v1 sharing API (read-merge-write against an explicit `library_section_ids` list).

Live validation on 2026-07-06 surfaced a real account ADR-017 could not model: a plex.tv friend can
hold an **all-libraries** share (`SharedServer allLibraries="1"`) — share-everything on a server,
**including libraries added in the future**. The owner's wife (friend id `19299967`) has this on
hayneskube. Two problems followed:

1. **Silent demotion.** A per-library remove against an all-libraries account computes an explicit
   remaining-section list and PUTs it — permanently converting the future-inclusive grant into a
   frozen list, so new libraries stop auto-appearing. A per-library add was a silent no-op. ADR-017
   C-14 *accepted* this as a consequence of the user's own action.
2. **No way to grant/keep "all".** Admins had no way to say "this role gets everything on server X
   (now and later)", and users had no way to move between all-libraries and a curated list.

The owner defined richer semantics that replace the C-14 stance: admins may grant a role **all
libraries on a server**, and a user with that grant may self-manage between two states on that
server — **On All** (`allLibraries=1`) or an **explicit list** — leaving All by demoting to an
explicit list seeded with their *current full* section set (no access loss), curating it, and later
returning to All. Users **without** the all-grant behave exactly as ADR-017 shipped (explicit only).

## Decision drivers

- No silent demotion, ever (the ADR-017 C-14 defect) — state changes are explicit and user-driven.
- Leaving All must lose no access — seed the explicit list with the account's current full set.
- Reuse the ADR-017 machinery: positive grants, role gate re-derived inside each mutation (TOCTOU),
  BC-04 is enforcement not decision, `@hnet/plex/write` stays import-confined (ADR-011), audit rows
  co-written in the same transaction (hard rule 6).
- The plex.tv **write** shape for the all flag is not in python-plexapi (see Consequences C-05).

## Considered options

1. **A separate `role_plex_server_all_grants` table + a `setServerAllShare` self-toggle, with the
   effective allowed set = explicit grants ∪ all-of-all-granted-servers.** (Chosen.)
2. **A boolean column on `role_library_grants` / a magic "ALL" library row.** Rejected: an all-grant
   is server-scoped, not library-scoped; a sentinel row corrupts the clean `(server, section_key)`
   identity and the per-library matrix.
3. **Keep ADR-017 C-14 (accept silent demotion).** Rejected by the owner — it silently strips
   future-library access from real family accounts.
4. **Model "all" purely in Plex (no app grant), read-only in the app.** Rejected: the owner wants
   admins to *control* which roles get all-on-server and users to self-manage the state.

## Decision

- **New table `role_plex_server_all_grants`** (`role_id`, `plex_server_id`, composite PK, both FKs
  cascade). Presence = the role grants all libraries (incl. future) on that server. Sits *alongside*
  `role_library_grants`; a role may hold both. An `is_admin` role stores no rows and implies all on
  every server. Migration `0015` creates it and rebuilds the `plex_share_audit` event CHECK.
- **Effective allowed set** (`effectiveAllowedLibrariesForUser`) = the union of the role's explicit
  library grants and every available library on any server the role all-grants (Admin ⇒ all). A new
  sibling `allGrantedServerIdsForUser` returns the servers a user may toggle.
- **`setServerAllShare({ userId, serverId, on })`** single-writer: role-gated (all-grant required,
  re-derived inside the call — TOCTOU). `on:true` writes the plex.tv all-libraries flag for the
  friend (creating the SharedServer if absent); `on:false` demotes by PUTting an explicit list
  **seeded with the account's current full section set** (every section on the server — no loss).
  Audited in `plex_share_audit` with two new events, `share_all_enabled` / `share_all_disabled`
  (server-scoped — no `plex_library_id`).
- **`applyShare` (per-library add/remove) refuses to act while the account is all-libraries**, throwing
  the typed `PlexAllStateError` (`PLEX_ALL_STATE` → `UNPROCESSABLE_CONTENT`) **before any Plex write**;
  the message directs the user to leave All first. No silent demotion path remains.
- **`setRoleLibraries`** extended to replace-whole-set the per-server all-grants too (optional
  `allServerIds`; omitted = untouched), same `update_role_libraries` audit row (all-server before/after
  in `detail`).
- **API:** `plex.myLibraries` surfaces per server `{ id, allGranted, allActive }`; new
  `plex.setServerAll` (authed, own account); `plex.roleLibraryGrants` returns `allGrantsByRole` and a
  server `id`; `plex.setRoleLibraryGrants` accepts `allServerIds`.

## Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: **no silent demotion.** Every transition between all-libraries and an explicit list is an explicit, audited user action; leaving All seeds the current full set so no access is lost. |
| C-02 | Good: **admins control the all-grant.** A role can be granted "everything on server X (incl. future libraries)"; a member of that role self-manages the two states. |
| C-03 | Good: **back-compatible.** Users without an all-grant, and every existing `role_library_grants` row, behave exactly as ADR-017 shipped; `setRoleLibraries` callers that omit `allServerIds` are unaffected. |
| C-04 | Neutral: two new server-scoped audit events (`share_all_enabled`/`share_all_disabled`) extend the `plex_share_audit` CHECK (migration 0015); these rows carry no `plex_library_id`. |
| C-05 | Risk/verify: **the plex.tv WRITE shape for the all flag is inferred, not verified in python-plexapi.** python-plexapi (source of record) only ever writes `library_section_ids`; `allLibraries` is read-only there. Turning All **off** uses the verified explicit-list PUT; turning All **on** uses the plex.tv-web convention `shared_server.all_libraries: true` (snake_case, consistent with the other keys). This half is deferred to live write-validation by the designated owner test-user (ADR-017 C-13). |
| C-06 | Bad/risk: **live shares are real access** (ADR-017 C-13 holds). A bad toggle against production is corrected via the same toggle or the owner token, not a code revert. |
