# PLAN-058: SSO immersion — one login, every site, no per-app "Log in with Plex"

- **Status:** Planned — inventory + per-app remediation designed (DESIGN-041); **awaiting owner
  rulings on DESIGN-041 Q-01..Q-08 before execution**. No code/estate changes made yet.
- **Intake (owner vision, 2026-07-16 late, near-verbatim):** "Auto login is very important to me,
  so it feels like SSO when you log into haynesnetwork.com and then you can go from site to site
  with your plex account. We have a pretty big immersion break with sites that provide their own
  'Log in with Plex' like Seerr and Tautulli."
- **The goal:** a member logs in once (Authentik, Plex-primary) and every estate app they open
  just works — no second login screen, no per-app Plex OAuth buttons.
- **Design:** `docs/designs/041-sso-immersion-estate-auto-login.md` — the full inventory
  (every catalog app × auth today × auto-login capability × role story), the per-app mechanisms
  (D-02..D-10), the safety invariant (D-01: break-glass verified before every flip), sequencing,
  risks, and the Q-NN owner questions. This plan is the execution ordering over that design.

## The one-paragraph shape

The haynesnetwork login already leaves a live Authentik session; every app that *redirects* to
Authentik completes promptlessly (implicit-consent providers). So per app the work is only the
first hop: flip the app's native auto-login flag where one exists (Kavita, ABS, Immich), deep-link
the catalog card at the SP-initiated login endpoint where no flag exists (Open WebUI), put an
Authentik forward-auth front door with header injection where the app has no OIDC at all
(Tautulli — the Paperless idiom), and be honest where neither works yet (Seerr: upstream OIDC is
still preview-only; Plex cards: plex.tv identity IS the SSO identity, N/A by design).

## Verdicts at a glance (from DESIGN-041)

| App | Verdict | Design |
|---|---|---|
| Kavita | Quick win: flip `AutoLogin=true` (runtime, instant, break-glass live) | D-02 |
| Audiobookshelf | Quick win: `authOpenIDAutoLaunch=true` (OPS-012 option A, rehearsed) | D-03 |
| Open WebUI | Catalog card deep-link → `/oauth/oidc/login` (zero-click, no app change) | D-05 |
| Immich | Verify live OAuth state → configure + `Auto Launch` | D-04 |
| Paperless | Already done (forward-auth reference implementation) | D-06 |
| Tautulli | Authentik proxy provider + HTTP-Basic injection on the external outpost; all-admin identity model needs Q-02 | D-07 |
| Kavita role sync | Phase 2 of the Kavita theme: Authentik roles-claim design (`library-<Name>`, floor-not-deny), then "Sync user settings with OIDC roles" | D-08 |
| Seerr | NO stable OIDC upstream (v3.3.0; PR #2715 open) — default = watch upstream, keep Plex OAuth; preview image only on owner opt-in (Q-01) | D-09 |
| Plex / K8Plex / PlexOps | N/A by design (plex.tv auth; the Plex account is the estate identity) | D-10 |

## Execution phases (blocked on the Q-NN rulings)

0. **Verify pass (read-only, agent-safe).** Diff live `app_catalog` vs the seeded 10 (admin may
   have added rows — they join the inventory). Confirm each app's Authentik provider binds the
   implicit-consent authorization flow. Probe every break-glass URL in DESIGN-041 D-01 and record
   results. Verify OWUI's `/oauth/oidc/login` GET behavior on our deployed version, and Immich's
   live OAuth/`autoLaunch=0` state (Q-04 input).
1. **Quick wins (owner-present recommended, minutes each):** Kavita `AutoLogin` flip (D-02) +
   ABS auto-launch flip (D-03). Same change: refresh the haynes-ops Kavita README (it still says
   `AutoLogin=false`, predates Default Roles, and omits the break-glass semantics — the intake's
   runbook-hygiene item) and append the OPS-012 addendum row for the ABS flip. Playwright
   zero-click round-trip proof per app (test strategy in DESIGN-041).
2. **OWUI deep-link (Q-05):** admin UI catalog edit of the Open WebUI card URL. Revert-on-upstream
   note recorded on the card description or the ops note.
3. **Immich (Q-04):** configure OAuth if absent (OPS-001-idiom provider create; mobile redirect
   URI included), flip `Auto Launch`, write the ops record (role-claim-at-creation-only caveat).
4. **Tautulli front door (Q-02, Q-08):** new Authentik blueprint (proxy provider + application +
   external-outpost assignment + group policy binding), haynes-ops PR adding the `ak-outpost-…`
   middleware to `ingressroute-tautulli.yaml` with unauthenticated-path carve-outs
   (`/newsletter`, `/image`, Gatus probe), Unraid-side "Use Basic Authentication" + injected
   credentials per the authentik integration guide. Verify carve-outs + group gating.
5. **Kavita role sync (Q-06):** owner supplies the tier table → author the Authentik scope
   mapping (floor-not-deny expression, the OPS-012 lesson) → flip "Sync user settings with OIDC
   roles" → verify a non-admin and an admin round-trip → ops record.
6. **Seerr (Q-01):** default O1 = standing upstream watch on seerr-team/seerr PR #2715 (adopt the
   first stable release containing it; the linking flow preserves request attribution). O2
   (preview image) only on explicit owner opt-in with verified backup + rollback.

An ADR (next free number at execution time) accompanies the first executing change, recording the
owner's Q-01/Q-02 rulings as the decision; DESIGN-041 stays the mechanism record. Glossary terms
T-194..T-196 (Estate Auto-Login, Immersion Break, Forward-Auth Front Door) landed with this plan.

## Hard rules for the executor

- **DESIGN-041 D-01 is law:** no auto-login flip before its break-glass is verified in the same
  session, and every flip is recorded in the app's README/OPS doc (runtime PVC state does not
  survive rebuilds).
- **OPS-009 blast-radius rule:** touch NO Authentik flows/stages/brand/web assets. Providers,
  applications, outposts, scope mappings, group policies only. The WebKit login crisis started as
  "harmless" login-estate changes.
- **Embedded-outpost ownership:** `50-dev-env.yaml` owns the embedded outpost's provider list —
  Tautulli rides the EXTERNAL outpost (or is added inside that blueprint, never via UI).
- The *arrs/downloads tier and non-catalog apps are out of scope unless Q-03 widens it.

## Notes

- Auto-login flips are trivial per-app settings; the work was the inventory + the odd apps
  (Seerr/Tautulli) + not breaking admin break-glass paths. That inventory now exists in
  DESIGN-041 with sources; the odd apps have honest verdicts (Seerr: nothing safe exists today;
  Tautulli: proxy + header injection, with an identity-model tradeoff the owner must rule on).
