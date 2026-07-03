# DDD-001: Ubiquitous Language

- **Status:** Accepted
- **Last updated:** 2026-07-03
- **Related:** PRD-001

<!-- The normative project glossary. Code and docs use these terms exactly (see
     CLAUDE.md / docs/PROCESS.md). Append-only in spirit: if a term changes
     meaning, add a new T-NN and mark the old row Superseded — never rewrite or
     renumber. Cite terms across docs as `DDD-001 T-NN`. -->

## How to use this glossary

- New domain terms must be added here **in the same change** that introduces them
  (CLAUDE.md). PRD-001 wins on any conflict — fix this doc, not the PRD.
- Code identifiers follow the todos-for-dues naming style: snake_case plural tables
  (`users`, `user_role_transitions`), snake_case columns, PascalCase TypeScript types,
  camelCase helpers, SCREAMING_SNAKE env vars. Identifiers for not-yet-built tables are
  prescriptive: designs use them or amend this row in the same change.
- `R-NN` / `AC-NN` / `Q-NN` references are PRD-001 IDs; `BC-NN` references are DDD-002.

## Identity & access

| ID | Term | Definition | Code identifier | Notes |
|----|------|------------|-----------------|-------|
| T-01 | User | A person known to the app. A row is auto-created as a Member on first successful Authentik login — no approval gate (R-03). | `users` | Better Auth schema + `role` column; displayName/email from OIDC claims (AC-02). |
| T-02 | Role | The single authorization level on a User. Exactly two: Member and Admin. Family is NOT a role (T-05). | `users.role` (`'member' \| 'admin'`) | Role changes write Audit Rows in the same transaction (R-04). |
| T-03 | Member | Default Role for every successful Authentik login. Sees default-visible Tiles; manages own Plex libraries within their Allowed Library Set; can raise Fix Requests. | `'member'` | PRD-001 Actors & roles. |
| T-04 | Admin | Full-control Role: catalog, users, permissions, tags, Family designation, Restore. First claimed via Bootstrap Admin (T-06). | `'admin'` | PRD-001 Actors & roles; R-02. |
| T-05 | Family | A designation (attribute) on a Member — not a third Role — granting visibility/addability of Family-Only Libraries. Set directly per user or bundled in a Tag (R-26, R-27). | `users.is_family` (direct); tag bundle flag (derived) | Provenance surfaces in Effective Permissions (T-16). |
| T-06 | Bootstrap Admin | Idempotent promotion to Admin of a first login whose email (case-insensitive) is on the allowlist; repeat logins are no-ops (R-02, AC-03). | `BOOTSTRAP_ADMIN_EMAILS` (env) | Allowlist seeded with both owner emails (Q-01). |
| T-07 | Session | The authenticated browser session established after the Authentik OIDC round-trip; 7-day cookie (AC-01). | `sessions` (Better Auth) | No password form exists anywhere (R-01). |
| T-08 | Authentik | The OIDC identity provider at `authentik.haynesnetwork.com` — the only sign-in path. Plex is offered as the credential inside Authentik (R-01). | `AUTHENTIK_*` (env) | Syncing permissions into Authentik is a follow-on (R-30). |

## Catalog & entitlements

