# DESIGN-010: Trash section — Maintainerr client, per-action grants, safety gate, Activity feed

- **Status:** Draft (backend vertical shipped; **UX shipped 2026-07-06** — D-09 records the as-built)
- **Last updated:** 2026-07-06
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

**Uncertainty flags (carried from source review):** (a) `typeId`/`dataType` is numeric on
`GET /rules` (`1=movie,2=show,3=season,4=episode`) but string on the collection Zod schema — our
pending fetch does **not** send `typeId` (it fetches all collections and buckets client-side by the
collection `type` / item id presence), sidestepping the ambiguity; (b) the delete date is **never
returned** — we derive it = `addDate + deleteAfterDays` days; (c) `POST /rules/exclusion`'s body has
no runtime ValidationPipe, so extra fields are ignored — we send the minimal `{ mediaId, action:0 }`;
(d) there is **no aggregated integration-health endpoint** — the audit derives connectivity from the
`rules/constants` `applications` list (present only for configured integrations) + the Plex test.

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
trash.pending({ media })                    → { media, totalSizeBytes, count, items: TrashPendingItem[] }   // item adds posterUrl
trash.collections()                         → MaintainerrCollection[]
trash.rules()                               → MaintainerrRuleGroup[]
trash.ruleConstants()                       → MaintainerrRuleConstants
trash.saveExclusion({ maintainerrMediaId, mediaItemId?, collectionId? })   → { excluded, alreadyExcluded }
trash.removeExclusion({ maintainerrMediaId, mediaItemId? })                → { removed }
trash.expediteItem({ media, collectionId, maintainerrMediaId, mediaItemId? }) → { scope:'item', protectedCount, expeditedCount, skippedCount }
trash.expediteAll({ media })                → { scope:'all', protectedCount, expeditedCount, skippedCount }   // per-item loop; skippedCount = kept-but-unevaluable / failed-protection (UX must surface it — review 2026-07-06)
trash.recentlyDeleted({ media })            → RecentlyDeletedItem[]   // adds posterUrl
trash.restoreDeleted({ media, mediaItemId })→ { runId, status }
trash.activity({ limit? })                  → NotificationView[]
trash.saveRule({ payload })                 → void      // gate edit_rules + section edit
trash.deleteRule({ ruleGroupId })           → void      // gate edit_rules + section edit
roles.setTrashActions({ roleId, actions[] })→ { changed, before[], after[] }   // adminProcedure
```

`TrashPendingItem`: `{ maintainerrMediaId, collectionId, collectionTitle, tmdbId, tvdbId, sizeBytes,
addedToCollectionAt, deleteAfterDays, scheduledDeleteAt, mediaItemId, title, year, arrKind, arrTags,
protectedByTag, recentlyWatched, lastViewedAt, requesters, sourceCollections, posterSource, posterUrl }`.

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
- **Shield (Save/whitelist, R-83):** a plain accent toggle (protective + reversible — ADR-014's
  two-step is reserved for destructive), constant footprint both states (ADR-015). The dnd tag
  only lands on the next *arr sync, so a session-local override reflects a fresh save/un-save
  immediately; `protectedByTag` is the durable signal. **Q-02 resolved — protect-in-context:**
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
- **e2e** (`apps/web/e2e/trash.spec.ts` + the stateful stub): pending badges/footer,
  save→protected→unsave (exclusion calls asserted), expedite-all partition + report with the
  **`/collections/handle` ABSENT** assertion (C-07a), the mid-flight-unsafe refusal, the
  banner-warn + disabled-destructive state, restore, rules round-trip, activity, the roles
  grid, save-only role gating (can shield, cannot expedite/restore/edit rules), the library
  shield (pending movie ⇒ panel; dnd badge; music ⇒ nothing), and the 390px internal-pan fit.

## Ops / deploy-time checklist (owner)

1. Place `MAINTAINERR_API_KEY` (Maintainerr's own first-run key) in 1Password `HaynesKube`; add
   `MAINTAINERR_URL` + `MAINTAINERR_API_KEY` to the app's ExternalSecret + Helm env.
2. Generate `MAINTAINERR_WEBHOOK_SECRET`, add it to 1Password + the app env. Configure Maintainerr's
   **Webhook** notification agent → `http://haynesnetwork.frontend.svc.cluster.local/api/webhooks/maintainerr`
   (in-cluster, not public) with the secret in the `x-webhook-secret` header (or `?token=`).
3. In Maintainerr, enable **"Tag excluded content"** on Radarr + Sonarr with the tag `dnd` and
   **"Remove tag on un-exclude" = ON** (or call `PATCH /api/settings` via our write client). This is
   what stamps/removes the protective tag our ledger reads as `protectedByTag`.
