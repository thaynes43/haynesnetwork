# DESIGN-010: Trash section — Maintainerr client, per-action grants, safety gate, Activity feed

- **Status:** Draft (backend vertical shipped; **UX shipped 2026-07-06** — D-09 records the
  as-built; **pending tables → poster walls 2026-07-07**, see the D-09 amendment)
- **Last updated:** 2026-07-09 (errata — Maintainerr aging-invariant safeguard, ADR-036 / incident;
  D-12 build C — watch indicators never occupy the action corner; every tile stays saveable)
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

## D-11 — Candidate read-model: snapshot-backed walls (amendment 2026-07-09, ADR-035)

**Why.** The paginated D-02 read was still READ-THROUGH: every `trash.pending` /
`trash.pendingCandidates` / no-batch `trash.overview` call re-crawled Maintainerr's collection API.
The 2026-07-09 live profile (742 movie candidates, v0.25.0) measured `content/:page` at **0.4–5.8 s
per call in-cluster regardless of page size** (15 serial `size=50` calls ≈ 6–9 s; ONE `size=750`
call ≈ 0.16 s warm), one tab load firing up to four concurrent crawls (no in-flight dedup on the 8 s
memo), and `httpBatchLink` gating first paint on the slowest call in the flight → **first wall tile
9.1 s** even when an open batch made the wall's own data DB-fast.

**What (ADR-035).**

- **`trash_candidates` + `trash_candidates_state` (migration 0027)** — the per-kind flat snapshot of
  Maintainerr's pending set (Maintainerr-owned facts only; verbatim `addDate`; crawl-order `ord`) +
  per-kind `refreshed_at`/count/bytes bookkeeping. Single writer:
  `@hnet/domain trash-candidates.ts` (`refreshTrashCandidates` — advisory-locked snapshot-replace;
  `removeTrashCandidateRows` — expedite/sweep cleanup). Guard list updated. Derived, rebuildable
  state ⇒ the writers append no ledger audit rows (ADR-035 C-05).
- **Reads.** `listTrashPendingPage`, `listTrashPendingCandidates`, `countTrashPending` (Overview)
  now serve from the snapshot; the ledger/metadata join stays AT READ TIME (facets track the media
  sync); the visible page's exclusion cross-check stays LIVE (≈2 ms/item in-cluster). The page wire
  gains **`refreshedAt`** and the router a **`trash.refreshCandidates`** mutation
  (`manage_batches`-gated).
- **Freshness.** Prod: serve instantly; older than 20 min ⇒ background deduped refresh; inline only
  when no snapshot exists. Non-prod (dev/e2e/vitest): inline refresh on EVERY read — read-through
  equivalence (the D-02 memo determinism rationale, now structural). Refresh cadence: the
  full/incremental sync post-step (15 min), rule-edit triggers, the walls' Refresh affordance;
  expedite/sweep drop their deleted ids immediately.
- **UX.** The counts bar carries the honest "candidates as of N min ago" + a manage-gated
  **Refresh**; the future-batch strip head shows the same age. Fixed slots — no reflow (ADR-015).
- **Live paths unchanged (safety).** `listTrashPending` (whole-set live read) still backs the
  guardian/expedite/batch-create/sweep/space-policy flows — every deletion decision re-reads
  Maintainerr fresh. `fetchMaintainerrPending` itself now pages at 500 with bounded-parallel
  collections, and the D-04 audit's sub-reads run concurrently, so those paths got faster too.

**Measured (before → after, 742 candidates; hermetic bench with the live-measured latency model).**
One BEFORE materialization crawl: **9.8 s** (16 serial content calls — matches the live 6.1–9.2 s
`trash.pending` cold). AFTER: `trash.pending` page **34–46 ms** (incl. 50 live exclusion checks),
`pendingCandidates` 9 ms, Overview count 1 ms — zero collection calls on the request path; snapshot
rebuild **1.4 s** modeled / ~0.5 s live warm Maintainerr, always off the paint path in prod.
Details: `.agents/context/2026-07-09-trash-wall-perf.md`.

## D-12 — Cross-server watch VISIBILITY on the trash walls (amendment 2026-07-09, owner-directed)

> **Owner ruling (2026-07-09), option B ONLY — SHOW watch history, change NO protection semantics.**
> Kometa rolls junk in fast and the owner wants FAST deletion, so this amendment adds *visibility*
> of when/where a slated title was last watched across the estate — it does **not** extend any
> guardian keep. An ever-watched-but-not-recent item stays sweep-deletable and wall-actionable.

