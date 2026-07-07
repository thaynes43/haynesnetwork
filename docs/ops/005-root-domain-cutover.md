# OPS-005: Root-domain cutover — staging to public (EXECUTED log)

- **Status:** **Executed 2026-07-07** — `haynesnetwork.com` + `www.haynesnetwork.com` are
  publicly live via the in-cluster Cloudflare Tunnel → `traefik-external`. Apex auth round-trip
  and every permissioned surface validated against real backends; `www` 301s to the apex; the
  staging host (`haynesnetwork.haynesops.com`) was **kept warm** as the rollback target.
- **ADR:** ADR-006 (C-03; this was the "pure manifest change" it promises — realized as four
  coupled `haynes-ops` commits, below)
- **PRD:** R-64 (staged rollout), R-14 (never leak `*.haynesops.com` — moot post-ADR-013), R-63
- **Related:** OPS-004 (deploy runbook — how to reconcile Flux), OPS-001 (Authentik provider),
  PLAN-008 (`.agents/plans/completed/008-haynesnetwork-public-cutover.md`)
- **Owner authorization:** the owner explicitly authorized go-live **ahead of the PLAN-011
  MFA/branding gate** (owner does Authentik native-account MFA + the sign-in rebrand that same
  night). This was safe because **Authentik was already publicly exposed** — the cutover added no
  new externally reachable auth surface.

## What this did

Moved haynesnetwork off the LAN-only staging ingress (`haynesnetwork.haynesops.com` /
`traefik-internal`) onto the **public root domain** `haynesnetwork.com` + `www.haynesnetwork.com`,
served through the existing in-cluster **Cloudflare Tunnel** (UUID `dbefa0b0-…`,
`cloudflare-tunnel/app/dnsendpoint.yaml`) fronting `traefik-external`, with a public certificate
and Better Auth callbacks/cookies scoped to the apex origin. All behavior lives in the sibling
**`haynes-ops`** repo under `kubernetes/main/apps/…`; this repo's change is the docs record only.

**Why the moving parts were coupled:** Better Auth builds its OAuth callback URL and sets session
cookies from `BETTER_AUTH_URL`. If the ingress serves the public host while `BETTER_AUTH_URL` (or
the trusted-origin set) still names the old origin — or the tunnel/DNS don't reach the apex — the
callback origin and cookie domain mismatch the browser origin and **every sign-in fails**. The
cutover therefore shipped as one atomic set, then two hotfix commits closed gotchas found live.

## Executed sequence (`haynes-ops`, 2026-07-07)

Four commits, in order. The first is the atomic cutover; the rest closed live-found gotchas.

