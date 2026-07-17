# PLAN-040: MAM governor admin tool — rank-aware account config in-app

- **Status:** PLACEHOLDER (owner 2026-07-11 eve). Build AFTER PLAN-039 ships and the rank
  progression is underway — until then the owner manually requests config changes at each
  MAM promotion.
- **Owner intent (2026-07-11, his words):** "MAM is a fallback that's governed based on my
  rating, but we also use/seed it enough to bring my rating up to the point where we never
  have to really disable it due to volume. I will manually request MAM account-related config
  changes as I get promoted for seeding, but we should make this an Admin tool."
- **Depends on:** 039 (the governor must exist). **Relates:** OPS-013 (runbook), 032 (list
  automation drives the volume the governor paces).

## Shape (sketch — to firm up when 039's as-built lands)

1. **Move the rank knob in-app:** the governor's `MAM_UNSATISFIED_LIMIT` + buffer move from
   env to an audited, DB-backed admin setting (the `app_settings`/`setMotd` precedent —
   single-writer domain mutation + audit row in the same tx); the governor CronJob resolves
   the DB value each run (039 is being built with the config read behind a single seam so
   this slots in without rework).
2. **Admin UI:** a small card/page under `/admin` — rank preset (New Member 20 / User 50 /
   Power User 100 / VIP 150 / custom), buffer, and live governor state (unsatisfied count,
   headroom, gate open/closed, last transition), plus a manual pause/resume override
   (audited).
3. **Niceties (optional):** a Metrics Apps-tab tile (039 Q-03 deferral); a "headroom pinned —
   check promotion eligibility" hint tied to the existing pinned-headroom alert.

## Open questions

- **Q-01:** admin-only, or a section-permission? (Lean admin-only — this is account
  compliance config, not member-facing.)
- **Q-02:** read the account rank automatically from a documented MAM user endpoint (verify
  against the automation rules FIRST — today's contract is search + dynamicSeedbox only) vs
  manual preset only. Manual is the safe default.

## Out of scope until scoped

Everything — this is a placeholder so the intent isn't lost.

## Research input (2026-07-17) — bonus points / VIP / class-cap mechanics

Full report: `.agents/context/2026-07-17-mam-vip-research.md`. The load-bearing findings for
this plan:

1. **Freeleech does not touch seed obligations.** Any freeleech flavor zeroes only the
   download/ratio cost; the 72h seed obligation applies identically. No spend on
   wedges/VIP-freeleech lifts the governor cap. Wedges: keep hoarding, never buy for this.
2. **The cap is a CLASS attribute** — New Member 20 → User 50 → Power User 100 → VIP 150 —
   confirming the preset ladder above. VIP helps because it is a higher class, not because
   of freeleech.
3. **VIP must be modeled as a MAINTAINED state:** it is points-bought in weeks (rolling
   ~90-day window), requires Power User first, and a lapse drops the cap back to 100 — the
   admin UI's VIP preset needs a "renewal owed" affordance, not a set-and-forget value.
4. **Optimal spend path (owner-directed):** earn Power User (member ≥4 weeks AND >25 GB
   uploaded AND ratio ≥2.0 — buy only the minimum upload credit to clear the ratio gate,
   ~500 points/GB), then points-buy VIP for cap 150. Sustained safe throughput ≈
   (cap − buffer)/72h: ~5/day at 20 → ~48/day at 150.
5. **Q-02 refinement:** if auto-read is ever wired, read the account CLASS, not freeleech
   status. Prices/thresholds are login-walled — the owner verifies in-site before spending.
