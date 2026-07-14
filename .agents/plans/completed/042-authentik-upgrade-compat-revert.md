# PLAN-042: Old-WebKit login crash — mitigation + upstream watch (compat-mode revert folded in)

- **Status:** COMPLETED 2026-07-13 evening — **Option A executed (owner-ruled), verified live,
  compat mode reverted.** The served authentik web assets are CSS-nesting-LOWERED by server-pod
  initContainers (haynes-ops); old WebKit 18.2 passes the live login natively 3/3 (vs 3/3
  renderer crash before); Plex-first ordering + divider self-healed; `%(theme)s` background
  polish shipped. Full build record in the check log below.
- *(Superseded status, kept for history:)* ESCALATED 2026-07-13 ~01:00 — the compat-mode
  workaround does NOT fix real Safari ≤18.3.x (owner re-tested: still crashes; upstream RCA
  explains why, below).
- **TRUE ROOT CAUSE (upstream RCA, goauthentik#19814 comment 2026-06-30):** authentik ≥2025.12
  (PatternFly v6 era) ships **native CSS nesting** pervasively — in `flow-<ver>.css` AND baked
  into JS-embedded component styles (esbuild loads CSS as raw text, never lowers it). Old WebKit
  has bug **#290102**: a `StyleRuleNestedDeclarations` selector list is left dangling; the next
  `setAttribute()` from Lit's render walks the freed list → **native WebContent crash
  (EXC_BAD_ACCESS), zero console errors**. Affected: iOS/iPadOS ~16.6–18.3.x and macOS Safari
  ~17.6 (upstream reports); FIXED in newer WebKit (current iOS/macOS are fine — "updating iOS
  resolves it"). This is why compat mode (ShadyDOM) passed in Playwright's WebKit builds but the
  owner's Safari 18.3.1 still spins — the crash is CSS-engine-level, not shadow-DOM-level.
- **Compat mode disposition:** keep `compatibility_mode: true` for now (harmless; helped at least
  one engine build; reverting churns the login again) — revert it as part of whichever fix lands.
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

## Option A — OUR mitigation (dispatchable NOW, owner ruling needed): asset nesting-lowering

The RCA author **verified** this approach: rebuild/post-process the authentik frontend bundles
with CSS-nesting **lowering** (lightningcss, target ~Safari 15) across BOTH the CSS bundles and
the JS-embedded component styles → 0 nesting markers → no `StyleRuleNestedDeclarations` → no
crash on old WebKit. For OUR estate (no fork): a **post-process step over the served static
assets** — e.g. an initContainer on the authentik server pod that copies `/web/dist` to an
emptyDir, runs the lowering over `flow-*.css` + the JS bundles' embedded styles, and mounts it
over the static path. Scope: haynes-ops-only; must survive authentik image bumps (re-runs each
start); needs a verify harness (the sso-webkit repro + ideally an OLD-WebKit engine or the iOS
Simulator note from upstream). Risks: transforming minified JS-embedded CSS safely; size/startup
cost. **Decide Monday: is old-WebKit reach worth this build?** (Owner is advertising the site;
upstream reports cover iOS 16–18 devices which are still common.)

## Option B — the upstream watch (cheap, any session; unchanged)

1. Check upstream: an Authentik release that lowers CSS nesting in its web build (or otherwise
   closes the #19814 class — no mitigation PR existed as of 2026-07-13; 2026.5.4's changelog is
   silent on it). Also consider FILING/upvoting the mitigation upstream — the RCA comment already
   contains the verified recipe.
2. If NO fix yet: note the date checked in the log below; done (minutes).
3. A FIXED release → the upgrade path becomes dispatchable (owner-present, login estate).

## Option C — user-side (no engineering): affected users update their OS

WebKit fixed the bug — current iOS/iPadOS/macOS don't crash. Owner/sister devices: update. Does
NOT help anonymous visitors on older devices (that's what A/B are for).

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
- 2026-07-13 ~01:00 (escalation): owner re-test — compat mode does NOT fix Safari 18.3.1; RCA
  found in the #19814 thread (CSS nesting + WebKit #290102); 2026.5.4 (2026-07-08) changelog
  silent; no upstream mitigation PR. Options A/B/C written; owner ruling Monday.
- 2026-07-13 ~01:30 (device-map correction + laptop variant closed): the failing `Version/18.3.1`
  Loki UA was the **iPad** — the owner's LAPTOP is macOS Tahoe 26.5.2 (current WebKit). On a
  console-open retest the laptop's private-mode flow page **rendered and logged in fine**: healthy
  boot (version banner → ws connect → executor GET → identification form), the ONLY failed request
  being the known **`%(theme)s` background nit** (`files/media/public/hnet/bg-c-%(theme)s.svg` —
  Safari "The network connection was lost"). Working theory for the earlier laptop spins:
  transient edge/QUIC connection drops and/or catching the page pre-propagation — NOT the WebKit
  crash. If a current-WebKit spin recurs, capture the console BEFORE theorizing.
- **Owner executed Option C for his devices (2026-07-13 overnight):** iPad updating to current
  iPadOS overnight. **Monday validation: retest the iPad login** — a pass confirms the WebKit-side
  fix and narrows the A/B/C ruling to ANONYMOUS old-WebKit visitors only.
- **Folded-in polish item: fix the `%(theme)s` placeholder** in the brand background URL
  (`10-hnet-brand.yaml`) — one doomed request per flow-page load in every browser; trivial
  blueprint edit + flow-page reload check. Do it with (or before) whichever option lands.
- 2026-07-13 ~18:05 (session-6 cold-start check): no change — 2026.5.4 still latest; #19814's
  newest comment is still the 2026-06-30 RCA; no mitigation PR.
- **2026-07-13 evening — OPTION A EXECUTED (owner-ruled): shipped, live-verified, compat
  REVERTED. Plan complete.** Build record (haynes-ops, direct commits to main):
  - `1b11dc69` — `%(theme)s` polish: `branding_default_flow_background` pinned to the concrete
    `hnet/bg-c-dark.svg` (authentik substitutes the placeholder for `branding_logo` but serves
    the flow-background URL VERBATIM → one doomed request per flow-page load). Verified live:
    signed URL 200 `image/svg+xml`, background visibly renders (screenshots), zero `%(theme)s`
    requests in any engine.
  - `4a7bc3af` — the core mitigation: server-pod initContainers — `web-dist-copy` (the chart's
    own server image via tpl'd `{{ .Chart.AppVersion }}` reference → image-bump-proof, re-runs
    every pod start; copies `/web/dist` to an emptyDir) and `web-dist-lower`
    (node:22-bookworm-slim; pinned lightningcss@1.30.1 + acorn@8.15.0 installed at pod start;
    lowers every `*.css` bundle AND every CSS string/expression-free template literal embedded
    in the JS bundles — `targets: safari >= 15` + `Features.Nesting`; tagged templates stay
    templates so Lit `css` semantics hold; deletes `.br`/`.gz` siblings; FAIL-LOUD gate) — with
    the emptyDir mounted OVER `/web/dist`. Script delivered as ConfigMap `authentik-web-lowering`
    (configMapGenerator + reloader annotation), file
    `kubernetes/main/apps/network/authentik/app/web-lowering/lower-css-nesting.mjs`.
  - Three fail-safe landing iterations (login stayed 200 throughout — each failure left the old
    ReplicaSet serving): `7258fd0f` envsubst safety (the app Kustomization has
    `postBuild.substitute`; the script's `${}` template-literal interpolations broke the post
    build for the WHOLE app dir → script rewritten with zero variable-like dollar tokens;
    pre-flighted with `kubectl kustomize | flux envsubst --strict`); `9392d81f` web-dist-copy
    CrashLoop (`cp -a`'s utimensat on the root-owned emptyDir mount point → EPERM as the
    image's non-root user → `cp -r`) + helm wait 15m; `234037a1` gate refinement — the full
    dist (358 JS files) surfaced 8 false-positive "residuals": Mermaid theme template fragments
    (stylis flattens `&` at runtime before injection) and Lezer parser tables in the CodeMirror
    chunk (packed grammar data, not CSS); the gate now fails ONLY on strings that STRICTLY parse
    as CSS stylesheets with nesting remaining (the actual WebKit #290102 vector) and logs the
    rest as auditable `suspects`; `716f5cc2` helm wait 20m (also minted a fresh HelmRelease
    generation after the exhausted-remediation rollbacks).
  - Origin result: rollout 3/3 ready; per-pod gate log `jsChanged: 20, literalsLowered: 25,
    residualCount: 0, suspectCount: 8, "OK: zero nesting markers"`. Served `flow-2026.5.3.css`
    33→0 markers (byte-identical to the local reference transform), `FlowInterface-2026.5.3.js`
    7→0, identification-stage chunk 0.
  - `dafdea79` — **compat revert**: `compatibility_mode: true → false` on all four flows
    (571c7a65's deviation comment replaced with a history note).
  - Verification (sso-webkit harness rebuilt in scratchpad — Playwright 1.50.1/WebKit 18.2 as
    the crash proxy + Playwright 1.61.1/WebKit 26.5, Chromium 149, Firefox 151; fresh ephemeral
    contexts against the live flow page):
    - Crash CONTROL (original assets + native mode simulated by stripping the ShadyDOM script):
      WebKit 18.2 renderer crash **3/3** — the proxy still bites.
    - Pre-proof (original assets lowered on the fly in-route, native): WebKit 18.2 **3/3 pass**.
    - Post-rollout, compat still ON: all four engines green (cache-busted through the real CDN).
    - DECISIVE, live native after the revert (no tricks): **WebKit 18.2 3/3 — no crash, form
      renders, advances past stage 1**; all four engines green; desktop + mobile viewports.
    - Brand in native mode: dark-green background + mark, brand card, GREEN "Log in with Plex"
      pill, pill-shaped buttons all hold (the specificity pass was written for both modes).
      **Plex-first ordering + divider SELF-HEALED** as predicted (probes: Plex button above the
      username field; `::before` divider content `"or sign in with a local account"` present).
      After-screenshots (desktop + mobile, old + current WebKit) captured for owner ratification.
  - Edge cache: Cloudflare canonical asset entries (max-age 14400) refreshed themselves by
    ~21:53 EDT — canonical CSS/JS now serve the lowered bytes (verified HIT + 0 markers).
  - Ops notes: kubectl/Omni auth was DOWN the whole evening (`authcode-browser … context
    deadline exceeded`) — every change landed via Flux's own GitRepository sync ticks (:12/:42,
    30m interval) and was verified via the Grafana MCP (Loki pod/controller logs, Prometheus
    kube-state metrics) + public HTTP only. The 30m tick is the change-latency floor when
    kubectl is out.
  - Upstream: 👍 reactions added to #19814 and to the RCA comment; a technical confirmation
    comment is DRAFTED for owner review (NOT posted) —
    `.agents/context/2026-07-13-plan-042-upstream-draft.md`.
  - OPS-009 amended in the same PR (mitigation as-built; TOTP-enrollment caveat kept with a
    "may be cured" note — the lowering covers ALL interfaces' static assets; owner retest
    pending). iPad Option C retest (updated iPadOS) also still pending owner.
