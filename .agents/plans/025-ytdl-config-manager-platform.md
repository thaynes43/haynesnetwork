# PLAN-025: Generic ytdl config-manager platform (plugin architecture) + Library-extras editing

- **Status:** **SCOPED (owner rulings 2026-07-20 — the owner-present scoping session happened).**
  The four gating questions are RULED (below); the two researchable ones (Q-02 source sweep,
  Q-03 plugin interface) are Opus-dispatched, reports land as dated `.agents/context/` notes.
  Next: ADR + design doc off the research, then the build saga. The DO-NOT-DISPATCH gate is
  LIFTED for docs/research; code waits on the accepted design + the owner creating the new repo
  (he names it — the Libretto precedent).

## ▶ SCOPING RULINGS (owner, 2026-07-20 — all four on the recommended option)

- **Q-01 shape → *ARR-SHAPED SERVICE.** Own API/domain (sources, subscriptions, scheduling,
  media rules); haynesnetwork integrates it exactly like Sonarr/Radarr (one-way sync in,
  confined write client, hard-rule-4 source-of-truth pattern). The decisive driver stands:
  Fix-everywhere parity for YouTube/Peloton items requires per-item remediation only a service
  can do. Suite doctrine applies (the Libretto precedent): HEADLESS, generic/reusable, the app
  owns 100% of the UX.
- **Q-06 codebase → NEW REPO; port the fragile-but-working Peloton logic behind the plugin
  seam.** The old manager keeps running untouched until cutover.
- **Q-04 state → SERVICE-OWNED.** Its own DB; it GENERATES ytdl-sub configs itself (no git-PR
  write path — member mutations want instant effect; the Kometa PR-per-change friction was
  live-measured the same day). haynes-ops just deploys the service; the hardcoded YouTube YAML
  gets taken over at cutover.
- **Q-05 member mutations → DIRECT with caps + audit.** Edit-granted roles add/remove channels
  directly (the collections direct-add doctrine: caps per role, over-cap → ticket, admins
  unbounded, audit rows same-tx). No suggest→approve.
- **Relates:** PLAN-022 (ytdl-sub Library surfaces + its phase-2 "config-manager cleanup" TODO —
  SUPERSEDED by this vision), PLAN-024 (poster guard — the "smallest Kometa-for-ytdl-sub"; likely
  folds in as a core or plugin concern), ADR-038/041 (read surfaces this would add write flows to),
  the `ytdlsub` section's currently-meaningless Edit level (becomes the user-facing write grant).
- **Repos:** `/home/thaynes/workspace/ytdl-sub-config-manager` (the donor/rework target),
  `haynes-ops` (currently hardcodes the YouTube YAML under kubernetes/main/apps/downloads/ytdl-sub/),
  this app (integration client + UI).

---

## Owner vision (2026-07-10)

ytdl-sub-config-manager is old, hard to work with without major refactoring; the Peloton logic is
fragile and buggy **but works**. Rework it into a **generic config manager with a plugin
architecture**:

1. **Core = generic ytdl-sub/yt-dlp config management.** Supports many ytdlp source types out of
   the box — requires a **sweep of what ytdl-sub/yt-dlp natively handle** to define the built-in
   source matrix. Takes over managing the **YouTube YAML currently hardcoded in haynes-ops**.
2. **Plugins for special sources.** Peloton is the first plugin — a **rebrand/port of the existing
   fragile-but-working logic** into the plugin interface. Most other plugin-requiring sources are
   skipped at the start (Peloton only).
3. **User-facing editing from haynesnetwork.com:** users add/remove YouTube channels (and later,
   other sources) through the app UI. This is what the Library-extras **Edit** permission level was
   reserved for — Edit = may mutate sources/subscriptions; Read-only = browse only.
4. **Media-management hooks** tied into the new app — open question whether it stays a *pure
   config manager* or grows into **"an *arr for ytdl content"**: a service with its own API/domain
   (sources, subscriptions, scheduling, media rules) that haynesnetwork.com integrates with the
   same way it integrates Sonarr/Radarr (one-way sync in, confined write client, source-of-truth
   stays with the service — the CLAUDE.md hard-rule-4 pattern extends naturally).

## Open questions for the scoping session (Q-NN when ratified)

- **Q-01 — pure manager vs *arr-shaped service:** where on that spectrum? (API-first service is
  what makes the app integration + RBAC story clean; also enables the poster-guard/media hooks to
  live there instead of in @hnet/sync long-term.) **New driver (owner 2026-07-11, PLAN-041):**
  the Library **Fix-everywhere parity goal** — YouTube/Peloton items can only get the TV/Movies-
  style "Fix" (re-download/replace a bad copy) if this becomes the *arr-shaped service; a pure
  config manager cannot remediate a single item. Weigh that leg of the parity table in the Q-01
  decision.
- **Q-02 — the ytdlp source sweep:** which source types are first-class out of the box; what does
  "supported" mean (subscribe/download/organize/present)?
- **Q-03 — plugin interface:** what does the Peloton port need from it (auth/session handling,
  scraping cadence, season/duration mapping — the exact fragile parts); language/runtime for
  plugins.
- **Q-04 — migration path:** haynes-ops YouTube YAML → managed state (GitOps-compatible? does the
  manager write PRs, own a CRD/ConfigMap, or hold state in its own DB with haynes-ops just
  deploying it?).
- **Q-05 — app integration surface:** which mutations members get (add/remove channel at Edit
  level), quota/approval gates (does a member request a channel and an admin approve — the
  requested-items pattern?), audit trail requirements.
- **Q-06 — what of ytdl-sub-config-manager survives:** rework in place vs new repo with the old
  Peloton logic ported behind the plugin seam.

## Out of scope until the owner green-lights scoping

Everything. No dispatches, no ADRs, no refactors of ytdl-sub-config-manager. PLAN-024's poster
guard keeps running as-is; PLAN-022 phase-2 cleanup TODOs are parked here.
