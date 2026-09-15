# 2026-09-14 — Trash wall: a brand-new title slated, "saved" titles back, and the re-add loop

**Reported by the owner (evening, from the phone):** on `/trash?tab=movies`, *Clash of the
Thundermans* is slated although it is brand new to the server and the rule was meant to catch only
titles present for six months to a year; *G.I. Joe*, a *Fantastic Four* and *Sex and the City* were
saved before and are back in today's Trash. Standing constraint restated in the same message: **a
trash deletion must never lead to the same NZB being fetched again from the same indexer** (the
household has already been warned twice); people may re-request, but the grab must be a new one.

**Verdict: three separate causes, none of them the ADR-086 re-key lapse.** v0.96.0 is live and the
relink reconciler is healthy (one real relink since deploy: Jurassic World Dominion, 09-04). Every
open save intent but one has a live exclusion; the one is Green Lantern's stale record (see §5).

---

## 1. Thundermans: the movie rule has no age clause (owner ruling → 180 days, applied live)

The live rule group `hnet — unwatched low-value movies` (Maintainerr group 1 → collection 1, which is
what the wall reads) was four clauses ANDed: Radarr IMDb rating **< 6.0**, Radarr IMDb votes **> 99**,
Plex times viewed **< 1**, Radarr tags **∌ `mediarequests`**. No `addDate` of any kind. The group's own
description said: *"Aged (>60d) guard intentionally omitted while the library is freshly seeded
(nothing is 60d old yet); re-add Radarr addDate BEFORE now-60d once it matures."* Written 07-09,
never actioned. The description was also stale on thresholds (it claimed rating < 4.0 and votes
19..1000; live was < 6.0 and > 99 with no ceiling).

Maintainerr's own evaluation (`collection_log` 8288, 09-08 04:03): Thundermans rating **4.7**, votes
**256**, views **0**, tags `[imdbpopular, kometa-added]` → pooled **17 hours after import**. It was
added by **Kometa's IMDB Popular chart** (Radarr 9722, added 09-07 10:58Z, grabbed 8 s later from
DrunkenSlug via Prowlarr, imported 11:04Z), not by a request. Six other titles added since 08-30
were on the wall for the same reason.

**Ruling (AskUserQuestion, 2026-09-14): 180 days on the Plex "date added".** Radarr's date was the
wrong field: 289 of the 300 pool movies were only added to Radarr in July's seeding, so anything
above 60 days on that field would have emptied the pool until January. Plex addedAt reaches back to
2010 for this pool. Measured before the change (300-movie pool, Plex addedAt):

| guard | shielded today | stay eligible |
|---|---|---|
| 60 d | 19 | 281 |
| 90 d | 64 | 236 |
| **180 d** | **101** | **199** |
| 365 d | 148 | 152 |

**Applied live via `PUT /api/rules`** (full `RuleGroupDto`, both groups 1 and 2) as a fifth clause
`{operator: AND, action: BEFORE(5), firstVal: [Plex(0), addDate(0)], customVal: {ruleTypeId: NUMBER(0),
value: "15552000"}}` — on a DATE property with a NUMBER custom value Maintainerr's comparator turns
BEFORE into `addedAt <= now − N seconds` (`rule.comparator.service.js` `getSecondValue`, read off the
3.28.0 image), which is the rolling "older than 180 days" form its UI produces. The descriptions were
rewritten to match the live thresholds. Verified after the write: both collections kept their Plex
`mediaServerId`, `deleteAfterDays 9999` and `arrAction 0` (ADR-036 intact); updating these fields does
not wipe membership (the wipe path is gated on dataType / manual-collection / library changes only).

## 2. The "saved" titles were never durably saved; one was saved and un-saved 13 s later

The complete `trash_excluded` ledger, `trash_save_intents` and Maintainerr's `exclusion` table agree:

| title | key | history before tonight |
|---|---|---|
| G.I. Joe: Retaliation (2013) | 94924 | **save 09-05 21:27:50 → unsave 09-05 21:28:03** (13 s, inside a burst of six taps), exclusion 393 deleted, Maintainerr log `Removed radarr exclusion tag 'dnd' from item 94924` |
| G.I. Joe: The Rise of Cobra (2009) | 94946 | nothing |
| Fantastic Four (2005) | 94429 | nothing |
| Sex and the City (2008) | 17277 | nothing (on Plex since 2023-08-05) |
| Clash of the Thundermans (2026) | 105817 | nothing |

No re-keying happened to any of them (single grab + import each, Plex `addedAt` = the import
second, keys stable since 07-10). All four July titles entered pool 1 on 07-09 and never left; the
owner's earlier encounters with them were the cancelled 07-10 685-item batch (`53bb1cc2`, 681 left
pending, cancelled 07-11 00:42 — a cancel writes no exclusion) and the weekly 50-item Leaving Soon
batches since. Three sibling Fantastic Four titles *were* deleted (1994 on 07-19, 2015 on 08-09 after
a re-add, Silver Surfer on 09-13).

