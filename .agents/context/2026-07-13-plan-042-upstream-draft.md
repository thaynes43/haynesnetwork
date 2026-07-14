# 2026-07-13 — PLAN-042 upstream comment DRAFT (goauthentik#19814) — awaiting owner sign-off

Written by the session-6 Option A build agent after live verification. 👍 reactions are
already on the issue + RCA comment; this comment is NOT posted — owner reviews, then posts
(or edits) it manually or delegates.

Confirming @arvin-ng's RCA and recipe work as a **deployment-side mitigation** (no fork, no rebuild) — for anyone who needs old-WebKit clients working before a fix ships upstream.

**Setup:** authentik 2026.5.3 (official Helm chart, k8s). We reproduced the crash class with Playwright's WebKit 18.2 build against our live flow page: with the stock assets and native rendering, the renderer crashed 3/3 before the first executor call, zero console errors. `compatibility_mode: true` did NOT fix real old-Safari clients — consistent with the RCA: the crash is CSS-engine-level (WebKit #290102), not shadow-DOM-level.

**Mitigation (initContainers on the server pod, post-processing the served assets):**

1. An initContainer running the authentik server image itself (chart-appVersion-templated, so image bumps re-run it) copies `/web/dist` into an `emptyDir`.
2. A second initContainer (node:22) runs a small script over the copy:
   - every `*.css` bundle -> `lightningcss` transform (`targets: safari >= 15`, `include: Features.Nesting`);
   - every `*.js` bundle -> parse with `acorn`; for every string literal and expression-free template literal that is CSS-with-nesting, run the same lightningcss lowering on the string content and splice it back (template literals stay template literals, so Lit `css`-tagged templates keep their semantics);
   - delete any precompressed `.br`/`.gz` siblings;
   - **fail the pod if any string that strictly parses as a CSS stylesheet still carries nesting** (as the RCA says, partial coverage does not fix the crash). Marker-bearing text that is NOT parseable CSS is logged as a non-fatal "suspect" — in 2026.5.3 the only suspects are Lezer parser tables in the CodeMirror chunk (not CSS) and Mermaid theme fragments (flattened by stylis at runtime).
3. The `emptyDir` is mounted over `/web/dist`, so only lowered assets are served. A failed transform leaves the previous ReplicaSet serving — the mitigation can never take login down.

**Marker counts (2026.5.3):** `flow-2026.5.3.css` 33 -> 0; `FlowInterface-2026.5.3.js` 7 -> 0; across the full dist, 25 embedded style literals lowered in 20 JS bundles; final scan of the live-served assets: **zero nesting markers** in CSS files and JS-embedded styles.

**Verified engines (fresh ephemeral contexts against the live login, `compatibility_mode` back at `false`):** Playwright WebKit **18.2** — previously 3/3 renderer crash on native rendering, now 3/3 renders the identification form and advances past the first stage; WebKit 26.5, Chromium 149, Firefox 151 all green, desktop and mobile viewports.

Happy to share the exact script/manifests if useful. And +1 to fixing this in the web build itself — lowering at build time (lightningcss/postcss-nesting, or a browserslist target that predates native nesting) would make this workaround unnecessary.