1. **`ea457b43` — the coupled cutover set.**
   - `ingressroute.yaml`: `traefik-internal` → **`traefik-external`**; host
     `haynesnetwork.haynesops.com` → **`haynesnetwork.com` + `www.haynesnetwork.com`**;
     `spec.tls.secretName` → **`certificate-haynesnetwork`**; external-dns target →
     **`ingress-ext.haynesnetwork.com`**.
   - `externalsecret.yaml`: `BETTER_AUTH_URL` → **`https://haynesnetwork.com`**, and a **new
     `TRUSTED_ORIGINS=https://www.haynesnetwork.com`** so a `www`-initiated request is accepted by
     Better Auth (the app's v0.16.0 auth hardening reads this).
   - `cloudflare-tunnel` config gains an explicit **bare-apex ingress rule** — the existing
     wildcard `*.haynesnetwork.com` matches `www` but a `*` label matches **exactly one label**,
     so the bare apex `haynesnetwork.com` would otherwise fall through to `http_status:404`. See
     §Cloudflare Tunnel apex specifics.

2. **`312dd17a` — Traefik v3 Host-syntax fix (GOTCHA #1) + warm rollback route.**
   Traefik **v3 dropped the multi-value `Host(a, b)` matcher** this runbook's original v2-era
   change-set table used — under v3 that expression matched **nothing**, so the apex/www served a
   404. Fixed the `IngressRoute` match to two single-value matchers OR'd together —
   `Host("haynesnetwork.com") || Host("www.haynesnetwork.com")` (backtick-quoted host args in the
   actual manifest).
   Same commit **restored `haynesnetwork.haynesops.com` as its own internal `IngressRoute`** (on
   `traefik-internal` / `certificate-haynesops`) so the staging rollback target stays warm rather
   than being consumed by the flip.

3. **`cf86397a` — `www`→apex 301 middleware (GOTCHA #2 fix) + retire `cloudflare-ddns`.**
   A `www`-initiated login failed with **`state_security_mismatch`**: Better Auth's OAuth **state
   cookie is host-scoped** (set on `www`) while the callback pins to the apex, so the returning
   request couldn't read its own state cookie. Fixed by a **`redirectRegex` Middleware that 301s
   `www` → apex** (preserving path + query) so login always runs single-origin on the apex; `www`
   is now a redirect shell, not a second live auth origin.
   Same commit **retired `cloudflare-ddns` from git**: its only job was pinning apex + `www`
   **A-records to the home WAN IP** (pre-tunnel legacy), and those stale A-records **blocked
   external-dns from taking ownership** of the names. The two stale A-records were **deleted via
   the Cloudflare API**, after which external-dns created its **proxied CNAMEs** (→
   `ingress-ext.haynesnetwork.com` → the tunnel) within a minute.

4. **`c9935b9b` — Flux `envsubst` escape (GOTCHA #3).**
   Flux's `postBuild` `envsubst` runs in **strict mode** and **ate the `${1}`** back-reference in
   the redirect replacement string (treated it as an undefined variable → empty). Fixed by
   escaping it as **`$${1}`** so the literal `${1}` reaches the rendered Middleware.

### The three gotchas, at a glance

| # | Symptom | Root cause | Fix (commit) |
|---|---------|-----------|--------------|
| 1 | apex/www 404 | Traefik **v3** removed multi-value `Host(a, b)` | `Host(a) || Host(b)` (`312dd17a`) |
| 2 | `www` login `state_security_mismatch` | OAuth **state cookie host-scoped** to `www`, callback pins apex | 301 `www`→apex `redirectRegex` (`cf86397a`) |
| 3 | redirect replacement rendered empty | Flux `postBuild` **envsubst strict** consumed `${1}` | escape `$${1}` (`c9935b9b`) |

A fourth, non-code cleanup rode along in `cf86397a`: **`cloudflare-ddns` had to be retired** (and
its two stale apex/www A-records deleted via API) before external-dns could own the names.

## Cloudflare Tunnel apex specifics (the routing gap and its fix)

The tunnel `config.yaml`
(`kubernetes/main/apps/network/cloudflare-tunnel/app/helmrelease.yaml`,
`values.configMaps.config.data.config.yaml`) historically carried a single-label wildcard
`*.haynesnetwork.com`. A `*` label matches **exactly one label**, so it covers
`www.haynesnetwork.com` but **not** the bare apex `haynesnetwork.com`, which would fall through to
`http_status:404`. `ea457b43` added an **explicit apex rule before the wildcard** so the apex
reaches `traefik-external` (the shared wildcard + terminal `http_status:404` were left intact —
other `*.haynesnetwork.com` apps depend on them):

```yaml
ingress:
  - hostname: "haynesnetwork.com"          # NEW — apex is not matched by *.haynesnetwork.com
    originRequest: { noTLSVerify: true }
    service: https://traefik-external.network.svc.cluster.local:443
  - hostname: "*.haynesnetwork.com"        # existing — covers www + every other app
    originRequest: { noTLSVerify: true }
    service: https://traefik-external.network.svc.cluster.local:443
  - service: http_status:404
```

This kept the **bare apex canonical** (matching `BETTER_AUTH_URL`); `www` is served by the same
`traefik-external` entrypoint but 301-redirected to the apex at the Traefik layer (gotcha #2 fix).
Because the apex is a real, explicitly-decided routing rule, no ADR-016 was minted — the decision
is recorded here.

## Live validation (agent, 2026-07-07)

Ran **6/7 first pass, then 7/7 after the `www`→apex 301 (`cf86397a`) landed**:

- **Apex auth round-trip:** `https://haynesnetwork.com` → Authentik → authorize → back
  **authenticated**, session cookie **scoped to `haynesnetwork.com`** (proves the
  `BETTER_AUTH_URL` flip matched the ingress).
- **`www`:** now **301s to the apex preserving path + query** (verified) — no more
  `state_security_mismatch`.
- **Library:** posters **50/50** through the authed proxy.
- **Trash:** Maintainerr shows **connected** with the live **Leaving Soon** batch.
- **Bulletin:** renders **real Seerr events**.
- **Mobile:** clean at **390px**.
- **TLS:** **Cloudflare edge cert** (Google Trust Services **WE1**) covering apex + wildcard.
- **Rate/health:** **zero 429s**; app logs clean.

## Post-cutover watch items (open, non-blocking)

- **(a) HSTS is `max-age=0`** at the Cloudflare edge — enable a real `Strict-Transport-Security`
  max-age later.
- **(b) Per-user rate-limit bucketing on `CF-Connecting-IP`** is coded (v0.16.0) but only provable
  under concurrent **real** users — watch under load.
- **(c) Two Trash posters 404** (cosmetic).
- **(d) Recommend a Cloudflare rate-limit / WAF rule on `/api/auth/*`** — owner dashboard task.

## Owner-gated follow-ups (deliberately deferred)

**PLAN-011 (Authentik native-account MFA + the haynesnetwork sign-in rebrand)** was deferred to
the owner the night of cutover. Go-live proceeded ahead of that gate on the owner's explicit
authorization; the rebrand/MFA are Authentik-side config the owner applies from the mockups +
apply/rollback runbook in `scratchpad/ux-011/`. The app-by-app SSO re-verification (OPS-001 flow)
is likewise an owner task.

## Rollback

Still coupled: revert the **`ea457b43..c9935b9b` set together** (single revert range) in
`haynes-ops` and reconcile Flux once. Because the staging host was **kept warm** (`312dd17a`
restored `haynesnetwork.haynesops.com` on `traefik-internal` / `certificate-haynesops`, and the
staging DNS + staging Authentik URIs were never removed), rollback restores a known-good origin
with **no external-system edits** — after reconcile, re-verify sign-in on
`https://haynesnetwork.haynesops.com`. The tunnel apex rule and the retired `cloudflare-ddns` do
not need reverting for a rollback (the wildcard + `http_status:404` remain intact); leave them.

> **Note (ADR-013, 2026-07-05):** the former gate "App catalog exposes only
> `*.haynesnetwork.com` URLs" was already removed before cutover. R-14 was reversed — the catalog
> accepts any `http(s)` URL — so catalog link hosts were not a cutover check.
