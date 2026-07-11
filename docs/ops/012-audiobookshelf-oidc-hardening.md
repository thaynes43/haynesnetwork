# OPS-012: Audiobookshelf OIDC hardening — admin group-mapping + login lockdown

- **Status:** Executed 2026-07-11 (ABS v2.35.1, Authentik 2026.x), owner-approved. Live-verified
  end-to-end via a headless OIDC round-trip.
- **Scope:** Audiobookshelf only. Namespace `media`, pod label `app.kubernetes.io/name=audiobookshelf`.
- **Where these settings live:** ABS auth settings are **PVC runtime state**, NOT GitOps — they sit in
  the `settings` table (`key='server-settings'`) of `/config/absdatabase.sqlite` on the
  `audiobookshelf` PVC. The Authentik OIDC provider/scope-mappings are **API-managed** (OPS-001, Q-11 —
  still outside the blueprints in OPS-009). Nothing here is a `haynes-ops` manifest change. Treat this
  doc as the seed for a future blueprint/seed entry (same pattern as Kavita).

## Problem

1. OIDC logins landed every user (including the owner `thaynes`) as a plain ABS `user`, never `admin`.
2. The login page showed a username/password form alongside the OIDC button (confusing for an
   OIDC-only estate).

## Key finding about how ABS 2.35 maps groups (why the "obvious" fix is wrong)

`server/auth/OidcAuthStrategy.js#setUserGroup` **lowercases the group-claim values and matches only the
literal tokens `admin` / `user` / `guest`** (in that priority). It does NOT match arbitrary Authentik
group names. Two consequences:

- Pointing `authOpenIDGroupClaim` at the shared `groups` claim (real Authentik group names like
  `authentik Admins`) would **never** grant admin — `authentik admins` ≠ `admin`.
- Worse: once `authOpenIDGroupClaim` is set, if a user's claim contains **none** of
  `admin`/`user`/`guest`, ABS **throws and denies the login entirely** (`No valid group found in
  userinfo`). The ABS Authentik application has **no policy bindings** (open to every authenticated
  user), so that would have locked out every family/friends member who could otherwise auto-register.

## Fix applied (Problem 1) — durable, non-regressive, ABS-scoped

A **dedicated** ABS role claim, additive to the provider so the shared `hnet-groups` mapping (also used
by Kavita/Open WebUI) is untouched and no denial-gate is introduced (everyone gets at least `user`).

| Object | Identity | Detail |
|---|---|---|
| Authentik group | `abs-admin` — pk `4807ec0a-b50a-4dc7-a52d-a24af600d2f9` | non-superuser; explicit/delegated ABS admins + safe test vehicle |
| Authentik scope mapping | `hnet-abs-role` — pk `31369f0b-67c5-459b-a981-2ca205abacc9` | `scope_name=abs_role`; expression below |
| Provider 111 (`Provider for Audiobookshelf`) | property_mappings | **appended** `31369f0b…` (kept all 4 existing: `acb0f69f` hnet-groups, `f8cbc5a4`, `57fbe55d`, `6c130fb7`) |
| ABS auth setting | `authOpenIDGroupClaim = "abs_role"` | `PATCH /api/auth-settings` |
| ABS user | `thaynes` (`7917cec0-4edb-4e19-9650-ff233c0af4ac`) | promoted `user → admin` directly (immediate; no re-login needed) |

Scope-mapping expression (`hnet-abs-role`):

```python
admin_groups = ["authentik Admins", "abs-admin"]
is_admin = request.user.ak_groups.filter(name__in=admin_groups).exists()
return {"abs_role": ["admin"] if is_admin else ["user"]}
```

Result: members of `authentik Admins` (the owner) or `abs-admin` → ABS `admin`; everyone else → ABS
`user` (auto-register still works, never denied). Future ABS admins = add to `abs-admin` (or they are
already `authentik Admins`).

**Proof (headless OIDC round-trip, Playwright against the live pod):**
- `hnet-e2e` (only `mfa-exempt`) → OIDC login succeeded → auto-registered as ABS **`user`** (claim
  delivered, non-admin not denied).
- Added `hnet-e2e` to `abs-admin` → OIDC login again → ABS log
  `[OidcAuth] openid callback: Updating user "hnet-e2e" type to "admin" from "user"` → ABS **`admin`**.
- Test artifacts removed afterward (ABS `hnet-e2e` user deleted; removed from `abs-admin`).

## Problem 2 — login lockdown: DECISION REQUIRED (not applied)

Goal was "show only the OIDC button." The literal approach — removing `local` from
`authActiveAuthMethods` — was tested and **rejected on safety grounds**:

- `Auth.js#initPassportJs` only registers the `local` passport strategy when
  `authActiveAuthMethods` includes `local`; `POST /login` unconditionally runs
  `passport.authenticate('local')`. **Verified live:** with `["openid"]` only, `POST /login` for
  `root` returns **HTTP 500** — root is locked out of password login.
- `?autoLaunch=0` is a **frontend-only** flag; it does NOT restore local login. With local disabled the
  page shows only the OIDC button but there is no working password path for `root`.

Two safe options for the owner (neither applied — this is the STOP/decision point):

- **(A, recommended) `authOpenIDAutoLaunch=true`, keep `local` enabled.** Verified: plain `/login`
  auto-redirects to Authentik (OIDC-only UX, no form shown); `/login?autoLaunch=0` still renders the
  ABS page WITH the local form so `root` can break-glass. One command:
  `PATCH /api/auth-settings {"authOpenIDAutoLaunch": true}`.
- **(B) Hard-disable local** (`authActiveAuthMethods:["openid"]`) — matches "only the OIDC button"
  literally, but accepts that `root` password login is gone; recovery is via the API/DB paths below.

## Break-glass / recovery (re-add `local`)

`local` is currently ENABLED — root password login works today. If local is ever disabled and you need
it back, in order of preference:

1. **Owner OIDC login (no cluster access needed).** `thaynes` is an ABS admin → log in via OIDC, then
   `PATCH /api/auth-settings {"authActiveAuthMethods":["local","openid"]}` with the resulting bearer.
2. **Saved admin bearer.** Any valid admin/root bearer token works (JWT strategy is always registered,
   independent of the local/openid strategies):
   `curl -X PATCH https://audiobookshelf.haynesnetwork.com/api/auth-settings -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"authActiveAuthMethods":["local","openid"]}'`
   (get a root bearer while local still works via `POST /login` with `root` + `ABS_ROOT_PASS` from
   secret `audiobookshelf-secret`).
3. **PVC SQLite (deepest fallback, needs cluster access).** Settings are in
   `/config/absdatabase.sqlite`, table `settings`, row `key='server-settings'`, `value` = JSON. The pod
   has no `sqlite3` binary; use the app's bundled module or copy the DB out:
   ```sql
   UPDATE settings
   SET value = json_set(value, '$.authActiveAuthMethods', json('["local","openid"]'))
   WHERE key = 'server-settings';
   ```
   then restart the pod (`kubectl rollout restart deploy/audiobookshelf -n media`) so ABS reloads
   settings and re-registers the local strategy.

## Token note (for future ops)

`audiobookshelf-secret` holds only `ABS_ROOT_PASS` (no admin API token). The homepage-secret
`HOMEPAGE_VAR_ABS_API_TOKEN` is non-admin (401 on `/api/settings`,`/api/users`). To hit the admin
settings/users APIs, authenticate as `root`: `POST /login` with `root` + `ABS_ROOT_PASS`; the response
`user.accessToken` (JWT) and `user.token` (long-lived) both work as `Authorization: Bearer`.
