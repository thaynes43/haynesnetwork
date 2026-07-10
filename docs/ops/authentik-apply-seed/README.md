# Authentik apply/rollback seed (PLAN-011 branding)

These files capture the **applied option-C login rebrand + the 011b "Plex primary" iteration**
as it went **live on `authentik.haynesnetwork.com` on 2026-07-09** (Authentik 2026.5.3), together
with the **exact rollback payloads** to restore the stock authentik look.

They were promoted here from a session-local scratchpad (`scratchpad/ux-011/`, which is
`/tmp`-based and wiped between sessions) so the applied state and its reverse are **tracked in
git**. This is the **SEED for the next session's Authentik blueprints / GitOps migration** —
see "Next step" below and [`001-authentik-provisioning.md`](../001-authentik-provisioning.md).

## Contents

| Path | What it is |
|---|---|
| `APPLY.md` | The full runbook: de-branding mechanism (Q-03), step-by-step apply, verification, rollback, and the §10 applied-state changelog (option C + the 011b Plex-primary deltas). **Start here.** |
| `payloads/brand-c.json` | The live `PATCH /api/v3/core/brands/<uuid>/` body — title, logo, favicon, background, and the full `branding_custom_css` (option C's brand CSS with the embedded Outfit font, ~70 KB). This is the applied state. |
| `payloads/flow-titles-c.json` | The three applied flow titles (`slug → title`): the "Sign in to haynesnetwork" / username-picker strings. |
| `payloads/brand-rollback.json` | Exact restore body — reverts the brand to stock authentik (empty custom CSS, stock logo/favicon/background/title). |
| `payloads/flow-titles-rollback.json` | Exact restore titles — the original "Welcome to authentik!" strings. |
| `current-brands.json` | Verbatim `GET /api/v3/core/brands/` capture (pre-change, 2026-07-07) — the rollback source of truth. Referenced by `APPLY.md` as a sibling. |
| `current-flows.json` | Verbatim `GET /api/v3/flows/instances/` capture (flow titles pre-change). Sibling of `APPLY.md`. |
| `assets/hnet-brand.css` | The readable master of the brand CSS (the same content baked into `payloads/brand-c.json`). Ports the app's ADR-005 / DESIGN-006 token seam as a *mechanism* with the shipped hnet palette. |

`brand_uuid` for the default brand is `de1b7109-2d4d-466c-8890-326e969015d5`; the three flows
patched are `default-authentication-flow`, `default-source-authentication`,
`default-source-enrollment`. Plus the two 011b finishing touches applied on top (see `APPLY.md`
§5 / §10): source `promoted: true` and `show_source_labels: true` on `sources/plex/haynestower/`
(rollback `promoted: false` / `show_source_labels: false`).

## No secrets here

These payloads are brand CSS + titles + static asset paths only. The Authentik **API token is
NOT stored in any of these files** — the runbook fetches it at apply time from 1Password (the
`homepage` item / in-cluster `homepage-secret`, key `HOMEPAGE_VAR_AUTHENTIK_API_TOKEN`; see
`APPLY.md` §4 and `001-authentik-provisioning.md`). `APPLY.md` only ever references it as the
`$TOKEN` shell variable ("never echo it"). The UUIDs / pks present are Authentik object
identifiers, not credentials.

## Not carried over from the session scratchpad

To keep this a focused seed, the following session-local artifacts from `ux-011/` were **not**
promoted: the owner-approval mockups + screenshots (`mock-{a,b,c}.html`, `shots/*`), the
non-chosen `brand-{a,b}.json` / `flow-titles-{a,b}.json` options, the brand image assets +
ConfigMap (`assets/*.svg`, `hnet-favicon-64.png`, `haynes-ops/…-configmap.yaml`), the generator
scripts, and the `live-011` / `live-011b` verification evidence. `APPLY.md` still references some
of these by their original `ux-011/` relative paths; treat those as historical pointers — the
load-bearing apply/rollback artifacts are all present here.

## Next step — blueprints / GitOps migration

This branding was **API-applied + OPS-logged** (the OPS-001 precedent). `APPLY.md` §8 (Q-01)
sketches the 1:1 translation into declarative blueprints: `authentik_brands.brand` keyed on
`identifiers: {brand_uuid: de1b7109-…}` and `authentik_flows.flow` keyed on `identifiers: {slug: …}`,
with these payload fields as the attrs, mounted as a ConfigMap to `/blueprints/custom/` on the
worker. The next session should use these payloads as the source-of-truth inputs when authoring
those blueprints, and fold them into the provisioning story in
[`001-authentik-provisioning.md`](../001-authentik-provisioning.md).
