# 2026-07-19 — MAM growth: demand is the constraint, not the gate or GB. Tomorrow = collection expansion.

Owner directive (2026-07-19): "grab all the Missing now, wait until tomorrow to expand collections, let usenet
grab what it can, then MAM for missing until we are close to the gate." Resume point for the MAM thread. Pairs
with [[2026-07-19-gb-quota-monitor-watch]] — the same 07-20 07:00 UTC GB reset is the trigger for both.

## Where MAM stands (live)

MAM governor (packages/domain/src/mam-governor.ts) is WIDE OPEN and was never the blocker:
`unsatisfied ~48 · limit 200 · buffer 15 · threshold 185 · headroom ~137 · gateOpen true · indexerEnabled true`.
It auto-pauses the LL MAM indexer at 185 on its own — no limit/buffer/config change is ever needed.

## What we did today (the GB-free force-search sweep — COMPLETE, pool exhausted)

Force-searched the ENTIRE GB-free searchable-missing set via LL `searchBook&id=<BookID>&type=<eBook|AudioBook>`
(id-keyed, zero Google Books calls — GB exhaustion is irrelevant to it):
- LL: 139 slots (33 Wanted + 106 Skipped, all BookID-bearing).
- Collections: 157 resolved-but-missing members (book_requests origin='collection' with a non-null ll_book_id).
- Deduped union = **285 items force-searched, 0 failures.** The GB-free searchable pool is now EXHAUSTED.

Result: MAM unsatisfied barely moved (47→48). Root cause, now proven twice at scale: **usenet (SAB) silently
absorbs almost all grabs and does NOT move the MAM counter; MAM only gap-fills the residue usenet can't serve.**
Existing demand is too usenet-serviceable for MAM to approach 185 — more force-searching will NOT help.

## The actual lever — tomorrow, after the 07:00 UTC GB reset

MAM grows only from NEW demand usenet can't satisfy. That means generating + resolving new wanted books:
- The **16 deferred collection members** (null ll_book_id — need a GB resolve) + new Libretto recipe members.
- Expanding/adding collections (find-missing) so more usenet-unavailable titles flow to MAM.

**GB-budget contention to respect (important):** resolving new collection members consumes Google Books calls,
and the v0.88.0 budgeter (#433) only earmarks the daily ~100-call cap for pairing(60)/goodreads(25)/bookfix(15)
— collection resolve is OUTSIDE that split. So an aggressive post-reset collection expansion will eat GB that
pairing/goodreads need and can re-trip the daily breaker early (exactly the 08:32-UTC-on-07-19 failure mode).
Pace the expansion; don't resolve hundreds of new members in the first post-reset hour. Owner may prefer to
steer WHICH collections/franchises to expand (so the MAM grabs are books he actually wants) — question is open.

## Standing behavior between now and then
- A settle-check cron fires ~19:54 UTC 07-19 to record where today's sweep lands once grabs seed (baseline).
- The find-missing cron keeps force-searching resolved-missing members (25/run, 12h/want cooldown); usenet-first,
  MAM gap-fills — but the resolved pool is exhausted, so it won't add until new members are resolved tomorrow.
- Non-negotiables that held all day: non-destructive, NO MAM bonus-point/wedge spend, governor self-caps at 185.
