# PLAN-025: Generic ytdl config-manager platform (plugin architecture) + Library-extras editing

- **Status:** **Roadmap (owner vision 2026-07-10) — DO NOT DISPATCH.** Captured verbatim-in-intent
  from the owner; explicitly "nothing to jump on right now, just roadmapping." Scoping/ADRs happen
  in a future owner-present session.
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
  live there instead of in @hnet/sync long-term.)
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
