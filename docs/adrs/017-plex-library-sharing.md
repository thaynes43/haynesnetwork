# ADR-017: Plex library sharing & the role-library-grant model

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (autonomous run, KICKOFF mandate)
- **Amended by:** [ADR-024](024-role-scoped-all-libraries.md) (2026-07-06) — adds a role-scoped
  *all-libraries-on-server* grant and self-service toggle between the plex.tv all-libraries state
  and an explicit list. This **supersedes C-14's stance** (which accepted that a self-service edit
  silently demotes an all-libraries account): no silent demotion ever — a per-library add/remove
  against an all-libraries account is refused (`PLEX_ALL_STATE`) and the user leaves All explicitly.
- **Amended by:** [ADR-029](029-plex-server-owner-recognition.md) (2026-07-07) — **amends C-06's
  friend-only user→account map**: the server OWNER is never in their own friend list, so
  `plex.myLibraries` recognizes the owner (via plex.tv `GET /api/v2/user`) and returns an owner
  state instead of the "not a friend" error (closes Q-06 for the owner case).

## Context and problem statement

Phase 3 (PRD-001 R-25..R-28) lets a user self-add/remove Plex libraries on **their own** Plex
account across the three servers of record (OPS-002): `haynestower` (legacy Unraid,
`plex.haynesnetwork.com`), `haynesops` (`plexops.haynesnetwork.com`), `hayneskube`
(`k8plex.haynesnetwork.com`) — limited to the libraries their **Role** allows. Admins assign,
per Role, which libraries that role may access. DDD-002 **BC-04 (Plex Sharing)** is the
enforcement arm: it decides nothing, it applies what BC-02 (Entitlements) allows.

