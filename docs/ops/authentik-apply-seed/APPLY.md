# PLAN-011 branding — apply plan (Authentik 2026.5.3, prepared 2026-07-07)

**Scope: branding ONLY.** MFA hardening is the owner's task.
**Status: APPLIED (option C) 2026-07-07 — see §10 Applied-state changelog** for the live
deltas (including the 011b "Plex primary" iteration). The steps below remain the runbook and
rollback reference.

Everything referenced lives next to this file in `ux-011/`:

| Artifact | Purpose |
|---|---|
| `current-brands.json` | **Verbatim capture** of `GET /api/v3/core/brands/` (2026-07-07) — the rollback source of truth |
| `current-flows.json` | Verbatim capture of `GET /api/v3/flows/instances/` (titles pre-change) |
| `assets/hnet-brand.css` | The shared brand CSS (readable master; already baked into the payloads) |
| `assets/*.svg`, `assets/hnet-favicon-64.png` | The generated brand image assets (same content as the ConfigMap) |
| `payloads/brand-{a,b,c}.json` | Ready-to-send Brand PATCH body per option (title + logo + favicon + background + custom CSS w/ embedded Outfit font) |
| `payloads/flow-titles-{a,b,c}.json` | Flow-title strings per option (slug → title) |
| `payloads/brand-rollback.json`, `payloads/flow-titles-rollback.json` | Exact restore payloads |
| `haynes-ops/authentik-brand-assets-configmap.yaml` | The ConfigMap for the haynes-ops PR (all images) |
| `mock-{a,b,c}.html`, `shots/*` | The owner-approval mocks + screenshots |

---

## 1. Current state (rollback baseline, captured live)

One Brand exists — the default, everything stock:

```json
{
  "brand_uuid": "de1b7109-2d4d-466c-8890-326e969015d5",
  "domain": "authentik-default",
  "default": true,
  "branding_title": "authentik",
  "branding_logo": "/static/dist/assets/icons/icon_left_brand.svg",
  "branding_favicon": "/static/dist/assets/icons/icon.png",
  "branding_custom_css": "",
  "branding_default_flow_background": "/static/dist/assets/images/flow_background.jpg",
  "attributes": {}
}
```

Flow titles that say "authentik" (user-facing):

| Flow slug | pk | Current title | Seen by |
|---|---|---|---|
| `default-authentication-flow` | `c8e7b494-606c-4772-9e5f-194b610bac40` | `Welcome to authentik!` | every login (card H1 + `window.authentik.flow.title`) |
| `default-source-authentication` | `67b51e33-b342-4319-a6d9-3d080d6aed73` | `Welcome to authentik!` | returning Plex-source logins |
| `default-source-enrollment` | `f80cd9b5-8969-4f4f-91ab-8810b221198d` | `Welcome to authentik! Please select a username.` | first-time Plex users |
| `initial-setup` | (stage_configuration) | `Welcome to authentik!` | akadmin only, once — **left alone** |

Other objects referenced below: identification stage `default-authentication-identification`
pk `08af63fb-b894-4c5a-bbbd-3dad23e2772f` (fields today: `password_stage: null`,
`show_source_labels: false`); Plex source slug `haynestower` (display name `HaynesTower`,
pk `2c61a5af-0f75-47b6-a01a-3b9741c22891`).

## 2. Q-03 — the verified de-branding mechanism (per 2026.5.3 source + live bundle)

Every user-visible "authentik" and how it's removed. All of this is **supported brand/flow
config**, no template hacks:

