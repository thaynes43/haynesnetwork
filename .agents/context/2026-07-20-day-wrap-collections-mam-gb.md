# 2026-07-20 — day wrap: collections live across ALL library types, MAM demand armed, GB accounting fixed (v0.88.3)

Owner directives today (near-verbatim): finish/verify the Collections saga + Libretto; "I want
to see new collections going live across all Library types. We can go small for Kometa"; "we
really need to build out Libretto recipes"; "check MAM and get that close to its quota so I can
start the 3 day countdown." Coordinator: Fable; all real work Opus-dispatched (7 agents).

## Shipped / proven today

1. **Kometa Movies/TV write path — FIRST live fire, PASSED end-to-end** (its arming was real:
   `HAYNESOPS_WRITE_TOKEN` works). Two small live proofs: "Sci-Fi Favorites (verify)" (6
   movies) + "Prestige Dramas (verify)" (5 shows) → bot PRs haynes-ops #2170/#2171 →
   managed-include diffs byte-correct → Kometa scoped run built both → mirror `provenance:
   kometa` (457→459). **Defect found + fixed same day (#445):** the auto-merge gate rolled up
   ALL PR checks within a hard 120s (the flux-local matrix never finishes in time) → every
   eligible add degraded to human-merge, and the mutation blocked ~135s. As-fixed: app-side
   3-condition eligibility + ONE scoped check on the named `Kometa Validate Managed Files`
   gate (green→merge, red→human, pending→arm a DEFERRED background wait), request returns
   immediately. Native GitHub auto-merge was rejected deliberately: the validate check is
   path-filtered and CANNOT be a required check, so native auto-merge would merge without it.
   NOTE: an agent's claim that HAYNESOPS_WRITE_TOKEN "is not provisioned" was a wrong
   inference (secret unreadable from the pod); the live test disproves it.
2. **25 new Libretto recipes live** (11 Kavita books reading lists + 14 ABS audiobook
   collections incl. 5 audiobook twins of Kavita-only franchises), ALL non-empty: **198 held
   members, 127 missing minted as origin='collection' wants, all `acquisitionEnabled:true`**
   (the MAM demand feed). Mirror verified (51→ collections, `created_by='libretto'`). Net
   Libretto recipes 20→45. Notables: Redwall audio 18 held, Discworld audio 41, The Reckoners
   audio COMPLETE 5/5.
3. **Comics grain SHIPPED in Libretto** (PR #11 → live `sha-7f042bd`; haynes-ops #2173):
   new `hardcover_comics` builder, series-grain conservative matching. Live + mirrored:
   **"Invincible Universe"** (Invincible + Guarding the Globe) + **"Scott Pilgrim"**. Comics
   stay grouping-only (acquisition = schema error). DESIGN-037 D-05/D-15 amended (this PR).
   **New collections landed across every library type today: Movies, TV, Books, Audiobooks,
   Comics.**
4. **The GB saga's REAL last layer:** the morning verification (#442) passed all criteria,
   then the daily breaker re-tripped 13:32 UTC at only 484 counted calls. Root cause
   (code-proven): the budgeter counted LOGICAL queries, metering `onCall` BEFORE the retry
   loop — Google meters every physical request; ratio ≈2.07:1 on a 503-heavy day. **Fixed
   #444** (count inside the retry loop = physical-accurate; budgets stay 700/200/100 which
   now sum to the real 1,000 cap; + the 201/200 reserve-before-commit off-by-one).
5. **v0.88.3 DEPLOYED + live-verified 15:44 UTC** (release PR #443 danced; haynes-ops #2172 —
   ONE anchored `&mainImage` line covers app + migrate + all 18 sync CronJobs; health 200).
   Both fixes live well before the 07:00 UTC reset.
6. **GB key diagnosis (masked direct-curl evidence):** all three keys VALID, Books API
   enabled, three genuinely distinct GCP projects. Today's null-resolve storm = Libretto
   exhausted its own 1,000/day (per-work fan-out over the 25-recipe wave; the 137-work
   Invincible attempt bit hard), and the app key exhausted its own (the #444 amplification).
   LazyLibrarian's key healthy. **Self-heals at the 07:00 UTC reset** — the hourly wants pass
   re-resolves the 127 nulls. Quota-increase requests are the known Books-API dead-end; the
   durable levers are more projects/keys per consumer + fewer calls per pass. **Broker
   hardening dispatched** (in flight at wrap): log GB status, 429/5xx retryable + run-latch
   short-circuit, additive `quota_exhausted` vs `no_match` reason (non-breaking).
7. **MAM: 48 → 112 unsatisfied** (organic; threshold 185, gate open). The 07-19 sweep's
   usenet-unavailable residue matured and flowed to MAM (accelerating: 20 grabs in the last
   watched hour; SAB queues empty). Batch skews young (~66h window left). Honest projection:
   plateaus ~140–160 WITHOUT new demand; **the 127 wants are the push to the gate** — they
   resolve post-reset, then the find-missing cron (25/run, 12h cooldown) + a dispatch sweep
   force-search them. The 15 "deferred" members are unresolvable-by-design (unpublished
   future titles, bonus chapters) — not a lever. NO bonus/wedge spend, nothing destructive.

## TOMORROW (07-21) — the watch (the #1)

07:00 UTC reset →
- **(a)** the app breaker must HOLD all day under physical-accurate accounting — the REAL
  first clean budgeted day (yesterday's morning-hold was accounting-flattered).
- **(b)** Libretto wants pass (:27 hourly) re-resolves the 127 null collection wants.
- **(c)** force-search them (cron + dispatch sweep, LL id-keyed = GB-free) → usenet absorbs →
  MAM gap-fills → unsatisfied climbs toward 185 → **tell the owner when the countdown can
  start.** A session-only cron is armed ~08:20 UTC (re-arm via CronCreate if the session died).

## Residuals / owner items

- **Two live "(verify)" Kometa collections** (Sci-Fi Favorites, Prestige Dramas) — owner:
  keep or delete; deleting via /collections admin would live-exercise the delete path (v1
  delete orphans the produced Plex collection — known limitation).
- Deferred-merge restart gap: the armed background wait is in-process; a pod restart mid-wait
  leaves the PR for a human (safe). If "auto" must survive restarts: a small reconcile over
  `listOpenManagedPrs` (already on the read client).
- Cosmetic mirror `item_count` drift (odd-thomas 9 vs 7, mortal-instruments 7 vs 6 — Kavita
  itemCount vs Libretto /missing grain).
- Comics ordered-interleave deferred; `wikidata_award` builder never existed (doc drift now
  noted in DESIGN-037 D-05).
- Libretto broker-hardening result lands after this wrap — check the next session note or the
  libretto repo PR list.
- Standing queue unchanged: SSO estate rollout rulings, T-194 double-assignment, PLAN-059,
  integrations-section grant.
