# DESIGN-010: Trash section — Maintainerr client, per-action grants, safety gate, Activity feed

- **Status:** Draft (backend vertical shipped; **UX shipped 2026-07-06** — D-09 records the
  as-built; **pending tables → poster walls 2026-07-07**, see the D-09 amendment)
- **Last updated:** 2026-07-08 (D-10 — Overview landing + kind tab count badges)
- **Satisfies:** PRD-001 **R-79..R-87** + **US-10** / **AC-14..AC-16**; governed by **ADR-023**
  (Trash/Maintainerr + per-action grants + safety gate). Reuses **ADR-021** (section levels),
  **ADR-008/011** (write-back confinement), **DESIGN-005 D-16** (Restore), **DESIGN-008/009 D-09**
  (the shared filter/table engine + `media_metadata`). Bounded contexts DDD-002 **BC-02
  Entitlements** (the permission mutation, audited) + **BC-03 Media Ledger** (the Trash actions).

> **Split note (2026-07-06, Fable 5).** The **backend vertical** — the `@hnet/arr` Maintainerr
> read/write client extension, the enums + `role_trash_action_grants` + `notifications` schema +
> migration 0016, the domain single-writers + orchestrators (`auditMaintainerr`, `listTrashPending`,
> `saveExclusion`/`removeExclusion`, `expediteDeletion`, `guardRecentlyWatched`, `restoreDeleted`,
> `upsert/deleteTrashRule`, `recordNotification`), the session/gating extensions
> (`SessionRole.trashActions`, `trashActionProcedure`), the `trash` tRPC router + `roles.setTrashActions`,
> the `POST /api/webhooks/maintainerr` receiver, the `/admin/restore`→`/trash` redirect, the minimal
> `/trash` route gate, and the stubs/tests — **landed on this branch.** The **UX layer** (the pending
> tables, Save shield, Expedite ConfirmButton/Modal, Rules editor, Recently-Deleted, Activity tab,
> the `/admin/roles` Trash-access + per-action editor, the top-bar nav entry) is the **follow-up**.

## D-01 — Client shape + config (ADR-023 C-01)

`@hnet/arr` grows the Maintainerr surface (no new package). Reads are keyless; writes require the
key (`x-api-key` header). Config: `MAINTAINERR_URL` (non-secret, in-cluster Service DNS default —
EXEMPT server-side base URL, like the *arrs) + `MAINTAINERR_API_KEY` (required secret;
`assertMaintainerrEnv` throws an `ArrConfigError` naming it, never echoed). The Trash bundle
(`MaintainerrClientBundle = { read, write }`) is env-built in `packages/api` (`resolveMaintainerrBundle`)
and stub-injected in tests — the `MaintainerrWriteClient` stays import-confined to `packages/domain`.

## D-02 — Maintainerr REST mapping (v3.17.0, derived from source — no live call)

Verification method: each path = the class `@Controller('…')` prefix + the method's route decorator
argument (there is **no** `setGlobalPrefix`, so effective paths are `/api/…`); request shapes = the
`@Body` DTO/Zod schema. Source at tag `v3.17.0` under `apps/server/src/...` (the repo moved from
`server/` → `apps/server/`). Shared envelopes: `ReturnStatus {code:0|1, result?, message?}` (rules);
`BasicResponseDto {status:'OK'|'NOK', code, message}` (settings tests). v3 renamed `plexId` →
`mediaServerId` (a Plex ratingKey) — Maintainerr's exclusion/handle key.