| Surface | Where it comes from | Fix |
|---|---|---|
| Browser tab `<title>` + logo `alt` | `Brand.branding_title` | brand PATCH |
| Logo above the card | `Brand.branding_logo` | brand PATCH → hnet lockup (ConfigMap asset) |
| Favicon | `Brand.branding_favicon` | brand PATCH → `hnet/favicon.png` |
| Card H1 "Welcome to authentik!" | `Flow.title` (3 flows above) | flow PATCHes |
| **"Powered by authentik" footer** | Hard-appended by `ak-brand-links` (verified in the shipped `FlowInterface-2026.5.3.js`: `[...links, {name: msg("Powered by authentik"), href: null}]` — unconditional, no license check) as `<li data-kind="text">` in **light DOM** | one rule in `branding_custom_css`: `ak-brand-links li[data-kind='text'] { display: none; }` — real footer links (`data-kind="link"`) survive |
| Stock forest-road background | `Brand.branding_default_flow_background` → `--ak-global--background-image` | brand PATCH → hnet background SVGs |
| Everything else (blue PatternFly card look) | component styles | `branding_custom_css` |

**Why custom CSS reaches inside the components:** authentik's `AKElement` base class turns
`brand.brandingCustomCss` into a constructed stylesheet and **adopts it into every web
component's shadow root** (verified in chunk `6JD7I43H.js`: the `styleRoot` setter pushes the
brand sheet into `adoptedStyleSheets`), and it is also inlined in the document head
(`<style data-id="brand-css">`). So plain selectors (`.pf-c-login__main`,
`.pf-c-form-control`, `.pf-c-button.pf-m-primary`…) style the card, inputs and buttons, and
CSS custom properties declared on `:root` inherit across every shadow boundary. The CSS ports
the app's ADR-005 token *mechanism* with the shipped hnet palette values; authentik keeps
`data-theme` on `<html>` in sync (auto → OS scheme), so `[data-theme=…]` token blocks give
first-class dark AND light.

**Font:** Outfit (the DESIGN-006 D-02 face) is embedded in the custom CSS as a base64
`data:` woff2 `@font-face` (CSP allows `font-src data:`; verified response header). A hosted
woff2 was rejected: media files are served through **15-minute signed URLs** (see below), so a
URL baked into the stored CSS would expire, and serving from haynesnetwork.com would need CORS
+ couples the IdP's look to app uptime. Cost: the brand CSS payload is ~66 KB, inlined per
flow-page load — fine at household scale.

**Logos are pure SVG paths** — the `haynesnetwork` wordmark was converted from
`Outfit-Variable.woff2` at wght 700 to path outlines (fontkit), so the logo assets have no
font dependency at all. Mark geometry is verbatim `apps/web/components/brand-mark.tsx`.

### Where logo files live (the "media dir" question)

- This install has **no media storage**: no PVC/S3 (helmrelease has no volumes), and the live
  config capabilities **omit `can_save_media`** → the Admin-UI *Customization → Files* upload
  is unavailable.
- 2026.x resolves brand image values through backends: `/static/...` (image-baked assets),
  `http(s)://...` (passthrough), everything else = **media file** under
  `{storage.media.file.path|./data}/media/{schema}/…` → in this image `/data/media -> /media`
  (symlink, verified in the live pod; dir empty, owned by `authentik`). Media is served by the
  Go router at `/files/media/…?token=<JWT>` (signed, 15 min, auto-generated at serialize time).