**The owner's saves tonight (21:41–21:44 ET, `batch_save`, exclusions 399–403) are real**, the app's
debounced rule-execute backstop dropped all five from pool 1 within minutes (307 → 300), and the
wall no longer lists them.

**The mechanism behind the 13-second reversal:** every surface released protection on a **single
tap** with no confirm — the pending wall's `shield` tile, the batch wall's `shield`/`check` tiles and
the `/library/[id]` shield button. 50 un-saves exist in the ledger; most landed 0–5 s after the save
they reversed. **Fixed in hnet #539:** releasing a save is the ADR-014 two-step (arm, then confirm
within 3 s; a double-tap inside 300 ms is ignored); saving stays one tap; armed state is colour only
(ADR-015). DESIGN-010 carries the errata.

## 3. The re-add loop is real, Radarr-only, and 100 % Kometa

Since 07-07 the app trash-deleted **388 distinct titles** (400 events). **16 were re-added — all 16
by Kometa** (`kometa-added`/`pmm-added` + a chart or `universecollection` tag, every re-add inside
the 06:30 ET `kometa-collections` window the morning after the sweep; median gap 16 h). Zero Seerr,
zero manual. **12 were deleted twice; 10 of those came back at a byte-identical size and
resolution** — the identical release fetched again (Fantastic Four 2015 35.07 GB twice, The Nun
46.77 GB twice, …). Annabelle was re-fetched **4×** on 08-30 and Mother Mary's identical re-grab
dupe-failed into the blocklist → next release. Sonarr: 0 of 13 deleted series re-added.

Why the identical NZB comes back: Maintainerr's delete (`arrAction 0`) is
`DELETE /api/v3/movie/{id}?deleteFiles=true&addImportExclusion=<listExclusions>`; the movie record
is destroyed and **Radarr deletes every blocklist row with it** (`BlocklistService.HandleAsync
(MoviesDeletedEvent)` → `DeleteForMovies`, unconditional; Sonarr mirrors it). A re-add re-runs the
same search on an empty blocklist and picks the same top release. SAB `no_dupes=3` (Fail) catches it
only **after** Prowlarr has fetched it with the *arr's UA — the fetch the indexer counts.

**Ruling (AskUserQuestion, 2026-09-14): `listExclusions: true` on both rule pools, applied live** in
the same `PUT`. Verified from primary sources first: Radarr `AddMovieService` / Sonarr
`AddSeriesService` never consult the exclusion list (only `ImportListSyncService` does), so **Seerr
re-requests and direct adds keep working**; Kometa calls `respect_list_exclusions_when_adding()` at
construction in both `modules/radarr.py` and `modules/sonarr.py`, so **chart and collection re-adds
stop**; the flag maps straight to `addImportExclusion`/`addImportListExclusion` on the delete
Maintainerr already performs. Kometa caches the list at startup, so an exclusion written mid-run is
honoured from the next run.

**What this does NOT close — recorded as an ADR-084 erratum:** on a deliberate Seerr re-request the
blocklist is still empty, so the identical release can still be fetched once and dupe-failed. ADR-084
D-1 ("blocklist the deleted release") cannot work as written because the delete destroys the
blocklist; the release memory has to live app-side (persist `sourceTitle`/`nzbInfoUrl`/indexer on the
deletion snapshot, re-apply the blocklist after a re-add is detected). That is the build ADR-084
still needs. Also new: the app's ledger records **nothing** for the re-add cycle (Radarr's history
dies with the record and the sync never backfills the new movieId) — the churn above was only
visible through the `deleted_size_bytes` fingerprint.

## 4. Bigger indexer exposure, outside this question (parked, needs a ruling)

Duplicate NZB fetches since 08-19 (from the *arr `downloadFailed` "Duplicate NZB" histories; SAB
keeps none because the *arrs delete the failed items): **234 total — only 3 from trash re-adds.**

- **Sonarr 186**, four series, **Tiny Ones Transport Service alone 164** — the same AndreMor MULTI
  re-posts the 08-19 incident named, still recurring on 09-11. Never trash-touched.
- **Radarr 17**, five movies: *Terminator 3* fetched **one** release **10× in two minutes** on 09-11
  across DrunkenSlug/NinjaCentral/NZBFinder/NZBgeek. Radarr's blocklist keys on release **+ indexer**
  while Prowlarr serves the same NZB from four indexers, so one dupe-walled release costs up to four
  counted fetches per search round. Fail mode completes (5/5 then imported a different release).
- Lidarr 31 (Fat Joe ×7, …), no trash involvement.

