# PLAN-008: haynesnetwork public cutover via Cloudflare Tunnel

- **Status:** `Completed (2026-07-07) — EXECUTED: haynesnetwork.com + www live via Cloudflare Tunnel; apex auth round-trip + permissioned surfaces validated; www→apex 301; DDNS retired; staging kept warm. Owner authorized go-live ahead of the 011 MFA/branding gate (owner does MFA tonight; Authentik was already public).` See `docs/ops/005-root-domain-cutover.md` for the executed log (four coupled `haynes-ops` commits ea457b43..c9935b9b; three gotchas: Traefik v3 Host syntax, cloudflare-ddns record ownership, Flux envsubst `${1}`).
- **Satisfies:** PRD-001 R-64 (`docs/prds/001-haynesnetwork.md:133` — claim `haynesnetwork.com` + `www` after e2e passes against staging), R-63 (`:132`), R-14-as-amended by ADR-013 (`:70`); executes OPS-005 (`docs/ops/005-root-domain-cutover.md`); ADR-006 C-03 (the "pure manifest change").
- **Depends on:** PLAN-002, PLAN-003, PLAN-004, PLAN-005, PLAN-006, **PLAN-012 and PLAN-011** (queue extended by the owner 2026-07-06) — **all Completed AND live-validated** (in `.agents/plans/completed/`). PLAN-007 (cosign) is NOT a blocker but SHOULD land first so the public image is signed. PLAN-013/014 are deliberately **post-cutover** and do not gate this plan.
- **TODO source:** backlog O-1 / "root-domain cutover per R-64 gates on Phase 1 e2e" (`docs/prds/001-haynesnetwork.md:172`).

---

## ⛔ HARD GATE — DO NOT START THIS PLAN UNTIL EVERY LINE IS TRUE

**THIS PLAN RUNS LAST.** Fable 5 must not touch it until the feature work is done, merged,
deployed, and validated against real backends. Verify each item *by inspection*, not by
assumption:

- [ ] PLAN-002, 003, 004, 005, 006 each moved to `.agents/plans/completed/` with a Completed
      status line (`git log --oneline -- .agents/plans/completed/` shows the `git mv`s).
- [ ] Phase-1 e2e is green **against staging** (`haynesnetwork.haynesops.com`) — the sign-in
      round-trip, dashboard, and catalog specs plus every spec the feature plans added. This is
      the literal R-64 gate (`docs/prds/001-haynesnetwork.md:133`) and OPS-005's first gate
      checkbox (`docs/ops/005-root-domain-cutover.md` §Gate).
- [ ] `main` is clean and the latest staging image is deployed and healthy (`/api/health` 200 on
      `haynesnetwork.haynesops.com`).
- [ ] **OWNER task (added 2026-07-06 by PLAN-011 scope):** after PLAN-011's Authentik changes
      (native-account MFA + the haynesnetwork sign-in rebrand), the owner has verified
      **app-by-app SSO login** for each catalog app behind Authentik (Grafana, Seerr, the *arrs,
      …) through the changed flow. Manual, not automated — do not cut over on an unverified
      shared login flow.

If any box is unchecked, **stop and pick the next-lowest active plan instead.** A broken cutover
takes the whole app offline for real users, unlike a feature bug behind the LAN ingress.

---

## Goal

Move haynesnetwork off the LAN-only staging ingress (`haynesnetwork.haynesops.com` /
`traefik-internal`) onto the **public root domain** `haynesnetwork.com` + `www.haynesnetwork.com`,
served through the existing in-cluster **Cloudflare Tunnel** → `traefik-external`, with a valid
public certificate and Better Auth callbacks/cookies scoped to the public origin. Sign-in must
work end-to-end on the public origin; the internal host must keep working throughout the change
window and may be retired only after public sign-in is proven.

