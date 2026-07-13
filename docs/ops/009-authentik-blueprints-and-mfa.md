# OPS-009: Authentik config-as-code (blueprints) + native-account MFA — executed log

- **Status:** Executed 2026-07-10 (Authentik 2026.5.3), owner-present. Live-verified.
- **Decision:** ADR-042 (blueprints as the config mechanism; resolves the original Q-01).
- **Requirements:** PRD R-133..R-136. **Glossary:** DDD-001 T-121..T-123.
- **Sibling of:** OPS-001 (the API-provisioned OIDC provider — still API-managed, Q-11) and
  `docs/ops/authentik-apply-seed/` (the branding-era API seed this migration formalizes).

This is the as-executed record for PLAN-011 round 2: migrating the haynesnetwork Authentik login
estate to **config-as-code blueprints** in `haynes-ops`, then enabling **native-account MFA** on
top of the drift-zero baseline. Everything below was verified live on 2026-07-10.

## What exists (blueprints + the objects they manage)

Blueprints live in the sibling repo at
`haynes-ops/kubernetes/main/apps/network/authentik/app/blueprints/` and are delivered to the
Authentik **worker** as a ConfigMap (see "Delivery" below). Four are discovered + applied:

| Blueprint file | `metadata.name` | Concern | Managed objects (name / pk) |
|---|---|---|---|
| `10-hnet-brand.yaml` | `hnet-brand` | Brand | Default brand (`brand_uuid de1b7109-2d4d-466c-8890-326e969015d5`) — title `haynesnetwork`, logo/favicon/background media paths, ~70 KB custom CSS. |
| `20-hnet-flows.yaml` | `hnet-login-flows` | Flows + stages + bindings + flow policies | `default-authentication-flow` (`c8e7b494-…`), `default-source-authentication` (`67b51e33-…`), `default-source-enrollment` (`f80cd9b5-…`), `default-invalidation-flow` (`8ba7e7a7-…`) with their full stage/policy graph. **Excludes** the order-30 MFA stage + binding (owned by `40`). |
| `30-hnet-sources.yaml` | `hnet-sources` | Sources | Plex OAuth source `HaynesTower` (`2c61a5af-…`), non-secret fields only — `plex_token` omitted so the partial-update never touches the live secret. |
| `40-hnet-mfa.yaml` | `hnet-mfa-enforcement` | Native-account MFA | Group `mfa-exempt`; expression policy `hnet-mfa-exempt-skip`; the order-30 authenticator-validation stage `default-authentication-mfa-validation` (`3cdaa8fa-be22-415b-aac6-df08662a1c88`); its flow-stage-binding (`3640815a-20a1-43fc-ba39-c5624329ea94`); the exempt policy-binding (`5415acce-c247-4a43-b458-10c969fe72dc`); friendly names on the WebAuthn + TOTP setup stages. |

**Live status (verified 2026-07-10, `GET /api/v3/managed/blueprints/`):** all four report
`status: successful` — `hnet-brand`, `hnet-login-flows`, `hnet-sources`, `hnet-mfa-enforcement`.
The MFA stage reads back `not_configured_action: configure`, `device_classes: [totp, webauthn]`,
`webauthn_user_verification: preferred`.

### Q-02 evidence — Plex-source logins are structurally never MFA-challenged