| Our operation                           | Verb + path                                                     | Request                                                                                                   | Response / notes                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collections (list)                      | `GET /api/collections`                                          | —                                                                                                         | `Collection[]` incl. `deleteAfterDays, isActive, type, totalSizeBytes`; `media` is a PREVIEW subset                                                                                |
| Collection membership + size            | `GET /api/collections/media/{id}/content/{page}?size=`          | page 1-based                                                                                              | `{ totalSize, items[] }`; item `sizeBytes`, `tmdbId`, `tvdbId`, `mediaServerId`, `addDate`                                                                                         |
| Rule groups                             | `GET /api/rules?activeOnly=&libraryId=&typeId=`                 | —                                                                                                         | `RulesDto[]` (`id,name,isActive,dataType,collection{...}`)                                                                                                                         |
| Rule-schema catalog                     | `GET /api/rules/constants`                                      | —                                                                                                         | `{ applications:[{id,name,mediaType,props}] }` — filtered to CONFIGURED integrations                                                                                               |
| Exclusions                              | `GET /api/rules/exclusion?mediaServerId=&rulegroupId=`          | —                                                                                                         | `Exclusion[]` (`ruleGroupId=null` ⇒ global); `[]` with no params. `Exclusion.parent` is a **string** (Plex ratingKey, written on every exclusion — schema is `string\|number`, P2) |
| Settings (tag-exclusion subset)         | `GET /api/settings`                                             | —                                                                                                         | `Settings` (secrets masked): `radarr_tag_exclusions`, `radarr_exclusion_tag`(default `dnd`), `radarr_untag_on_unexclude`, `sonarr_*`                                               |
| App status / version                    | `GET /api/app/status`                                           | —                                                                                                         | `VersionResponse {status,version,commitTag,updateAvailable}` (may arrive double-encoded — the client pre-parses)                                                                   |
| Plex connectivity                       | `GET /api/settings/test/plex`                                   | —                                                                                                         | `BasicResponseDto` (`status:'OK'` ⇒ connected)                                                                                                                                     |
| **Add exclusion (Save)**                | `POST /api/rules/exclusion`                                     | `{ mediaId, action:0, collectionId? }` (omit `collectionId` ⇒ global)                                     | `ReturnStatus`; **`code:0` at HTTP 201 = logical FAILURE** (parsed → throw, P1a); `action:1` routes to remove                                                                      |
| **Remove exclusion (un-save)**          | `DELETE /api/rules/exclusions/{mediaServerId}`                  | path param                                                                                                | `ReturnStatus` (removes ALL exclusions for the item); `code:0` fails closed (P1a)                                                                                                  |
| **Expedite ALL** _(NEVER CALLED — P1b)_ | `POST /api/collections/handle`                                  | no body                                                                                                   | `201`; processes EVERY active collection (all kinds, not scopeable) → **not used**; expedite loops per-item instead                                                                |
| **Expedite one item**                   | `POST /api/collections/media/handle`                            | `{ collectionId, mediaId }`                                                                               | `201`, **void** (no ReturnStatus); the ONLY deletion trigger expedite uses (per item)                                                                                              |
| **Rule group create / update / delete** | `POST /api/rules` · `PUT /api/rules` · `DELETE /api/rules/{id}` | `RulesDto` (create/update) / id                                                                           | `ReturnStatus` (`code:0` fails closed, P1a); `deleteAfterDays` lives in the nested `collection`                                                                                    |
| **Enable tag exclusions + `dnd`**       | `PATCH /api/settings`                                           | partial `SettingDto` (`{radarr_tag_exclusions,radarr_exclusion_tag,radarr_untag_on_unexclude, sonarr_*}`) | `BasicResponseDto {status,code,message}` (`code:0` fails closed, P1a); full replace is `POST /api/settings`                                                                        |

**Uncertainty flags (carried from source review):** (a) **RESOLVED (2026-07-07, verified against
v3.17.0 source).** `dataType` on `GET /rules` is a **STRING** `MediaItemType`
(`'movie'|'show'|'season'|'episode'`) — the `rule_group.dataType` column is `varchar` and contracts'
`MediaItemType` is a string union; the earlier "numeric on `GET /rules`" note was wrong. This matters
because `PUT /api/rules` (`updateRules`) treats a change to **`dataType` / `manualCollection` /
`manualCollectionName` / `libraryId`** (vs the stored group/collection) as a _crucial setting change_
that **wipes the collection's media + specific exclusions and deletes the Plex collection**. So an
arm/disarm toggle MUST round-trip `dataType` and `libraryId` **verbatim** (both varchar strings) — the
write seam never coerces them (see `upsertTrashRule`). The pending fetch still does **not** send
`typeId` (it buckets client-side), sidestepping the collection-type ambiguity. **Server selection:**
`GET /rules` nests the *arr server ids under the **collection** (`collection.radarrSettingsId` /
`collection.sonarrSettingsId`), but `PUT` validates them at the **group** level
(`validateRuleServerSelection`: a rule whose `firstVal[0]`/`lastVal[0]` is Radarr=1/Sonarr=2 with no
group-level id → `{code:0,"Radarr rules require a Radarr server to be selected"}` → fail closed →
502) — `upsertTrashRule` lifts them up from the nested collection when absent (the ids do **not**
participate in the crucial-change wipe); (b) the delete date is **never returned** — we derive it =
`addDate + deleteAfterDays` days; (c) `POST /rules/exclusion`'s body has no runtime ValidationPipe, so
extra fields are ignored — we send the minimal `{ mediaId, action:0 }`; (d) there is **no aggregated
integration-health endpoint** — the audit derives connectivity from the `rules/constants`
`applications` list (present only for configured integrations) + the Plex test.

