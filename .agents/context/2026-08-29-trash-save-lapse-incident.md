# 2026-08-29 — Trash "Save" silently lapses when a title's file is replaced

**Reported by the owner:** "Green Lantern and a few others have been saved for at least a week"
and still sit on the Trash wall, where a save used to make an item disappear on Maintainerr's next
run. Owner asked whether the recent download-loop remediation changed this, and whether there is
anything to worry about.

**Verdict: a real bug — not expected behaviour, and unrelated to the download-loop fix.** The trigger
is an ordinary Radarr **quality upgrade** (file replaced in place); the movie is never deleted from
Radarr and never re-added. What breaks the save is that Plex sometimes retires the old item and
mints a new ratingKey when the file underneath it changes.
No deletion risk today. One live case (Green Lantern), re-protected during this investigation.
Owner ruled **fix both halves** (AskUserQuestion, 2026-08-29).

---

## The failure chain (verified end to end)

| # | What happens | Evidence |
|---|---|---|
| 1 | Owner saves a title. App writes a Maintainerr exclusion keyed on the **Plex ratingKey** (`mediaServerId`), plus a `trash_excluded` ledger row. | `trash-flow.ts:791-821`; `write.ts:347-357` (`POST /api/rules/exclusion {mediaId, action:0}`) |
| 2 | Maintainerr drops it from the rule pool on the next run. Item leaves the wall. **This part works.** | 0 of 291 exclusions are still pool members; 107 of 108 saved items are correctly out of the pools |
| 3 | Later, Radarr **upgrades the file in place** — grab a better release, delete the OLD FILE, import the new one. The movie is never removed from Radarr. Plex nonetheless retires the old item and mints a new one with a **new ratingKey**. | Green Lantern 2026-08-05: Remux-1080p → **WEBDL-2160p**, `movieId 2974` constant throughout, delete payload `kind: file_deleted` / `rawEventType: movieFileDeleted` pointing at the OLD file path, `media_items.deleted_from_arr_at` still NULL. Plex `addedAt` = **21:33:01**, the exact import second; key 95267 → **102261** |
| 4 | Maintainerr's nightly **Rule Maintenance** (cron `20 4 * * *`) runs `removeLeftoverExclusions()`, which **deletes every exclusion whose ratingKey no longer exists on the media server**. The save is erased. | `rule-maintenance.service.js` (v3.25.0, read off the running pod); exclusion for 95267 absent from `exclusion` table |
| 5 | The paired `dnd` un-tag **cannot complete**: it resolves the *arr item from the (now nonexistent) ratingKey, with a `collection_media` fallback row that is also gone ⇒ zero lookup candidates ⇒ no *arr id ⇒ tag left behind. | `servarr-tag.service.js:237-246` → `metadata.service.js:114-120`; `radarr_untag_on_unexclude = 1` yet Green Lantern still carries `dnd` |
| 6 | Rules re-evaluate the new, unexcluded item ⇒ **back in the deletion pool**. | `trash_candidates` row for 102261, `hnet — unwatched low-value movies`, pool add 2026-08-06 |
| 7 | The wall paints it **protected** off the stale tag, with the **inert `check` glyph** the owner cannot tap to re-save. | `trash-flow.ts:576` `protectedByTag: arrTags.includes(PROTECTED_TAG)`; `apps/web/lib/trash.ts:166` — "`check` stays inert" |

So the owner's read was exactly right: it looks saved, it never leaves, and the tile refuses to act.

## Scope

- **Live cases today: 1** (Green Lantern). Every one of the other 107 saved items is correctly
  excluded and out of the pools; all recent saves (95537, 104030, 99634, 96849, …) verified intact.
- **Exposure, measured properly (corrected 2026-08-29 after an owner question).** The trigger is a
  routine **quality upgrade**, not a delete-and-re-add: of the file-removal events since 07-01,
  **11,700 are `file_deleted` (653 items) vs 255 `item_removed`**, and **11,645 of the 11,700 are
  followed by an import within 15 minutes** — 99.5% are upgrades.

  But an upgrade does **not** usually break a save. **15 saved titles were upgraded after being
  saved; exactly 1 (Green Lantern) lapsed.** Plex normally updates the existing item in place and
  the ratingKey survives; the lapse needs the rarer case where Plex retires the old item and mints a
  new one. So the honest risk is "an upgrade *can* re-key the item, and when it does the save is
  silently gone", not "every replacement lapses a save".

  An earlier version of this note said the latter. That was wrong, and the corrected conditional is
  the one to quote.
