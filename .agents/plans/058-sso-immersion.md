# PLAN-058: SSO immersion — one login, every site, no per-app "Log in with Plex"

- **Status:** Intake (owner vision, 2026-07-16 late: "Auto login is very important to me, so it
  feels like SSO when you log into haynesnetwork.com and then you can go from site to site with
  your plex account. We have a pretty big immersion break with sites that provide their own
  'Log in with Plex' like Seerr and Tautulli.")
- **The goal:** a member logs in once (Authentik, Plex-primary) and every estate app they open
  just works — no second login screen, no per-app Plex OAuth buttons.

## Shape (scope at a session with the owner)

1. **Inventory pass:** every catalog app × its current auth (Authentik OIDC? auto-login on?
   own Plex OAuth? none?). Known immersion breaks: Seerr (own Plex login), Tautulli (own auth).
   Known good: haynesnetwork, Open WebUI, ABS (OIDC), Kavita (OIDC — auto-login OFF today,
   deliberately during admin work; flipping it ON is this plan's first cheap win, with the
   break-glass URL documented as the fallback).
2. **Per-app remediation:** native OIDC where supported (Seerr/Overseerr OIDC support?
   research), else Authentik proxy-provider/forward-auth in front (the Authentik outpost
   idiom), else accept + document.
3. **Kavita follow-up (same theme):** "Sync user settings with OIDC roles" ON once the
   Authentik group→Kavita-role mapping is designed (extends PLAN-026's portal; today's fix =
   Default Roles Login+Bookmark+Download landed 2026-07-16, manual per-user tuning above that).
4. **Runbook hygiene:** the Kavita README in haynes-ops omits DefaultRoles/auto-login/break-glass
   semantics (tonight's incident class) — document alongside the flips.

## Notes

- Auto-login flips are trivial per-app settings; the work is the inventory + the odd apps
  (Seerr/Tautulli) + not breaking admin break-glass paths.