## D-03 — Permission matrix (ADR-023 C-03)

| Capability                                                                | Gate                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| View pending / collections / rules / recently-deleted / activity / status | `sectionProcedure('trash','read_only')`                                  |
| Save / un-save an item                                                    | `trashActionProcedure('save_exclude'                                     | 'remove_exclude')` (read_only + grant) |
| Expedite one / all                                                        | `trashActionProcedure('expedite_item'                                    | 'expedite_all')`                       |
| Restore a deleted item                                                    | `trashActionProcedure('restore_deleted')`                                |
| Create/update/delete a rule group                                         | `trashActionProcedure('edit_rules','edit')` — grant **and** section Edit |
| Set a role's Trash actions                                                | `roles.setTrashActions` (`adminProcedure`)                               |

Admin ⇒ every section Edit + every action (no rows). Section `disabled` ⇒ no procedure reachable
(server-authoritative — the grants are session-carried, never client-hidden only, AC-16). A row in
`role_trash_action_grants` **is** the grant; section edit-level implies nothing extra.

## D-04 — Safety audit (`trash.status`, ADR-023 C-04)

`auditMaintainerr` → `{ safe, reachable, version, integrations:{plex,radarr,sonarr,tautulli,seerr},
armedRules, activeCollections }`, read-only, writes no state, each sub-read fails closed. SAFE =
reachable AND every required integration connected. `expedite*` re-run it and refuse
(`MAINTAINERR_UNSAFE` → `PRECONDITION_FAILED`) unless SAFE; exclusion writes need only reachability.

## D-05 — Write ordering + the guardian (ADR-023 C-05/C-07)

- **In-band failure detection (review 2026-07-06, Fable — P1a).** Maintainerr's WRITE endpoints
  return their body — `ReturnStatus {code:0|1,result?,message?}` (exclusion + rule CRUD) or
  `BasicResponseDto {status,code,message}` (settings `PATCH`) — at **HTTP 201/200 even on a LOGICAL
  failure** (`code:0`; e.g. `setExclusion` → `{code:0,'Failed - no metadata'}`, verified v3.17.0
  `createReturnStatus`). So the write client parses those bodies (not HTTP-status-only `requestVoid`)
  and throws `MaintainerrWriteFailedError` (→ `MaintainerrUpstreamError` → **BAD_GATEWAY**) when
  `code === 0` — a logical failure now fails **closed** exactly like a non-2xx, so a failed save can
  never mint a phantom `trash_excluded` event or phantom guardian protection. The two collection
  **handle** endpoints return VOID (no ReturnStatus) and keep void semantics (a non-2xx still throws).
