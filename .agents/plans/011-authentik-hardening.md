# PLAN-011: Authentik hardening — MFA for native accounts + haynesnetwork sign-in rebrand

- **Status:** Draft <!-- Fable 5 flips Draft → Executing → Completed -->
- **Satisfies:** PRD-001 new **R-NN** block (indicative **R-97..R-99** — native-account MFA,
  rebranded sign-in, no user-facing "Authentik"); new **ADR-NN** (indicative **ADR-026** —
  Authentik login hardening + brand: MFA-for-native-only policy, exemption group, config-as-API
  vs blueprints); new **OPS-NN** (indicative **OPS-007** — executed provisioning log, sibling of
  `docs/ops/001-authentik-provisioning.md`); **DESIGN-006 amendment** (new D-NN — the sign-in
  brand applies the existing hnet mark/type/shape language to the Authentik flow). Relates
  ADR-002 (Authentik OIDC only), DESIGN-002 D-09 (login-flow sequence,
  `docs/designs/002-auth-and-authentik.md:346`).
- **Depends on:** none (no app code/schema dependency). Queue position: after PLAN-006 and
  PLAN-012 per the owner's 2026-07-06 ordering — this plan touches only Authentik-side config +
  docs; it never blocks, and is never blocked by, the Trash work.
- **TODO source:** owner scope agreement 2026-07-06 (recorded in `.agents/HANDOFF.md` "Queue
  extended per owner").

> **ID reconciliation (Fable 5, do first):** the numbers above (ADR-026, OPS-007, R-97..) are
> *indicative placeholders* per `.agents/plans/README.md` §Cross-plan reconciliation. Ceilings at
> authoring (2026-07-06): ADR-024 on `main` **plus ADR-023 on the pending `feat/trash-section`
> branch** (so next free is 025+), DESIGN-010 (branch), R-87 (branch), T-74 (branch), OPS-006,
> migration 0016 (branch). PLAN-012 executes before this plan and consumes IDs first. Re-grep the
> live ceilings and take the next free numbers; IDs are stable once chosen (CLAUDE.md).

---

## Goal

Harden and de-brand the estate's front door. Three scoped outcomes (owner-agreed 2026-07-06):

1. **MFA enforcement for NATIVE Authentik accounts only.** Password-based local Authentik
   accounts (e.g. `akadmin`, any hand-created local user) must pass an authenticator
   (TOTP/WebAuthn) challenge at login. **Plex/external-source logins are exempt** — we cannot
   force MFA on an upstream identity provider (Plex owns that session), and challenging them
   locally would double-gate the household for no threat-model gain. A **documented exemption
   group** (working name `mfa-exempt`) carries the `hnet-e2e` validation accounts (created via
   `ak shell`; see `.agents/HANDOFF.md` "Key gotchas" #1) so live staging validation keeps
   automating without an authenticator seed.
2. **Rebrand the login as haynesnetwork.** Remove the word "Authentik" from every user-facing
   sign-in screen. Working name **"haynesnetwork sign-in"**. Mock **2–3 name/look options** and
   screenshot them for **owner approval before applying** (owner memory: distinct visual
   identity, screenshot approval). Reuse the hnet mark/colors/type — the brand-mark component
   (`apps/web/components/brand-mark.tsx`, DESIGN-006 D-01) is the source for the logo asset;
   apply the app's palette values, not demo-console's look.
3. **App-by-app SSO login verification is an OWNER task, not automated here.** Every catalog
   app behind Authentik (`grafana`, `seerr`, the *arrs, etc.) should be spot-checked to sign in
   through the rebranded/hardened flow — this plan **places that checkbox in PLAN-008's HARD
   GATE preconditions** (done in this docs PR) and hands the task to the owner. This plan's own
   validation covers the haynesnetwork journeys only.

Non-goal: no change to the app's Better Auth wiring, callback URIs, or session model — the
OIDC contract (OPS-001 table) is untouched; everything here is Authentik-side flow/stage/brand
configuration plus docs.

---

## Docs-first artifacts to author (same PR as the config change)

- **PRD-001** — new requirements block under the auth section (next free R-NN):
  native-Authentik-account logins require MFA (Must); external-source (Plex) logins are not
  locally challenged (Must); a documented exemption group exists for automation accounts
  (Must); user-facing sign-in screens carry haynesnetwork branding with no "Authentik" wording
  (Must).
- **New ADR (indicative ADR-026), MADR 3.0, author AND ratify to Accepted.** Decides:
  - MFA is enforced **in the authentication flow** for password-stage logins only — the
    enforcement point is the flow/stage graph, not per-user settings, so future native accounts
    are covered by default.
  - The **exemption-group mechanism** (policy bound to the authenticator-validation stage
    skipping members of `mfa-exempt`) and the rule that ONLY automation/validation accounts may
    live in it — membership changes are an owner action recorded in OPS-NN.
  - **Config mechanics — the plan's core open decision (Q-01):** API-applied + documented in
    OPS-NN (how OPS-001 did the provider) **vs** Authentik **blueprint files committed to
    haynes-ops** for GitOps drift-control. Record the choice + rationale.
  - The **brand identity** ruling: the sign-in surface is haynesnetwork-branded (name chosen
    from the owner-approved mock), sourced from DESIGN-006 tokens/mark.
- **New OPS doc (indicative OPS-007)** — the executed log, mirroring OPS-001's shape: what
  flows/stages/policies/groups/brand objects exist afterwards (names + pks), the API calls or
  blueprint files that made them, credential/token locations (the Authentik API token lives in
  the 1Password `homepage` item, `AUTHENTIK_API_TOKEN` — OPS-001 §How to re-provision, incl.
  the Cloudflare user-agent 1010 gotcha), and the rollback steps.
- **DESIGN-006 amendment (new D-NN, do not renumber)** — the sign-in brand: chosen name, logo
  asset derivation from `brand-mark.tsx`, background/color treatment, and the 2–3 mock options
  presented (keep the losing mocks in the doc as the decision record).
- **Glossary** — add only if new terms stick (e.g. **Native account**, **MFA exemption
  group**); next free T-NN.

---

## Data model / app code

**None.** No `packages/db` change, no migration, no tRPC/UI change, no guard-list edits. The
app's only auth surface is the Better Auth generic-OAuth round-trip (DESIGN-002 D-09), which is
agnostic to Authentik's internal flow graph and brand. Stated explicitly so no slice gets
invented. (If a login-page copy tweak is wanted to echo the new sign-in name, it is a one-line
`apps/web` text change — optional, owner call at screenshot time.)

---

## Authentik configuration (the actual behavior change)

Authentik 2026.5.3 (OPS-001). Applied via the API or blueprints per Q-01; every object recorded
in OPS-NN. Indicative shape (verify names against the live instance before touching anything):

1. **MFA stage + flow wiring** — an Authenticator Validation stage (TOTP + WebAuthn device
   classes; enrollment prompt on first challenge) inserted into the **password authentication
   flow** after the password stage. Because external-source logins (Plex OAuth source) enter
   via the source's authentication and do not traverse the password stage the same way, they
   are structurally outside the challenge path — **verify this live** (Q-02) rather than
   assuming; if the shared flow does challenge source logins, bind a skip policy on
   source-authenticated pending users.
2. **Exemption group** — create `mfa-exempt`; bind an expression policy on the
   authenticator-validation stage binding that skips members. Add `hnet-e2e` (and any sibling
   validation accounts) to it.
3. **Brand** — Authentik Brand object for the login domain: branding title = the owner-approved
   name (working: "haynesnetwork sign-in"), logo + favicon from the hnet mark, flow background
   per the approved mock; strip "Powered by authentik" footer per brand/custom-CSS support on
   2026.5 (verify the supported mechanism — Q-03). No user-facing "Authentik" remains on the
   login, MFA, or consent screens (consent is implicit per OPS-001, so normally unseen).
4. **Mocks first** — before applying, produce 2–3 name/look candidates (screenshots of a
   staging brand or local render) and get owner approval. Only then apply to the live brand.

**Blast-radius warning:** the authentication flow and brand are **shared by every app behind
this Authentik** (Grafana, Seerr, *arrs…). Changes must be additive and reversible; test with a
throwaway native account before binding the stage to the default flow. This is also why scope
(3) exists — the owner walks the other apps afterwards (PLAN-008 HARD GATE checkbox).

---

## Open decisions (record as ADR-NN Q-NN)

- **Q-01 — API-applied vs blueprints-in-haynes-ops.** API + OPS log matches OPS-001 precedent
  and is fastest; blueprints give GitOps drift-control for a surface that is now
  security-relevant. Decide and record; if blueprints, they live in haynes-ops next to the
  Authentik deployment, and OPS-NN links them.
- **Q-02 — Verify the exact flow topology that exempts source logins.** Which flow do Plex-source
  logins traverse on this install, and does the authenticator stage sit where only
  password-stage logins hit it? Decide the skip-policy shape from live evidence.
- **Q-03 — Brand mechanism for removing "Authentik" wording** on 2026.5.3 (brand fields vs
  custom CSS vs flow-title text) — pick the least-hacky supported one.
- **Q-04 — Sign-in name** — "haynesnetwork sign-in" vs alternatives; owner picks from the
  mocks (screenshot approval is the gate).
- **Q-05 — akadmin handling** — the 1Password `AUTHENTIK_BOOTSTRAP_PASSWORD` is known-stale
  (HANDOFF gotcha #1). Decide whether this plan rotates/repairs the akadmin credential (it is
  the archetypal native account MFA now protects) or logs it as an owner task in OPS-NN.

---

## Verification

Merge gate on the docs/PR side as usual (`pnpm lint && pnpm lint:css && pnpm typecheck &&
pnpm test && pnpm build` — must not regress even for a docs+config plan).

**LIVE journeys on staging (`https://haynesnetwork.haynesops.com`) + the real Authentik:**

1. **Member (Plex-source) journey — NO MFA prompt.** A Plex-backed login lands on the
   dashboard with **no authenticator challenge** anywhere in the flow, and every screen
   traversed shows the approved haynesnetwork branding with no "Authentik" wording.
2. **Native-account journey — MFA enforced.** A throwaway native Authentik account (created
   for the test, then removed) is challenged for authenticator enrollment/validation after its
   password and cannot reach a session without it.
3. **Exemption journey — e2e accounts still automate.** The existing LIVE Playwright sign-in
   (which authenticates as `hnet-e2e`) passes unchanged — the exemption group works and the
   full staging e2e suite stays green.
4. **Brand check** — screenshot the login + MFA screens at phone width (390px) and desktop;
   owner-approved look matches; attach to OPS-NN.

---

## Definition of Done

- Owner approved a mock (screenshot) BEFORE the brand was applied.
- MFA stage + exemption group live; brand applied; all four LIVE journeys pass.
- ADR ratified Accepted; OPS-NN executed log written; PRD block + DESIGN-006 D-NN + glossary
  landed in the same PR; merge gate green; squash-merged.
- PLAN-008's HARD GATE carries the owner's app-by-app SSO verification checkbox (landed with
  this plans-docs PR; the owner works it before 008 starts).
- Plan marked Completed and `git mv`'d to `.agents/plans/completed/`.

---

## Out of scope

- Forcing MFA on Plex/upstream identities (impossible from here; Plex owns its own 2FA).
- Automated SSO verification of the other catalog apps (owner task; PLAN-008 precondition).
- Any Better Auth / app-session change; any redirect-URI change (OPS-001 table untouched).
- A general Authentik upgrade or policy overhaul beyond the two scoped changes.

---

## Rollback

No app deploy is involved, so rollback is Authentik-side only and cheap: unbind the
authenticator-validation stage from the flow (or revert the blueprint commit in haynes-ops if
Q-01 chose blueprints) and restore the prior brand object values (recorded in OPS-NN before the
change). The exemption group is harmless to leave. Verify by re-running LIVE journey 3 (e2e
sign-in) after the revert.
