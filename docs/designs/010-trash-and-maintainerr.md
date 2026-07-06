# DESIGN-010: Trash section — Maintainerr client, per-action grants, safety gate, Activity feed

- **Status:** Draft (backend vertical shipped; the Trash UX is a Fable follow-up)
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

| Our operation | Verb + path | Request | Response / notes |
|---|---|---|---|
| Collections (list) | `GET /api/collections` | — | `Collection[]` incl. `deleteAfterDays, isActive, type, totalSizeBytes`; `media` is a PREVIEW subset |
| Collection membership + size | `GET /api/collections/media/{id}/content/{page}?size=` | page 1-based | `{ totalSize, items[] }`; item `sizeBytes`, `tmdbId`, `tvdbId`, `mediaServerId`, `addDate` |
| Rule groups | `GET /api/rules?activeOnly=&libraryId=&typeId=` | — | `RulesDto[]` (`id,name,isActive,dataType,collection{...}`) |
| Rule-schema catalog | `GET /api/rules/constants` | — | `{ applications:[{id,name,mediaType,props}] }` — filtered to CONFIGURED integrations |
| Exclusions | `GET /api/rules/exclusion?mediaServerId=&rulegroupId=` | — | `Exclusion[]` (`ruleGroupId=null` ⇒ global); `[]` with no params |
| Settings (tag-exclusion subset) | `GET /api/settings` | — | `Settings` (secrets masked): `radarr_tag_exclusions`, `radarr_exclusion_tag`(default `dnd`), `radarr_untag_on_unexclude`, `sonarr_*` |
| App status / version | `GET /api/app/status` | — | `VersionResponse {status,version,commitTag,updateAvailable}` (may arrive double-encoded — the client pre-parses) |
| Plex connectivity | `GET /api/settings/test/plex` | — | `BasicResponseDto` (`status:'OK'` ⇒ connected) |
| **Add exclusion (Save)** | `POST /api/rules/exclusion` | `{ mediaId, action:0, collectionId? }` (omit `collectionId` ⇒ global) | `ReturnStatus`; `action:1` routes to remove |
| **Remove exclusion (un-save)** | `DELETE /api/rules/exclusions/{mediaServerId}` | path param | `ReturnStatus` (removes ALL exclusions for the item) |
| **Expedite ALL** | `POST /api/collections/handle` | no body | `201`; `409` if the handler is already running |
| **Expedite one item** | `POST /api/collections/media/handle` | `{ collectionId, mediaId }` | `201`; `404`/`409` on miss/conflict |
| **Rule group create / update / delete** | `POST /api/rules` · `PUT /api/rules` · `DELETE /api/rules/{id}` | `RulesDto` (create/update) / id | `ReturnStatus`; `deleteAfterDays` lives in the nested `collection` |
| **Enable tag exclusions + `dnd`** | `PATCH /api/settings` | partial `SettingDto` (`{radarr_tag_exclusions,radarr_exclusion_tag,radarr_untag_on_unexclude, sonarr_*}`) | full replace is `POST /api/settings` |

**Uncertainty flags (carried from source review):** (a) `typeId`/`dataType` is numeric on
`GET /rules` (`1=movie,2=show,3=season,4=episode`) but string on the collection Zod schema — our
pending fetch does **not** send `typeId` (it fetches all collections and buckets client-side by the
collection `type` / item id presence), sidestepping the ambiguity; (b) the delete date is **never
returned** — we derive it = `addDate + deleteAfterDays` days; (c) `POST /rules/exclusion`'s body has
no runtime ValidationPipe, so extra fields are ignored — we send the minimal `{ mediaId, action:0 }`;
(d) there is **no aggregated integration-health endpoint** — the audit derives connectivity from the
`rules/constants` `applications` list (present only for configured integrations) + the Plex test.

## D-03 — Permission matrix (ADR-023 C-03)

| Capability | Gate |
|---|---|
| View pending / collections / rules / recently-deleted / activity / status | `sectionProcedure('trash','read_only')` |
| Save / un-save an item | `trashActionProcedure('save_exclude'|'remove_exclude')` (read_only + grant) |
| Expedite one / all | `trashActionProcedure('expedite_item'|'expedite_all')` |
| Restore a deleted item | `trashActionProcedure('restore_deleted')` |
| Create/update/delete a rule group | `trashActionProcedure('edit_rules','edit')` — grant **and** section Edit |
| Set a role's Trash actions | `roles.setTrashActions` (`adminProcedure`) |

Admin ⇒ every section Edit + every action (no rows). Section `disabled` ⇒ no procedure reachable
(server-authoritative — the grants are session-carried, never client-hidden only, AC-16). A row in
`role_trash_action_grants` **is** the grant; section edit-level implies nothing extra.

## D-04 — Safety audit (`trash.status`, ADR-023 C-04)

`auditMaintainerr` → `{ safe, reachable, version, integrations:{plex,radarr,sonarr,tautulli,seerr},
armedRules, activeCollections }`, read-only, writes no state, each sub-read fails closed. SAFE =
reachable AND every required integration connected. `expedite*` re-run it and refuse
(`MAINTAINERR_UNSAFE` → `PRECONDITION_FAILED`) unless SAFE; exclusion writes need only reachability.

## D-05 — Write ordering + the guardian (ADR-023 C-05/C-07)

- **Save/remove exclusion (protective):** external Maintainerr call **first**, then the
  `trash_excluded` event (idempotent — already excluded ⇒ no-op/no event). Rationale: a Save is
  protective, so the fail-safe direction is establish-protection-first; a phantom protective event
  (written before a failed call) is the dangerous under-protection failure, so we never write it
  first. A crash after the exclusion leaves the item genuinely protected (audit reconcilable from
  Maintainerr's exclusion list).
- **Expedite (destructive):** commit the `trash_expedited` intent event **first**, then the
  Maintainerr handle call (the Fix D-09 discipline — a lost response must never hide an initiated
  deletion; over-reporting a destructive intent is the safe direction).
- **Guardian:** `guardRecentlyWatched` runs before an expedite-all (auto-whitelisting
  recently-watched / requester-tagged items so Maintainerr's handler can't delete them) and per-item
  for `expedite_item` (a watched/requested target is protected instead of deleted). Window
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
endpoint/table.

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
trash.expediteItem({ media, collectionId, maintainerrMediaId, mediaItemId? }) → { scope:'item', protectedCount, expeditedCount }
trash.expediteAll({ media })                → { scope:'all', protectedCount, expeditedCount }
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

## Ops / deploy-time checklist (owner)

1. Place `MAINTAINERR_API_KEY` (Maintainerr's own first-run key) in 1Password `HaynesKube`; add
   `MAINTAINERR_URL` + `MAINTAINERR_API_KEY` to the app's ExternalSecret + Helm env.
2. Generate `MAINTAINERR_WEBHOOK_SECRET`, add it to 1Password + the app env. Configure Maintainerr's
   **Webhook** notification agent → `http://haynesnetwork.frontend.svc.cluster.local/api/webhooks/maintainerr`
   (in-cluster, not public) with the secret in the `x-webhook-secret` header (or `?token=`).
3. In Maintainerr, enable **"Tag excluded content"** on Radarr + Sonarr with the tag `dnd` and
   **"Remove tag on un-exclude" = ON** (or call `PATCH /api/settings` via our write client). This is
   what stamps/removes the protective tag our ledger reads as `protectedByTag`.
