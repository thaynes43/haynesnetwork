# DDD-002: Bounded Contexts

- **Status:** Accepted
- **Last updated:** 2026-07-03
- **Related:** PRD-001, DDD-001

Four bounded contexts, one per cohesive model. Stable IDs `BC-NN`, cited across docs as
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
- **External systems:** none in Phase 1; follow-on push of app permissions into Authentik (R-30).

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
  (R-74..R-78, ADR-021/022).
- **Outbound (the only write-backs, R-52 + R-75):** Fix — **Blocklist** + search, or **Fix
  Fallback** delete + search (R-44); Restore / Ledger Add-&-search — the generalized
  `executeArrAdd`: re-add absent items monitored (recorded profile/root/tags), set monitored
  on present-but-unmonitored items, and trigger a search (R-51, R-75; ADR-022).
- **External systems:** Sonarr, Radarr, Lidarr (read items + history; write fix/restore);
  Seerr (read-only attribution). Maintainerr is a follow-on (Q-04).
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