Verified against the exported flow graph (in the PR #2014 description with flow pks): a "Log in
with Plex" login traverses **`default-source-authentication`**, which binds a **single order-0
`user_login` stage** (`default-source-authentication-login`, `d81d77d2-…`) gated only by the
`ak_is_sso_flow` policy — **no password stage, no authenticator-validation stage**. MFA lives only
in `default-authentication-flow` (the native username+password path). So a Plex identity, and even
a *native* user who clicks the Plex button, is never challenged — matching owner requirement #2.
The live rehearsal confirmed this (the `hnet-e2e` exemption test below).

## Delivery (kustomize → ConfigMap → worker mount → discovery)

```
configMapGenerator (kustomize)  ->  ConfigMap authentik-hnet-blueprints  (disableNameSuffixHash)
        |  files: 10/20/30/40-*.yaml            |  helmrelease values.blueprints.configMaps
        v                                       v
   git (blueprints/ dir)          worker /blueprints/mounted/cm-authentik-hnet-blueprints/  -> apply
```

`app/kustomization.yaml` `configMapGenerator` bundles the four files into ConfigMap
`authentik-hnet-blueprints`; `app/helmrelease.yaml` lists that ConfigMap under
`values.blueprints.configMaps`; the goauthentik chart mounts it onto the worker and the engine
discovers every `*.yaml` key. Confirm live:

```bash
CTX=haynes-ops ; NS=network
kubectl --context $CTX -n $NS get cm authentik-hnet-blueprints -o jsonpath='{.data}' \
  | tr ',' '\n' | grep -oE '"[0-9]+-[a-z-]+\.yaml"'   # -> 10/20/30/40 keys
kubectl --context $CTX -n $NS exec deploy/authentik-worker -c worker -- \
  ls /blueprints/mounted/cm-authentik-hnet-blueprints
```

## Apply / verify sequence (as executed 2026-07-10)

### Phase 1 (overnight, agent-safe — NO live writes)

Read-only export of the live estate via the Authentik API → drift-zero baseline blueprints
(`10`/`20`/`30`) + the drafted MFA blueprint parked in `pending/40-hnet-mfa.yaml`. Shipped as
**PR #2014** (haynes-ops), CI green, left unmerged. Zero POST/PUT/PATCH/DELETE against live.

### Phase 2 (owner-present)

1. **Merge the baseline** (`10`/`20`/`30`). Flux reconciled → the ConfigMap mounted onto the
   worker → the engine applied the discovered blueprints.
2. **Transient rollout error (expected, benign).** During the 3-worker Helm rollout the **initial
   brand apply errored once**; a **re-apply succeeded**. A single blueprint error mid-rollout is
   not a failure signal — confirm final status via the managed-blueprints API.
3. **Drift-zero PROVEN.** All three baseline blueprints report `successful`; the events log shows
   **zero `model_updated`** from the applies; the login page title stayed `haynesnetwork`. The
   baseline is a faithful mirror — applying it changed nothing observable.
4. **Promote MFA.** `git mv pending/40-hnet-mfa.yaml 40-hnet-mfa.yaml`, added it to the
   `configMapGenerator`, and **removed** the order-30 stage + its flow-stage-binding from
   `20-hnet-flows.yaml` (ownership rule — prevents the baseline `skip` and the MFA `configure`
   from flip-flopping on each reconcile). Committed as `a8bd665b`.

## Blueprint-iteration technique — validate before commit (`ak shell` dry-run)

There is **no offline `ak` validator binary** in this image, so the supported dry-run is the
worker's own importer, run in-process, asserting **`VALID=True`** before the commit Flux would
apply live:

```bash
kubectl --context haynes-ops -n network exec -it deploy/authentik-worker -c worker -- ak shell
```
```python
from authentik.blueprints.v1.importer import Importer
with open("/blueprints/mounted/cm-authentik-hnet-blueprints/40-hnet-mfa.yaml") as f:
    body = f.read()
importer = Importer(body)
valid, _logs = importer.validate()
print("VALID =", valid)   # must be True before committing the change
```

This dry-run caught **two real defects** during MFA promotion:

1. **`!KeyOf` against a partially-committed apply → switched to `!Find` by name.** The first apply
   committed the group + policy + policy-binding, then errored on a `!KeyOf` reference that
   couldn't resolve mid-transaction. Fix: reference the policy by a stable natural key —
   `!Find [authentik_policies_expression.expressionpolicy, [name, hnet-mfa-exempt-skip]]` — which
   is robust to partial state. (Commit `42347d80`.)
2. **PolicyBinding not matchable by `(target, policy, order)` → pin the existing pk.** A re-apply
   hit the `(policy, target, order)` unique constraint because **`PolicyBinding.target` is the
   internal `pbm_uuid`, not the `FlowStageBinding` pk** — so the importer tried to *create* a
   duplicate binding. Fix: pin the pre-created binding's `pk` (`5415acce-…`) in `identifiers`,
   baseline-style, so it updates in place. (Commit `42347d80`.) Validated `VALID=True` before the
   commit.

## Live rehearsal — enroll + challenge + exemption (throwaway account, since deleted)

Exercised headlessly via the flow-executor against a throwaway native account:

- **1st login:** forced **enrollment** (chooser with 2 options) → TOTP enroll → session.
- **2nd login:** TOTP **challenge** → code → session (response shape: `selected_challenge` + `code`).
- **`hnet-e2e` login:** **NO challenge** — exemption proven (member of `mfa-exempt`).

Final live stage config: `not_configured_action: configure`, `device_classes: [totp, webauthn]`,
`webauthn_user_verification: preferred`; the order-30 binding is `policy_engine_mode: all` (the
shipped webauthn-passwordless skip policy AND the exempt-skip policy must both pass to run the
stage); the exempt policy-binding is at `order: 20` with `failure_result: true` (**fail-closed** —
a policy error enforces MFA rather than skipping it). The throwaway account was deleted after.

## Owner enrollment + ruling

- **thaynes** enrolled a **WebAuthn passkey** (`WebAuthnDevice` "1Password", confirmed) as the
  primary factor + a **TOTP** backup; round-trip login verified.
- **OWNER RULING (2026-07-10):** thaynes' **Plex-source login path is ACCEPTED as-is** — Plex's own
  2FA covers it. Native MFA guards the **username+password path only**; the app never double-gates
  a Plex identity (owner requirement #2).
- **Friendly enrollment names** (owner feedback, commit `58355768`): the device chooser shows
  **"Passkey (recommended)"** and **"Authenticator app (6-digit codes)"** instead of the stock
  "WebAuthn device" / "TOTP Device" (confusing to non-technical local users).

## Client-side caveat (known, NOT a server issue)

**Safari / WebKit on macOS failed the TOTP-setup flow twice** — first "The string did not match
the expected pattern", then fetches that never reached the server. The Authentik server was
**verified healthy throughout** (Chrome completed the same enrollment first try). Treat this as a
**client caveat**: enroll TOTP in Chrome (or another Chromium browser) if Safari stalls. WebAuthn
passkey enrollment was unaffected.

## Credential locations

| Credential | Where it lives | Notes |
|---|---|---|
| `AUTHENTIK_API_TOKEN` | 1Password `homepage` item (`AUTHENTIK_API_TOKEN`); in-cluster `kubectl get secret homepage-secret -n frontend -o jsonpath='{.data.HOMEPAGE_VAR_AUTHENTIK_API_TOKEN}' \| base64 -d` | Read/apply token. Cloudflare fronting `authentik.haynesnetwork.com` bans Python's default UA (error 1010) — send `User-Agent: curl/8.5.0` (OPS-001). |
| `AUTHENTIK_BOOTSTRAP_PASSWORD` (akadmin) | 1Password (`HaynesKube` vault) — **now valid** | Was stale (the HANDOFF gotcha). Rotated via `ak` shell on 2026-07-10; owner updated 1Password. akadmin is a recoverable break-glass account and will **MFA-enroll on its next interactive login**. |
| `hnet-e2e` / `hnet-e2e-member` passwords | 1Password (owner-stored) | Rotated 2026-07-10; both are in the `mfa-exempt` group (no challenge, Playwright stays green). |
| `plex_token` (HaynesTower source) | Not in git; lives in Authentik | `30-hnet-sources.yaml` omits it — the partial-update never touches the live secret. |
| Provider `client_secret` (pk 109) | 1Password `haynesnetwork` item | Provider stays API-managed (OPS-001); not blueprinted (Q-11). |

Service accounts for the **ak-outpost** are **unaffected** — they use no interactive flow, so MFA
does not apply to them.

## Rollback

- **Baseline (`10`/`20`/`30`):** revert the commit. Because it is drift-zero, reverting also
  changes nothing live — the objects simply stop being managed as code. Brand/flow *content*
  rollback to stock Authentik remains the API payloads in
  `docs/ops/authentik-apply-seed/` (`brand-rollback.json`, `flow-titles-rollback.json`).
- **MFA (`40`):** two paths, rehearsed conceptually and documented in the blueprints' README:
  - **Fast (live):** `ak` shell / API — set the order-30 stage `not_configured_action` back to
    `skip` (or delete the exempt policy-binding). Pre-MFA behavior returns immediately.
  - **Config:** revert the promotion commit `a8bd665b` — moves `40-hnet-mfa.yaml` back to
    `pending/`, drops it from the `configMapGenerator`, and restores the two owned entries in
    `20-hnet-flows.yaml`.

## Follow-ons / open

- **Q-10:** akadmin post-repair policy — keep as break-glass **with** MFA (current), or disable
  interactive login entirely and rely on `ak` shell recovery. Owner's call.
- **Q-11:** adopt the OIDC provider/application (pk 109) into blueprints for full GitOps, or leave
  them API-managed (OPS-001). Provider secrets stay in 1Password either way. A sanitized snapshot
  lives in the sibling repo's `exports/` for reference.

## 2026-07-13 amendment — old-WebKit login crash: compat-mode workaround (partial) + PLAN-042

- **Live deviation from the drift-zero baseline:** `compatibility_mode: true` on all four flows in
  `20-hnet-flows.yaml` (haynes-ops `571c7a65`) + a brand-CSS specificity pass so the brand green
  survives the ShadyDOM polyfill (`0d9699a`, `10-hnet-brand.yaml`; `!important` on the
  load-bearing declarations — a no-op under native rendering).
- **Why:** the authentik ≥2025.12 flow interface crashes OLD WebKit's renderer (iOS/iPadOS
  ~16.6–18.3.x, macOS Safari ~17.6) — upstream goauthentik#19814; TRUE root cause is **native CSS
  nesting** in the web bundles hitting WebKit bug **#290102** (style-invalidation over a freed
  `StyleRuleNestedDeclarations` selector list; native crash, no console errors). Compat mode fixed
  Playwright's WebKit builds but **does NOT cover real old-WebKit devices** — the crash is
  CSS-engine-level. Current-OS WebKit is fixed upstream.
- **Known compat-mode side effects (accepted meanwhile):** identification-stage Plex-first
  ordering + divider are inert (local form renders above the Plex button, correctly
  de-emphasized); the Safari TOTP-enrollment caveat (§ above) likely shares the #19814 root cause.
- **Disposition:** `.agents/plans/042-*.md` owns the resolution — Option A (post-process the
  served web assets with CSS-nesting lowering; upstream-RCA-verified recipe), Option B (upstream
  watch / contribute the fix), Option C (affected users update their OS). Compat mode reverts as
  part of whichever lands.