This is almost entirely a **sibling-repo (`haynes-ops`) + external-systems** change. The
**haynesnetwork repo** change is **docs-only** (OPS-005 executed-log update; optional ADR-016;
this plan → Completed). No app product code, no schema, no tRPC, no UI.

---

## Docs-first artifacts to author (this repo, in the SAME PR)

Per `docs/PROCESS.md` (PRD → ADR → DDD → design → plan → code → tests). Behavior here lives in
`haynes-ops`, but the *record of it* is OPS-005 and (if a decision is made) an ADR — both land in
the haynesnetwork repo alongside marking this plan Completed.

1. **`docs/ops/005-root-domain-cutover.md` — rewrite from plan to executed log.**
   OPS-005 is an ops runbook, **not** an immutable ADR, so it is edited in place (contrast the
   ADR immutability rule, CLAUDE.md "Documentation-first process"). Concretely:
   - Flip the top `Status:` from `NOT YET DONE` to `DONE <date> — public root domain live via
     Cloudflare Tunnel; staging host retired/kept per §Sequence`.
   - Add a **`## Cloudflare Tunnel specifics`** section documenting the **apex-routing gap and its
     fix** (see Data/Infra below): the tunnel `config.yaml` ingress rule is today the single-label
     wildcard `*.haynesnetwork.com`
     (`haynes-ops kubernetes/main/apps/network/cloudflare-tunnel/app/helmrelease.yaml`
     `values.configMaps.config.data.config.yaml`), which matches `www.haynesnetwork.com` but
     **NOT** the bare apex `haynesnetwork.com` (a `*` label matches exactly one label) — so the
     apex falls through to `http_status:404` unless an explicit apex rule is added. Record the
     exact rule shipped and why.
   - Fill in the **actual executed values**: the ingressroute diff, the `BETTER_AUTH_URL` value,
     the DNS records external-dns published, the tunnel UUID in play
     (`dbefa0b0-...cfargotunnel.com` per `cloudflare-tunnel/app/dnsendpoint.yaml`), the certificate
     name/Ready timestamp, and the Authentik verify result.
   - Update **§Verify** and **§Rollback** checkboxes to reflect what was actually run (keep the
     coupled two-file — now possibly three-file — revert instruction).

2. **ADR-016 (NEW, only if a real decision is made) — "Cloudflare Tunnel apex routing for the
   public root domain."** MADR 3.0, next free number after ADR-015
   (`docs/adrs/015-no-layout-reorientation-on-interaction.md`). Fable 5 is authorized to author
   **and Accept** it. Decision it resolves (**C-01**): how the apex `haynesnetwork.com` reaches
   `traefik-external` given the wildcard-only tunnel ingress — options: (a) add an explicit
   `hostname: "haynesnetwork.com"` rule to the tunnel `config.yaml` alongside the wildcard;
   (b) broaden to a two-entry list; (c) 301 apex → `www` at Cloudflare and only serve `www`.
   Recommended: (a), keeping the bare apex canonical to match `BETTER_AUTH_URL` (OPS-005 already
   picks the bare root as the single cookie/callback origin). If Fable 5 instead finds the apex
   already routes (e.g. Cloudflare "CNAME flattening" + an existing catch-all), **no ADR is
   needed** — record that finding as a `Q-NN` note in OPS-005 and skip ADR-016. Do not mint an ADR
   for a non-decision.

3. **Glossary (`docs/domain-driven-design/001-ubiquitous-language.md`) — add only if missing:**
   "**Public origin**" (`https://haynesnetwork.com` — the canonical Better Auth origin post-cutover)
   and "**Cloudflare Tunnel**" (outbound in-cluster connector fronting `traefik-external`; removes
   inbound WAN reachability). These are new terms this change introduces to the app's docs; add
   them in the same PR per the normative-glossary rule (CLAUDE.md).

No PRD requirement text changes (R-64 already describes exactly this); no new DESIGN doc (no UI /
domain surface). No new `D-NN`.

---

## Data model / schema

