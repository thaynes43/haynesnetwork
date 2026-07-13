# PLAN-042: Authentik upgrade watch → revert login compatibility mode

- **Status:** Backlog, UNBLOCKED for the check step — **periodically check whether the upstream
  Authentik fix has shipped; a fixed release triggers the work below.** The revert work itself is
  gated only on that release existing (plus the owner-present upgrade rule).
- **Origin (2026-07-12/13 night):** the Authentik **2026.5.3** flow-interface SPA **crashes the
  WebKit 18.x renderer** at boot (before the first executor call) — iPad Safari, Kiosker Pro
  (WKWebView), and desktop Safari 18.3.1 private mode all spun forever on login. Same defect class
  as upstream **goauthentik/authentik#19814** (iOS 18.3.x login crash, introduced ≥2025.12; see
  also #9761/#11282). Emergency fix shipped that night: **`compatibility_mode: true` on all four
  login-surface flows** (haynes-ops `571c7a65`, blueprint `20-hnet-flows.yaml`) — forces the
  ShadyDOM polyfill path, which avoids the crashing code. Live-verified in WebKit 18.2/26.5,
  Chromium, Firefox.
- **Why revert eventually:** compat mode is a workaround with costs — it flattens component
  styling (the brand-green button had to be re-won with a CSS specificity pass on
  `10-hnet-brand.yaml`), and it keeps us on the polyfill path upstream doesn't optimize for. The
  Safari TOTP-**enrollment** failure (OPS-009 caveat) likely shares the same root cause and is NOT
  covered by our flows (authenticator-setup flows aren't blueprint-managed) — an upstream fix
  should cure it for real.

## The periodic check (cheap, any session; do this until it fires)

1. Check upstream: is there an Authentik release whose changelog/issues close **#19814** (or the
   WebKit-crash class)? Look at goauthentik/authentik releases + the issue thread.
2. If NO fix yet: note the date checked in this file's log below; done (minutes of work).
3. If a FIXED release exists → this plan becomes DISPATCHABLE (see work section). Surface it to
   the owner as a queue item — the upgrade step is **owner-present** (login estate).

## The triggered work (dispatch when the check fires)

1. **Owner-present Authentik upgrade** in haynes-ops to the fixed release (Renovate PR or manual
   bump; follow the estate's upgrade conventions; verify worker + server healthy, blueprints all
   `successful`).
2. **Revert `compatibility_mode: true → false`** on the four flows in `20-hnet-flows.yaml`
   (drop the deviation comment added in `571c7a65`).
3. **Re-verify with the existing harness** — `scratchpad/sso-webkit/repro.js` pattern (rebuild it
   if the scratchpad is gone; the method is recorded in the session-5 context note): login form
   renders + advances past the first stage in **WebKit 18.x, current WebKit, Chromium, Firefox**
   fresh ephemeral contexts against https://haynesnetwork.com.
4. **Brand check:** native rendering returns — confirm the login page brand styling (green button,
   pill shape) still holds with the post-compat CSS from the specificity pass (it was written to be
   robust in BOTH rendering modes; if native mode regresses styling, fix `10-hnet-brand.yaml`
   forward, don't reintroduce compat mode).
5. **Retest the OPS-009 Safari TOTP-enrollment caveat** on the upgraded version — if fixed, delete
   the caveat from OPS-009; if not, file it upstream-referenced.
6. Docs: OPS-009 gains the upgrade + revert record; close this plan to `completed/`.

## Relates

- OPS-009 (Authentik blueprints as-built; the apply/verify/rollback mechanics used both nights).
- haynes-ops `571c7a65` (compat-mode fix) + the brand-CSS specificity commit that followed it.
- `.agents/context/2026-07-12-session-4-wrap.md` / session-5 notes (evidence + method).
- Upstream: goauthentik/authentik **#19814**, #9761, #11282, #4906.

## Check log

- 2026-07-13 (filing): no fixed release yet — 2026.5.3 is current and affected.
