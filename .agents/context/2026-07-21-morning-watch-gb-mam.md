# 2026-07-21 — morning watch: GB breaker held post-reset, MAM demand held pending the ref fix

The morning read of the GB budget / pairing / collection-wants / MAM-governor loop after the 07:00Z Google
Books daily-quota reset. Headline: the breaker HELD post-reset, goodreads self-capped at its budget, and the
MAM governor's unsatisfied count is low BUT artificially so — the app-side demand injector
(`collection-force-search`) has been dead on a Libretto schema drift. Verdict: do not let the governor
de-escalate the MAM gate until that injector is fixed and demand is honestly re-measured. That fix is
`fix/libretto-ref-array` (`2026-07-21-libretto-ref-schema-drift.md`).

## GB / goodreads — the #444 accounting fix working as designed (live evidence)

Post the 07:00Z reset the breaker did NOT re-trip. Goodreads run 08:41 UTC (`…-goodreads-29743721`):

```
08:41:04  goodreads-sync: GB daily call budget spent — enrichment skipped for the rest of the run  used:199
08:41:10  goodreads-sync complete  integrations:2 synced:2 failed:0 transientBlips:0 skippedEnrichment:0 skippedBudget:142
```

Goodreads capped at **199** by its OWN reserve-before-commit gate (the enforced-consumer budget), NOT by a
breaker trip — this is exactly the #444 physical-call-accounting fix (`2026-07-20-gb-physical-call-accounting.md`)
behaving as designed: an enforced slice never starts a resolve it can't fully afford, so it self-stops one
short of budget and logs `skippedBudget` for the remainder (142 here). `synced:2 failed:0 transientBlips:0`
= a clean run. Format-pairing later in the window (08:32) hit heavy transient GB **503 backendFailed** weather
and honestly degraded (`format-pairing: GB resolve failed (want stays unmintable)`) — transient backend
unavailability, not a quota event; those wants stay unminted and retry next run.

## Pairing + collection wants

- Format-pairing minting ~**77/run** across the morning (the healthy-run rate; the 08:32 run was suppressed
  by the 503 weather above).
- Collection wants: **146 / 286** resolved to a GB volume id (force-searchable) cumulatively; honest broker
  reasons live (a null resolve keeps the tile visible but not searchable — an honest gap, never fabricated).
  Per-run resolve confirmed live at 08:28 (`collection-wants complete … resolved:25`). The unresolvable floor
  is documented and expected: unpublished sequels and bonus-chapter/novella entries that have no acquirable
  edition. Expanse mains still pending a Hardcover source.

## MAM governor — low but artificially so; HOLD the de-escalation (live evidence)

MAM governor run 08:49 UTC (`…-mam-governor-29743729`):

```
mam-governor evaluated  unsatisfied:107 downloading:0 seedingUnder72:107 total:169
                        limit:200 buffer:15 threshold:185 headroom:93
                        gateOpen:true desiredOpen:true indexerEnabled:true actuated:false event:null
```

Unsatisfied **107 vs gate 185** and receding. The gate is open and the indexer enabled; the governor did not
actuate. The catch: **107 is artificially low** because the app-side demand injector
(`collection-force-search`) has aborted every hourly run on the Libretto `builder.ref` array drift, so real
find-missing demand is not reaching MAM. **Verdict: DO-NOT-START-COUNTDOWN** — do not act on the low number to
de-escalate / close the MAM gate; once the injector is fixed and deployed, unsatisfied climbs back toward the
gate as the off-cooldown wants force-search. Unblock: `fix/libretto-ref-array`.

## The 48-want GB-free force-search injection — fired clean

The GB-free demand lever (inject wants that already carry a resolved LL id, so no GB budget is spent —
`2026-07-19-mam-demand-and-expansion-plan.md`) fired cleanly this morning: **48 wants** force-searched with
zero GB draw. This is a distinct path from the dead `collection-force-search` leg (it does not depend on the
recipe-list parse), which is why it succeeded while the recipe-driven leg aborted.

## Minor anomalies (noted, not blocking)

- **Libretto mislabels a per-minute 429 as "daily"** in its own log text. Cosmetic: the underlying event is a
  burst/per-minute rate limit, not a daily-quota exhaustion. A Libretto-side log-copy nit, no functional
  impact; worth a one-line fix in Libretto when convenient.
- **Stale failed one-shot jobs linger** in ns `frontend` (e.g. `…-sync-ai-usage-29739252` Failed, 3d old).
  GC/cleanup residue from old runs, not live failures — the current schedules all complete. Worth a
  `ttlSecondsAfterFinished` / history-limit tidy, not urgent.
