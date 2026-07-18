# 2026-07-17 — Owner rulings + backlog (remote-control session)

Captured live; to be folded into the design docs (docs-first) + HANDOFF by a consolidated
recording pass. Source of truth until then.

## Resolved rulings
- **Thin recipes:** KEEP (never cut) — Wanted tiles make them non-empty. Owner going MAM VIP soon (faster fills).
- **DESIGN-004 Q-04:** DELETE the 3 dormant Plex catalog rows (`plex`/`k8plex`/`plexops`). [deletion agent in progress]
- **DESIGN-041 Q-01 (Seerr):** WAIT for upstream OIDC to reach stable.
- **DESIGN-041 Q-03 (SSO v1 scope):** catalog cards FIRST (as designed). Estate apps = BACKLOG (lower priority; make a plan, update with learnings from the cards). Home Assistant has NO OIDC (Authentik creator has some unmerged work) → needs research.
- **DESIGN-041 Q-05 (Open WebUI):** DEEP-LINK now (`/oauth/oidc/login`, zero-click, revert on upstream). ACTIONABLE.
- **DESIGN-041 Q-06 (Kavita role sync):** ENABLE NOW — auto-login looks good, no more soak — WITHOUT age. ACTIONABLE. Age handling deferred (see backlog).
- **DESIGN-041 Q-08 (Tautulli scope):** family-facing only for now; LAN instances → BACKLOG. Vision: one Tautulli for all Plex servers (single URL + server picker, maybe via SSO wrap).
- **DESIGN-042 Q-07 (Kometa acquisition):** ON, but fenced by role-control + admin-only size cap + the Wanted-tile UX.

## Backlog (new, owner-directed)
- **Estate-apps SSO** (Grafana / Home Assistant / homepage / headlamp) — lower priority; make a plan, update from the card learnings. **HA needs OIDC research** (Authentik creator's unmerged work).
- **Unified Tautulli** across all Plex servers — single URL + server picker; fold last night's `config.ini`/GitOps setup learnings (the tweaks differ under GitOps).
- **Kid/Teen roles + library curation** — age-based content control as CURATION (what library they see), not parental controls. Needs kid/YA books acquired first (son 11, daughter 6 — nothing on the shelves interests them today).
- **SMTP for Kavita + other apps** that support it — was a problem early on (new-account authorization emails).

## Live-verified by the owner (2026-07-17 evening)
- **Home rule position** (between the glance badges and the About tile) — owner: fixed. ✓
- **Books/audiobooks/comics detail-page parity** — owner: looks great (incl. the v0.72.1 About
  clamp). ✓
- FIRST MOVES item 2 (the pre-bounce "not yet live-verified" visuals) is fully CLOSED.

## Collections design ready
`.agents/context/2026-07-17-label-driven-collections-spike.md` — holistic label-driven + Wanted-tile
design, 8 blocking owner decisions (Q-1..Q-8). Awaiting owner ratification.
