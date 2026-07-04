# OPS-001: Authentik OIDC provisioning for haynesnetwork

- **Status:** Executed 2026-07-03 (Authentik 2026.5.3)
- **Design:** DESIGN-002 §(b)

What exists in Authentik (created via API, additive only):

| Object | Value |
|--------|-------|
| OAuth2 Provider | `Provider for haynesnetwork` (pk 109), `confidential`, sub_mode `hashed_user_id` |
| Application | slug `haynesnetwork`, bound to the provider, no extra policy bindings (any authenticated Authentik user may sign in — matches PRD R-03) |
| Flows | authorization `default-provider-authorization-implicit-consent`, invalidation `default-provider-invalidation-flow` (mirrors the Grafana provider) |
| Signing key | `Cloudflare Origin for Haynesnetwork` (mirrors Grafana) |
| Scopes | `openid`, `profile`, `email` (managed mappings) |
| Redirect URIs (strict) | `http://localhost:3000/api/auth/oauth2/callback/authentik` · `https://haynesnetwork.haynesops.com/api/auth/oauth2/callback/authentik` · `https://haynesnetwork.com/api/auth/oauth2/callback/authentik` · `https://www.haynesnetwork.com/api/auth/oauth2/callback/authentik` |
| Discovery | `https://authentik.haynesnetwork.com/application/o/haynesnetwork/.well-known/openid-configuration` (verified live) |

The callback path is Better Auth's generic-OAuth route: `{BETTER_AUTH_URL}/api/auth/oauth2/callback/authentik` (verified against the installed better-auth 1.6.23 source — `packages/auth` declares `^1.6.11`, the lockfile resolves it to 1.6.23; see DESIGN-002 D-04).

## Credential locations

- **Local dev:** `.env.local` (gitignored, 0600) — `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` written at provisioning time.
- **Cluster (OWNER ACTION REQUIRED):** create a 1Password item **`haynesnetwork`** in the
  `HaynesKube` vault with these fields (labels must match exactly — the haynes-ops
  ExternalSecret extracts by label):

  | Field | Value |
  |-------|-------|
  | `OIDC_CLIENT_ID` | from Authentik UI → Providers → *Provider for haynesnetwork* (or dev `.env.local`) |
  | `OIDC_CLIENT_SECRET` | same source |
  | `BETTER_AUTH_SECRET` | any fresh 32+ char random (do not reuse the dev one) |
  | `BOOTSTRAP_ADMIN_EMAILS` | `manofoz@gmail.com,t.haynes43@gmail.com,admin@haynesnetwork.com` |
  | `HAYNESNETWORK_POSTGRESQL__USER` | `haynesnetwork` |
  | `HAYNESNETWORK_POSTGRESQL__PASSWORD` | any fresh random — postgres-init creates the role with it |

  Programmatic creation was attempted via the in-cluster 1Password Connect API
  (2026-07-03): the ESO token is **read-only** (`403 … does not have permission to
  perform create`), so this stays a manual step.

## How to re-provision (idempotent)

The API token lives in the 1Password `homepage` item (`AUTHENTIK_API_TOKEN`); in-cluster
copy: `kubectl get secret homepage-secret -n frontend -o jsonpath='{.data.HOMEPAGE_VAR_AUTHENTIK_API_TOKEN}' | base64 -d`.

Gotcha: Cloudflare fronting `authentik.haynesnetwork.com` bans Python's default
user-agent (error 1010) — send `User-Agent: curl/8.5.0` (curl itself is fine).

1. `GET /api/v3/providers/oauth2/?page_size=100` — skip creation if `Provider for haynesnetwork` exists.
2. `POST /api/v3/providers/oauth2/` with the table's values (flows/keys/mappings pks via
   `GET /flows/instances/?designation=...`, `/crypto/certificatekeypairs/`,
   `/propertymappings/provider/scope/`). **MUST include
   `"grant_types": ["authorization_code", "refresh_token"]`** — omitting the field on
   Authentik 2026.5 saves an EMPTY list, which rejects every authorize request with
   `invalid_request: The request is otherwise malformed` (cost us the first production
   sign-in bug, fixed by PATCH 2026-07-03; UI-created providers default it correctly).
3. `POST /api/v3/core/applications/` `{name, slug: haynesnetwork, provider: <pk>}`.
4. `GET /api/v3/providers/oauth2/<pk>/` → `client_id`/`client_secret` → `.env.local` + 1Password.
5. Verify the discovery URL returns 200.

To revoke everything: delete the application then the provider in the Authentik UI (or
`DELETE` the same API paths). Nothing else in Authentik was modified.

## Follow-ons

- Redirect URIs already include the staging + production hosts, so no Authentik change is
  needed at cutover (ADR-002 C-08 satisfied).
- If the owner later wants Authentik-side access control per app (PRD R-30), bind policies
  to the `haynesnetwork` application and sync grants via this same API.
