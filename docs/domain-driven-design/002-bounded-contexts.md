# DDD-002: Bounded Contexts

- **Status:** Accepted
- **Last updated:** 2026-09-25 (BC-06 also writes the owner's plex.tv watchlist — ADR-092, DESIGN-051). Prior: 2026-09-23 (BC-06 gains the public connector surface — ADR-091, DESIGN-050). Prior: 2026-09-23 (BC-06 Watch Companion — ADR-087/088/089, DESIGN-049)
- **Related:** PRD-001, DDD-001

Bounded contexts, one per cohesive model. Stable IDs `BC-NN`, cited across docs as
`DDD-002 BC-NN`. Terms in **bold** are defined in DDD-001.

## 1. Context map

```
      Authentik (OIDC; Plex is the credential inside it)
           |
           v
   +--------------+   user + role    +---------------+  effective perms   +---------------+
   |    BC-01     | ---------------> |     BC-02     | -----------------> |     BC-04     |
   |  Identity &  |  (read by every  |  Entitlements |  (allowed library  |  Plex Sharing |
   |    Access    |     context)     |   (DECIDES)   |   sets, family)    |  (ENFORCES)   |
   +------+-------+                  +-------+-------+                    +-------+-------+
          |                                  | tile visibility                   | sharing API
          | role gates fix (member)          v                                   v (owner tokens)
          | and restore (admin)         Dashboard UI                  k8plex / plexops /
          v                             (ENFORCES)                    haynestower Plex servers
   +--------------+
   |    BC-03     |  <--- sync, one-way --------------- Sonarr / Radarr / Lidarr
   | Media Ledger |  <--- request attribution, read-only ---------------- Seerr
   |    (ACL)     |  ---- fix + restore (the only write-backs) ---> Sonarr / Radarr / Lidarr
   +--------------+
```

## 2. Catalog

| ID | Context | Phase | Importance | Purpose in one line |
|----|---------|-------|------------|---------------------|
| BC-01 | Identity & Access | 1 | Generic | Turn an Authentik OIDC round-trip into an authenticated **User** with a **Role**. |
| BC-02 | Entitlements | 1 | Core | Decide who may see/use what: catalog, grants, tags — owns **Effective Permissions**. |
| BC-03 | Media Ledger | 2 | Core | Mirror the media estate from the *arrs; own **Fix Request** and **Restore**. |
| BC-04 | Plex Sharing | 3 | Supporting | Apply library-share decisions to the three Plex servers. |
| BC-05 | Media Communication | 2.5 | Supporting | Aggregate inbound third-party events into a **Feed**; host a user **Messages** board (Bulletin). |
| BC-06 | Watch Companion | 7 | Supporting | Know what the Server Owner has watched, is watching and might watch next; serve it to voice and agent consumers over MCP. |

## 3. Contexts in detail

### BC-01 — Identity & Access

- **Purpose:** authentication and identity only — Better Auth + Authentik OIDC (R-01),
  **Member** auto-create (R-03), **Bootstrap Admin** promotion (R-02), **Session**
  lifecycle, audited role transitions (R-04). Ends at "an authenticated User with a Role."
- **Owned aggregates:** User (with Role), Session; the `user_role_transitions` audit log.
- **Inbound:** OIDC callback from Authentik; admin role-change commands.
- **Outbound:** session (user + role), read by every other context on every request.
- **External systems:** Authentik (`authentik.haynesnetwork.com`) — the only one.
- **Does NOT own:** grants or the Family designation — permission concerns (BC-02).

### BC-02 — Entitlements

- **Purpose:** the decision authority for access — the **Source of Truth** for permissions
  and catalog. Owns the **App** catalog (R-11..R-13), **App Grants** (R-15), **Tags** with
  **Permission Bundles** (R-20, R-21), **Library Grants** + **Family** designation (R-26,
  R-27), and computes **Effective Permissions** with provenance (R-22, AC-06).
- **Owned aggregates:** Catalog Entry, App Grant, Tag (+ bundle), Library Grant, Family
  designation; permission-mutation audit rows.
- **Inbound:** admin CRUD commands (catalog, grants, tags, family); permission queries from
  the Dashboard and BC-04. Catalog writes normalize the entered URL to a canonical `http(s)`
  URL (ADR-013 reversed R-14 — any host allowed).
- **Outbound:** Effective Permissions to the Dashboard (tile visibility, AC-05) and to
  BC-04 (**Allowed Library Sets**, family); audit rows in the same transaction (R-04).
- **Section Permission (ADR-021, R-78):** a role's Edit/Read-Only/Disabled **level per
  top-level section** (`role_section_permissions`) is a permission concern owned here,
  alongside Effective Permissions — carried on the session and consumed by BC-03's Ledger
  (and later BC-03's Trash) nav + `sectionProcedure` gate.
- **External systems:** none in Phase 1; the follow-on push of app permissions into Authentik (R-30)
  is now **built** — the **Authentik Role Portal** (ADR-045 / DESIGN-023, PLAN-026). A synced-tier Role
  projects to an **Authentik group**; assigning it writes the identity's **group membership** (exclusive
  across owned tier groups), which propagates to every Authentik-backed app (Open WebUI, later
  Kavita/ABS). This is the BC-04 posture applied to identity: BC-02 **decides** (the Role), an
  import-confined write client (`@hnet/authentik/write`, `@hnet/openwebui/write`) **applies** — only to
  groups on a positive owned-groups allowlist (`assertGroupOwned`, → FORBIDDEN before any call), never
  the admin-managed flows/stages/brand/MFA groups the ADR-042 blueprints own. External group writes are
  audited **after** the apply (`authentik_group_audit`, the `plex_share_audit` seam); the local
  allowlist/role→group-map and pending-assignment writes are same-tx audited. A read-only
  `authentik-users` sync mirrors the whole Authentik directory (`authentik_users`) for the `/admin/users`
  roster.

### BC-03 — Media Ledger

- **Purpose:** durable, queryable mirror of the media estate plus self-service repair and
  disaster recovery: **Sync** (one-way *arr → app, R-40), Seerr-attributed history (R-41),
  **Wanted Items** (R-42), **Fix Requests** + **Fix Reasons** (R-43..R-47), and
  **Restore** + **Restore Preview** (R-50..R-52).
- **Anti-corruption layer:** per-service adapters translate external models (Sonarr
  series, Radarr movies, Lidarr albums, Seerr requests) into the ledger's own terms
  (**Media Item**, **Ledger Event**); external schemas and quirks never leak past them.
- **Owned aggregates:** Media Item, Ledger Event, Wanted Item (derived), Fix Request,
  Sync run, Restore run.
- **Inbound:** scheduled Sync pulls; user Fix commands (Member, rate-guarded per R-47);
  admin Restore commands; ledger browse/search queries (R-43); **Ledger section** browse /
  bulk **Add-&-search** / **export** commands, section-gated by BC-02's Section Permission
  (R-74..R-78, ADR-021/022); **Trash section** pending browse / Save / Expedite / Restore /
  rule-edit commands, gated by BC-02's Section Permission (VIEW) + Trash Action Grants (writes)
  (R-79..R-87, ADR-023).
- **Outbound (the only write-backs, R-52 + R-75 + R-79..R-87):** Fix — **Blocklist** + search,
  or **Fix Fallback** delete + search (R-44); Restore / Ledger Add-&-search — the generalized
  `executeArrAdd`: re-add absent items monitored (recorded profile/root/tags), set monitored
  on present-but-unmonitored items, and trigger a search (R-51, R-75; ADR-022); **Trash /
  Maintainerr** — add/remove exclusion (Save), rule-group CRUD, and the collection **handle**
  Expedite trigger (ADR-023; the mutating Maintainerr surface stays confined to `packages/domain`).
- **External systems:** Sonarr, Radarr, Lidarr (read items + history; write fix/restore);
  Seerr (read-only attribution); **Maintainerr** (read collections/rules/exclusions/settings;
  write exclusions/rules/expedite — the deletion system of record, **Q-04 RESOLVED** by ADR-023:
  Trash is read-through + a confined write surface, not a re-implementation). The Section/Action
  permission *mutation* is BC-02 Entitlements (audited); the Trash actions themselves are BC-03.
- **Does NOT own:** media lists — the *arrs are the **Source of Truth**; this is a mirror
  plus attribution/audit.

### BC-04 — Plex Sharing (Phase 3 — **built**: ADR-017 / DESIGN-007)

- **Purpose:** the enforcement arm for library access. Registry of the three **Plex
  Servers** and their **Plex Libraries**; applies users' add/remove-library requests
  through the plex.tv v1 sharing API using each server's owner token (R-25, R-28).
- **Owned aggregates (built):** Plex Server registry (`plex_servers`), Plex Library
  registry (`plex_libraries`), and the Plex Share audit ledger (`plex_share_audit`).
  Family gating is a `Family`-**role grant**, not a library flag (ADR-017 C-02 — there
  is no `is_family_only` column).
- **Inbound:** user add/remove-library commands — validated against BC-02's Allowed
  Library Set (re-derived inside the mutation, TOCTOU) before any Plex call; the
  admin-triggered Library Registry Refresh from the Plex APIs.
- **Outbound:** plex.tv sharing API calls (read-merge-write — never blind overwrite);
  a `plex_share_audit` row for every applied change.
- **External systems:** the three Plex servers — `haynesops`, `hayneskube` (k8s),
  `haynestower` (legacy Unraid); owner tokens sourced from 1Password via External
  Secrets, held header-only (never in git/URLs).
- **Decides nothing:** a share is applied only if BC-02 allows it (R-26, R-27; ADR-017 C-08).

### BC-05 — Media Communication (Phase 2.5 / stretch — **backend built**: ADR-026 / DESIGN-012)

- **Purpose:** the household's communication surface — aggregate inbound third-party events into one
  durable, filterable **Feed**, and host a user-driven **Messages** board for free-form
  discussion/triage. The Bulletin section (R-97..R-104).
- **Owned aggregates:** **Notification** (`notifications` — the durable normalized third-party
  event store, widened from PLAN-006), **Message** (`messages` — user board entries with a soft
  moderation lifecycle), and the **Message Action Grant** (`role_message_action_grants` — the
  fine-grained post/moderate grant; its *mutation* audit is BC-02 Entitlements, `update_message_actions`).
- **Anti-corruption layer:** per-source webhook **adapters** (Seerr/Overseerr, Tautulli, Maintainerr)
  translate each service's webhook template into the common Notification model; external payload
  quirks never leak past the parser (known-key validation + sanitization).
- **Inbound:** secret-gated webhook POSTs (`POST /api/webhooks/<source>`) → `recordNotification`;
  Feed browse + Message post/edit/moderate commands, gated by BC-02's Section Permission (READ) +
  the Message Action Grant (post/moderate).
- **Outbound:** none — the receiver is **inbound-only** (writes nothing to the source services); a
  Message linked to a Media Item is a reference, never a write. NO *arr/Plex/Maintainerr mutation.
- **Attribution reuse (from BC-03):** the email-only requester→user auto-link (ADR-008 C-05) and the
  tmdb/tvdb→Media Item match are the **single** factored path (`resolveUserIdByEmail` /
  `resolveMediaItemId`) — BC-05 reuses them, never a second attribution path.
- **External systems:** Seerr/Overseerr, Tautulli, Maintainerr — **as webhook senders only** (they
  POST us; we never call them for the Feed). In-cluster, per-source shared secret.
- **Does NOT own:** the media estate or the Fix flow — Messages **complement** Fix (BC-03), never
  replace it; the Feed is a read-through over inbound events, not a media source of truth.

### BC-06 — Watch Companion (ADR-087 / ADR-088 / ADR-089 / DESIGN-049, PLAN-068; ADR-091 / DESIGN-050, PLAN-069; ADR-092 / DESIGN-051, PLAN-071)

- **Purpose:** answer "what haven't I finished", "what should I watch next" and "I already watched
  that" for the **Server Owner** (T-94), fast enough for a voice turn, and expose it to machine
  consumers (the Movie Room voice agent, the dev-env agents) through the in-cluster MCP surface, and to
  external AI apps through public **Connectors** (T-254, ADR-091).
- **Owned aggregates:** **Watch Event** (`watch_events`, the append-only play log), **Title State**
  (`watch_titles`, the per-account progress snapshot), **Watch Mark** (`watch_marks`, the owner's
  audited corrections), the tracked-account registry (`watch_accounts`) and the recommendation
  signal cache (`watch_reco_signals`). For the public connectors (ADR-091) it also owns the OAuth state:
  **OAuth Client** (`oauth_clients`), **Authorization Transaction** (`oauth_authorizations`, with
  `oauth_authorization_codes`), and the **Refresh Family** and **Delegated Token** stores
  (`oauth_refresh_tokens`, `oauth_access_tokens`).
- **Inbound:** the `watch` sync mode (Tautulli history, the owner's Plex progress, the plex.tv
  watchlist, TMDB recommendations); MCP tool calls from an **MCP Consumer** (T-251) through the
  **MCP Hop** (T-252); MCP tool calls from a **Connector** on the public `/mcp` with a **Delegated
  Token** (T-258), answering for its user's **Tracked Account** (T-259); consent from a signed-in
  BC-01 user.
- **Outbound:** Plex `scrobble`/`unscrobble` for `watched` Watch Marks only (owner ruling
  2026-09-23), through the import-confined `@hnet/plex/write`. Nothing else is written anywhere.
- **Reuse, not reinvention:** the Server Owner comes from BC-04's owner recognition (ADR-029); the
  Tautulli trio from the ADR-068 env contract; ratings, genres and availability from BC-03's
  ledger (`media_metadata`, `media_plex_matches`). BC-06 reads them and owns none of them.
- **Does NOT own:** ADR-053's per-title `user_media_watch` facets or the household watch stats
  (BC-03), library access (BC-02/BC-04), or requests (Seerr).

## 4. Relationship rules

- **Entitlements decides; the Dashboard and BC-04 enforce.** Both consume Effective
  Permissions and embed no permission logic of their own; hiding links is the accepted
  enforcement start (PRD Non-goals; Authentik-side enforcement is follow-on R-30).
- **BC-01 is upstream of everything:** contexts read (user, role); none mutates identity.
- **The *arrs are upstream of BC-03** (conformist behind the ACL): sync is strictly
  *arr → app; the only writes back are Fix and Restore, both narrow and audited (R-52).
- **BC-04 owns library identity; BC-02 references it** — `role_library_grants` (BC-02)
  point at `plex_libraries` `(server_id, section_key)` identities from BC-04's registry.
- **Seerr is read-only** — attribution source and a catalog Tile; never replaced (Non-goals).
- **BC-06 reads BC-03 and BC-04, writes only Plex watch state and the owner's plex.tv watchlist.** Its outbound writes are the owner-issued `watched` mark (ADR-088) and the owner-issued Watchlist Change (ADR-092; plex.tv only, and Seerr auto-requests what it adds); MCP consumers get watch scopes only (ADR-087 C-05). A Connector's principal is its user's Tracked Account, resolved through the ADR-053 Plex Account Map; Plex is written only when that account is the Server Owner's (ADR-091 C-04). BC-06 reads the BC-01 session at consent and never turns a Delegated Token into one (hard rule 5).

## 5. Cross-cutting (not bounded contexts)

- **Audit:** each context writes its own Audit Rows in-transaction (R-04, R-28, R-52) —
  a shared pattern (from todos-for-dues), not a context.
- **Dashboard UI:** a view over BC-01 + BC-02 owning no aggregate; on the map only as an
  enforcement point.

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-07-03 | Tom Haynes | Initial contexts BC-01..BC-04 identified from PRD-001 (Accepted). |
| 2026-07-06 | Fable 5 | BC-04 Plex Sharing promoted intent → **built** (ADR-017 / DESIGN-007): owns `plex_servers`/`plex_libraries`/`plex_share_audit`; family gating is a `Family`-role grant (no `is_family_only` flag); BC-02→BC-04 reference named as `role_library_grants` → `plex_libraries (server_id, section_key)`; server slugs corrected to `haynestower`/`haynesops`/`hayneskube`. |
| 2026-07-07 | Fable 5 | Added **BC-05 Media Communication** (ADR-026 / DESIGN-012, PLAN-009 Bulletin, backend built): owns Notification (`notifications`, widened), Message (`messages`), Message Action Grant (`role_message_action_grants`); inbound-only webhook adapters (Seerr/Tautulli/Maintainerr); reuses BC-03's single email/media attribution path; complements (never replaces) BC-03's Fix. The Feed/Messages UX lands as a Fable follow-up. |
| 2026-07-10 | Fable 5 | BC-02 Entitlements gains an **outbound apply into Authentik** — the R-30 follow-on is now built as the **Authentik Role Portal** (ADR-045 / DESIGN-023, PLAN-026): a synced-tier Role projects to an Authentik group and role assignment writes group membership (exclusive across owned tier groups) through the import-confined `@hnet/authentik/write` + `@hnet/openwebui/write`, gated by a positive owned-groups allowlist (never the admin/MFA groups or ADR-042 blueprint-owned flows/stages/brand). The BC-04 "decide here, apply externally" posture applied to identity; external writes audited after the apply (`authentik_group_audit`), local changes same-tx audited. No BC renumbering. |
| 2026-09-23 | Opus 5.5 | Added **BC-06 Watch Companion** (ADR-087/088/089 / DESIGN-049, PLAN-068): owns Watch Event, Title State, Watch Mark, the tracked-account registry and the recommendation signal cache; reads BC-03/BC-04; one outbound write (Plex scrobble for an owner-issued `watched` mark); serves MCP consumers through the in-cluster hop. |
| 2026-09-23 | Opus 5.5 | **BC-06 gains the public connector surface** (ADR-091 / DESIGN-050, PLAN-069): owns the five OAuth tables (OAuth Client, Authorization Transaction and codes, Refresh Family and Delegated Token stores); Connectors call the public `/mcp` and answer for their user's Tracked Account (T-259) through the ADR-053 Plex Account Map; Plex write-back stays owner-only. No new context. |