**None.** No `packages/db` tables, no `enums.ts`, no guard-list changes
(`packages/domain/__tests__/no-direct-state-writes.test.ts`), no import-confinement changes
(`packages/domain/__tests__/arr-write-import-guard.test.ts`). This plan touches zero rows and zero
domain writers. Called out explicitly so Fable 5 does not go looking for a slice to build.

---

## Infra changes (sibling `haynes-ops` repo — the actual behavior change)

All under `kubernetes/main/apps/frontend/haynesnetwork/app/` unless noted. **Coupled — commit
together, one conventional commit, per OPS-005's "Ship the pair in one commit" rule** (extended to
the tunnel file if touched).

1. **`ingressroute.yaml`** — swap staging → public, exactly the OPS-005 §"Change set 1" table:
   - annotation `external-dns.alpha.kubernetes.io/target`: `internal.haynesops` →
     `ingress-ext.haynesnetwork.com`
   - annotation `kubernetes.io/ingress.class`: `traefik-internal` → `traefik-external`
   - `spec.routes[].match`: `` Host(`haynesnetwork.haynesops.com`) && PathPrefix(`/`) `` →
     `` Host(`haynesnetwork.com`, `www.haynesnetwork.com`) && PathPrefix(`/`) ``
   - `spec.tls.secretName`: `certificate-haynesops` → `certificate-haynesnetwork`
   - `entryPoints: [websecure]` and the `services` block (`haynesnetwork:3000`) unchanged.
   - The `traefik-proxy` external-dns source publishes `haynesnetwork.com` + `www` as proxied
     CNAMEs → the annotation target `ingress-ext.haynesnetwork.com`
     (per `haynes-ops docs/standardization/cloudflare-tunnel.md` §Background); this is how DNS
     appears — no hand-edited zone records. `ingress-ext.haynesnetwork.com` itself is the CNAME to
     the tunnel (`cloudflare-tunnel/app/dnsendpoint.yaml`).

2. **`externalsecret.yaml`** — `target.template.data.BETTER_AUTH_URL`:
   `"https://haynesnetwork.haynesops.com"` → `"https://haynesnetwork.com"` (the literal at the
   `# STAGED ROLLOUT` comment). `stakater/reloader` restarts the pod on
   `haynesnetwork-secret` change — no manual bounce (OPS-005 §"Change set 2"). Keep it a template
   literal (the 1Password-promotion is explicitly optional in OPS-005).

3. **`../../../network/cloudflare-tunnel/app/helmrelease.yaml`** — **apex fix (the gap).** In
   `values.configMaps.config.data.config.yaml`, add an explicit apex `ingress` entry *before* the
   wildcard so the bare `haynesnetwork.com` routes to `traefik-external`:
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
   Only ship this if Fable 5 confirms the apex is otherwise unreachable (see Open Decisions).
   This edits a **shared network component** other apps depend on — the wildcard entry must not be
   removed or reordered relative to `http_status:404`. If touched, it joins the coupled commit.

4. **Authentik redirect URIs — verify, expect no-op.** OPS-001
   (`docs/ops/001-authentik-provisioning.md:15`) already lists all four callbacks incl.
   `https://haynesnetwork.com/api/auth/oauth2/callback/authentik` and the `www` variant (strict
   match, path `{origin}/api/auth/oauth2/callback/authentik`). Confirm in the Authentik UI
   (Providers → *haynesnetwork* → Redirect URIs); add any missing one; **leave staging + localhost
   URIs in place** so rollback needs no second Authentik edit.

