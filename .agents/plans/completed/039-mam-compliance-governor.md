# PLAN-039: MAM compliance governor — cap-aware torrent-fallback pacing

- **Status:** ✅ **COMPLETED (v0.45.0, 2026-07-11/12).** ADR-054 / DESIGN-027 / migration 0041
  (`mam_gate_state`) + the confined `@hnet/downloads` package (qB count read + Prowlarr indexer
  `enable` toggle, import-confined to domain). Seam = the **Prowlarr indexer** (its fullSync LL
  application propagates the toggle to LazyLibrarian in ~6s, so LL never queries a dead feed —
  the LL-side toggle was REJECTED as non-durable, fullSync clobbers it). Fail-closed counting,
  transitions-only Pushover, first-run baseline never pages, config behind one
  `resolveGovernorConfig()` seam for PLAN-040. Deployed via haynes-ops `726e2b9e` (image bump +
  `sync-mam-governor` CronJob `4,19,34,49 * * * *` + PROWLARR_API_KEY ExternalSecret line).
  **Live-proven:** first manual run counted 13/13 unsatisfied (threshold 15, headroom 7, gate
  open, no page, 86ms); scheduled runs green; after the real Matilda grab the next run read
  **14 unsatisfied / headroom 6** — the count tracks reality. Build was an Opus agent; the
  coordinator took over merge→release→deploy after the agent's self-resume flipped it to Fable
  (see `[[subagent-resume-loses-model-override]]`).
  Original build ruling (2026-07-11 eve, kept for the record): "governor first, then docs" —
  the guardrail ships BEFORE any list automation drives grabs; superseded the earlier
  "wait for miss-rate data" gate after the first 13 real grabs exposed the compliance risk
  directly (OPS-013 corrections — the qB queueing trap + backwards provider priority). Rank
  knob starts at 20 (New Member).
- **The problem (owner-stated):** LL is usenet-first with MAM fallback. A large wanted list
  (say 1000 items, 100 usenet-misses) would burst-grab past MAM's **unsatisfied-torrents cap**
  (New Member 20 → User 50 → PU 100 → VIP 150; exceed ⇒ downloads blocked up to 24h — see
  `2026-07-11-mam-rules-scrape.md`). "Unsatisfied" = snatched but not yet seeded 72h(/30d), so
  with 24/7 seeding the cap is really a THROUGHPUT limit: ≈ rank-limit per ~72h window
  (New Member ≈ 6–7 grabs/day sustainable).
- **Tooling reality (be honest at design):** no off-the-shelf cap-aware grab governor exists
  for the LL+Prowlarr+MAM combo. Adjacent tools: qbit_manage (per-tracker seed-rule
  enforcement/tagging — candidate for the seed-forever guardrail), Prowlarr per-indexer seed
  criteria (already set to never-stop), autobrr (racing, not compliance). The governor is OURS
  to build — and it fits the estate's sync-mode pattern exactly.

## Shape (coordinator sketch)

A small governor (CronJob/sync-mode, ~15-min cadence) that:
1. **Counts unsatisfied locally** from qBittorrent: torrents in `books-mam` with
   `seeding_time < 72h` (+ a still-downloading count). Local counting = zero extra MAM API
   surface (compliance: automation stays search + dynamicSeedbox only).
2. **Gates the fallback at the Prowlarr seam:** when `unsatisfied >= limit - buffer` (e.g.
   buffer 5), PAUSE the MyAnonaMouse indexer via Prowlarr's API (usenet keeps flowing;
   LL never even sees MAM results); resume when torrents mature past 72h. Grabs self-pace to
   the cap with zero MAM-side behavior changes.
3. **Rank knob:** `MAM_UNSATISFIED_LIMIT` config (20 today) the owner bumps at each MAM
   promotion (User 50 → PU 100 → VIP 150). Optional later: read rank from MAM user JSON if a
   documented endpoint exists — verify against the automation rule first; manual knob is safe.
4. **Visibility:** Pushover (existing outbox) when the governor pauses/resumes the indexer or
   when headroom stays pinned at 0 for >48h (means demand far exceeds throughput — owner may
   want to prioritize the wanted list); counts surfaced on the Metrics Apps tab later (nicety).
5. **Seed-forever guardrail:** evaluate qbit_manage vs native qBittorrent category settings
   for enforcing never-stop/never-delete on `books-mam` (PLAN-031 sets it; the guardrail keeps
   config drift from silently breaking it).

## Open questions (defer to scoping)

- Q-01: buffer size + whether Complete-but-<72h downloading torrents count (be conservative).
- Q-02: pause-indexer vs LL-side provider toggle (indexer-pause is cleaner: one seam).
- Q-03: surface governor state in-app (Metrics) or logs+Pushover only for v1?