Two upstream facts constrain the design: ADR-012 collapsed all permissioning into a single
admin-managed **Role** per user (no per-user or per-tag grants; the `users.is_family` flag was
dropped), and OPS-002 established that library **names differ across servers** (HAYNESOPS
mirrors HAYNESTOWER's Movies/TV under different names), so library identity must be
`(server, section_key)`, never name (resolves PRD Q-03).

The hard unknown was the Plex sharing API itself: which endpoints apply a per-user library
share, how a haynesnetwork user maps to a Plex account, and what a mutation must preserve.
These were verified **live** against the real servers on 2026-07-06 (GET-only; no writes).

## Decision drivers

- One-role-per-user model (ADR-012 C-08/C-09/C-12) — no per-user/per-tag grants.
- Library identity survives cross-server name collisions (OPS-002; Q-03).
- Family-library gating must attach to a role, not a resurrected `is_family` flag (C-09).
- BC-04 is enforcement, never decision (DDD-002): the role gate runs before any Plex call.
- Owner tokens are secrets — never in git, never echoed (CLAUDE.md rule 7).
- The mutating Plex surface must be import-confined like `@hnet/arr/write` (ADR-011).
- haynestower already has ~40 real user shares (160 sections) — a mistake here revokes real
  family/friends' access, so mutations must be non-destructive by construction.

## Considered options

1. **Positive role→library allow-list (`role_library_grants`), family as ordinary grants,
   read-merge-write against the plex.tv v1 sharing API.** (Chosen.)
2. **Per-user / per-tag library grants** (the DESIGN-001 Appendix A sketch:
   `user_library_grants` + `tag_library_grants`). Rejected: ADR-012 abolished per-user and
   per-tag permissioning; a user has exactly one Role.
3. **A `plex_libraries.is_family_only` deny flag** (Appendix A). Rejected: reintroduces
   attribute-based gating outside the Role model; the two family libraries are simply libraries
   only the `Family` role is granted (C-09/C-12). No flag column.
4. **The plex.tv v2 API** (`/api/v2/shared_servers`). Rejected: returned **HTTP 405** live
   2026-07-06; the working surface is the v1 XML "friend" model (python-plexapi shape).
5. **Blind per-user overwrite of the shared section set.** Rejected: would revoke every other
   library a user already has — see the read-merge-write invariant below.

## Decision outcome

Chosen option: **1** — a positive `role_library_grants` allow-list (exact mirror of
`role_app_grants`), family libraries as ordinary rows granted only to the seeded `Family` role,
and a read-merge-write share client over the plex.tv **v1** sharing API. The rulings:

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: **Positive allow-list.** `role_library_grants(role_id, plex_library_id)` mirrors `role_app_grants`; a user may self-add exactly the libraries their role grants. Settles the Appendix A "grants may become deny rows" question in favor of positive grants. |
| C-02 | Good: **Family = a role grant, not a flag.** The two HAYNESTOWER family libraries (`HNet Home Videos`, `HNet Photos`) are ordinary `plex_libraries` rows granted only to the `Family` role. No `is_family_only` column (supersedes the Appendix A sketch). Discharges ADR-012 C-09/C-12. |
| C-03 | Good: **`is_admin` short-circuits to ALL libraries; `grants_all` does NOT.** Only the Admin role sees every library implicitly (mirrors effectiveAppsForUser's `is_admin` branch) — but, unlike apps, a non-admin `grants_all` role still needs explicit library grants. "All apps" never means "all libraries." |
| C-04 | Good: **Library identity is `(server_id, section_key)`, never name** (Q-03 resolved). Two servers mirroring a `Movies` library under different names stay distinct rows; `section_key` is the per-server Plex section key. |
| C-05 | Good: **Sharing API = plex.tv v1, XML.** `GET/POST https://plex.tv/api/servers/{machineIdentifier}/shared_servers` + `PUT/DELETE .../{sharedServerId}`; the section-id map comes from `GET /api/servers/{machineIdentifier}`; the user→account map from `GET /api/users` (friend list). All XML, verified live 2026-07-06. v2 returned 405. |
| C-06 | Good: **User→Plex-account mapping is email match, case-insensitive** (OIDC email vs the friend list's `email`). **Precondition:** the user must ALREADY be a Plex friend of the server owner — no match throws `PlexAccountUnmatchedError` (→ UNPROCESSABLE_CONTENT). There is **no invite/friend-creation flow** (out of scope — Q-06). |
| C-07 | Good (safety-critical): **Read-merge-write is mandatory.** Every mutation reads the target user's CURRENT `SharedServer` and PUTs `current ∪ {section}` (add) / `current ∖ {section}` (remove) — POST a new SharedServer when none exists, DELETE when the set empties. A blind overwrite would revoke the other libraries a user holds; haynestower has ~40 real shares. The write client's `library_section_ids` carry plex.tv section ids (from `/api/servers/{machineId}`), not server section keys. |
| C-08 | Good: **Share application is enforcement, never decision** (BC-04). The share single-writers re-derive the fresh role-allowed set INSIDE the operation (TOCTOU guard, mirroring `executeRestore`) and throw `LibraryNotAllowedError` (→ FORBIDDEN) BEFORE any Plex write. Un-sharing is always permitted (revoking access is the safe direction). |
| C-09 | Good: **Owner tokens are references, never values.** `plex_servers.token_ref` stores the env var name (`PLEX_<SLUG>_TOKEN`); the write client reads the actual `X-Plex-Token` from `process.env` at call time and sends it header-only (never in URLs/errors — copies the assertArrEnv discipline). Cluster source: 1Password `HaynesKube` → `homepage` item fields (DESIGN-007 D-11). |
| C-10 | Good: **`@hnet/plex/write` is import-confined** to `packages/domain` + `packages/plex`, extending the ADR-011 `@hnet/arr/write` guard test. Registry + grant + share-audit tables join the `no-direct-state-writes` guard. |
| C-11 | Good: **All three servers are in scope for writes**, including haynestower (its PMS 1.43.2.10687 speaks the same v1 API — verified). Family self-service therefore works day one. |
| C-12 | Good: **Audited.** Role-library-grant edits write a `permission_audit` row (`update_role_libraries` action) in the same tx as the mutation. Applied user shares write `plex_share_audit` rows (BC-04 owns its own audit, like the BC-03 media aggregates) — single-shot, after the Plex apply succeeds, with the preserved section set in the detail. |
| C-13 | Bad/risk: **Live shares are real user access.** A bad share/unshare against production is not auto-undone by a code revert — it is corrected via the same un-share/share path or the owner token (noted in the runbook). Live write validation is deferred to a designated owner test-user (Q-06 open). |
| C-14 | Bad: **allLibraries users get frozen to an explicit set.** A user currently shared with `allLibraries=1` who self-adds/removes via the app is converted to an explicit `library_section_ids` list (their current sections ∪/∖ the target). They keep their access, but a future new library no longer auto-appears for them until re-shared. Acceptable for the self-service model. |
| C-15 | Bad: **Registry refresh is admin-button-only** (no CronJob) for now — libraries can be stale until an admin refreshes. A soft-state `available` flag (never a hard delete) keeps grants/audit intact across a vanished library. A refresh CronJob is future work (Q-06). |

## More information

- PRD-001 R-25..R-28 (reworded to the role model); PRD Q-03 resolved.
- DESIGN-007 — the full schema, XML client ACL, share/unshare/refresh sequences, env/ops.
- OPS-002 — the Plex/Tautulli topology of record (slugs, tokens, machine identifiers).
- ADR-011 (`@hnet/arr/write` confinement — extended here), ADR-012 (unified Role model:
  C-08/C-09/C-11/C-12), ADR-013 (`base_url` server-side exemption), ADR-014 (ConfirmButton),
  ADR-015 (no layout reorientation).
- DDD-002 BC-04 (promoted intent → owned by this ADR + DESIGN-007).
- Live verification 2026-07-06: `/library/sections` types `movie|show|artist|photo` (no
  `homevideo`); `/api/users`, `/api/servers/{mid}`, `/api/servers/{mid}/shared_servers` XML
  shapes; v2 405; machine identifiers all PMS 1.43.2.10687.
