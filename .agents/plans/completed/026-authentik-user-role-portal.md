# PLAN-026: haynesnetwork as the Authentik user/role portal (write-back group management)

- **Status:** Completed (2026-07-10, v0.38.0) — shipped + live-validated on PROD. The app writes Authentik group membership (import-confined `@hnet/authentik/write` + `@hnet/openwebui/write`), auto-creates synced-tier groups in Authentik + Open WebUI, parks role intents for Authentik-only identities (consumed on first login), and refuses any non-owned group. Acceptance a/b/c/d passed (Friends tier created; mikebi12 moved family→friends + pending row; hnet-e2e OIDC→OWUI "Adding user to group friends"; mfa-exempt write refused). Service account `hnet-portal` (least-privilege). See ADR-045 / DESIGN-023 / OPS-011.
- **Satisfies:** PRD-001 new R-block (single-pane user/role management across every Authentik-backed
  app); new ADR (Authentik group-membership write surface — the app becomes source-of-truth for role
  assignment, import-confined + audited like the Plex/arr write clients); DESIGN (admin user/role UX);
  glossary. Migration if a mapping/cache table is added. **ID reconciliation:** re-grep ceilings
  before authoring (ADR-044 / DESIGN-022 / migration 0035 / R-143 / T-128 consumed by v0.37.0; more
  in flight — re-grep at authoring).
- **Depends on:** Phase 1 (done). Relates PLAN-011 (Authentik blueprints/API), PLAN-021 (the first
  consumer — Open WebUI `family` tier), the books stack (Kavita/ABS OIDC, Phase 3).

## Phase 1 — Authentik-driven group SYNC (DONE, live 2026-07-10)

The mechanism that makes per-platform user management unnecessary:
- Authentik `family` group (pk `70779481-…`); `hnet-groups` OAuth2 scope mapping
  (`return {"groups": [g.name for g in request.user.ak_groups.all()]}`, scope `groups`) attached to
  the Open WebUI provider (pk 4).
- Open WebUI flipped (`OAUTH_SCOPES: "openid email profile groups"`,
  `ENABLE_OAUTH_GROUP_MANAGEMENT: true`, `OAUTH_GROUP_CLAIM: groups`) — on every login OWUI syncs its
  group membership from the claim, so `family` (large-model + image access) follows Authentik.
- Seeded family: thaynes, KAH517, FGTVMan, mia.xh, mikebi12. **Membership is API-managed, NOT
  blueprinted** — deliberately, so Phase 2 can own it without a reconcile fight.
- **Design rule established:** Authentik groups = the cross-app role primitive. Any new
  Authentik-backed app (Kavita/ABS/etc.) enables the same groups-claim sync → one role model,
  many apps. **Group NAMES must match** what each app expects (OWUI matches by name; group creation
  stays OFF so a typo can't spawn a phantom group).

## Phase 2 — haynesnetwork writes Authentik group membership (this plan)

Make the app the portal: a role change on haynesnetwork.com propagates to every Authentik-backed
app, for **every** Authentik user — including people who have only ever logged into Open WebUI /
Kavita / etc. and never hit haynesnetwork.

1. **Read side:** `/admin/users` lists ALL Authentik users (not just app-known ones) via the
   Authentik API (token in 1P homepage item) — surfacing external-source (Plex) accounts too. A
   sync job (the *arr-ledger pattern) or on-demand read; decide in the ADR.
2. **Write side (the core ADR):** assigning an app role writes the corresponding Authentik group
   membership in the same audited transaction (single-writer in `packages/domain`; a new
   import-confined `@hnet/authentik/write` surface mirroring `@hnet/plex/write` / `@hnet/arr/write`
   per ADR-017). The app's role model maps to Authentik groups (Family→`family`, etc.); the mapping
   is explicit + versioned.
3. **Reconcile the two identity spaces:** an app user (Better Auth session) is keyed to an Authentik
   identity via the OIDC `sub`; a user who only exists in Authentik (never logged into the app) has
   no app row yet — the admin UI assigns their group anyway (write is to Authentik, the app row is
   created lazily on their first app login). ADR resolves the keying.
4. **Guardrails:** never remove a user from a group they were manually granted outside the app
   unless the admin does so here; the app is authoritative for the groups it manages, advisory for
   others (an `hnet-managed` marker set, or a documented owned-groups allowlist). Audit every flip.

## Owner scope addition (2026-07-10) — tier/group AUTO-CREATION

The owner plans at least one tier between Default and Family (**"Friends"** — more restricted than
Family, less than Default's floor... i.e. Default gets tightened, Friends sits between) and possibly
more later. Ruling: **creating a role in haynesnetwork auto-creates the Authentik group.**

- A role carries a **"synced tier" opt-in flag** (not every role must project to Authentik —
  internal/experimental roles stay app-local). When flagged, the app creates the Authentik group
  (naming convention: role name lowercased, e.g. Friends→`friends`), adds it to the owned-groups
  allowlist, and manages membership from then on. Creation + flag flips audited like everything else.
- **Also ensure the group exists in Open WebUI** at tier creation (the app holds
  `OPENWEBUI_API_KEY`; OWUI deliberately does NOT auto-create groups from claims — creation stays
  off there, so the portal must pre-create for the claim-sync to have a target).
- **Honest boundary:** a tier's *existence* propagates automatically; a tier's *entitlements* are
  still per-app config (which OWUI models, which Kavita libraries). The portal makes the identity
  plumbing instant; each app's admin surface decides what the tier grants there. Document this
  clearly in the admin UX (a new synced tier shows "group created — configure app entitlements").

## Open questions (Q-NN at authoring)

- **Q-01:** which groups does the app OWN (family + future tiers) vs merely display? (avoid the app
  clobbering Authentik-admin-managed groups like `authentik Admins`).
- **Q-02:** membership source-of-truth once Phase 2 ships — app is authoritative for owned groups;
  confirm blueprints never re-assert membership for those (Phase 1 already kept membership out of
  blueprints — hold that line).
- **Q-03:** Kavita/ABS group→library-access mapping (their OIDC group sync) — does the app manage
  those groups too, or only the coarse tier? (books Phase 3 coordination.)
- **Q-04:** de-provisioning UX — removing a role/group from a departed user across all apps.

## Out of scope

Phase 1 (done). Authentik admin-console replacement (the app manages ROLE/GROUP membership, not
flows/providers/brand — those stay blueprints/API per PLAN-011). Per-app permission granularity
beyond group tiers.
