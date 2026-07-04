# OPS-005: Root-domain cutover — staging to public

- **Status:** NOT YET DONE — staging (`haynesnetwork.haynesops.com`) is the current live
  ingress. Execute only after the gate below is green.
- **ADR:** ADR-006 (C-03; this is the "pure manifest change" it promises)
- **PRD:** R-64 (staged rollout), R-14 (never leak `*.haynesops.com`), R-63
- **Related:** OPS-004 (deploy runbook — how to reconcile Flux), OPS-001 (Authentik provider)

## What this does

Moves haynesnetwork off the LAN-only staging ingress and onto the public root domain. All
edits land in the **sibling `haynes-ops` repo** under
`kubernetes/main/apps/frontend/haynesnetwork/app/` — nothing in this repo changes. Two
files are **coupled and order-sensitive**:

1. `ingressroute.yaml` — swap `traefik-internal` / `haynesnetwork.haynesops.com` for
   `traefik-external` serving `haynesnetwork.com` + `www.haynesnetwork.com`
   (`certificate-haynesnetwork`, external-dns target `ingress-ext.haynesnetwork.com`).
2. `externalsecret.yaml` — flip `BETTER_AUTH_URL` to `https://haynesnetwork.com`.

**Why both, together:** Better Auth builds its OAuth callback URL and sets session cookies
from `BETTER_AUTH_URL`. If the ingress serves the public host but `BETTER_AUTH_URL` still
says `haynesnetwork.haynesops.com` (or vice-versa), the callback origin and cookie domain
mismatch the browser origin and **every sign-in fails**. Ship the pair in one commit.

## Gate (do not start until all true)

- [ ] Phase 1 e2e green against staging (R-64) — the sign-in round-trip, dashboard, and
      catalog specs pass on `haynesnetwork.haynesops.com`.
- [ ] Public DNS for `haynesnetwork.com` + `www` resolves through the Cloudflare Tunnel to
      `ingress-ext.haynesnetwork.com` (external-dns / Cloudflare records exist).
- [ ] `certificate-haynesnetwork` TLS secret exists in namespace `frontend` and is Ready.
- [ ] `traefik-external` is the healthy public entrypoint (other `*.haynesnetwork.com` apps
      serve through it).
- [ ] Authentik redirect URIs already list both public callbacks (see Authentik step below
      — already provisioned per OPS-001; verify, do not assume).

## Change set (haynes-ops)

### 1. `app/ingressroute.yaml`

Current staging route (annotations + host + tls) becomes the external route:

| Field | From (staging) | To (public) |
|-------|----------------|-------------|
| `external-dns.alpha.kubernetes.io/target` | `internal.haynesops` | `ingress-ext.haynesnetwork.com` |
| `kubernetes.io/ingress.class` | `traefik-internal` | `traefik-external` |
| `spec.routes[].match` | ``Host(`haynesnetwork.haynesops.com`) && PathPrefix(`/`)`` | ``Host(`haynesnetwork.com`, `www.haynesnetwork.com`) && PathPrefix(`/`)`` |
| `spec.tls.secretName` | `certificate-haynesops` | `certificate-haynesnetwork` |

`entryPoints: [websecure]` and the `services` block (name `haynesnetwork`, port 3000) are
unchanged.

### 2. `app/externalsecret.yaml`

In the `target.template.data` block:

```yaml
BETTER_AUTH_URL: "https://haynesnetwork.com"   # was https://haynesnetwork.haynesops.com
```

`www` is served but the canonical `BETTER_AUTH_URL` is the bare root — pick one origin and
keep it stable so cookies/callback are single-valued. `stakater/reloader` (annotated on the
controller) restarts the app pod when `haynesnetwork-secret` changes; no manual bounce.

> Optional 1Password promotion: `BETTER_AUTH_URL` is currently a literal in the template,
> not a 1Password field. Leaving it a literal is fine. If you instead move it into the
> `haynesnetwork` 1Password item, add the field there and template it as
> `"{{ .BETTER_AUTH_URL }}"` — do that in the SAME commit as the ingress swap.

### 3. Authentik redirect URIs — verify (should be no-op)

OPS-001 provisioned the provider with all four callbacks already, including
`https://haynesnetwork.com/api/auth/oauth2/callback/authentik` and the `www` variant. So
this is normally a **verification**, not a change:

- Authentik UI → Providers → *Provider for haynesnetwork* → Redirect URIs — confirm both
  public callbacks are present (strict match).
- If either is missing, add it (path is always
  `{origin}/api/auth/oauth2/callback/authentik`). Leave the existing staging + localhost
  URIs in place so rollback works without another Authentik edit.

## Apply

1. Commit the two edited files to `haynes-ops` (one commit, conventional message) and merge
   per that repo's flow.
2. Reconcile Flux (see OPS-004): `flux reconcile kustomization ... --with-source`, or wait
   for the 30m interval. ExternalSecret refreshes `haynesnetwork-secret`; reloader restarts
   the pod with the new `BETTER_AUTH_URL`; Traefik picks up the new IngressRoute.

## Verify

- [ ] `https://haynesnetwork.com` serves the app over the public host (valid cert from
      `certificate-haynesnetwork`, HTTP 200 on `/api/health`).
- [ ] `https://www.haynesnetwork.com` serves the same app.
- [ ] Full sign-in round-trip on `https://haynesnetwork.com`: redirect to Authentik →
      authorize → callback → landed authenticated with a session cookie scoped to the public
      host. This is the assertion that proves the `BETTER_AUTH_URL` flip matched the ingress.
- [ ] `haynesnetwork.haynesops.com` no longer routes (staging host retired) — confirms R-14:
      the LAN host is gone from the public surface.
- [ ] App catalog still exposes only `*.haynesnetwork.com` URLs (R-14, unchanged by cutover).

## Rollback

Revert **both** files together (single revert commit) and reconcile:

- `ingressroute.yaml` → back to `traefik-internal` / `haynesnetwork.haynesops.com` /
  `certificate-haynesops`.
- `externalsecret.yaml` → `BETTER_AUTH_URL: "https://haynesnetwork.com"` back to
  `https://haynesnetwork.haynesops.com`.

Authentik needs no rollback — the staging + localhost redirect URIs were never removed.
After reconcile, re-verify sign-in on `haynesnetwork.haynesops.com`.
