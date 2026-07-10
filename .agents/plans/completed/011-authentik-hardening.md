# PLAN-011: Authentik hardening — blueprints/GitOps migration + native-account MFA

- **Status:** ✅ **COMPLETED (2026-07-10, owner-present).** Both phases delivered and live-verified:
  the Authentik login estate (brand · flows · sources · MFA) is config-as-code blueprints in
  `haynes-ops` (drift-zero baseline proven) and native-account MFA is enforced on the
  username+password path (WebAuthn passkey/TOTP, enroll on first challenge; `mfa-exempt` fail-closed;
  Plex-source logins never challenged — owner accepted `thaynes`' Plex path). Owner enrolled a
  1Password passkey + TOTP backup; akadmin/e2e credentials rotated + true in 1Password. Docs:
  **ADR-042 / OPS-009 / R-133..R-136 / T-121..T-123**; haynes-ops PR #2014 +
  `a8bd665b`/`42347d80`/`58355768`. Carried forward as owner open items: **Q-10** (akadmin interactive
  policy) and **Q-11** (blueprint the OIDC provider/app). Historical scope + as-executed detail below.
  <!-- Original round-2 rescope status preserved for the record: -->
  **Round 2 rescope (2026-07-10).** Branding was ✅ COMPLETE (2026-07-07/09: option C rebrand +
  Plex-primary login card + RP-initiated SSO logout, live; apply/rollback seed preserved at
  `docs/ops/authentik-apply-seed/`). Remaining scope, owner-ordered: **(1) blueprints-as-code makeover
  FIRST, (2) MFA for native accounts on top of it.** **Phase 1 (agent-safe, overnight): read-only
  export → blueprint files → drafted MFA blueprint, NOTHING applied to live Authentik. Phase 2
  (owner-present): apply + enroll + verify.**
- **Satisfies:** PRD-001 R-133..R-136 (native-account MFA; Plex-source pass-through; exemption
  group; config-as-code); ADR-042 (blueprints/GitOps as the Authentik config mechanism —
  resolves the original Q-01 in favor of blueprints per owner ruling 2026-07-08); OPS-009
  (executed log, sibling of OPS-001). Relates ADR-002, DESIGN-002 D-09, OPS-001,
  `docs/ops/authentik-apply-seed/` (the branding-era seed this migration formalizes).
- **Depends on:** none. **IDs consumed (next-free at authoring 2026-07-10):** ADR-042, OPS-009,
  R-133..R-136, T-121..T-123. (No new DESIGN doc or migration — Authentik-side config only.)

---

## Owner requirements (zprompt.md 2026-07-10, verbatim intent)

1. **MFA for local/native Authentik accounts** (`thaynes`, `akadmin`, any hand-created local
   user): required at login, no exceptions besides the documented automation exemption group.
2. **"Log in with Plex" external accounts pass through untouched** — their MFA posture is
   whatever their Plex account has; we never double-gate them locally.
3. **Owner's primary factor = a 1Password passkey (WebAuthn) on `thaynes`**, plus a backup
   authenticator (TOTP). Enrollment is an owner-present action.
4. **Lockout safety is paramount.** Nothing binds an MFA stage to the live flow until: a
   throwaway native test account has proven the full enroll+login cycle; a recovery path is
   verified (see Q-05 akadmin below); and rollback (blueprint revert + `ak` shell unbind) is
   written down and rehearsed in the OPS doc.

## Phase 1 — blueprints/GitOps migration (agent-safe, NO live writes)

Authentik 2026.5.3. All work is **read-only against live** + file authoring in `haynes-ops`:

1. **Export the live estate** via the Authentik API (token: 1Password `homepage` item,
   `AUTHENTIK_API_TOKEN`; OPS-001 §re-provision has access + the Cloudflare UA-1010 gotcha):
   flows, stages, stage-bindings, policies, policy-bindings, groups, brand objects, the Plex
   OAuth source, and the haynesnetwork OIDC provider/application.
2. **Author blueprint YAMLs** under `haynes-ops/kubernetes/main/apps/network/authentik/`
   (layout decision in the ADR: one blueprint per concern — brand, flows, sources, providers,
   groups). Blueprints must reproduce the CURRENT live state first (drift-zero baseline) —
   the `docs/ops/authentik-apply-seed/` payloads are the brand/flow-title source of truth.
3. **Wire blueprint delivery** the supported way for our Helm deployment (configmap/mount +
   `blueprints` discovery), but **leave it unmerged on a PR branch** — Flux applies main.
4. **Draft (do not apply) the MFA blueprint**: authenticator-validation stage (WebAuthn +
   TOTP device classes, enrollment on first challenge) bound into the password flow path;
   `mfa-exempt` group + skip policy (carries `hnet-e2e` and siblings); Plex-source logins
   verified structurally outside the challenge path (original Q-02 — verify against the
   exported flow graph, record evidence in the PR).
5. **Validation without touching live:** blueprint schema lint (`ak` blueprint validation in a
   throwaway container image if feasible, else documented dry-run plan for Phase 2).

**Hard constraint for Phase 1 agents: zero POST/PUT/PATCH/DELETE against live Authentik.**
Export, diff, author, PR. Anything that mutates waits for Phase 2.

## Phase 2 — apply + enroll (OWNER-PRESENT, morning)

1. Merge the baseline blueprints (drift-zero — applying them changes nothing); verify live diff.
2. Create the throwaway native test account; apply the MFA blueprint; prove enroll+login+
   recovery on the test account **before** the stage binding covers real accounts.
3. Owner enrolls the 1Password passkey + backup TOTP on `thaynes`; verify login; verify a
   Plex-source login sees NO challenge; verify `hnet-e2e` Playwright sign-in stays green.
4. **Q-05 (carried): akadmin repair** — the 1Password `AUTHENTIK_BOOTSTRAP_PASSWORD` is stale.
   Rotate via `ak` shell during Phase 2 so akadmin is a recoverable break-glass account WITH
   MFA, and 1Password is true again.
5. OPS-NN executed log + rollback rehearsal note; move plan to completed/.

## Verification

- Phase 1 PR: blueprints reproduce live state (export diff attached), MFA blueprint drafted,
  schema-valid; repo merge gate green (docs/config only — must not regress).
- Phase 2 live journeys: (1) Plex-source login — no challenge, branding intact; (2) native test
  account — enrollment forced, no session without factor; (3) `hnet-e2e` — exempt, e2e green;
  (4) `thaynes` passkey + TOTP backup both work; (5) rollback rehearsed (unbind + revert).

## Out of scope

Forcing MFA on Plex identities; other apps' SSO re-verification (owner spot-check); Better
Auth/app changes; Authentik version upgrades.

## TODO-questions (owner, morning)

- **Q-10:** akadmin post-repair policy — keep as break-glass with MFA, or disable interactive
  login entirely and rely on `ak` shell recovery?
- **Q-11:** should the blueprint set also adopt the OIDC provider/application objects (full
  GitOps) or stay flows/brand/groups-only for round 2? (Provider secrets stay in 1P either way.)