This is the dominant flag risk today and it is upgrade/re-post driven. Parked in `.agents/plans/TODO.md`
with the evidence commands; it needs an owner ruling on the remedy (release-profile block on the
re-post group, per-series unmonitor, or a Prowlarr-side dedupe).

## 5. Loose ends found on the way (all recorded, none left silent)

- **Green Lantern's intent still carries the dead key 95267** while its exclusion lives on 102261
  (the 08-29 hand repair). Not a protection risk; it will make the next audit lie. The reconciler
  cannot fix it because the title is not in a pool (D-4 is pool-scoped). A one-line intent re-point
  belongs in the next `fix:` that touches `trash-save-intents.ts`.
- **`sameKeyCensus` is not a lapse count** as its docstring claims: it counts open intents whose
  pooled key equals the recorded key, which is every fresh save until Maintainerr's next rule run
  drops it from the pool. It read 6 tonight — all six were the owner's saves minutes earlier.
- Maintainerr is **3.28.0** (renovate 09-12), not the 3.25.0 the 08-29 note recorded; the 3.26–3.28
  notes contain nothing exclusion-related (3.27 reworked collection "manual" markers).
- `forceSeerr` is **true** on both rule pools (an earlier read in this session said unset — wrong):
  a trash delete also clears the Seerr request, which is what makes a re-request possible.

## Verification after the live changes (same session)

- `POST /api/rules/execute` at 23:07 ET: the movie run **removed exactly 101 items** from pool 1
  (300 → **199**), matching the pre-measured 180-day count to the item. Both pools kept
  `deleteAfterDays 9999` / `arrAction 0` / their Plex `mediaServerId`; `listExclusions` reads `true`
  on both. The TV run removed **all 4** pool members (Muppets Now, Tales of the Walking Dead, Squid Game:
  The Challenge, The Masked Singer — all Plex-added inside 180 days), so the TV pool is **0** and
  Maintainerr removed the now-empty Plex collection object (it recreates it when a member qualifies;
  the rule group and its collection record are intact).
- **The open Leaving Soon batch inherits the guard without any change:** 15 of its 44 pending items
  are younger than 180 days by Plex date (the 09-07 chart adds, Mother Mary, Annabelle, and a July
  re-import cohort). `sweepExpiredBatches` builds its "fresh" set from the **live** Maintainerr
  pending set (`trash-batches.ts` `freshById` ← `listTrashPending`) and marks any item no longer in
  it **skipped**, never deleted. Check on 09-20 after 01:17 ET: the batch outcome should read
  15 skipped for that reason.
- `trash_candidates` (the wall) refreshes on the next `*/15` incremental tick; the five saved titles
  were already gone from it before the rule edit.
- Fix PR hnet **#539** merged (required checks green; e2e advisory) → release-please **#538**
  (v0.96.1) → haynes-ops tag bump → rollout. Status at the time of writing is in `HANDOFF.md`.

## Reproduction / audit commands

```bash
# Rule groups (clauses, listExclusions, description) and pools
kubectl -n media exec deploy/maintainerr -c app -- curl -s http://127.0.0.1:6246/api/rules
kubectl -n media exec deploy/maintainerr -c app -- curl -s "http://127.0.0.1:6246/api/collections/media/1/content/1?size=2000"
# Update a group: GET the group, parse each rules[].ruleJson, append a clause, PUT the FULL RuleGroupDto
#   (top-level listExclusions/forceSeerr/arrAction/…SettingsId + collection{deleteAfterDays…}); read back.
# Maintainerr sqlite (collection_log meta holds per-clause results): base64 /opt/data/maintainerr.sqlite out.
# Plex addedAt for the pool (token stays in-pod): read plex_hostname/port/token from settings, then
#   kubectl exec -i … 'read T; curl -H "X-Plex-Token: $T" http://<plex>/library/sections/1/all?…' < token
# Save history for a key
kubectl -n database exec postgres16-1 -c postgres -- psql -U postgres -d haynesnetwork -c \
  "select occurred_at, payload->>'action', payload->>'reason' from ledger_events where event_type='trash_excluded' and payload->>'maintainerrMediaId'='94924' order by 1;"
# Re-add churn fingerprint
kubectl -n database exec postgres16-1 -c postgres -- psql -U postgres -d haynesnetwork -c \
  "select tmdb_id, max(title), count(*), string_agg(to_char(deleted_at,'MM-DD')||' '||round(deleted_size_bytes/1073741824.0,2)||'GB', ' ; ' order by deleted_at) from trash_batch_items where state='deleted' group by 1 having count(*)>1;"
# Duplicate fetches (Radarr; Sonarr on 8989 with SONARR__AUTH__APIKEY)
kubectl -n media exec deploy/radarr -c app -- sh -c 'curl -s -H "X-Api-Key: $RADARR__AUTH__APIKEY" "localhost:7878/api/v3/history?page=1&pageSize=2000&sortKey=date&sortDirection=descending&eventType=4"'
```