**Why.** The wall already surfaces a *recently* watched (`≤ RECENTLY_WATCHED_WINDOW_DAYS`, 30d) item
as the inert `eye` corner glyph (the guardian keeps it). But a title watched **longer ago** read as a
plain cold candidate — the family had no signal that "we watched this in 2024, maybe don't nuke it
blind." The owner wanted that context *visible* without turning it into protection.

**Data (migration 0028).** Two additive, nullable columns on `media_metadata`:
`last_watched_at` (timestamptz) + `last_watched_server` (text — the estate slug
`haynesops | hayneskube | haynestower`). `last_watched_at` is the **MAX last-watch instant across all
three Tautulli histories** (full history, NOT the 30-day window; TV rolled up to the show — the same
episodes→series `grandparent_rating_key` rollup the harvest already does), and `last_watched_server`
is the server that owns that max. **Relationship to `last_viewed_at` (0012):** they hold the SAME
source instant — `last_viewed_at` is the guardian's watch-stat (recentlyWatched derives from it,
UNCHANGED); `last_watched_at`/`last_watched_server` is the wall/detail-facing **display pair**, stored
together so the timestamp and its attribution are always consistent. (A future cleanup could collapse
the two; kept separate here so this change touches no guardian input.)

**Harvest (no new Tautulli cost — DESIGN-008 D-04 piggyback).** The 6h metadata-refresh already pages
each of the three Tautulli histories ONCE, groups by rating key (movie) / grandparent rating key
(episode→series), resolves guids, and merges the per-instance contributions
(`mergeWatchContributions`: `play_count` = SUM, `last_viewed_at` = MAX). D-12 extends that SAME merge
to also record **which instance owns the max** (`lastWatchedServer`) — zero extra requests, no
per-title `get_history&rating_key=` storm. The harvest writes `last_watched_at = last_viewed_at` +
`last_watched_server` on the existing single-writer upsert.

**Read-model.** The fields ride the existing `media_items ⟕ media_metadata` join at READ time in
`shapePendingItems` (so they flow to the ADR-035 snapshot walls for free — the snapshot itself is
unchanged) and in `getBatchDetail`. `TrashPendingItem` + `BatchDetailItem` gain
`lastWatchedAt`/`lastWatchedServer`.

**Surfacing (both pending walls + batch wall + future strip).**

- **Recently watched (≤30d):** UNCHANGED — the inert `eye` corner glyph; the guardian keeps it. No
  muted indicator (never doubles up).
- **Watched longer ago** (`lastWatchedAt` set AND NOT `recentlyWatched`): a **muted small watch
  indicator** in the tile's **meta line** — a subdued eye (`WatchedAgoNote`, `data-testid="wall-watched"`)
  pinned at the end of `size · ★rating`, `--color-text-muted` at 0.8 opacity, 13px. Deliberately in the
  caption/meta zone (NOT a corner puck) so it can never read as the protective shield/check/eye state
  glyphs. Tooltip + `role="img"` label: `Last watched on <server> · <Mon YYYY>` (tz America/New_York).
  The tile stays **fully actionable** (tap-save / slate / delete exactly as before).
- **Glyph precedence (documented).** The corner glyph is unchanged: a **requested / person-shield item
  keeps the corner**; the watch info moves to the meta-line indicator + tooltip. So a requested,
  watched-long-ago tile shows the person-shield corner **and** the muted watch note — they co-exist,
  requested wins the corner (unit-tested `pendingWallGlyph`, e2e on Breaking Prod).
- **Item detail deletion card** (`TrashPendingNotice`): gains a `Last watched on <server> · <Mon YYYY>`
  line (`data-testid="trash-last-watched"`) when present. It never gates the card's actions.

**No guardian changes. No candidate filtering. No new keeps.** `classifyGuardian`,
`RECENTLY_WATCHED_WINDOW_DAYS`, `recentlyWatched`, the sweep, and every keep partition are byte-for-byte
unchanged. Regression-asserted: an ever-watched-but-not-recent item ⇒ `classifyGuardian` `{keep:false}`
(deletable) and a tappable wall tile.

**Pure client helpers** (`apps/web/lib/trash.ts`, unit-tested): `watchServerLabel` (slug → display
name), `formatWatchMonth`, `watchedLongAgo`, `lastWatchedLabel`.