**Certificate:** `certificate-haynesnetwork` must exist in ns `frontend` and be `Ready` before the
ingress flip (OPS-005 §Gate). cert-manager issues via **ACME DNS-01 through Cloudflare** (tunnel
doc §0.3), so issuance does **not** depend on inbound HTTP — safe behind the tunnel. If the
Certificate resource does not yet exist, create it in the same `app/` kustomization (mirror a
sibling `*.haynesnetwork.com` app's `certificate.yaml`) and wait for Ready before flipping.

---

## Sequence (avoid an auth-broken window)

The failure mode OPS-005 warns about: ingress serves the public host while `BETTER_AUTH_URL` still
names the old origin (or vice-versa) → callback/cookie origin mismatch → **every sign-in fails**.
Because both live in one Flux reconcile, ship them atomically:

1. **Pre-flight (read-only, no change):** confirm `certificate-haynesnetwork` Ready; `traefik-external`
   healthy (another `*.haynesnetwork.com` app answers publicly); tunnel pods Ready
   (`cloudflare-tunnel` 2/2, `/ready` on `:8080`); Authentik URIs present; apex-routing decision made.
2. **Commit** the coupled set (ingressroute + externalsecret [+ tunnel helmrelease if apex fix]) to
   `haynes-ops`, merge per that repo's flow.
3. **Reconcile Flux once** (OPS-004): `flux reconcile kustomization <ks> --with-source`. ExternalSecret
   refreshes `haynesnetwork-secret` → reloader restarts the pod with the new `BETTER_AUTH_URL`;
   Traefik picks up the new IngressRoute; external-dns publishes the public records; the tunnel
   picks up the new `config.yaml` (its own `reloader.stakater.com/auto` restart). One reconcile,
   both halves — no intermediate mismatched state persisted.
4. **Do NOT remove** the localhost/staging Authentik URIs; **do NOT** delete the staging Certificate
   or `internal.haynesops` DNS until §Verify passes — that is the rollback path.
5. Staging-host retirement (deciding whether `haynesnetwork.haynesops.com` should stop routing) is a
   **follow-up** after public sign-in is proven, not part of the atomic flip.

---

## API / Domain / UI / Client

**None of the above.** No routers, no procedures, no pages, no components, no `@hnet/*` package
changes, no e2e stub (no new external system reaches the app — Cloudflare/Traefik/Authentik are all
already-modeled infra; the app is oblivious to which ingress fronts it). Stated explicitly so Fable
5 does not spin subagents to build a slice that doesn't exist here.

---

## Open decisions Fable 5 must make (authorized to decide + record as ADR-016 / Q-NN)

1. **Are all prerequisites actually satisfied before flipping?** Independently verify (do not trust
   this doc's assumptions): public DNS for `haynesnetwork.com` + `www` resolves through Cloudflare to
   the tunnel; `certificate-haynesnetwork` exists and is Ready in ns `frontend`; `traefik-external`
   is the healthy public entrypoint; tunnel pods healthy; Authentik URIs present. Any gap →
   remediate in the same coupled commit (create the Certificate; add the URI) before flipping.
2. **Apex routing (ADR-016 C-01).** Confirm whether the bare apex `haynesnetwork.com` reaches
   `traefik-external` today. Given the wildcard-only tunnel `config.yaml`, the expectation is **no**
   — decide the fix (recommended: add an explicit apex `hostname` rule), ship it in the coupled
   commit, and ratify ADR-016. If it *does* already route, record why as a `Q-NN` in OPS-005 and skip
   the ADR.
3. **Canonical origin & www handling.** OPS-005 pins the bare root as the single `BETTER_AUTH_URL`
   origin. Decide whether `www` should 301→apex at Cloudflare (cleaner single-origin cookies) or be
   served directly by the same IngressRoute host list (current plan). Either is acceptable; record
   the choice. Do not split cookies across two live origins.
4. **Staging-host retirement.** After public sign-in passes, decide whether to retire
   `haynesnetwork.haynesops.com` now or keep it as a warm rollback target for a cool-down window.
   Recommended: **keep it** for at least the validation window; retire in a later trivial commit.

---

## Verification (the real acceptance bar — live, against production infra)

Merge-gate on the **haynesnetwork repo docs PR** is trivial but still required:
`pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build` green (docs-only diff —
must not regress). The substantive verification is **live**, post-reconcile:

1. **Public reachability through the tunnel:** `GET https://haynesnetwork.com/api/health` → 200 with
   a valid cert chained to `certificate-haynesnetwork` (not `certificate-haynesops`). Same for
   `https://www.haynesnetwork.com`. Confirm the response transited the tunnel (Cloudflare response
   headers present; no `523`).
2. **Full Authentik login round-trip on the public origin (the decisive check):** LIVE Playwright
   against **real** `https://haynesnetwork.com` — load `/` → redirect to
   `authentik.haynesnetwork.com` → authorize with a real account → land back authenticated on the
   public host with a session cookie scoped to `haynesnetwork.com`. This is what proves the
   `BETTER_AUTH_URL` flip matched the ingress (OPS-005 §Verify). Repeat starting from `www` per the
   www decision.
3. **Apex specifically:** navigating the bare `https://haynesnetwork.com` (not just `www`) returns
   the app, not `http_status:404` — the ADR-016 fix works.
4. **Internal host during/after:** `https://haynesnetwork.haynesops.com` still serves the app while
   the staging Certificate/DNS remain (rollback stays viable). Only after (1)-(3) pass is retirement
   even considered.
5. **Phase-1 e2e still green** post-cutover (re-point the suite's base URL to the public origin, or
   run the existing staging suite — both must pass; regressions block).
6. **A permissioned action end-to-end on the public origin** (e.g. load the dashboard + one
   feature-plan surface from 002-006) to confirm tRPC/session works through the tunnel, not just
   `/api/health`.

---

## Definition of Done

- Coupled `haynes-ops` commit (ingressroute + externalsecret [+ tunnel apex]) merged and Flux-reconciled.
- Certificate `certificate-haynesnetwork` Ready; Authentik URIs verified.
- All six Verification checks pass **live** against `https://haynesnetwork.com` + `www`, including a
  real Authentik round-trip and a real permissioned action; internal host still healthy.
- haynesnetwork-repo docs PR (OPS-005 executed-log rewrite [+ ADR-016 if minted] [+ glossary terms])
  merged with the merge-gate green.
- This plan marked **Completed** and `git mv`'d to `.agents/plans/completed/008-haynesnetwork-public-cutover.md`.
- Because this is the **last** queued plan, on completion the queue is drained — no "next plan".

---

## Out of scope

- Split DNS (LAN clients bypassing Cloudflare) — that's the tunnel doc's Phase 3, a separate
  `haynes-ops` effort (`docs/standardization/cloudflare-tunnel.md` §"With split DNS (Phase 3)").
- Any app product feature — 002-006 own those and gate this one.
- Cosign image signing — PLAN-007 (should precede, not blocked-on).
- Broader Cloudflare WAF/rate-limit/Zero-Trust access policy tuning on the public origin.
- Deleting the tunnel wildcard or reworking other apps' routing.

---

## Rollback

Single **revert commit** in `haynes-ops` reverting the **coupled set together** (OPS-005 §Rollback),
then one Flux reconcile:

- `ingressroute.yaml` → `traefik-internal` / `` Host(`haynesnetwork.haynesops.com`) `` /
  `certificate-haynesops` / target `internal.haynesops`.
- `externalsecret.yaml` → `BETTER_AUTH_URL: "https://haynesnetwork.haynesops.com"`.
- `cloudflare-tunnel/app/helmrelease.yaml` → drop the added apex rule (leave the wildcard +
  `http_status:404` intact — other apps depend on them).
- Authentik needs no rollback (staging + localhost URIs were never removed).

After reconcile, re-verify sign-in on `https://haynesnetwork.haynesops.com`. Because staging DNS,
the staging Certificate, and the staging Authentik URI were all left intact through the change
window, rollback restores a known-good origin with no external-system edits. Then re-open this plan
(Draft), diagnose, and re-attempt.