- **`data:` URIs do NOT work for brand image fields** — the passthrough backend only accepts
  `http:`/`https://`/`fa://`; anything unmatched serializes to `""` (empty logo). (CSP would
  have allowed it; the backend doesn't.)
- **Chosen mechanism: GitOps ConfigMap mounted into the server pods** at
  `/media/public/hnet/` (`public` = tenant schema name). Brand values are then plain media
  paths like `hnet/logo-%(theme)s.svg`. The `%(theme)s` placeholder is the supported
  per-theme mechanism (2026.5 `Brand.branding_*_themed_urls`): authentik substitutes
  `light`/`dark` and the frontend picks per active theme — that's how the lockup's wordmark
  gets `--color-text` white on dark and `#53565a` on light.

## 3. Step 0 — haynes-ops PR (do this first; safe on its own)

In `haynes-ops` (`kubernetes/main/apps/network/authentik/app/`):

1. **Add** `configmap.yaml` — copy `ux-011/haynes-ops/authentik-brand-assets-configmap.yaml`
   (ConfigMap `authentik-brand-assets`, ns `network`: `logo-{light,dark}.svg`, `mark.svg`,
   `bg-{a,b,c}-{light,dark}.svg`, `favicon.png` ≈ 18 KB total).
2. **Edit** `kustomization.yaml` — add `- ./configmap.yaml` to `resources`.
3. **Edit** `helmrelease.yaml` — under `values.server` add (chart exposes
   `server.volumes/volumeMounts`, verified against goauthentik/helm values):

   ```yaml
    server:
      # ... existing values ...
      volumes:
        - name: brand-assets
          configMap:
            name: authentik-brand-assets
      volumeMounts:
        - name: brand-assets
          mountPath: /media/public/hnet
          readOnly: true
   ```

4. Reconcile + verify the files are served (any pod):

   ```bash
   kubectl --context haynes-ops -n network exec deploy/authentik-server -c server -- ls /media/public/hnet
   ```

This changes nothing user-visible until the Brand PATCH points at the files. Rollback of this
step = revert the commit. (Read-only mount → `can_save_media` stays off, as today.)

## 4. Step 1 (optional but recommended) — staged preview on a throwaway brand

Brands match by request host, so a second brand scoped to `localhost` previews everything on
the REAL Authentik without touching the default brand:

```bash
TOKEN=$(kubectl --context haynes-ops -n frontend get secret homepage-secret \
  -o jsonpath='{.data.HOMEPAGE_VAR_AUTHENTIK_API_TOKEN}' | base64 -d)   # never echo it
B=https://authentik.haynesnetwork.com/api/v3
UA='User-Agent: curl/8.5.0'   # Cloudflare bans python-UA (error 1010) — OPS-001 gotcha

# create the test brand from the chosen option's payload (example: option c)
python3 - payloads/brand-c.json <<'EOF' > /tmp/test-brand.json
import json,sys
p = json.load(open(sys.argv[1])); p["domain"] = "localhost"; p["default"] = False
print(json.dumps(p))
EOF
curl -sS -X POST "$B/core/brands/" -H "Authorization: Bearer $TOKEN" -H "$UA" \
  -H 'Content-Type: application/json' --data @/tmp/test-brand.json
# note the returned brand_uuid, then:
kubectl --context haynes-ops -n network port-forward svc/authentik-server 9000:80
# browse http://localhost:9000/if/flow/default-authentication-flow/ (+ ?theme=light / dark)
# when satisfied:
curl -sS -X DELETE "$B/core/brands/<test-brand-uuid>/" -H "Authorization: Bearer $TOKEN" -H "$UA"
```

(Flow titles are shared, not per-brand — preview those on the live PATCH in step 2; they are
one-string reverts.)

## 5. Step 2 — apply the chosen option to the default brand

`X` = the approved option (`a` | `b` | `c`). Payloads already contain the full custom CSS.

```bash
TOKEN=...  # as above, masked
B=https://authentik.haynesnetwork.com/api/v3
UA='User-Agent: curl/8.5.0'
BRAND=de1b7109-2d4d-466c-8890-326e969015d5

# 5.1 brand (title/logo/favicon/background/custom CSS [+ option-b forced dark theme])
curl -sS -X PATCH "$B/core/brands/$BRAND/" -H "Authorization: Bearer $TOKEN" -H "$UA" \
  -H 'Content-Type: application/json' --data @payloads/brand-X.json

# 5.2 flow titles (3 calls; flows API lookup is by slug)
python3 - payloads/flow-titles-X.json <<'EOF'
import json, subprocess, sys, os
titles = json.load(open(sys.argv[1]))
for slug, title in titles.items():
    subprocess.run(["curl","-sS","-X","PATCH",
      f"{os.environ['B']}/flows/instances/{slug}/",
      "-H", f"Authorization: Bearer {os.environ['TOKEN']}",
      "-H","User-Agent: curl/8.5.0","-H","Content-Type: application/json",
      "--data", json.dumps({"title": title})], check=True)
    print("patched", slug)
EOF
```

### Optional finishing touches (shown in the mocks — owner call)

The mocks render the Plex button as a labelled pill ("Continue with Plex"). Live config is
icon-only (`show_source_labels: false`) and the source's display name is `HaynesTower`:

```bash
# labelled source button
curl -sS -X PATCH "$B/stages/identification/08af63fb-b894-4c5a-bbbd-3dad23e2772f/" \
  -H "Authorization: Bearer $TOKEN" -H "$UA" -H 'Content-Type: application/json' \
  --data '{"show_source_labels": true}'
# display name "Plex" (label reads "Plex" instead of "HaynesTower")
curl -sS -X PATCH "$B/sources/plex/haynestower/" \
  -H "Authorization: Bearer $TOKEN" -H "$UA" -H 'Content-Type: application/json' \
  --data '{"name": "Plex"}'
```

Rename caveat: the source button's `aria-label`/label derives from the name — if any live
automation targets "HaynesTower" on the LOGIN page, update it (repo e2e does not; it uses the
stub OIDC locally, and `hnet-e2e` types into `uidField`/`password`, whose names/DOM are
untouched by all of this).

Also available (not mocked): tenant-level footer links (they render in the now-cleaned footer
band) — `PATCH $B/admin/settings/ {"footer_links": [{"name": "haynesnetwork.com", "href":
"https://haynesnetwork.com"}]}`.

## 6. Verification

1. `https://authentik.haynesnetwork.com/if/flow/default-authentication-flow/` at 1920×1080 and
   390×844, dark and light (`?theme=light|dark` forces it): hnet card, lockup logo, pill
   buttons, no "authentik" text anywhere, no "Powered by authentik", correct background;
   `<title>` = the chosen brand title; favicon = the mark.
2. Password stage (enter any username → Continue) renders the matched-user banner + pill.
3. A real Plex-source login round-trips into the app (checks `default-source-authentication`
   title + brand on the source path).
4. The `hnet-e2e` live sign-in still automates (names `uidField`/`password` unchanged).
5. Admin sanity: `/if/admin` still usable — the CSS skins generic inputs/pf-m-primary buttons
   there too (accepted; scope selectors under `:host([part='challenge'])` later if it ever
   bothers). The dashboard's user count etc. unaffected.
6. Screenshot both stages for OPS-NN (the plan's brand-check journey #4).

## 7. Rollback (cheap, no deploy)

```bash
curl -sS -X PATCH "$B/core/brands/$BRAND/" -H "Authorization: Bearer $TOKEN" -H "$UA" \
  -H 'Content-Type: application/json' --data @payloads/brand-rollback.json
# ...and if option b was applied, also clear the forced theme:
#   --data '{"attributes": {}}'
# restore flow titles:
#   same loop as 5.2 with payloads/flow-titles-rollback.json
# optional-extras rollback: {"show_source_labels": false} / {"name": "HaynesTower"} / {"promoted": false}
# haynes-ops: revert the Step-0 commit (or leave it; unreferenced assets are inert)
```

`current-brands.json` / `current-flows.json` hold the full pre-change objects if anything else
ever needs cross-checking.

## 8. Q-01 note — API vs blueprints

This plan ships **API-applied + OPS-log** (OPS-001 precedent). If the ADR lands on blueprints
instead: the same three payload groups translate 1:1 into a blueprint YAML (entries for
`authentik_brands.brand` with `identifiers: {brand_uuid: de1b7109-…}` and
`authentik_flows.flow` with `identifiers: {slug: …}`, attrs = the payload fields); mount it as
a ConfigMap to `/blueprints/custom/` on the worker (chart `blueprints` value) and it applies
declaratively. The image ConfigMap from Step 0 is needed either way. Decide in the ADR;
either choice keeps this file's rollback story.

## 9. Incidental findings for the owner's MFA half (out of my scope, free intel)

- `default-authentication-flow` **already has** an Authenticator Validation stage:
  `default-authentication-mfa-validation` bound at order 30 (identification 10 → password 20 →
  mfa-validation 30 → login 100). The MFA task is therefore likely a stage-config/policy
  tweak (not-configured-action, device classes, `mfa-exempt` skip policy), not new wiring.
- Plex-source logins traverse `default-source-authentication` (separate flow) — consistent
  with the plan's Q-02 hypothesis that source logins bypass the password flow's MFA stage;
  verify live before relying on it.
- The instance reports `is_enterprise` in capabilities, but the "Powered by authentik" footer
  append is unconditional in this build — the CSS hide is required regardless.

## 10. Applied-state changelog

### 2026-07-07 — option C applied (live)

Brand PATCH (`payloads/brand-c.json`), the three flow-title PATCHes
(`payloads/flow-titles-c.json`), plus both optional finishing touches from §5:
`show_source_labels: true` and source display name `HaynesTower` → `Plex`.
Evidence + verification: `../live-011/` (screenshots, `resp-*.json`).

### 2026-07-07 — 011b "Plex primary" (owner feedback iteration, live)

Owner: the Plex button must be the obvious primary action ("Log in with Plex"); the local
form is secondary (admins + hnet-e2e only). Applied on top of option C:

1. **Source PATCH** `{"promoted": true}` on `sources/plex/haynestower/` — Authentik's
   first-class promoted-source rendering: the button becomes
   `pf-m-primary pf-m-block source-button source-button-promoted`, full-width.
   Rollback: `{"promoted": false}`.
2. **Brand CSS extended** (in `assets/hnet-brand.css`, baked into all `payloads/brand-*.json`
   by `gen-payloads.mjs`; live brand re-PATCHed from `payloads/brand-c.json`):
   - Card reorder (identification stage ONLY, scoped via `:host([part='flow-card'])` — the
     ident stage is the only place that sets that part, verified in the 2026.5.3 bundle):
     title → Plex button → divider → local form.
   - Divider microcopy "or sign in with a local account" via
     `.pf-c-login__main-body::before` + hairline.
   - Promoted button restyled as the big green pill; visible label swapped to
     **"Log in with Plex"** via `font-size: 0` + `::after` content (plus a `::before`
     Plex-chevron data-URI icon). The source NAME stays "Plex" so user-settings/link pages
     and the "Continue with Plex" aria-label read sanely. NOTE: PatternFly uses
     `.pf-c-button::after` as an absolute border overlay — the rule resets
     `position/border`. Selectors are prefixed with `fieldset[name='login-sources']` to beat
     the stage's nested rules (specificity (0,3,2)).
   - Ident-stage form submit de-emphasized to an outline pill via
     `:host(ak-stage-identification)` scoping (the password stage's Continue stays full
     green primary).
   - Sources fieldset inline padding aligned to the card body (xl / 2xl at 768px) by feeding
     `--ak-c-login-sources-padding-inline`.
   - `uidField`/`password` untouched — form fully usable.
3. **Verification** (evidence in `../live-011b/`): desktop dark+light + mobile 390
   screenshots (`signin-*.png`); full hnet-e2e FORM round-trip on haynesnetwork.com
   (`ROUNDTRIP_FORM_OK`, `roundtrip-app-logged-in.png`); Plex button click navigates to the
   `app.plex.tv/auth` pin flow (`PLEX_CLICK_OK`, abandoned before OAuth); password stage
   confirmed untouched (`password-stage.png`). Pre-011b payload backup:
   `../live-011b/brand-c-pre-011b.json`.