> **⚠ Superseded in part by the D-12 build-C amendment below (2026-07-09).** The bullets above that
> describe a recently-watched item keeping an inert `eye` **corner** glyph are RETIRED: the corner is
> now always the action toggle, and the watch fact (both recent AND long-ago) lives on the meta line.

### D-12 build C — watch indicators never occupy the action corner (owner ruling 2026-07-09)

> **Owner ruling (2026-07-09), verbatim intent:** after the watch-visibility deploy, a pending-wall
> tile (PAW Patrol: The Mighty Movie) showed the `eye` in the top-right corner and **clicking did
> nothing** — the owner expects **tap → save**. "We may want to put the watched icon in a different
> spot, whatever is good UI design, so it doesn't conflict with our normal trash/shield flow."

**Diagnosis.** PAW Patrol is a cold candidate on HOps (never watched there → the guardian rule) but
recently-watched **cross-server** (HNet). #142's cross-server harvest made `recentlyWatched` true for
such titles far more often, so the tile got the legacy `eye` corner glyph — which had **always** been
inert (pre-existing: recently-watched = the guardian will keep it = "nothing to do"). The flaw #142
exposed: an inert corner blocks **both** directions — the owner also can't **Save** (permanent
whitelist) a recently-watched item. The eye was doing two jobs (state + a dead affordance) in the one
slot reserved for the action.

**Ruling / IA as built.**

1. **The top-right corner is ALWAYS the action toggle** (trash ⇄ shield; the tag-protected `check` is
   tappable-to-unprotect per the ADR-025 errata; the requester `requested`/person-shield is a
   tappable save/un-save). A recently-watched item now gets the **normal** toggle like everything
   else — the `eye` corner glyph is **retired** on every wall (pending, future strip, batch). Saving a
   recently-watched item is the standard exclusion (it leaves the pool); **slating stays honest** — the
   guardian still keeps it at the **sweep** (a sweep-time protection, unchanged, `classifyGuardian`
   untouched). It simply is no longer a wall-corner state that dead-ends the tap.
2. **Watch info moves OUT of the action corner entirely**, onto the meta line, for **both** watch
   states (unified `watchNote`, `WatchNoteBadge`, `data-testid="wall-watched"`, `data-tone`):
   - **recently watched ⇒ INFO-tone eye** (`--color-info`) + `Watched recently on <server>` (tooltip
     w/ month). Always present (a recently-watched item always earns its note, even before the
     cross-server instant is attributed → a bare "Watched recently").
   - **watched a while ago ⇒ MUTED eye** (`--color-text-muted` @ 0.8) + `Last watched on <server> ·
     <Mon YYYY>` — the D-12 build-A/B behavior, unchanged.
   The chip is a fixed-size meta-line element (never a corner puck); TONE carries the state at a
   glance, the full label rides the tooltip/aria (the meta line is one fixed-height row — ADR-015, no
   reflow). Requester/person-shield still WIN the corner; watch info + corner never collide.
3. **Batch wall — same flaw, same fix.** A recently-watched batch item snapshots as `pending` (the
   requester auto-save is gated on `!recentlyWatched`, so it is NOT auto-saved) and previously showed
   the inert `eye` — a recently-watched batch item **could not be rescued**. Now it reads as its normal
   glyph (`trash`, or the `requested` person-shield when a requester is on record) and is **saveable**:
   `tileTappable` makes a `pending` person-shield tap-to-save (either direction is valid for any saver
   in an interactive phase). **Batch save semantics are unchanged** — only the corner became actionable.
   Counts follow the glyph (a recently-watched pending item counts as **slated**, mirroring the pending
   wall; the sweep-time guardian keep is surfaced by the meta chip, not a "kept" tally).
4. **Precedence (documented, unit-tested).** Corner glyph precedence: `dnd` tag → live exclusion →
   requester person-shield → trash. Watch is **no input to the corner** — it is purely the meta note.
   A requested + recently-watched tile shows the tappable person-shield corner **and** the info-tone
   watch chip; they co-exist.

**No guardian changes (still).** `classifyGuardian`, `RECENTLY_WATCHED_WINDOW_DAYS`, `recentlyWatched`,
the sweep, the expedite preview (`previewGuardian`), and every keep partition are byte-for-byte
unchanged — a recently-watched item is still *protected at the sweep*, it is just no longer *inert on
the wall*. Both themes; legible at 390px (3-col grid).

