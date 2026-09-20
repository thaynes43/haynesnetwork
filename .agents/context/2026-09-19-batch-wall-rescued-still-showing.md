# 2026-09-19 — "Saved days ago, still in the trash": the saves were sound, the batch wall was not

**Reported by the owner (from the phone, screenshot of `/trash?tab=movies`):** *Sex and the City*,
*AVP: Alien vs. Predator* and *Fantastic Four (2005)* carry green shields but are still on the trash
page days after being saved, under a header reading `Deleting 44 · Rescued 6 · Kept 0 · frees 1.2 TB`.
Question asked: did the save not sync to Maintainerr?

**Verdict: the saves synced. The page was the defect.** Nothing saved was ever at deletion risk.

## 1. Live audit (read-only, 2026-09-19)

Open batch `3671be2e-3459-4582-8ef1-520e8f1188db` — movie, `leaving_soon`, 7-day window,
`gate_skipped`, greenlit 09-13 01:17:09 ET, **expires 09-20 01:17:09 ET**, Leaving Soon collection
**22**. Items: 44 `pending` (1212 GB) + 6 `saved` (193 GB) = 50.

All six saved rows (09-14 21:41–21:44 ET, reason `batch_save`): G.I. Joe: Retaliation 94924,
G.I. Joe: The Rise of Cobra 94946, Fantastic Four (2005) 94429, Clash of the Thundermans 105817,
Sex and the City 17277, AVP 95012. For every one of them: open unrevoked `trash_save_intents` row
(`relink_count 0`), latest `trash_excluded` action `save`, a **global** Maintainerr exclusion
(ids 399–404, sequential, `ruleGroupId null`), absent from the rule pool (collection 1), absent from
collection 22, absent from `trash_candidates`. The sweep only reads `state='pending'` rows
(`trash-batches.ts` `expireOneBatch`), so a `saved` row is unreachable by it regardless.

Corrections to earlier notes: the movie *rule pool* is collection **1**, the movie *Leaving Soon*
collection is **22**; the TV pool is collection **3** (not 2), TV Leaving Soon is 23.

Pools: collection 1 = 201 · collection 3 = 0 · `trash_candidates` = 201 rows, all movie — in step.

## 2. Why the owner saw them

With a batch open the Movies tab renders the **batch wall**, a frozen snapshot of 50, instead of the
pending pool wall. DESIGN-011 D-07 flips a tile in place on save and never removes it; the server
orders items by frozen size descending (`getBatchDetail`, a sort the docs never specified), so
rescued tiles sat interleaved with slated ones for the rest of the window. On the pending wall a
save *does* make the tile disappear, which is the behaviour the owner expected here.

## 3. Defects found on the way (all fixed in the same change)

1. **Header overstated the deletion.** `wallCounts()` counted every `pending` row; `getBatchDetail`
   made no pool check. **15 of the 44** pending items left the live pool when the 180-day age guard
   landed on 09-14 (Annabelle, Battle: Los Angeles, Gamer, Just Play Dead, Mother Mary, Passenger,
   Pet Sematary 2019, Pinocchio: Unstrung, Scream 3, The Devil's Mouth, The Last Sunrise, The
   Runner, The Shrouds, They Came from Beyond Space, Thir13en Ghosts — 0.46 TB). The sweep marks
   them `skipped`. Honest outcome: **29 deleted, ~0.84 TB**. This confirms the 09-14 prediction to
   the item.
2. **Expire-now preview had the same blind spot** (`willDelete` ignored pool membership, and that
   number arms the typed confirm).
3. **A save made outside the wall never reached the wall.** `saveExclusion` (pending wall, library
   shield) did not touch `trash_batch_items`, so a title saved from `/library` while in an open
   batch kept the red trash glyph and counted in `Deleting`; the sweep kept it as `liveExcluded`
   regardless. Latent, no wrong deletion possible.
4. `Kept` could never warn during an open batch — `skipped` is only written by the sweep.

## 4. Ruling and design

**Owner ruling (AskUserQuestion, 2026-09-19): rescued posters move to their own section below the
slated grid on the next load.** Recorded as the 2026-09-19 amendment to DESIGN-011 D-07: load-time
sections (slated / Rescued / Kept) with membership pinned per mount so a tap still never moves a
tile (hard rule 9 intact); `inLivePool` projected from the `trash_candidates` read model (display
only, 60-minute freshness gate, unknown reads as slated); header + Expire preview follow the glyphs;
`saveExclusion` flips a matching open-batch row (protective direction only).

## 5. Audit commands

```bash
kubectl -n database exec postgres16-1 -c postgres -- psql -U postgres -d haynesnetwork -c \
  "SELECT state,count(*),pg_size_pretty(sum(size_bytes)) FROM trash_batch_items WHERE batch_id='3671be2e-3459-4582-8ef1-520e8f1188db' GROUP BY state;"
# per-item exclusion needs the id — a bare GET returns []
kubectl -n media exec deploy/maintainerr -c app -- curl -s "http://127.0.0.1:6246/api/rules/exclusion?mediaServerId=17277"
kubectl -n media exec deploy/maintainerr -c app -- curl -s "http://127.0.0.1:6246/api/collections"
kubectl -n media exec deploy/maintainerr -c app -- curl -s "http://127.0.0.1:6246/api/collections/media/1/content/1?size=2000"
```
