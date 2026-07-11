# 2026-07-11 — Session 3 wrap (the "big features + polish loop" marathon)

Resume point for the next session. Read alongside `.agents/HANDOFF.md` (kept current by each
plan's bookkeeping PR), `.agents/context/2026-07-11-polish-loop.md` (the live findings tracker),
and the round-2 plan queue `.agents/plans/README.md`.

## What shipped this session (v0.30.0 → v0.40.1, 11+ app releases + a large ops layer)

- **Metrics section (PLAN-017/018/019/020):** top-level Metrics tab after Bulletin; per-role
  full|limited access; Overview (WAN up/down vs capacity), Apps (*arr/downloads), Hardware
  (SMART/node/pve, critical-only Pushover alerting), Network (unpoller, privacy-invariant). Grafana
  deep-links admin-only.
- **AI (PLAN-021):** Ollama starter models on gasha01; Open WebUI RBAC (small→all, large→Family+Admin);
  ComfyUI image-gen (all users, Qwen workflow); AI usage-metrics sub-tab. GPU repair (2nd 3090)
  DEFERRED (owner-present). Q&A-agent = future.
- **Authentik (PLAN-011):** blueprints-as-code baseline + native-account MFA (owner enrolled passkey+TOTP
  on thaynes); the CSP form-action fix (below) unblocked app OIDC.
- **Role portal (PLAN-026):** haynesnetwork writes Authentik group membership (hnet-portal service
  account, least-priv); OIDC groups-claim sync drives Open WebUI `family` tier on login. mikebi12
  assigned Friends as the acceptance case.
- **Books & Audiobooks (PLAN-023, all 4 phases):** Kavita (ebooks+comics) + Audiobookshelf (audio) +
  LazyLibrarian + Kapowarr deployed (gasha01 CephFS), migrated (tower originals untouched), Prowlarr/
  downloader-wired, PUBLIC via OIDC on *.haynesnetwork.com, and in-app: books_items ledger
  (1283 books / 823 audiobooks / 10 comics), Library tabs + covers + catalog tiles. Default+Family can see.
- **ytdl-sub Library (PLAN-022) + poster guard (PLAN-024):** Peloton/YouTube tabs (direct k8plex),
  detail drill-in, 630× cover perf fix; durable Peloton season-poster guard (hourly CronJob).
- **Library deep-links + access gating (PLAN-028):** *arr→Plex ratingKey match (media_plex_matches,
  hourly sync); "Watch on Plex — <library> ↗" per accessible library on detail pages; SECURITY
  invariant — a role without a library grant never receives its items (server-side, adversarially
  proven). Default keeps all *arr-feeding libs (only Home Videos+Photos ungranted → no member regression).
- **Ops:** collection wave (bazarr exportarr, slskd, qbittorrent-exporter sidecar, pve-exporter all 5
  nodes, HaynesTower node+smartctl scrape, NAS Grafana board); Kometa theatrical-window removal
  (In Theaters chart deleted, availability=released guard, 14 sweep exclusions); scope:host alert
  labels (17 rules — alert-responder skips LLM diagnosis on host/hardware); staging-NVMe SMART mute;
  book-stack memory bumps (Kavita 16Gi etc.); infinite-scroll parity on books walls.

## Polish loop (2026-07-11, owner walkthrough) — see `2026-07-11-polish-loop.md`
- F-01/F-02 Kavita OIDC: DP keys are DB-persisted (non-issue); the REAL cause was **CSP form-action**
  (Authentik traefik middleware only allowed *.haynesops.com → browsers blocked the OIDC form_post to
  *.haynesnetwork.com → infinite "Loading" on ALL browsers). FIXED (commit 31d1d653) — also unblocked ABS.
  **Lesson: headless OIDC validation can't catch CSP/browser failures.**
- F-03 Kavita hnetadmin email → admin@haynesnetwork.com (DB, so OIDC logs owner into admin). DONE.
- F-04 No SMTP (estate-wide) → Phase-3 bucket (owner's Google Workspace + noreply@ alias idea).
- Kavita hardening: OIDC button "Log in with Haynesnetwork"; local-password disabled (admins exempt =
  break-glass, runbook in haynes-ops kavita/README.md). ABS hardening: group→admin mapping (owner IS
  admin now) + disable-local (in flight).
- Comic "broken series" = empty folders + RAR-as-cbz archives (agent quarantining, not deleting).
- Kavita "Match" = Kavita+ (paid, unlicensed) → 400; comic metadata should come from ComicInfo.xml.

## Agents IN FLIGHT at wrap (verify completion FIRST next session — they land releases + bookkeeping PRs)
1. ~~030 season art~~ ✅ DONE v0.41.0 (ADR-048 signed item-scoped /api/library/plex-art; owner still
   owes a prod glance at a Rick-and-Morty detail). ~~not-on-disk button~~ ✅ DONE v0.42.0 (live).
   ~~ABS hardening~~ ✅ DONE (F-07).
2. ~~comic-fix~~ ✅ DONE (50 series/0 broken; quarantine + re-grab list in tracker F-08).
3. ~~027 roles/Bulletin~~ ✅ DONE v0.43.0 (capability map; Trash kept 3-state — justified deviation;
   Default=Messages-only VERIFIED: deployed version + grant table + FORBIDDEN tests + live persona).
4. **MOTD** — code SHIPPED in v0.43.0; agent still owes: live markdown-MOTD swap + screenshots +
   the identity-ping answer (report must lead with the "You are powered by" line; if Opus-served,
   Fable re-review before accepting). THE ONLY LOOSE END at wrap — close first next session.
Final loop tally + owner checklist: see 2026-07-11-polish-loop.md "OWNER RETURN-PASS CHECKLIST"
(releases v0.39.1→v0.43.0). Owner verified R&M season art desktop; mobile pass pending.

**Process caveat (030 agent):** main is NOT prettier-clean (3.8.3→3.9.4 drift; `pnpm format` reflows
392 files). Do NOT run repo-wide format until a dedicated formatting pass; CI doesn't enforce it.

## Plans created/updated this session
- 025 ytdl config-manager platform (ROADMAP), 026 portal (DONE), 027 roles-grid+bulletin (DISPATCHED),
  028 library play-here links (DONE), 029 library views/grouping/collections (ROADMAP — needs owner's
  5 scoping Qs), 030 season-art (DISPATCHED). Polish tracker has an open F-item: Feed attribution
  (Seerr/Tautulli name the user but ingestion doesn't map it → "unattributed").

## Open OWNER items for next session
- **PLAN-029 scoping** (5 Qs): view-pref persistence, comics default group, collections curation
  rights, group-by in the D-09 search contract, which Plex sort/filter affordances.
- **Phase-3 bucket** (post-polish): SMTP/email integration; the Feed-attribution improvement;
  Books→collections/reading-order; ytdl-sub config-manager (025).
- **MAM interview** (private book tracker) — Sat/Wed windows; then owner supplies mam_id and I wire Prowlarr.
- **1Password niceties:** the Kavita/ABS OIDC client secrets + AUTHENTIK_API_TOKEN as reference fields;
  GOOGLE_BOOKS + ComicVine already in.
- (No deferred polish item — the "one more" at wrap was the trash-timing + Music-target questions,
  both answered: 7-day cooldown gates the next auto-batch, Music has no target by design.)

## Trash cooldown test IN PROGRESS at wrap (owner, ~23:30 2026-07-10)
Owner set space_policy cooldownDays 7→0 to test batch proposal (HaynesTower 78.8% > new 75% target);
expects a draft batch at the next hourly :17 run. RESOLVED REASONING: leaving cooldown=0 is FINE —
the batch save window (owner: 21d) + one-open-per-kind is the real pacing; cooldown only matters on
the cancel path (a cancelled batch re-proposes next hour at cooldown=0; a 1-2d cooldown absorbs that).
If no batch appeared by the next :17, trace candidates/open-batch/eval log.

## Model-switch watch (CRITICAL — [[fable-safeguard-model-switch]])
THREE Fable→Opus safeguard flips happened this session (ALL caught by Tom, not me — #3 during a
conversational stretch with no dispatches, so the probe-before-mutation cadence never fired; degraded
window covered only doc edits + trash-cooldown discussion, all reviewed clean after restore). Protocol:
**probe (`model: fable` echo of "You are powered by") before EVERY dispatch/PR-merge/cluster-mutating
step; on mismatch, PushNotification + STOP + wait for Tom to switch back.** Neutral phrasing in prompts.

## Standing rules that bit this session
- Turn discipline: all tool calls first, user-facing reply LAST ([[reply-text-must-end-turn]]).
- New user-facing services LAN-only until OIDC ([[new-services-lan-until-oidc]]) — books went public
  correctly after 011.
- Subagents stall exiting-while-CI-waits — resume them with a BLOCKING `gh run watch --exit-status`.
- haynes-ops direct-to-main is bypass-protected (owner account); PULL FIRST, forward-only image bumps.