- **Save/remove exclusion (protective):** external Maintainerr call **first**, then the
  `trash_excluded` event (idempotent — already excluded ⇒ no-op/no event). Rationale: a Save is
  protective, so the fail-safe direction is establish-protection-first; a phantom protective event
  (written before a failed call) is the dangerous under-protection failure, so we never write it
  first. A crash after the exclusion leaves the item genuinely protected (audit reconcilable from
  Maintainerr's exclusion list).
- **Expedite (destructive) is PER ITEM — the estate-wide handler is deliberately never used (review
  2026-07-06, Fable — P1b/P5).** `POST /collections/handle` processes EVERY active collection (all
  media kinds, incl. items outside our ledger) and is **not scopeable**, so `expediteDeletion` never
  calls it. Both scopes delete via `POST /collections/media/handle`, one item at a time, each having
  passed the guardian. **scope 'all'** is a two-pass loop over the requested kind's pending set: PASS 1
  runs the guardian over each item (auto-whitelist watched/requested; a **failed protection SKIPS**
  that item — a failed protection is never followed by that item's deletion); PASS 2 deletes each
  SURVIVOR individually, committing its `trash_expedited` intent event **before** its handle call (the
  Fix D-09 discipline — a lost response must never hide an initiated deletion). **scope 'item'**
  resolves the target's REAL identity from the actual pending set (NOT the client `media` param);
  if it cannot be resolved to run the guardian it **REFUSES** (fail closed), never fires blind.
- **Live-exclusion safety seam (pre-ship review 2026-07-06 — F1).** `classifyGuardian` reads only the
  SYNCED facets (`arrTags`/watched/requesters); a just-SAVED item's protective `dnd` tag has not yet
  round-tripped Maintainerr → the *arr → our ledger, so the guardian alone would clear a freshly-saved
  cold item as deletable (the save→expedite race). BOTH scopes therefore fetch the LIVE Maintainerr
  exclusion set once, before the guardian loop (`fetchLiveExclusions` — per candidate by
  `mediaServerId`, since real Maintainerr returns [] with no params), and treat any live exclusion as
  **PROTECTED**, never handled — counted in `protectedCount`. The confirm modal's item verdict is built
  from the guardian mirror + server-declared fields only (never a session-local shield override), so the
  copy can no longer promise "nothing deletes" on state the server won't honor.
- **Pinned whole-set (pre-ship review 2026-07-06 — F2).** `trash.expediteAll` takes a REQUIRED
  `maintainerrMediaIds` snapshot (1..1000) — the ids the confirm modal displayed. The run processes
  EXACTLY that ∩ the current pending set: ids no longer pending → `stalePending` (never deleted); items
  that became pending after the modal opened are absent from the snapshot and NEVER touched. Converges
  toward PLAN-012's explicit batch endpoint.
- **Guardian (`classifyGuardian`, fail closed — P3/P4):** an item is expeditable ONLY when it is
  positively evaluated (resolved to our ledger, so we hold the cross-server watch / requester signal)
  AND cold. Kept otherwise: `tag` (already `dnd`-whitelisted), `recently_watched`/`requested`
  (auto-whitelisted), or `unevaluable` (unknown to our ledger — we never delete what we cannot
  evaluate). The client-supplied `media` never steers which set is searched. Window
  `RECENTLY_WATCHED_WINDOW_DAYS = 30` (constant — **Q-01:** admin/per-role configurability deferred).
  The `dnd` protective tag is Maintainerr-managed (settings `PATCH` deploy step); we read it off
  `arrTags` as `protectedByTag` and never hand-apply it.

## D-06 — Recently-Deleted source of truth (ADR-023 C-02)

Recently-Deleted = our tombstoned `media_items` (`deleted_from_arr_at` set), newest first — the
durable, restore-able set (Maintainerr has no deletion-history API). `trash.restoreDeleted` reuses
`executeRestore` (reason 'restore', searches OFF, skip-if-present) and adds a `trash_restored`
marker event (source 'maintainerr') on top of executeRestore's own 'restored' event.

## D-07 — Activity feed + webhook receiver (ADR-023 C-08, addendum c)

Generic `notifications` table (`source` CHECK `['maintainerr']` for now, `type,title,body,payload,
created_at,read_at`) written only by `recordNotification`. `POST /api/webhooks/maintainerr` —
session-unauthenticated, **shared-secret-required** (`MAINTAINERR_WEBHOOK_SECRET` via
`x-webhook-secret` / `Authorization: Bearer` / `?token=`; 503 when unset, 401 without) → tolerant
Overseerr-style field map → `recordNotification`. `trash.activity` reads `source='maintainerr'`,
newest first. Built as the generic pattern PLAN-009 (Bulletin) extends — NOT a Maintainerr-specific
endpoint/table. **Hardening (review 2026-07-06):** the secret compare is **constant-time**
(`crypto.timingSafeEqual` over SHA-256 digests — length-safe, no early bail); the body is **capped at
~64KB** before parsing (413 over); the payload is **Zod-validated to a known shape**, arbitrary /
prototype-polluting keys are **stripped**, and stored `type`/`title`/`body` are **length-capped** — we
never persist unbounded caller JSON. (Pure helpers in `apps/web/lib/maintainerr-webhook.ts`.)

## D-08 — `trash` router wire contracts (for the UX follow-up)

All `movie|tv` only (music rejected). Reads gate `read_only`; writes gate the named action.

```
trash.status()                              → { safe, reachable, version, integrations{plex,radarr,sonarr,tautulli,seerr}, armedRules, activeCollections }
trash.pending({ media })                    → { media, totalSizeBytes, count, items: TrashPendingItem[] }   // item adds posterUrl; ORs the LIVE Maintainerr exclusion set into protectedByExclusion (2026-07-06 live fix) so an exclusion made outside this session reads Protected before its dnd tag syncs
trash.collections()                         → MaintainerrCollection[]
trash.rules()                               → MaintainerrRuleGroup[]
trash.ruleConstants()                       → MaintainerrRuleConstants
trash.saveExclusion({ maintainerrMediaId, mediaItemId?, collectionId? })   → { excluded, alreadyExcluded }
trash.removeExclusion({ maintainerrMediaId, mediaItemId? })                → { removed }
trash.expediteItem({ media, collectionId, maintainerrMediaId, mediaItemId? }) → { scope:'item', protectedCount, expeditedCount, skippedCount, stalePending:0 }
trash.expediteAll({ media, maintainerrMediaIds[] })  → { scope:'all', protectedCount, expeditedCount, skippedCount, stalePending }   // per-item loop; maintainerrMediaIds (REQUIRED, 1..1000) = the snapshot the user SAW — the run processes exactly that ∩ the current pending set (F2, 2026-07-06). skippedCount = kept-but-unevaluable / failed-protection; stalePending = snapshot ids no longer pending (never deleted). BOTH scopes honor LIVE Maintainerr exclusions first (F1) — a just-saved item is protected before its dnd tag syncs.
trash.recentlyDeleted({ media })            → RecentlyDeletedItem[]   // adds posterUrl
trash.restoreDeleted({ media, mediaItemId })→ { runId, status }
trash.activity({ limit? })                  → NotificationView[]
trash.saveRule({ payload })                 → void      // gate edit_rules + section edit
trash.deleteRule({ ruleGroupId })           → void      // gate edit_rules + section edit
roles.setTrashActions({ roleId, actions[] })→ { changed, before[], after[] }   // adminProcedure
```

`TrashPendingItem`: `{ maintainerrMediaId, collectionId, collectionTitle, tmdbId, tvdbId, sizeBytes,
addedToCollectionAt, deleteAfterDays, scheduledDeleteAt, mediaItemId, title, year, arrKind, arrTags,
protectedByTag, protectedByExclusion, recentlyWatched, lastViewedAt, requesters, sourceCollections,
posterSource, posterUrl }`. `protectedByExclusion` (2026-07-06 live fix) is the LIVE Maintainerr
exclusion signal, set only on the pending-tab read (`includeLiveExclusions`): the UI treats
tag-OR-exclusion as Protected. Real Maintainerr answers `[]` for a param-less exclusion GET, so the
read cross-checks per pending item by `mediaServerId` (the same `fetchLiveExclusions` seam the
expedite path uses — no bulk-all endpoint exists); the internal expedite/guardian calls leave it off.

## D-09 — Trash UX (as built, 2026-07-06 Fable UX pass; ADR-014/ADR-015 governed)

`/trash` (`apps/web/app/(app)/trash/`) — a server page gate (Disabled ⇒ the clean "not
available" state, mirroring `/ledger`; the page resolves `{level, actions}` off the session,
admin ⇒ all actions) over `trash-client.tsx`. Top-nav **Trash** entry renders only when the
session's `sectionPermissions.trash ≠ disabled` (no-row default is _disabled_ — falls closed).

- **Safety banner first** (`trash.status`, D-04): a reserved-height strip above the tabs —
  `safe` (accent: "Maintainerr connected · vX · N rules armed · M active collections"), `warn`
  (integration(s) named; **every Expedite control disables**; the shield stays live — exclusion
  writes need only reachability), `down` (unreachable ⇒ read-only). The banner mirrors; the
  server re-audits on every destructive call regardless.
- **Tabs:** Movies · TV · Recently Deleted · Rules · Activity (`?tab=`, WAI-ARIA tablist, keyed
  remount, tab switch keeps only `?tab`). Movies/TV are NEVER combined; Music does not exist
  here (R-87).
  > **Amended by ADR-032 (2026-07-07 / DESIGN-004 D-16):** the **Rules tab moved to
  > `/settings/trash`** (user-menu "Trash settings", gated at trash **Edit**) — it is a
  > setting, not a user-facing deletion surface. `/trash` keeps Movies · TV · Batches ·
  > Recently Deleted · Activity; the rules list/arm/disarm/delete below are unchanged, just
  > re-homed (same testids and wire calls).
- **Pending tables:** the `/ledger` spreadsheet treatment (sticky header + frozen Title column,
  both-axis internal scroll) with the shared chip engine (`?q/genre/res/req/col/rmin/rmax/sort`).
  Because `trash.pending` returns the WHOLE kind's set (household scale), filtering/sorting is
  **client-side**; facet values derive from the live set. _(The UX pass extended
  `TrashPendingItem` with `genres/resolution/imdbRating/tmdbRating` — same media_metadata join —
  so the chips have data.)_ Columns: Title (poster thumb + `/library/[id]` link when
  ledger-joined), Size, **Deletes** (date + a days-left pill that deepens muted→warn→danger as
  the delete nears), Rating, Status badges (**Protected** accent-shield / **Recently watched** /
  **Requested** / **Not in ledger** warn), Requested-by, Collection, Actions. Default sort:
  soonest-deleting first. A persistent **footer** ("Reclaiming N across M items", filter-aware,
  "· filtered from K pending" when narrowed) carries the **Expedite all…** button.
  > **Amended 2026-07-07 (owner: "the tables are unusable on my phone — the Batches wall UX is
  > perfect for all devices"):** the Movies/TV pending views are now **poster walls** riding the
  > DESIGN-011 D-07 wall grammar (the shared `.bwall` grid — fixed 2:3 boxes, 3-up at 390px);
  > the tables are retired with **no view toggle**. Same wire calls, same actions, re-skinned:
  > each tile carries **two fixed reserved corners** — the **shield** (top-right: `check` =
  > protected by the dnd tag or an exclusion made outside this session, **inert**; filled
  > `shield` = saved by YOU this session, tap ⇒ un-save; `outline` = tap ⇒ save — the flip is
  > optimistic, reconciles with the response, reverts on error; one flip in flight per tile) and
  > the **trash-can** (top-left: opens the unchanged ADR-014 Expedite Modal; disabled when
  > unsafe). **Tapping the poster opens `/library/[id]`** (ledger-joined items only — history/fix
  > live there; the bulletin-chip pattern); the old Deletes/Status/Requested-by/Collection
  > columns move into the tile **tooltip** (multi-line `title` attr). Caption: title (year);
  > meta: size · ★rating (fixed-height single lines). The reclaim bar moved **above** the wall
  > (sticky, constant-height, still carrying Expedite all…), a `/library`-style **sort bar**
  > replaces the table headers (same `?sort` tokens, soonest-deleting default), and a
  > fixed-height error slot sits between them (ADR-015). Un-saving protection you didn't make
  > stays possible via the `/library/[id]` guard panel, not the wall. The glyph rules are
  > unit-tested (`apps/web/lib/trash.ts pendingShieldGlyph`/`pendingShieldTappable`).
  >
  > **Amended by ADR-033 (2026-07-07 evening, owner-directed):** the pending wall now shares the
  > batch wall's **fast tap-toggle** — the WHOLE poster is the toggle (`trash` ⇄ `shield`),
  > optimistic + reflow-free; there is no separate shield corner. The glyph language is **unified**
  > with the batch wall (`trash` slated · `shield` saved-by-you · `check` protected-elsewhere,
  > inert · `eye` recently-watched, inert), rendered by the shared `WallGlyphSvg`; the rules moved
  > to `apps/web/lib/trash.ts` **`pendingWallGlyph`/`pendingWallTappable`** (unit-tested). The
  > `/library/[id]` nav moved OFF the poster to a distinct **top-left corner icon** (an open book,
  > `LibraryCornerLink`) carrying the `?from=trash-movies|trash-tv` context (DESIGN-005 D-17
  > amendment). **Per-item Expedite left the wall**: the trash-can is now a STATE, not a Modal
  > trigger — per-item "Delete now…" moved to the `/library/[id]` deletion-guard card
  > (`TrashPendingNotice`, admin/`expedite_item`-gated, safe-gated), reusing the ADR-014 Expedite
  > Modal. The bulk **Expedite all…** pill stays on the wall unchanged. The Trash tabs become
  > **Movies · TV · Recently Deleted · Activity** (Batches folded into the kind tabs — ADR-033).
  > **Further amended 2026-07-08 (D-10):** a leading **Overview** tab is prepended and becomes the
  > **default landing** (superseding default-Movies); Movies/TV gain count badges.
- **Shield (Save/whitelist, R-83):** a plain accent toggle (protective + reversible — ADR-014's
  two-step is reserved for destructive), constant footprint both states (ADR-015). The `dnd` tag only
  lands on the next *arr sync, but the pending read now ORs the LIVE Maintainerr exclusion set into
  `protectedByExclusion` (2026-07-06 live fix), so an exclusion made in ANY session — or outside the
  app entirely — reads Protected immediately; there is no cross-session lag to paper over. The
  session-local shield override remains only as an instant optimistic echo of the current click (the
  refetch confirms it); `protectedByTag`/`protectedByExclusion` are the durable signals. **Q-02
  resolved — protect-in-context:**
  the `/library/[id]` guard panel (scheduled-delete warning + shield) renders ONLY while the
  item is in the actual pending set — `saveExclusion` needs the Maintainerr mediaServerId (a
  Plex ratingKey) which only pending rows carry, and D-02's endpoint inventory has **no**
  tmdb/tvdb→ratingKey lookup, so an always-on library shield is not implementable without
  guessing ids (never). A dnd-tagged item additionally shows a display-only "Protected from
  deletion" badge on its detail header (read off `arrTags`). Music never shows either.
- **Expedite — the Modal EVERY time (ADR-014; never one-click):** per-row Expedite
  (`expedite_item`) and footer Expedite-all (`expedite_all`). The confirm predicts the guardian
  partition via a client mirror of `classifyGuardian` + the all-loop's unactionable check
  (`apps/web/lib/trash.ts previewGuardian` — unit-tested against the server semantics): **X
  deleted NOW (freeing S)** / **P protected** / **K kept-unverifiable**. The single-item Modal
  keys its copy to the verdict (cold ⇒ "immediate and permanent"; watched/requested ⇒ "will be
  protected instead"; unverifiable ⇒ "kept"). **Expedite-all cannot be scoped by filters** (the
  wire contract takes only `media`), so with any filter active the Modal **refuses to arm** and
  offers _Clear filters_ — the "looks filtered, deletes everything" state is unexpressible. The
  post-run report renders `expeditedCount/protectedCount/skippedCount` as **deleted / protected
  / skipped** with explicit copy that skipped = "could not be verified safe, kept" ≠ protected
  (C-07b). `MAINTAINERR_UNSAFE` (PRECONDITION_FAILED — no longer pending, or a between-check
  regression) renders a calm "Nothing was deleted — refreshed" state and invalidates the list.
- **Recently Deleted:** movie+tv tombstones merged newest-first (poster, kind badge, size,
  deleted-at); per-row **Restore** is a two-step `ConfirmButton` (`restore_deleted`) →
  `trash.restoreDeleted` (failsafe re-add); the row reports inline ("Re-added — clears on the
  next sync" — the tombstone lifts at sync time, deliberately).
- **Rules (scope decision):** this pass ships a readable **list + arm/disarm + delete** —
  name, media kind, delete-after days, Armed/Disarmed. Arm/disarm round-trips the passthrough
  RulesDto via `trash.saveRule` (`{...rule, isActive}`); delete is a two-step ConfirmButton.
  **Full rule BUILDING is deferred**: `GET /rules/constants` describes a deep
  application×property×operator matrix whose faithful editor is a project of its own — a
  half-faithful builder on the deletion engine is a safety liability, so authoring stays in
  Maintainerr for now (noted in the UI). Controls render only for section **Edit** +
  `edit_rules` (C-03) and disable when unreachable.
- **Activity:** `trash.activity` as the timeline list (type/title/body/when). PLAN-009 extends.
- **/admin/roles:** a **Trash** column — level `<select>` (applies on change) stacked over a
  constant-width "N actions" summary (tooltip lists them; ADR-015 — recounts, never reflows);
  the **per-action grid** (6 checkboxes, destructive ones labeled so) lives in the row editor
  and Add-role modal, submitted via `roles.setTrashActions` (replace-set). Admin shows
  "Edit · all actions", locked.
- **e2e** (`apps/web/e2e/trash.spec.ts` + the stateful stub): pending wall glyphs/tooltips +
  the reclaim counts bar + sort bar + poster-tap → `/library/[id]` (2026-07-07 amendment),
  save→saved-shield→unsave (exclusion calls asserted; an outside-session exclusion renders the
  inert check), expedite-all partition + report with the **`/collections/handle` ABSENT**
  assertion (C-07a), the mid-flight-unsafe refusal, the banner-warn + disabled-destructive
  state, restore, rules round-trip, activity, the roles grid, save-only role gating (can
  shield, cannot expedite/restore/edit rules), the library shield (pending movie ⇒ panel; dnd
  badge; music ⇒ nothing), and the 390px 3-column wall + viewport fit.

## D-10 — Trash Overview landing + kind tab count badges (amendment 2026-07-08, owner-directed)

> **Supersedes the default-Movies landing (D-09 / ADR-033).** Owner rationale: `/trash` opened on
> **Movies**, so **TV was a separate click and easy to miss** — it has been empty, but a TV-only
> deletion window would have been **invisible** from the landing. The fix is to **aggregate what's
> slated before you navigate**. The tab set gains a leading **Overview** and becomes
> **Overview · Movies · TV · Recently Deleted · Activity**; **Overview is the new default** (no
> `?tab=` → Overview; an explicit `?tab=movies|tv|deleted|activity` is unchanged, and the retired
> `?tab=batches` still folds to Movies — ADR-033).

- **Kind cards (the stars).** One card per kind (Movies, TV). Each shows the **count slated** — an
  open batch's **still-`pending` count**, else the **live candidate count** (the same number the
  kind tab's candidate hint / pending count shows, so the two never disagree) — the **reclaimable
  bytes** ("frees 114 GB"), the **open-batch state + deadline** when one is open ("Admin review — 18
  items" / "Leaving Soon — window closes Jul 21 (in 9 days)"), and a **state tone**: neutral
  (no batch) · info (admin review) · warn (Leaving-Soon window open) · **danger (≤3 days left**,
  mirroring `daysLeftTone`). An empty kind reads **"Nothing pending"**; a kind whose live candidate
  read failed (Maintainerr unreachable, no open batch) reads **"Candidates unavailable"**. **The
  whole card is a `<button>`** that opens its kind tab (keyboard-accessible).
- **Recent strip (light, below).** The newest few **Recently-Deleted** rows (title · by · size ·
  when) and **Activity** events, one line each, linking to those tabs. The cards lead; the strip is
  secondary.
- **Tab count badges.** The **Movies/TV** tab labels carry a small token pill (the roles-table
  `.action-badge` idiom) with the **same count as the card** — **suppressed at zero** (and when the
  live count is unknown), **warn** while a Leaving-Soon window is open, **danger ≤3 days** (aria /
  tooltip: "window closes Jul 21"). It rides **inside the fixed-height tab row** and never reflows it
  (ADR-015); the 390px tablist wraps as before. Overview / Recently-Deleted / Activity carry no badge.
- **Data — `trash.overview` (sectionProcedure `trash` `read_only`).** One light read the tab shell
  fetches **once** for both the cards and the badges:
  `{ kinds: [{ kind, slatedCount, reclaimableBytes, live, batch: { state, expiresAt, pendingCount } |
  null }], recentlyDeleted[], activity[] }`. It **composes existing reads** (`@hnet/domain
  getTrashOverview` — no duplicated query logic): the per-kind slated summary is `listTrashPending`
  (no open batch) or `listBatches` counts + the new `pendingBytes` (open batch — the frozen size of
  the still-`pending` items, the companion of `reclaimedBytes`); the strip heads are
  `listRecentlyDeleted` (both kinds, merged newest-first) + `listNotifications`. A no-batch kind's
  live read **degrades to `live:false`** (count unknown, not zero) when Maintainerr can't answer, so
  the landing never hard-errors on a down install — the safety banner remains the health mirror.
- **Client purity.** The card/badge tone + deadline copy are pure, unit-tested helpers
  (`apps/web/lib/trash.ts` `overviewCardTone` / `overviewDeadlineLabel` / `overviewBadge`), mirroring
  the wire — never re-deriving the server's slated/pending semantics.
- **e2e.** Bare `/trash` lands on Overview; a stubbed **Leaving-Soon movie** (warn card + deadline +
  still-pending count) beside an **emptied TV** ("nothing pending" card, suppressed-zero badge); the
  Movies tab badge shows the count in warn tone; a card click opens its kind tab; a direct
  `?tab=movies` deep link is unaffected; the landing fits 390px.

## Ops / deploy-time checklist (owner)

1. Place `MAINTAINERR_API_KEY` (Maintainerr's own first-run key) in 1Password `HaynesKube`; add
   `MAINTAINERR_URL` + `MAINTAINERR_API_KEY` to the app's ExternalSecret + Helm env.
2. Generate `MAINTAINERR_WEBHOOK_SECRET`, add it to 1Password + the app env. Configure Maintainerr's
   **Webhook** notification agent → `http://haynesnetwork.frontend.svc.cluster.local/api/webhooks/maintainerr`
   (in-cluster, not public) with the secret in the `x-webhook-secret` header (or `?token=`).
3. In Maintainerr, enable **"Tag excluded content"** on Radarr + Sonarr with the tag `dnd` and
   **"Remove tag on un-exclude" = ON** (or call `PATCH /api/settings` via our write client). This is
   what stamps/removes the protective tag our ledger reads as `protectedByTag`.
