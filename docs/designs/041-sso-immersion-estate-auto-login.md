# DESIGN-041: SSO immersion — estate auto-login inventory and per-app remediation

- **Status:** **Accepted (2026-07-20)** — Q-01..Q-09 all resolved or assumed-accepted (advanced
  Draft → Proposed → Accepted per the doc lifecycle). Q-06 is resolved-as-deferred (D-08 remains
  the deferred follow-up), which does not block acceptance. See the 2026-07-20 amendment.
- **Last updated:** 2026-07-20
- **Satisfies:** PLAN-058 (owner directive 2026-07-16/17: "SINGLE sign in" through the site and
  every app it supports — auto-login everywhere, retire per-app "Log in with Plex"); governed by
  ADR-002 (Authentik OIDC only), ADR-042 / OPS-009 (Authentik config-as-code + the WebKit-crisis
  lessons), ADR-045 / OPS-011 (the role portal + `hnet-portal` write surface), OPS-012 (the ABS
  OIDC hardening + break-glass discipline).

## Overview

A member logs in **once** — at `haynesnetwork.com`, via Authentik (Plex-primary source) — and
every estate app they open from the dashboard just works: no second login screen, no per-app
"Log in with Plex" button, the right identity, the right role. Seerr and Tautulli are the named
immersion breaks.

**The mechanism that makes this cheap:** the haynesnetwork login already leaves a live Authentik
session cookie in the browser. Any app that redirects to Authentik (native OIDC redirect, or a
proxy-outpost forward-auth challenge) completes **promptlessly** against that session — the
Authentik-side providers all use the implicit-consent authorization flow (verified idiom:
`default-provider-authorization-implicit-consent`, the flow the dev-env blueprint binds), so no
consent screen interrupts. What is missing today is only the **app-side first hop**: most apps
show their own login page with an SSO *button* instead of redirecting automatically. "Auto-login"
per app therefore means: make the app (or its front door) start the OIDC/forward-auth redirect
without user interaction, while preserving a documented break-glass path that skips it.

Two estate idioms already exist and are reused, not invented:

- **Native OIDC** (Kavita, Audiobookshelf, Open WebUI; Immich capable): the app is an OIDC client
  of its own Authentik provider; role/entitlement mapping rides claims (the OPS-012
  `hnet-abs-role` scope-mapping pattern).
- **Forward-auth front door** (Paperless, dev-env, headlamp): a Traefik middleware
  (`ak-outpost-proxy-provider-<outpost>`) sends every request through an Authentik proxy
  provider; the app trusts the outpost's identity headers (Paperless:
  `PAPERLESS_HTTP_REMOTE_USER_HEADER_NAME: HTTP_X_AUTHENTIK_EMAIL`) or its injected
  HTTP-Basic credentials. Zero clicks by construction.

### D-01 — The auto-login safety invariant (the incident-class rule)

Every auto-login flip **documents its break-glass URL/path in the same change**, and the flip is
made only after the break-glass is verified working. This is the lesson of the Kavita evening
(2026-07-16) and OPS-012: auto-redirect hides the local login form, and each app has a distinct
escape hatch. The catalog of hatches:

| App | Break-glass |
|---|---|
| Kavita | `/login?forceShowPassword=true&skipAutoLogin=true` + `hnetadmin` password (`kavita-secret`); admins are exempt from `DisablePasswordAuthentication` by Kavita design (cannot be turned off) |
| Audiobookshelf | `/login?autoLaunch=0` + `root` password (`audiobookshelf-secret`); `local` stays in `authActiveAuthMethods` (OPS-012 option A — never option B) |
| Immich | `/auth/login?autoLaunch=0` + admin password login (verify the exact param during execution — D-06) |
| Open WebUI | unchanged — the deep-link option (D-05) never touches OWUI's own login page, which keeps working as-is |
| Paperless / any outpost-fronted app | Authentik itself is the login; if Authentik is down the app is unreachable by design (same posture as haynesnetwork.com) |
| Tautulli (proposed outpost front) | the in-cluster/LAN route bypasses the outpost; Tautulli's own admin login stays intact underneath |

### D-11 — The LAN-only ingress invariant (SSO must never surface a LAN app to the internet)