**Client surface** (`apps/web/lib/trash.ts` + `trash-batches.ts`, unit-tested; `pending-wall.tsx`,
`kind-tab.tsx`, `trash-shield.tsx`): `pendingWallGlyph`/`wallGlyph` drop the `eye` branch (and the
glyph unions drop `'eye'`); `pendingWallTappable` no longer special-cases `eye`; `tileTappable`'s
`requested` branch is tappable in both directions; new `recentlyWatchedLabel` + `watchNote` +
`WatchNoteBadge` (replacing `WatchedAgoNote`).

> **Errata (2026-07-09, owner-directed) — the requester person-shield is retired; requested is a
> meta-line info badge (like the watch note).** Owner ruling, verbatim: *"Maintainerr rules decide what
> gets promoted; the app controls how much and when it's deleted."* Points 3 and 4 above are amended:
> a requester is **no input to the corner glyph** either. The `requested` person-shield glyph is
> removed from `pendingWallGlyph`/`wallGlyph` and from `WallGlyphSvg`; `wallGlyph` depends only on item
> state, and a `pending` item (recently-watched, requested, or plain) is always the slated, saveable
> `trash`-can. The requester attribution moves OUT to the meta line as an **info badge** — a person
> icon + "Requested by &lt;name&gt;" tooltip (`RequestedByBadge`, `data-testid="wall-requested"`), a
> fixed-size chip co-existing with the watch note (both are info, neither reflows — ADR-015). So a
> requested + recently-watched tile now shows the **slated trash-can corner** plus TWO meta chips (the
> person badge + the info-tone watch eye). The corner-precedence line reduces to `dnd` tag → live
> exclusion → trash. The guardian is likewise amended (a requester is no longer a keep) — see the
> ADR-025 errata (2026-07-09); the **recently-watched** sweep keep is unchanged. Batch counts: a
> requested pending item counts as **slated** (it is no longer a "kept" person-shield). See DESIGN-011
> D-11 errata.

## D-13 — Strategy-mirrored wall order + honest cadence + debounced pool refresh (amendment 2026-07-09, build D)

Owner-greenlit. Three coherent pieces on the pending walls now that Maintainerr's per-item countdown is
defused (`deleteAfterDays 9999` — a delete date is meaningless):