- **Rare enough to have gone unnoticed:** zero `Removed exclusion` lines in the 7 days of retained
  Maintainerr logs. It only bites when a replaced title happens to have been saved.

## What is NOT wrong (ruled out with positive evidence)

- **The exclusion → pool-removal mechanism.** 0 of 291 exclusions are still pool members.
- **The debounced `POST /api/rules/execute` backstop.** The 17:33 save triggered a full rule run
  at 17:41–17:45 the same day.
- **The candidate read model / sync CronJobs.** `trash_candidates_state` refreshed 5 min before
  the check; every trash-related CronJob is Completed on schedule.
- **ADR-036's aging invariant.** Both rule pools still carry `deleteAfterDays: 9999` + `arrAction: 0`;
  both Leaving-Soon collections carry `arrAction: 4`. Maintainerr cannot self-delete.
- **Mass-wipe risk in the pruner.** `readItemPresence` only marks an id missing after a *successful*
  `itemExists` returning false; a thrown error is inconclusive. A Plex outage will **not** wipe
  exclusions.
- **GitOps drift.** The pod runs `3.25.0` and `origin/main` pins `3.25.0` (haynes-ops #2640). A local
  clone was stale; there is no drift.
- **The Kometa / NZB download-loop remediation.** Unrelated mechanism (SAB `no_dupes`, see
  `2026-08-19-nzb-dupe-loop-incident.md`). It did not cause this and did not change it. It did drive
  file-replacement churn (weekly file-delete events peaked at 2,399 / 288 items the week of 08-10,
  falling to 1,003 / 89 items the week of 08-24), but churn only matters where it intersects a
  *saved* title AND Plex re-keys — see the corrected conditional above. Do not present the churn
  numbers as the exposure figure.

## Why no deletion risk today

The stale `dnd` tag, ironically, still protects the item from every delete path this app owns:
`trash-flow.ts:886` (`protectedByTag ⇒ keep: true, reason: 'tag'`) and `trash-batches.ts:414`
(`deletable = actionable.filter(p => !p.protectedByTag)`). Maintainerr cannot delete it either
(horizon 9999). The danger is the **inverse** case: an item whose tag *does* get cleaned up while
the owner still believes it is saved. The protection is currently resting on a leftover tag rather
than on the system of record.

## Immediate remediation (done)

`POST /api/rules/exclusion {mediaId:"102261", action:0}` → `{"code":1,"result":"Success"}`,
exclusion id **388** verified present. `POST /api/rules/execute` triggered; the movie pool run
(18:28:57 → 18:32:05) dropped it: **pool 437 → 436, key 102261 absent**. Confirmed off the wall.

Caveat for the record: this was written **directly to Maintainerr**, so it carries **no
`trash_excluded` ledger row**. The relink reconciler (ADR-086) is what should have done it, with
proper attribution.

## The two halves the owner authorised

- **A — durable save intent + relink.** A save must mean "this movie", not "this Plex object".
  The app owns the intent durably and re-applies the exclusion when a saved title reappears in a
  pool under a new key.
- **B — an honest wall.** Stop presenting a bare `dnd` tag as proof of protection. Keep it as a
  fail-safe *keep* signal in the guardian (that is a safety property, do not weaken it), but stop
  rendering it as an inert `check` that blocks the owner from re-saving.

Follow-on: **ADR-086** → DESIGN-048 → PLAN-067.

## Reproduction / audit commands

```bash
# Maintainerr state (keyless reads, from the dev-env pod)
kubectl -n media exec deploy/maintainerr -c app -- curl -s http://127.0.0.1:6246/api/collections
kubectl -n media exec deploy/maintainerr -c app -- curl -s \
  "http://127.0.0.1:6246/api/collections/media/1/content/1?size=2000"
kubectl -n media exec deploy/maintainerr -c app -- curl -s \
  "http://127.0.0.1:6246/api/rules/exclusion?mediaServerId=<ratingKey>"

# The pruner + the un-tag path, read off the running image
kubectl -n media exec deploy/maintainerr -c app -- sh -c \
  'cat /opt/app/apps/server/dist/modules/rules/tasks/rule-maintenance.service.js'

# App side
kubectl -n database exec postgres16-1 -c postgres -- psql -U postgres -d haynesnetwork -c \
  "select occurred_at, payload->>'action', payload->>'maintainerrMediaId'
     from ledger_events where event_type='trash_excluded' order by occurred_at desc limit 25;"
```