| ID | Term | Definition | Code identifier | Notes |
|----|------|------------|-----------------|-------|
| T-09 | App (Catalog Entry) | A DB-backed catalog row for a self-hosted app: name, description, icon, URL, default-visible flag, display order (R-11). URLs must be `*.haynesnetwork.com` — never `*.haynesops.com` (R-14, enforced on catalog writes). | `apps` | Admin-editable without redeploy; seeds per R-12/R-13. |
| T-10 | Default-Visible | Catalog flag marking Apps every Member sees with no grant: Seerr, Plex, K8Plex at seed (R-12). | `apps.is_default_visible` | A fresh Member's Dashboard shows exactly these (AC-04). |
| T-11 | Tile | The Dashboard rendering of one App the viewer is permitted to open; links out to its `*.haynesnetwork.com` URL (R-10). | `Tile` (UI component) | |
| T-12 | Dashboard | The permissioned home page: the viewer's Tiles, derived from Effective Permissions. | `Dashboard` (route `/`) | Enforces (renders/hides); never decides — see DDD-002 §4. |
| T-13 | App Grant | Permission for one User to see/open one App. Direct (admin grants per user, R-15) or tag-derived (via a Tag's Permission Bundle, R-21). | `app_grants` (direct); via `tag_apps` (derived) | Grant and revoke are both audit-logged (AC-05). |
| T-14 | Tag | An admin-created label carrying a Permission Bundle; applying/removing it on a User applies/removes the bundled permissions (R-20, R-21). | `tags`, `user_tags` | Per-user permissions remain possible without tags (R-21). |
| T-15 | Permission Bundle | The set of permissions a Tag carries: App Grants, Library Grants, and optionally the Family designation (R-20). | `tag_apps`, `tag_libraries`, `tags.grants_family` | Removing the tag removes only tag-derived permissions (AC-06). |
| T-16 | Effective Permissions | The computed union of a User's direct grants and tag-derived grants, with provenance — which direct grant or tag produced each permission (R-22). Never stored; recomputed per query. | `EffectivePermissions`, `getEffectivePermissions()` | Changes take effect on the next dashboard query — no re-login (AC-05). |

## Plex servers & libraries

| ID | Term | Definition | Code identifier | Notes |
|----|------|------------|-----------------|-------|
| T-17 | Plex Server | One of the three Plex instances under management: `k8plex` and `plexops` (k8s) and `haynestower` (legacy Unraid) (R-25). | `plex_servers` | Owner tokens from 1Password (R-28). |
| T-18 | Plex Library | A named library on one specific Plex Server; identity is per (server, library). | `plex_libraries` | Whether names align across servers is open (Q-03). |
| T-19 | Library Grant | Permission for a User to self-add a given Plex Library to their account; direct or tag-derived (R-27). | `library_grants` (direct); `tag_libraries` (derived) | Share application happens in Plex Sharing (DDD-002 BC-04). |
| T-20 | Allowed Library Set | A User's effective set of self-addable libraries. Default = all libraries except Family-Only Libraries; adjusted by admins per user or per tag (R-25..R-27). | derived from `EffectivePermissions` | |
| T-21 | Family-Only Library | A Plex Library visible/addable only to Family users. Exactly `HNet Home Videos` and `HNet Photos` today (R-26). | `plex_libraries.is_family_only` | |

## Media ledger & fix

| ID | Term | Definition | Code identifier | Notes |
|----|------|------------|-----------------|-------|
| T-22 | *arr | Collective for Sonarr (TV), Radarr (movies), Lidarr (music) — the Source of Truth for media lists (R-40). | `arr_kind` (`'sonarr' \| 'radarr' \| 'lidarr'`) | |
| T-23 | Monitored | *arr state meaning the *arr actively manages/searches for an item. The Ledger mirrors all monitored media (R-40). | `ledger_items.monitored` | *arr concept we reference. |
| T-24 | Media Item | One Ledger row mirroring a monitored *arr item: on-disk state, quality profile, root folder, *arr tags (R-40). One row per Sonarr series / Radarr movie / Lidarr artist (DESIGN-005 D-04). | `media_items` | Written only by Sync — never hand-edited. Identifier amended from `ledger_items` to the DESIGN-001 D-15 reserved name (DESIGN-005). |
| T-25 | Ledger | The app's durable, queryable mirror of the media estate: Media Items + Ledger Events + Wanted Items. Doubles as the disaster-recovery source for Restore (R-40..R-42, R-50, R-51). | `media_items`, `ledger_events`, `wanted_items` (view) | A synced copy plus attribution/audit — never the Source of Truth for media. |
| T-26 | Ledger Event | A history record on the Ledger: who requested what (attributed via Seerr), what was deleted when, grabs/imports from *arr history (R-41). | `ledger_events`, `ledger_events.event_type` | Maintainerr enrichment is a follow-on (Q-04). |
| T-27 | Wanted Item | A Monitored Media Item with nothing on disk; captured and browsable (R-42). | `wanted_items` (view over `media_items`, DESIGN-005 D-08) | Derived, never stored. |
| T-28 | Seerr | The request app users request content through. We link to it and read request attribution from its API; we do not replace it (Non-goals, R-41). | `seerr` API client | Tile URL flips at the owner's cutover (Q-02). |
| T-29 | Fix Request | A user's tracked repair action on a Media Item they believe is broken: requester, item, Fix Reason, *arr actions taken, outcome (R-43, R-46). | `fix_requests` | Users see their own history/status; admins see all. Rate-guarded (R-47, Q-05). |
| T-30 | Fix Reason | Required taxonomy value on every Fix Request: `wont_play_corrupt`, `wrong_language`, `wrong_version_quality`, `missing_subtitles`, `wrong_content`, or `other` + free text (R-45). | `fix_requests.reason`, `fix_requests.reason_text` | Stored for analysis. Identifiers aligned to DESIGN-001 snake_case enum convention (DESIGN-005 D-09); free text rides only on `other`. |
| T-31 | Release | *arr concept: a specific downloadable version/file of a media item offered by an indexer. Referenced, not owned. | — | |
| T-32 | Grab | *arr concept: the *arr taking a Release for download; appears in *arr history. Fix chooses its path by grab history (R-44). | — | |
| T-33 | Blocklist | *arr concept: marking a Release failed so the *arr won't re-grab it. Fix = mark-failed (blocklist) + trigger a new search (R-44, AC-07). | — | Via the *arr's history-failed endpoint. |
| T-34 | Fix Fallback | The Fix path when an item has no Grab history: delete the file(s) + trigger search (R-44, AC-08). | `fix_requests.path_taken = 'delete_search'`, `fix_requests.actions_taken` | Outcome recorded either way. |
| T-35 | Restore | The admin-only failsafe: diff the Ledger against a live *arr, preview, then re-add missing items Monitored with recorded quality profile, root folder, and tags (R-50..R-52). | `restore_runs` | The only bulk write-back; explicitly admin-initiated and audit-logged. |
| T-36 | Restore Preview | The pre-execution diff listing exactly the Ledger items absent from the target *arr (R-52, AC-09). | `RestorePreview` | Execution reports successes/failures per item. |
| T-37 | Sync | The one-way import *arr → app that keeps the Ledger current (R-40). Sync direction is strictly *arr → app; the only write-backs are Fix and Restore (R-52). | `sync_runs` | |

## Cross-cutting

| ID | Term | Definition | Code identifier | Notes |
|----|------|------------|-----------------|-------|
| T-38 | Source of Truth | The ownership split: the *arrs own media lists (the Ledger mirrors them); this app owns permissions and the App catalog. | — | CLAUDE.md hard rule 4. |
| T-39 | Audit Row | A record (who, what, when, Initiator Kind) written in the same transaction as any role/permission mutation (R-04), library change (R-28), or Restore (R-52). | `user_role_transitions` (+ analogs per mutation type) | Pattern borrowed from todos-for-dues. |
| T-40 | Initiator Kind | Audit field distinguishing what caused a change: system (e.g. bootstrap promotion) vs admin vs user. | `initiator_kind` | AC-03: bootstrap writes a system-initiator row. |
| T-41 | Tombstone | A Media Item marked as no longer present in its *arr (`deleted_from_arr_at` set) but retained in the Ledger — deletion history (R-41) and the Restore source (R-50) both require keeping the row. Cleared if the item reappears. | `media_items.deleted_from_arr_at` | Sync tombstones, never deletes; mass-tombstone guard in DESIGN-005 D-14. |
| T-42 | Sync Cursor | The per-source high-water mark (history timestamp) that incremental Sync resumes from; advanced in the same transaction as each ingested batch. | `sync_state.history_cursor` | One row per source (`sonarr`, `radarr`, `lidarr`, `seerr`). |
| T-43 | Fix Lifecycle | The tracked status progression of a Fix Request: `pending → actioned → search_triggered → completed`, with `failed` reachable from any active state. Completion is asynchronous — observed by Sync (ADR-007 C-06). | `fix_requests.status` | Transitions only via `packages/domain` writers (DESIGN-005 D-09/D-12). |

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-07-03 | Tom Haynes | Initial glossary seeded from PRD-001 (Accepted). T-01..T-40 assigned. |
| 2026-07-03 | Tom Haynes | DESIGN-005: added T-41 Tombstone, T-42 Sync Cursor, T-43 Fix Lifecycle; amended prescriptive identifiers on T-24..T-27, T-30, T-34 to the DESIGN-001 D-15 reserved names and snake_case enum convention. |