1. **Strategy-mirrored default sort.** The dead **"Deletes" (`scheduled`) sort is RETIRED** — removed
   from the wall's sort bar and the wire enum. The new DEFAULT is **"Next up" (`strategy`)**, which
   mirrors the ACTIVE batch-selection strategy for the kind (`activeBatchStrategy(policy, kind)` — the
   kind's `space_policy.perKind[kind].strategy`, else the owner default `worst-rated`) so the TOP of the
   wall = the front of the deletion queue. The ordering is the SHARED `compareByStrategy` (`packages/
   domain/src/trash-strategy.ts`) that `selectBatchCandidates` also uses: `worst-rated` = rating asc
   with UNRATED FIRST, ties size desc, then title; `largest` = size desc, then title. Server-side sort
   (`listTrashPendingPage` → `comparePending`) reads the strategy and orders the paginated read; the
   "Potential in future batches" strip inherits the same default. The sort bar keeps Title/Size/Rating
   as manual overrides. `buildKindTargeting` now reads the same resolver (behaviour-preserving: an unset
   per-kind strategy still yields `worst-rated`, the prior hard-coded value).

2. **Honest pool re-evaluation cadence.** The walls' counts bar extends the "candidates as of N min ago
   · Refresh" line with **"pool re-evaluates every N h"** — Maintainerr's OWN rule-handler cron read
   from `GET /api/settings` (`rules_handler_job_cron`; the live install is `0 0-23/8 * * *` → every 8 h,
   the v3.17.0 default). Parsed by `parseCronEveryHours`, fetched via the read client, cached in-process
   (`getPoolRefreshCadence`, `trash.poolCadence`), and gracefully omitted when Maintainerr is unreachable.

3. **Debounced post-save rule re-execution.** A new audited app-setting `pool_refresh_after_save`
   (`{ enabled, delayMinutes }`, DEFAULT `{ true, 5 }`) on **/settings/trash → General** (inside the
   single-green-Save form). On a save/un-save the server upserts a per-kind `pending_pool_refresh`
   marker with `due_at = now + delayMinutes` (a TRAILING debounce — each save pushes `due_at` out, so a
   burst coalesces to one run after the last save) and arms an in-process web timer. Draining (the timer
   OR the crash-safe incremental-sync backstop) coalesces to ONE `POST /api/rules/execute` — Maintainerr
   re-evaluates all active rule groups, dropping excluded/shielded items from the pool. This is the RULE
   handler, NOT the collection handler (`handleAllCollections`, still deliberately never called): it
   re-computes membership and does NOT delete media, so it does not bypass the guardian and is safe to
   trigger from a user save. Maintainerr's own single-run guard (`409` "already running") is the
   cross-process backstop; a non-confirmed run keeps the marker for the next tick. `enabled=false` is
   respected at both arm and drain.

Migration **0029** (`0029_pool_refresh_after_save.sql`, journal idx 28) relaxes the `app_settings.key`
CHECK for the new key and adds the `pending_pool_refresh` marker table.

## Ops / deploy-time checklist (owner)

1. Place `MAINTAINERR_API_KEY` (Maintainerr's own first-run key) in 1Password `HaynesKube`; add
   `MAINTAINERR_URL` + `MAINTAINERR_API_KEY` to the app's ExternalSecret + Helm env.
2. Generate `MAINTAINERR_WEBHOOK_SECRET`, add it to 1Password + the app env. Configure Maintainerr's
   **Webhook** notification agent → `http://haynesnetwork.frontend.svc.cluster.local/api/webhooks/maintainerr`
   (in-cluster, not public) with the secret in the `x-webhook-secret` header (or `?token=`).
3. In Maintainerr, enable **"Tag excluded content"** on Radarr + Sonarr with the tag `dnd` and
   **"Remove tag on un-exclude" = ON** (or call `PATCH /api/settings` via our write client). This is
   what stamps/removes the protective tag our ledger reads as `protectedByTag`.

## Errata — Maintainerr aging-invariant safeguard (2026-07-09, ADR-036)

**Incident.** A live audit found the two production **rule collections** (`hnet — unwatched low-value
movies` ~741 items / ~16 TB; `hnet — unwatched low-value TV` ~13 items) configured with
`deleteAfterDays: 60` and `arrAction: 0` (DELETE). Maintainerr's **own** aging worker
(`collection-worker.service.ts`, v3.17.0) deletes any member whose `addDate <= now −
deleteAfterDays·86_400_000` and skips **only** `arrAction === DO_NOTHING (4)` — with **no** null/0
guard (a null/0 horizon deletes immediately). That worker path **bypasses this app's entire pipeline**
(batch, Leaving-Soon window, cross-server guardian, ledger attribution). Unaddressed, the movie pool
would have been mass-deleted ~Sep 5–7, 2026.

**Immediate ops fix.** Raised `deleteAfterDays` `60 → 9999` on **both** rule groups via the guarded
`upsertTrashRule` (`PUT /api/rules`), changing **only** `collection.deleteAfterDays`. Verified from the
v3.17.0 `updateRules` source that the change does **not** trip the crucial-change wipe (which compares
only `dataType` / `manualCollection` / `manualCollectionName` / `libraryId`). Before/after: collection
ids stable (1, 3), `arrAction` unchanged (0), `mediaCount` stable (741 / 13), rule-content hashes
IDENTICAL, exclusions IDENTICAL (198 each). `deleteAfterDays: 9999` puts dangerDate ~27 years in the
past ⇒ zero eligible items, while `arrAction: 0` keeps the app's per-item `/collections/media/handle`
delete working.

**Standing invariant (D-15).** `auditMaintainerr` now evaluates two invariants over every **active**
collection and folds any breach into the existing `safe` gate (blocking `expediteDeletion` +
`sweepExpiredBatches` unchanged), surfacing a specific human reason in the safety banner:

- **Rule pool** (active, not a Leaving-Soon manual collection): `deleteAfterDays >=
  AGING_HORIZON_MIN_DAYS (3650)` **AND** `arrAction === 0`. Breach ⇒ e.g. *"Maintainerr would
  self-delete the '<pool>' pool in N days — raise its delete-after horizon"*.
- **App-managed Leaving-Soon manual collection** (matched by title, ADR-025): `arrAction === 4`
  (DO_NOTHING). Breach ⇒ *"… Maintainerr could delete curated items outside the batch pipeline"*.

A `GET /collections` read failure fails **closed**. The invariant core is the pure, unit-tested
`evaluateAgingInvariants` (`packages/domain/src/trash-flow.ts`); the audit wire shape gains
`agingViolations: string[]`; the banner (`apps/web/components/trash-safety.tsx`) renders the reasons.
Read schema `maintainerrCollectionSchema` was extended to carry `arrAction` / `manualCollection`.