Added 2026-07-20 (owner ruling on Q-03). Bringing an app under true SSO must **never** move it
from an internal ingress onto a public one. The app keeps its existing internal ingress
(`*.haynesops.com`); only the **auth redirect** traverses the public Authentik. Hard constraint
(owner, near-verbatim): "we don't have a local only Authentik path yet and I am using cloudflare
tunnels so `*.haynesnetwork.com` always resolves to the internet." Because Authentik itself is only
reachable at a public `*.haynesnetwork.com` host today, the redirect leg is unavoidably
internet-facing — but the **application** it protects must not follow it out. A LAN-only app that
gains OIDC or a forward-auth front door stays LAN-only: its ingress class, hostnames, and reach are
unchanged by the SSO work. Any remediation that would require exposing the app publicly to wire up
SSO is **out of bounds** until a local-only Authentik path exists (a separate future decision).
This is the companion to D-01 — D-01 guards the break-glass, D-11 guards the network boundary — and
it governs both the phase-2 catalog expansion (Q-03) and the two LAN-internal Tautulli instances
(Q-08).

## Inventory — every catalog app × its auth today

Scope = the seeded `app_catalog` (10 rows, migration 0002 + 0037). The catalog is admin-curated
runtime data (R-11), so execution starts by diffing the **live** catalog against this table
(plan step; rows added since seed join the inventory).

Estate URLs resolved from `haynes-ops` (traefik-external ingressroutes + app ingresses),
2026-07-17:

