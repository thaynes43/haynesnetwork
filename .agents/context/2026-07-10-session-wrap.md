# 2026-07-10 — Session-2 wrap: v0.14.1 → v0.29.0, trash automation proven in production

The dated chronicle of session 2. Session 1 built the board (plans 002–016) and went public; session
2 was **owner-feedback-driven hardening** that turned the trash automation loop from *armed* into a
**proven production pipeline** (first real sweep 2026-07-09), plus three live incidents caught and
fixed. Cold-start state lives in `.agents/HANDOFF.md`; this file is the narrative.

## Releases (one line each)

- **v0.14.1** — ledger/library sort affordance + true filtered export count (Ledger UX polish, task #21).
- **v0.15.0** — PLAN-015 downstream *arr action feedback: live Fix/Force-Search progress (ADR-028;
  derived phases over `/queue`+history, no poller, no migration; anti-mash lock surfaced as a chip).
- **v0.16.0** — cutover auth hardening (trustedOrigins for apex/www + real client IP behind the
  tunnel); Ledger **Runs** tab; My Plex recognizes the server owner; themed dark-mode Bulletin/shared
  inputs. (Four owner-reported fixes batched.)
- **v0.16.1** — track expedited deletions in Recently Deleted + Activity; Expedite/Save equal button
  weight; **cosign-verify retry** to absorb GHCR signature-propagation lag (the flake that had been
  red-flagging release runs).
- **v0.17.0** — PLAN-013 storage metrics: utilization vs a configurable space target + reclaim
  attribution (ADR-030 HYBRID; native reclaim + deep-linked Grafana trend; migration 0021).
- **v0.18.0** — PLAN-014 space-driven batch proposals + rules-tuning report (ADR-031, **propose-only,
  delivered OFF**); RP-initiated Authentik SSO logout on sign-out; bulletin messages deep-link
  referenced titles with repair-status hints; deleted items fall back to TMDB posters.
- **v0.18.1** — local logout when the id_token is stale/absent (no SSO login-loop).
- **v0.19.0** — trash pending views become **phone-first poster walls**; universal top nav +
  role-gated user menu (My Plex, Ledger, Trash settings); save-stats/rescue rates count **net**
  outcomes, not raw save events.
- **v0.20.0** — **per-kind trash lifecycle** (Batches folded into Movies/TV) + context-aware item
  back-links (ADR-033); Plex identity matched by plex.tv numeric id (automatic owner/friend
  recognition); My Plex resolves the real Plex identity (not the OIDC email); ledger rows become
  stacked cards on portrait mobile.
- **v0.20.1** — global Save implies Leaving-Soon rescue (UI + server); roles table inline action badges.
- **v0.21.0** — trash **Overview** landing + kind-tab count badges.
- **v0.22.0** — PLAN-016 **Pushover batch notifications** with delivery window (outbox drained by a
  CronJob; ADR-034; migration 0024). *This closed the curate→notify→delete loop.*
- **v0.23.0** — mid-window **expire override** (typed confirm, audited) + reclaim-targeted (GB) batch
  creation; "Delete all now" naming + requester-protected glyphs on walls.
- **v0.24.0** — tabbed **Trash Settings** hub + requested items start saved (overridable); **continuous
  batch mode** + per-kind caps + all-day notify default + countdown fix; **fix-request timeouts /
  close-on-import / human history copy** (incident #2 fix — see below).
- **v0.25.0** — **paginated** trash walls + interactive future-batch candidates; themed settings
  inputs + Batch policy under General; batch-wall exclusion unprotect + legacy requested reclassification.
- **v0.25.1** — **ADR-035 `trash_candidates` Postgres read-model — instant walls** (incident #3 fix —
  the 9.5s→148ms wall-latency fix; migration 0027).
- **v0.26.0** — native **free-space trend chart** (replaces the LAN-only Grafana deep-link);
  cross-server watch visibility on walls (informational, not protection).
- **v0.27.0** — **SAFE audit enforces Maintainerr aging invariants** so rule pools can never
  self-delete (incident #1 fix — see below); strategy-mirrored wall order + debounced pool refresh
  after saves; watch indicators never occupy the action corner (every tile stays saveable).
- **v0.28.0** — **requested items are informational only** — the separation-of-responsibilities
  ruling: rules promote, humans decide, the app schedules (no requester guardian keep); future-batch
  strip visible to trash users; **role editor works on phones**.
- **v0.29.0** — configurable **final-warning push** (2h before) + honest next-sweep times.

## Owner-feedback batches (the shape of the session)

Session 2 had no plan queue — it ran as tight owner-feedback loops. The recurring themes:

- **Phone-first trash UX**: poster walls (v0.19.0), per-kind lifecycle folding Batches in (v0.20.0),
  Overview landing + count badges (v0.21.0), tabbed Settings hub (v0.24.0), pagination (v0.25.0),
  strategy-mirrored order (v0.27.0), and portrait-safe roles/settings editors (v0.28.0). Everything
  admins touch now works in portrait on a phone.
- **Batch controls the owner actually wanted**: GB/count targeting + mid-window force-expire with
  typed confirm (v0.23.0), continuous mode + per-kind caps (v0.24.0), interactive future-batch
  candidate strips (v0.25.0).
- **Notifications**: Pushover outbox + window (v0.22.0), all-day default (v0.24.0), configurable
  final-warning + honest next-sweep times (v0.29.0).
- **The "who decides" question, settled**: requested items went from a proposed guardian keep to
  **informational-only** (v0.28.0) — the app schedules, rules promote, **humans rescue** in the save
  window. Recently-watched keep is retained; cross-server watch is info, not protection.
- **Identity correctness**: My Plex now resolves the real Plex identity by plex.tv numeric id rather
  than the OIDC email (v0.16.0/v0.20.0), so owner/friend recognition is automatic.

## First production sweep (2026-07-09 23:45 ET)

The proof the loop works: **14/15 deleted, 90.7 GiB reclaimed.** The single survivor was **honestly
guardian-skipped** — it had left the rule pool mid-window, and the guardian re-checks eligibility at
the deletion gate (correct, not a bug). Seerr entries cleared via **forceSeerr**; the **Pushover**
summary was delivered. Details + the as-built pipeline are in `.agents/HANDOFF.md`.

## Three live incidents caught and fixed

1. **Maintainerr 60-day aging bomb.** The session-1 test rule carried a **60-day `deleteAfterDays`**
   horizon — left alone it would have let Maintainerr delete on its own timeline, outside the app's
   gate. Fixed by moving every production rule to **`deleteAfterDays 9999` + `arrAction 0`
   (DO_NOTHING)** and adding the **SAFE audit that enforces the Maintainerr aging invariants**
   (v0.27.0) so a rule pool can never self-delete out from under the app scheduler.

2. **Stuck fixes.** Fix requests could hang (never timing out, never closing on import). Fixed in
   **v0.24.0**: fix-request timeouts, close-on-import, and clearer human-readable history copy.

3. **Trash wall latency 9.5s → 148ms.** The walls were doing live Maintainerr content crawls; at
   ~742 movie candidates that was up to four concurrent multi-second crawls per tab load (live
   profile in `.agents/context/2026-07-09-trash-wall-perf.md`). Fixed with the **ADR-035
   `trash_candidates` Postgres read-model** (v0.25.1, migration 0027) — walls/candidates/Overview
   serve from PG, refreshed by the sync post-step / rule-edit triggers / a manage-gated refresh;
   ledger join + visible-page exclusion checks stay live. First wall paint dropped from ~9.5s to
   sub-150ms.

## Go-live + cutover gotchas (already recorded in OPS-005)

The public cutover to `haynesnetwork.com` was executed in session 1; the auth-hardening tail landed
early session 2 (v0.16.0: trustedOrigins for apex/www, real client IP behind the tunnel; v0.18.0/
v0.18.1: RP-initiated SSO logout + a stale/absent-id_token local-logout fix that closed an SSO
login-loop). The three cutover gotchas (Traefik v3 `Host()` syntax; cloudflare-ddns record
ownership; Flux envsubst `${1}`) and the post-cutover watch items are all in
`docs/ops/005-root-domain-cutover.md` — not repeated here.

## Next session

Owner-stated: **larger site features + Authentik MFA hardening**, including **migrating Authentik to
blueprints / GitOps**. Every live Authentik change this session is documented with rollbacks in
`docs/ops/001-authentik-provisioning.md` + `scratchpad/ux-011/APPLY.md` (the blueprint seed). Also
owed: the **6:30 AM Kometa check** that the 14 deleted movies do not re-import. See `.agents/HANDOFF.md`.