| Card | URL → actual backend | Auth today | Native OIDC? | Auto-login capable? | Forward-auth viable? | Role-mapping story |
|---|---|---|---|---|---|---|
| Seerr | `overseerr.haynesnetwork.com` → in-cluster **Seerr v3.3.0** (cut over from Unraid Overseerr 2026-07-03; migrated in place from Jellyseerr 2.7.3) | **Plex OAuth** (imported Plex users) + local users — THE immersion break | **No (stable).** OIDC exists only in the experimental `preview-new-oidc` image (upstream PR seerr-team/seerr#2715, still open; predecessor #1505 closed unmerged) | Not today | Gate-only: Seerr has no trusted-header auth, so an outpost would add a wall *and keep* the Plex login behind it — rejected | Seerr permissions ride its own user records (imported Plex users); preview OIDC has **no role/claim mapping yet** |
| Plex | `plex.haynesnetwork.com` → Unraid `haynestower:32400` | plex.tv account (Plex's own auth; not replaceable) | N/A | N/A | N/A | The Plex account **is** the estate's primary identity (Authentik's Plex source) — accepted as-is (Q-07) |
| K8Plex | `k8plex.haynesnetwork.com` → in-cluster Plex | plex.tv account | N/A | N/A | N/A | same |
| PlexOps | `plexops.haynesnetwork.com` → ops Plex | plex.tv account | N/A | N/A | N/A | same |
| Immich | `immich.haynesnetwork.com` (plain ingressroute, no middleware) | Runtime admin-settings state — **not in git; live state unverified** (Q-04) | **Yes** (Administration → Settings → OAuth; docs: <https://docs.immich.app/administration/oauth/>) | **Yes** — the `Auto Launch` setting auto-redirects the login page to the provider | Possible but pointless given native support | OIDC `Role Claim` (`immich_role`: `user`/`admin`) applied **on user creation only**, never re-synced; storage-label claim available. Mobile app needs `app.immich:///oauth-callback` redirect URI |
| Open WebUI | `ai.haynesnetwork.com` | **Authentik OIDC live** (git-managed env): `ENABLE_LOGIN_FORM=false`, `ENABLE_OAUTH_SIGNUP=true`, groups claim + `ENABLE_OAUTH_GROUP_MANAGEMENT=true` → today = ONE "Continue with authentik" button, then promptless | Yes (live) | **No native auto-redirect env** — upstream feature still open as of 2026-03 (open-webui/open-webui discussion #7337); workarounds are code patches or ingress hacks | Trusted-header mode exists (`WEBUI_AUTH_TRUSTED_EMAIL_HEADER`) but would bypass the OAuth path that does **group sync** — rejected (D-05) | Groups claim already syncs OWUI membership per login (PLAN-021/026; the portal writes the groups) |
| Paperless | `paperless.haynesnetwork.com` | **Forward-auth SSO already complete**: `ak-outpost-proxy-provider-external-outpost` middleware + `PAPERLESS_ENABLE_HTTP_REMOTE_USER` + `HTTP_X_AUTHENTIK_EMAIL` | (n/a — trusted header) | **Already zero-click** (given an Authentik session) | Is the reference implementation | Paperless-side permissions managed in-app; identity keyed by Authentik email |
| Tautulli | `tautulli.haynesnetwork.com` → **Unraid `haynestower:8181`** (two more in-cluster instances, `tautulli-k8plex` / `tautulli.haynesops.com`, are LAN-internal only) | Tautulli's own login: admin password + optional **Plex OAuth** admin/guest login — the second named immersion break. HTTP Basic mode available | **No** (no OIDC support; no trusted-header/remote-user support; FAQ: auth **cannot be disabled** in Docker installs) | Not natively | **Yes — the real path** (D-07): Authentik proxy provider + HTTP-Basic header injection (documented authentik integration: <https://integrations.goauthentik.io/media/tautulli/>) | None per-user behind the proxy — every passer holds the single injected identity (admin unless per-user attributes are set); gate WHO passes via an Authentik group policy (Q-02) |
| Kavita | `kavita.haynesnetwork.com` (plain pass-through route — "NO forward-auth middleware" by design) | **Authentik OIDC live** (provider pk 110). 2026-07-16 estate state: `DisablePasswordAuthentication=true` (admins exempt = built-in break-glass), **Default Roles Login+Bookmark+Download landed** (future members auto-provision), owner's SSO acct maps to `hnetadmin`. **`AutoLogin=false`** — deliberately, during the admin work; flipping it ON was explicitly deferred into PLAN-058 | Yes (live) | **Yes — a runtime flag** (`AutoLogin` in the `OidcConfiguration` blob, ServerSetting Key=40; effective immediately, no restart) | Unnecessary | Native + rich: "Sync user settings with OIDC roles" derives roles, `library-<Name>` access and `age-restriction-<Rating>` from a roles claim, re-synced each login (<https://wiki.kavitareader.com/guides/admin-settings/open-id-connect/>) — **deferred into this plan**, needs the Authentik claim design (D-08) |
| Audiobookshelf | `audiobookshelf.haynesnetwork.com` (plain pass-through route) | **Authentik OIDC live + hardened** (OPS-012): `abs_role` claim maps admin/user; `local` + `openid` both enabled; AudioBooth mobile allow-listed | Yes (live) | **Yes — a runtime flag**: `authOpenIDAutoLaunch=true` (OPS-012 option A, recommended there and **not yet applied**) | Unnecessary | Solved (OPS-012 `hnet-abs-role` scope mapping: `authentik Admins`/`abs-admin` → admin, everyone else → user, never denied) |

Not on the dashboard (grafana, homepage, headlamp, Home Assistant, dev-env, the *arrs, qBittorrent,
…): out of scope for v1 unless the owner widens it (Q-03). haynesnetwork.com itself is the session
anchor and already correct (ADR-002).

## Per-app remediation design

Ordered easiest → hardest. Each names the exact mechanism.

### D-02 — Kavita: flip `AutoLogin=true` (quick win #1)

Runtime DB setting (Server Settings → OpenID Connect → Auto Login, or the `OidcConfiguration`
JSON blob at ServerSetting Key=40) — effective immediately, no restart, no manifest change.
Result: hitting `kavita.haynesnetwork.com` bounces straight through Authentik and lands in the
right Kavita account (owner → `hnetadmin` via the OIDC link established 2026-07-16).
Break-glass (verified, already live): `/login?forceShowPassword=true&skipAutoLogin=true` +
`KAVITA_ADMIN_PASS`. Same change updates the `haynes-ops` Kavita README, which today still says
`AutoLogin=false` and predates Default Roles (the PLAN-058 intake's runbook-hygiene item — its
"Current settings" block and the missing DefaultRoles/auto-login/break-glass semantics).

### D-03 — Audiobookshelf: flip `authOpenIDAutoLaunch=true` (quick win #2)

Exactly OPS-012 option A, already recommended and rehearsed there:
`PATCH /api/auth-settings {"authOpenIDAutoLaunch": true}` (root bearer per OPS-012's token note).
`local` **stays** in `authActiveAuthMethods` (option B remains rejected — root lockout).
Break-glass: `/login?autoLaunch=0`. Mobile (AudioBooth / official app) is untouched — the mobile
OIDC flow is ABS-mediated and allow-listed already (OPS-012 addendum). OPS-012 gets an addendum
row when executed.

### D-04 — Immich: verify live state, configure OAuth if absent, then `Auto Launch` (Q-04)

Immich's OAuth config is runtime admin-settings state (nothing in git — D-14 in the inventory).
Steps: (1) verify live whether OAuth is configured; (2) if not, create the Authentik OIDC
provider/application pair (OPS-001 idiom; implicit-consent flow) and configure
Administration → Settings → OAuth (issuer = the Authentik application's
`.well-known/openid-configuration`, auto-register on, mobile redirect
`app.immich:///oauth-callback`); (3) flip `Auto Launch` on. Caveats to document in the ops record:
the `immich_role` claim is applied **only at account creation** (no ongoing role sync — admin
promotion stays manual or at-creation via claim), and the password break-glass param must be
verified live before the flip (D-01). Immich is seeded admin-grantable/hidden, so blast radius is
small. **Q-04 RESOLVED (owner, 2026-07-20):** OAuth is already configured — "we just need Auto
Launch - trust but verify." The live path is therefore verify (OAuth config + the
`app.immich:///oauth-callback` mobile redirect URI) → flip `Auto Launch`; the configure-if-absent
step is kept only as the fallback should verification find it missing.

### D-05 — Open WebUI: zero-click via catalog deep-link (no app change)

Upstream has no auto-redirect setting (discussion #7337 open; the docs' recommended state —
`ENABLE_LOGIN_FORM=false` + OAuth — is exactly what we already run, and it still leaves one
button). Rather than patch OWUI or bolt an ingress hack, **change the catalog card URL** to the
SP-initiated login endpoint: `https://ai.haynesnetwork.com/oauth/oidc/login`. With a live
Authentik session that completes promptlessly into the app; group sync keeps riding the OAuth
login (unlike the trusted-header alternative, which would bypass it — rejected). The catalog is
admin-curated (ADR-013 accepts arbitrary URLs), so this is an admin UI edit, not a migration.
Execution verifies the endpoint path against our deployed OWUI version and the behavior for
already-authenticated users (expected: bounce → back into the app). If upstream later ships
native auto-redirect, revert the URL to the root. Alternative kept on file: none needed; the
login page with its single button remains the direct-URL experience (acceptable — still one
click, zero credentials).

### D-06 — Paperless: nothing to do (reference implementation)

Already the target state: external-outpost forward-auth + trusted `X-Authentik-Email` header.
Cited in the plan only as the proven idiom for D-07.

### D-07 — Tautulli: Authentik proxy provider + HTTP-Basic injection (the honest option)

Tautulli has **no OIDC and no trusted-header support**, and its FAQ rules out disabling auth in
Docker installs. The workable zero-click design (the documented authentik↔Tautulli integration):

1. **Authentik:** a proxy provider (`forward_single`, external host
   `https://tautulli.haynesnetwork.com`, implicit-consent flow) assigned to the **external
   outpost** (the Paperless outpost — NOT the embedded one, whose provider list is owned by the
   `50-dev-env.yaml` blueprint; a new blueprint file owns this provider/application, ADR-042
   style). The provider injects **HTTP-Basic** credentials (Tautulli's admin user/pass, stored as
   Authentik user/group attributes per the integration guide) — Tautulli must have **"Use Basic
   Authentication"** enabled.
2. **Access policy:** bind an Authentik group policy on the application so only the intended
   tiers pass (Q-02) — behind the proxy **everyone who passes is the same Tautulli admin
   identity** (per-user Plex guest views are retired with the Plex OAuth button).
3. **Traefik:** add the `ak-outpost-…` middleware to `ingressroute-tautulli.yaml`
   (haynes-ops PR; same shape as Paperless).
4. **Carve-outs:** Tautulli's unauthenticated surfaces — `/newsletter`, `/image`, and the Gatus
   health probe path — must be listed as the proxy provider's unauthenticated paths, or those
   consumers break. Homepage widgets are unaffected (they hit the in-cluster service URL).
   The backend is the **Unraid** instance, so step 1's Tautulli-side setting is an owner/Unraid
   action, not GitOps.

Scope note: the family-facing card URL (`tautulli.haynesnetwork.com`) is the Q-02 pilot and is
already LIVE (gated to `authentik Admins` + `family`). **Q-08 RESOLVED (owner, 2026-07-20): the
two LAN-internal instances (`tautulli-k8plex` / `tautulli-plexops`, haynesops.com) ALSO get the
front door** — staying on their internal ingress per **D-11** (only the auth redirect is public),
default access **admins-only** (they are ops surfaces; the family-facing pilot keeps admins +
Family), a default the owner can later widen. Their HTTP-login creds come from two HaynesKube
1Password items (`tautulli-k8plex`, `tautulli-plexops`, username + password each). See the
2026-07-20 amendment.

### D-08 — Kavita role sync via the OIDC roles claim (the deferred follow-up)

Turn on Kavita's "Sync user settings with OIDC roles" **only after** the Authentik-side claim
design exists (the OPS-012 `hnet-abs-role` idiom, one scope mapping emitting Kavita's expected
tokens): Kavita role names for the tier, `library-<LibraryName>` per granted library,
`age-restriction-<Rating>`. The mapping source is the owner's tier table (Q-06): which Authentik
groups (portal-owned, ADR-045) map to which Kavita roles/libraries. Hard cautions from the Kavita
docs + the ABS lesson (OPS-012): with sync ON, per-user edits inside Kavita are disabled (the
claim is the single source of truth), and a missing/empty claim must degrade to the Default-Roles
floor rather than deny — the expression mapping must emit a floor for every authenticated user,
never nothing (the exact failure class OPS-012 dodged for ABS). Admin lockout is guarded by the
password break-glass (admins exempt, by Kavita design). This lands as its own execution phase
with an OPS record; the ADR-045 portal may later grow a "Kavita entitlements" projection, which
would be a separate ADR.

### D-09 — Seerr: no safe zero-click today; track upstream, owner ruling on the preview (Q-01)

Honest state (verified 2026-07-17): stable Seerr v3.3.0 (our deployed tag, latest release
2026-06-02) has **no OIDC**. Support exists only in the experimental `preview-new-oidc` image
(upstream PR seerr-team/seerr#2715, open; earlier #1505 closed unmerged). Per the upstream
testing thread (discussion #2721): auto-creation (`newUserLogin`) and account linking work;
**not** implemented: role/permission mapping from claims, automatic merging of existing users
(email-collision `UNIQUE constraint failed: user.email` on migration), any web UI for the config
(JSON edits only), or disabling the legacy login methods; recent preview builds shipped a login
regression affecting all auth methods. Options, in preference order:

- **O1 (default): wait + watch.** Keep Plex OAuth; subscribe to PR #2715 / the release feed;
  adopt native OIDC the release after it merges to stable. Softener meanwhile: none good —
  forward-auth cannot log a user into Seerr (no trusted header), it only adds a wall (rejected).
- **O2 (owner opt-in): run `preview-new-oidc` now.** Zero-click is still NOT delivered (no
  documented auto-redirect; login page keeps its buttons), users must one-time link accounts,
  and it is explicitly not production-advised. Requires a verified PVC backup + tested rollback
  to v3.3.0. Only worth it if the owner values retiring the Plex button above stability.
- **O3: accept + document** (status quo, card copy explains "sign in with your Plex account").

Recommendation: O1, revisited monthly; the plan carries a standing watch item. Seerr keeps its
Plex-user identity model either way — requests stay attributed to the same users after any
OIDC adoption via the linking flow.

### D-10 — Plex / K8Plex / PlexOps: accepted as-is (Q-07 confirms)

Plex Web authenticates against plex.tv; there is no OIDC seam and no proxy trick that changes
that. But this is **not** an immersion break in practice: the estate's primary identity IS the
Plex account (Authentik's Plex source), and Plex clients hold their own persistent plex.tv
session. Clicking a Plex card lands in Plex Web already signed in for any member who has ever
used Plex in that browser. Documented as N/A-by-design.

## Sequencing and risk

| Phase | What | Type | Risk |
|---|---|---|---|
| 0 | Verify live catalog vs seed; verify each app provider uses the implicit-consent flow; verify break-glass paths (D-01) | read-only | none |
| 1 | Kavita `AutoLogin` (D-02) + ABS `authOpenIDAutoLaunch` (D-03) + haynes-ops Kavita README refresh | runtime flips + docs | LOW — both have verified break-glass; instantly revertible |
| 2 | OWUI catalog deep-link (D-05) | admin UI catalog edit | LOW — revert = restore URL |
| 3 | Immich verify/configure/auto-launch (D-04) | runtime admin settings (+ possible Authentik provider create) | LOW-MED — new provider creation is OPS-001-idiom API work; hidden-by-default card |
| 4 | Tautulli forward-auth front door (D-07) | haynes-ops PR (blueprint + middleware) + Unraid-side setting | MED — carve-outs must be right or newsletters/Gatus break; identity model change needs Q-02 |
| 5 | Kavita role sync (D-08) | Authentik scope mapping + Kavita flip | MED — claim-floor design must be right; per-user edits lock |
| — | Seerr (D-09) | owner ruling / upstream watch | O2 is the only HIGH-risk item in the plan; O1 is zero-risk |

Cross-cutting risks:

- **The WebKit login crisis (OPS-009) rule:** nothing in this plan touches Authentik flows,
  stages, brand, or the login estate's web assets. All Authentik-side work is *provider/
  application/outpost/scope-mapping* creation — additive objects, blueprint- or API-managed,
  outside the crisis blast radius. Any temptation to "improve" the login flow itself is out of
  scope here.
- **Auto-login lockout class:** covered by D-01 (break-glass verified before each flip).
- **Runtime-state drift:** Kavita/ABS/Immich auto-login settings live on PVCs, not in git — a
  PVC rebuild resets them. Each flip is recorded in the app's README/OPS doc (the existing
  Kavita-README pattern) so restores re-apply them.
- **Embedded-outpost ownership:** the `50-dev-env.yaml` blueprint owns the embedded outpost's
  provider list; Tautulli's proxy provider must ride the **external** outpost or be added in
  that blueprint — never a UI edit that the blueprint will revert.

## Alternatives considered

- **One estate-wide forward-auth wall in front of everything:** rejected — apps with native OIDC
  get a worse double-hop, apps without trusted-header support (Seerr, Tautulli-guest) still show
  their own login behind the wall, and it centralizes an outage point without retiring any
  buttons on its own.
- **haynesnetwork-mediated token hand-off (the site logs users into apps server-side):** rejected
  — the site never holds member Plex credentials/tokens (ADR-017 posture), and no target app
  supports third-party session minting; this would be invented capability.
- **OWUI trusted-header / Seerr forward-auth / Tautulli auth-disable:** each rejected inline
  above (D-05, D-09, D-07) with the specific reason.

## Test strategy

- Playwright (the OPS-012 headless-OIDC-round-trip idiom) per flipped app: fresh context → log
  in at haynesnetwork.com (stub or `hnet-e2e` against live Authentik, MFA-exempt) → navigate to
  the app URL → assert landing **inside** the app with zero interactions, as the expected
  identity/role.
- Per-app break-glass probe: the documented skip-URL renders the local form (D-01), asserted in
  the same pass BEFORE the flip is made.
- Tautulli: assert `/newsletter` + Gatus path reachable unauthenticated after the middleware
  lands; assert a non-permitted-group identity is blocked.
- No unit-test surface in this repo (all changes are estate/runtime/ops) except if the catalog
  deep-link is seeded for fresh deploys — then the migrations test updates with it.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | **Seerr:** wait for upstream OIDC to reach stable (O1, default) or run the experimental `preview-new-oidc` image now (O2 — backup + rollback plan, JSON config, no role mapping, known preview login regressions)? | **RESOLVED (owner, 2026-07-17): O1 — wait for upstream OIDC to reach stable.** Do not run the experimental `preview-new-oidc` image; revisit when upstream ships a stable OIDC release. |
| Q-02 | **Tautulli:** is the all-admin shared-identity model behind the Authentik front door acceptable (per-user Plex guest views retired)? Which Authentik groups/tiers may reach Tautulli at all? | **RESOLVED (owner, 2026-07-17): proxy accepted; login allowed to admins + the Family tier only** ("it doesn't get much use anyway" — the pilot for role-governed app login, see the amendment below). |
| Q-03 | **v1 scope:** catalog cards only, or also estate apps outside the catalog (Grafana, Home Assistant, homepage, headlamp)? | **RESOLVED (owner, 2026-07-20): catalog apps first, but the standing aspiration is that *anything Authentik is used for* reaches true SSO over time** — keep working through more apps, adding OIDC where basic auth lives today; expansion beyond the catalog is **phase-2, app-by-app**. HARD CONSTRAINT (near-verbatim): "we don't have a local only Authentik path yet and I am using cloudflare tunnels so `*.haynesnetwork.com` always resolves to the internet." Codified as **D-11** — SSO for a LAN-only app must never move it onto a public ingress (the app keeps its internal ingress; only the auth redirect traverses the public Authentik). *(Re-capture: a prior Q-03 answer was lost in an uncommitted worktree — see the 2026-07-20 amendment.)* |
| Q-04 | **Immich:** is OAuth already configured live (runtime state, not in git)? And is Auto Launch wanted given the card is currently admin-grantable/hidden? | **RESOLVED (owner, 2026-07-20): OAuth is already configured — "we just need Auto Launch - trust but verify."** Verify the live OAuth config (incl. the `app.immich:///oauth-callback` mobile redirect URI) first, then flip `Auto Launch` (D-04). The configure-if-absent step in D-04 is expected to be a no-op but is kept as the verify fallback. |
| Q-05 | **OWUI:** accept the catalog deep-link to `/oauth/oidc/login` (zero-click now, revert-on-upstream), or keep the one-button page and wait upstream? | **RESOLVED (owner, 2026-07-20): take the catalog deep-link to `/oauth/oidc/login` — zero-click now, with the documented revert-on-upstream** (restore the root URL if OWUI ships native auto-redirect). Per D-05. |
| Q-06 | **Kavita role sync:** the tier table — which Authentik groups map to which Kavita roles, libraries (`library-<Name>`), and age restrictions? Flip only after the Phase-1 auto-login soak? | **RESOLVED-as-deferred (owner, 2026-07-20): deferred until after the auto-login rollout soaks; the owner supplies the tier table when ready.** D-08 remains the deferred follow-up — no Kavita role-sync flip until the owner's group → role / `library-<Name>` / age-restriction mapping lands. |
| Q-07 | **Plex cards:** confirm accepted-as-is (plex.tv identity IS the SSO identity; no seam exists) | **Assumed accepted (2026-07-20 — presented as the default, owner unobjected):** Plex cards stay as-is; plex.tv identity IS the SSO identity (no OIDC seam exists). Per D-10. |
| Q-08 | **Tautulli scope:** family-facing `tautulli.haynesnetwork.com` only, or also the LAN-internal k8plex/plexops instances? | **RESOLVED (owner, 2026-07-20): YES — both LAN-internal instances (`tautulli-k8plex` and the plexops one) ALSO get the Authentik front door**, owner-directed (near-verbatim): "you can handle the other two tautullis without me save a few 1Password items for the http login creds." They stay on their internal `haynesops.com` ingress per **D-11** (Q-03 constraint) — only the auth redirect is public. Default access policy **admins-only** (they are ops surfaces; the family-facing pilot stays admins + Family per Q-02) — a default the owner can widen. Creds gated on two HaynesKube 1Password items: `tautulli-k8plex`, `tautulli-plexops` (username + password each). |
| Q-09 | **Authentik Plex source — allowed servers (owner-raised 2026-07-17):** the source was set up allowing anyone with access to HaynesTower to authenticate; new members will be shared on HOps going forward, so an HOps-only member CANNOT log in until HOps is in the source's allowed-servers list. Which servers define the SSO trust boundary? | **RESOLVED (owner, 2026-07-17): ALL THREE servers allowed** — owner applied the edit in the Authentik UI himself. Reasoning (near-verbatim): My Plex self-service lets members add/remove themselves from libraries, and a member who removes all but one library must not lose SSO — so the trust boundary is any-of-the-three, deliberately. Machine ids per the repo-pinned `PLEX_MACHINE_IDENTIFIERS`. |

## Amendment — 2026-07-17: role-governed app login (owner direction)

The owner extended this design's access story (near-verbatim): "take it one level up and use
the apps assigned to roles to govern which apps not only show up for users but which Authentik
will let them log into. We would have to make all Roles synced tier but I think that's
something I want anyway."

**The mechanism:** the app's role→app-catalog grants (the `/admin/roles` Apps chips) become the
SINGLE source of truth for per-app LOGIN authorization, enforced Authentik-side:

1. **Every role becomes a synced tier** (PLAN-026 machinery — role ⇒ Authentik group of the
   same lowercased name; Friends and Family already are; Default and future roles follow).
2. **Each Authentik application gets group-bound access policies** matching exactly the roles
   whose grant list carries that app. A user whose role loses an app chip stops being able to
   LOG IN to it, not merely stops seeing the card.
3. **Tautulli is the pilot** (Q-02 ruling): proxy provider + application with bindings for the
   admins group + `family` only.
4. **Follow-ups (not the pilot):** flip Default (and any future roles) to synced tier; then
   design the grant→policy SYNC — the app already writes group membership via
   `@hnet/authentik/write` (ADR-045); pushing application policy bindings from the catalog
   grants is a new confined write surface that needs its own ADR (the ADR-045 owned-groups
   guardrail idiom extends: only bindings for OWNED apps/groups, never flows/stages).

This supersedes nothing above; it upgrades the D-07 Tautulli front door from a one-off into
the first instance of the general pattern.

## Amendment — 2026-07-20: owner rulings close Q-03..Q-08; design Accepted

The owner ruled on the remaining open questions. With Q-01..Q-09 all resolved or assumed-accepted,
this design advances **Draft → Proposed → Accepted** (per the doc lifecycle) as of 2026-07-20.
Q-06 is **resolved-as-deferred** (D-08 stays the deferred follow-up), which does not block
acceptance. The near-verbatim capture lives in the Open questions table; the rulings in brief:

- **Q-03 (scope) — catalog first, but keep expanding.** The aspiration is that *anything Authentik
  is used for* reaches true SSO over time (add OIDC where basic auth lives today), app-by-app in
  phase 2. This introduced a hard network constraint, codified as **D-11**: SSO for a LAN-only app
  must never move it onto a public ingress — the app keeps its internal `haynesops.com` ingress;
  only the auth redirect traverses the public Authentik (there is no local-only Authentik path yet,
  and Cloudflare tunnels mean `*.haynesnetwork.com` always resolves to the internet).
- **Q-04 (Immich) — Auto Launch, "trust but verify."** OAuth is already configured; verify the
  live config (incl. the mobile redirect URI), then flip Auto Launch (D-04).
- **Q-05 (OWUI) — take the deep-link** to `/oauth/oidc/login` now, revert-on-upstream (D-05).
- **Q-06 (Kavita role sync) — deferred** until the auto-login rollout soaks; owner supplies the
  tier table when ready (D-08 stays the deferred follow-up).
- **Q-07 (Plex cards) — assumed accepted** (presented as the default, owner unobjected): plex.tv
  identity IS the SSO identity (D-10).
- **Q-08 (Tautulli scope) — both LAN instances too.** `tautulli-k8plex` and `tautulli-plexops`
  also get the Authentik front door, on their internal ingress per D-11, default admins-only (ops
  surfaces), creds from 1Password `tautulli-k8plex` / `tautulli-plexops`.

**Process note (why this PR exists).** A prior Q-03 answer was captured in an uncommitted worktree
and **lost** when that worktree was cleaned up — the owner flagged it himself. This amendment is
the re-capture. It is the origin case of the standing "backlog/saga state must reach `main`" rule:
agent working state and doc rulings are never left untracked in a disposable worktree.

## Amendment — 2026-07-20 (evening): wave 1 AS-EXECUTED + the Authentik-only posture ruling

**The Authentik-only posture (owner ruling, binding, supplements D-01):** "we do not need local
admin when we have Authentik, I don't plan to use local accounts." Estate apps being
Authentik-hard-dependent (the Paperless posture) is ACCEPTED — no standing password logins or
local accounts are added as safety measures. The sanctioned escape hatches are admin API /
config-level reverts; pre-existing break-glass accounts (Kavita hnetadmin) remain OIDC-down
emergency fallbacks only.

**D-04 Immich — EXECUTED.** Live OAuth verified correct first (issuer, client, `immich_role`
claim, mobile `app.immich:///oauth-callback` already registered on Authentik provider pk 39 —
which is deliberately NOT blueprint-managed, per the blueprints README's OIDC deferral), then
`oauth.autoLaunch=true` via the admin API (the key rides `homepage-secret`). Zero-click proven
(unauth authorize → Authentik). `?autoLaunch=0` stops the redirect but `passwordLogin` stays
false — SSO-only per the posture ruling above. Revert = `PUT /api/system-config
oauth.autoLaunch=false`. Runtime-state note: the flip lives in Immich's own DB (survives pod
restarts; resets on a DB rebuild — re-flip then).

**D-05 Open WebUI — EXECUTED.** Catalog card URL updated via the audited `updateApp` production
writer: `https://ai.haynesnetwork.com` → `https://ai.haynesnetwork.com/oauth/oidc/login`
(audit row recorded; the OLD url is the documented revert value). Verified: the deep-link 302s
into Authentik authorize with the `groups` scope intact (group sync preserved).

**D-07/Q-08 LAN Tautulli front doors — INFRA LIVE, ARM PENDING (owner).** haynes-ops #2176
merged: per-app proxy providers + applications + admins-only bindings + dedicated INTERNAL
outposts (the D-11 rule honored — apps stay on `*.haynesops.com`; only the auth redirect
traverses public Authentik, verified 302s in-cluster) + the Authorization-re-add twin
middlewares + ExternalSecrets off the 1Password Login items (no field quirks — top-level
`username`/`password` properties synced first-try). **Discovery that simplifies D-07:** both
in-cluster instances serve their UI OPEN today, so the forward-auth gate ALONE delivers
admins-only zero-click — the HTTP-Basic injection wiring is staged but DORMANT (optional
hardening; per the posture ruling it stays dormant unless a real need appears). **The arm step
is haynes-ops #2177 (draft, "merge after arm")** — attaching the middlewares flips both hosts
from open-on-LAN to admins-only, and browser login is unverifiable from the pod, so the owner
marks it ready + merges, then LAN click-tests both hosts (zero-click through Authentik as an
admin; access-denied as non-admin).

## Sources (external capabilities, verified 2026-07-17)

- Seerr OIDC state: <https://github.com/seerr-team/seerr/pull/2715> (open),
  <https://github.com/seerr-team/seerr/discussions/2721> (preview status/limitations),
  <https://github.com/seerr-team/seerr/pull/1505> (closed unmerged); releases page (v3.3.0
  latest, 2026-06-02).
- Tautulli: <https://docs.tautulli.com/support/frequently-asked-questions> (auth cannot be
  disabled in Docker installs; blank-credentials caveat),
  <https://integrations.goauthentik.io/media/tautulli/> (proxy provider + HTTP-Basic injection
  recipe), <https://github.com/goauthentik/authentik/discussions/6069>.
- Open WebUI: <https://docs.openwebui.com/features/authentication-access/auth/sso/> (env
  contract), <https://github.com/open-webui/open-webui/discussions/7337> (auto-redirect still
  unimplemented as of 2026-03).
- Kavita OIDC: <https://wiki.kavitareader.com/guides/admin-settings/open-id-connect/> (AutoLogin,
  Sync-user-settings semantics, `library-<Name>` / `age-restriction-<Rating>` tokens).
- Audiobookshelf: <https://www.audiobookshelf.org/guides/oidc_authentication/>
  (`authOpenIDAutoLaunch`, `?autoLaunch=0`) + OPS-012 (as-executed local record).
- Immich: <https://docs.immich.app/administration/oauth/> (OAuth, Auto Launch, role claim
  at-creation-only, mobile redirect URI).
