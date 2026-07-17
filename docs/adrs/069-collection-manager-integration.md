# ADR-069: Collection-manager integration — a confined `@hnet/libretto` write surface, role-governed collection actions, and member contributions

- **Status:** Accepted (owner directive 2026-07-16 eve — PLAN-052 Libretto leg; Accept authority per plan-loop)
- **Date:** 2026-07-17
- **Deciders:** Tom Haynes (owner directive 2026-07-16: "add a way to haynesnetwork.com to
  manage and monitor its collections... it would be great for users to be able to contribute to
  building new collections that grow our catalogue... Edits to collections pose some risk of
  pulling a ton of content so we should gate them depending on peoples role.")
- **Builds on / refines:** DESIGN-037 (Libretto — the stateless "Kometa for books" app + its
  provider-parity API contract, the binding target of this ADR) · ADR-064/DESIGN-035 (mirrored-only
  doctrine — external software is ALWAYS the collections source of truth; Libretto IS that external
  software for books) · ADR-066/DESIGN-038 (the books-collections MIRROR the walls read — unchanged;
  this ADR adds the MANAGER, the mirror keeps showing what Libretto produces) · ADR-055/ADR-056
  (the confined `@hnet/lazylibrarian/write` / `@hnet/kapowarr/write` read+write split + the
  arr-write-import-guard idiom — copied here for `@hnet/libretto/write`) · ADR-023/ADR-059/ADR-062
  (the fine-grained per-action role grants — `role_trash_action_grants` /
  `role_activity_action_grants` / `role_books_action_grants`, the single-writer + same-tx-audit +
  guard-listed idiom this ADR copies exactly) · ADR-058 (the shared card system these surfaces
  extend) · ADR-014/ADR-015 (ConfirmButton + reflow-free). All STAND.

## Context and problem statement

The estate now has a books collection-manager app — **Libretto** (DESIGN-037): a standalone,
stateless "Kometa for books" that builds Kavita/ABS collections from list sources (Hardcover
series, NYT lists, static id lists) and, when a recipe opts in, drives the missing books into the
library via LazyLibrarian. Libretto is proven live this session (16 collections built through its
API). PLAN-051 (ADR-066) already MIRRORS whatever Libretto writes onto the Books/Audiobooks walls.

What is missing is the **management + monitoring + contribution** surface the owner asked for: a way
inside haynesnetwork to see the recipes Libretto runs, their match/miss counts, whether each pulls
content, to create/edit/apply/delete recipes, and — the creative half — a **non-invasive way for
members to contribute** collection ideas that grow the catalogue, all **gated by role** because
recipe edits (and especially the acquisition toggle) can pull a lot of content.

Three things this ADR must decide, all with existing precedent:

1. **How the app talks to Libretto** — Libretto's write API pulls content (apply + acquisition);
   that is the same "confined mutating external surface" class as the *arrs, Plex, LazyLibrarian.
2. **How the risk is gated by role** — the owner's explicit shape: different roles get different
   powers, and the content-pulling knob is the most restricted.
3. **How a member contributes non-invasively** — a light affordance that proposes, never applies,
   and an admin approval step that materializes the proposal through the confined writer.

The Kometa provider leg is being designed in parallel (DESIGN-037 Appendix A step 1). This ADR must
leave the DOMAIN model **provider-shaped** so Kometa slots in later with no schema churn (R2 —
integration parity: "the integration from haynesnetwork should look the same for both our new book
app and Kometa").

## Decision drivers

1. Libretto's apply + acquisition endpoints PULL CONTENT — they belong behind the same confined
   write boundary the *arr/Plex/LL write surfaces sit behind (hard rule 4 spirit; ADR-055 precedent).
   NEVER reachable from the browser.
2. The owner's gating shape is role-scoped and graduated: a member may propose, a manager may
   create/edit/apply, and only an `acquire` role may flip the content-pulling knob.
3. Ship-safe rollout (the books-Fix / metrics / integrations precedent): every new action ships
   Admin-only (NO grant rows) and the owner opens it per role after review.
4. Mirror-only doctrine holds (ADR-064): Libretto/Kavita/ABS remain the collections source of
   truth. This surface READS Libretto live and WRITES recipes through the confined client; it never
   duplicates Libretto's recipe/collection state into a local mirror (Libretto is stateless — its
   API IS the read model). The only durable local state is the role grants + the pending suggestions.
5. Provider-shaped from day one (R2) — a `provider` discriminator column, 'libretto' now, so the
   Kometa leg is a data + adapter addition, not a migration.
6. Honesty when Libretto is down (ADR-059 degrade discipline): the manager reports "unreachable",
   the mirror walls keep working, nothing crashes.
7. Hermetic-only (ADR-010): the Libretto client is fetch-injectable; a stub server (the LL/arr stub
   idiom) drives every test + the screenshot capture offline.

## Considered options

**How the app talks to Libretto:**
- A — a plain fetch in packages/api. Rejected: a content-pulling write surface reachable from any
  code path is exactly what ADR-055's confinement exists to prevent.
- **B (CHOSEN) — a confined `@hnet/libretto` client package**, read + write split, the write
  entrypoint import-confined to packages/domain (arr-write-import-guard extended for
  `@hnet/libretto/write`). The read surface (list recipes / runs / collections / validate) is
  safe-everywhere; the write surface (upsert / delete / apply) is domain-only. Identical discipline
  to `@hnet/lazylibrarian`.

**Role gating shape:**
- A — one coarse `manage_collections` boolean. Rejected: it can't separate "propose" from "edit"
  from "pull content", which is exactly the owner's graduated ask.
- **B (CHOSEN) — a `role_collection_action_grants` table** in the ADR-023/059/062 idiom with three
  actions: `suggest`, `manage`, `acquire`. A row is the grant; Admin implies all; ships with NO
  rows. `acquire` is deliberately separate from `manage` so the content-pulling knob is its own
  grant a manager does not automatically hold.

**Contribution flow:**
- A — members create recipes directly (self-service). Rejected: a member creating a
  `hardcover_series` recipe with acquisition is exactly the "pull a ton of content" risk.
- **B (CHOSEN) — a propose→approve flow.** A `suggest`-granted member files a `collection_suggestions`
  row (pending); it applies NOTHING. A `manage` admin approves (materialize the recipe via the
  confined writer, acquisition still off unless `acquire`) or declines with a reason. Every step
  audited. The suggester sees their suggestion's state on the wall affordance.

## Decision outcome

- **C-01 — the confined `@hnet/libretto` client.** A new package `@hnet/libretto` (barrel = safe
  errors/config/schemas; `@hnet/libretto/read` = list recipes/runs/collections + validate;
  `@hnet/libretto/write` = upsertRecipe/deleteRecipe/apply, import-confined to packages/domain). Env
  contract: `LIBRETTO_URL` (default in-cluster `http://libretto.media.svc.cluster.local:8080`) +
  `LIBRETTO_API_KEY` (REQUIRED, Bearer, never echoed). The arr-write-import-guard test is extended so
  `@hnet/libretto/write` may be imported ONLY by packages/domain + packages/libretto. NEVER called
  from the browser — every call goes through a tRPC procedure.
- **C-02 — the PROVEN live API surface (DESIGN-037 D-10, verified this session).** Read:
  `GET /api/recipes[/:id]` (`{recipes, issues}` — invalid recipe FILES surface in `issues[]`),
  `GET /api/collections`, `GET /api/runs/:id` (last 50 only — losable, the targets are the truth),
  `POST /api/validate`. Write: `PUT /api/recipes/:id` (idempotent, strictObject → 400 with per-path
  issues on an unknown key), `DELETE /api/recipes/:id` (does NOT cascade — orphans the target
  collection), `POST /api/apply {scope}` → 202 `{runId}` (async, serialized). Builders v1:
  `static_ids`, `hardcover_series`, `nyt_list`, `wikidata_award`. `variables.acquisitionEnabled` is
  the content-pulling knob (default false).
- **C-03 — `role_collection_action_grants` (the ADR-062 idiom, migration 0059).** Actions
  `suggest` (propose a collection — the member contribution), `manage` (create/edit/delete recipes,
  apply runs), `acquire` (flip `acquisitionEnabled` — THE dangerous one, it pulls content). A ROW is
  the grant; an `is_admin` role stores NO rows and implies every action. Ships with NO rows ⇒
  Admin-only. Written ONLY by the `@hnet/domain` `setRoleCollectionActions` single-writer, which
  co-writes an `update_collection_actions` `permission_audit` row in the SAME tx (hard rule 6). The
  writer joins the no-direct-state-writes guard list.
- **C-04 — `acquire` is a distinct grant, gated a second time at the call.** `manage` lets a role
  create/edit/apply/delete; it does NOT let it enable acquisition. Enabling `acquisitionEnabled`
  requires `acquire` AND is confirmed through an explanatory `Modal` ("This will make the estate
  acquire the list's missing books"). A `manage`-only editor sees the toggle disabled with an honest
  "needs the acquire grant" note; the server re-checks (a `manage`-only caller who forges the flag
  gets FORBIDDEN). Defaults: admin everything; every other role NO rows.
- **C-05 — `collection_suggestions` (migration 0059), the propose→approve flow.** A `suggest`-granted
  member files `{ suggester, provider, name, builder_type, builder_ref, target_library?, note? }` →
  status `pending`; it applies nothing. `createCollectionSuggestion` co-writes a
  `create_collection_suggestion` audit row same-tx. A `manage` admin `approveCollectionSuggestion`
  (materialize the recipe via the confined `upsertRecipe` — acquisition OFF unless the approver also
  holds `acquire` and opts in) or `declineCollectionSuggestion` with a reason; both co-write a
  `review_collection_suggestion` audit row same-tx and stamp `reviewed_by/at`. Suggestions are the
  ONLY place the app persists a collection intent; the recipe itself lives in Libretto once approved.
- **C-06 — provider-shaped (R2).** `collection_suggestions.provider` + every wire type carries a
  `provider` discriminator, CHECK-constrained to `COLLECTION_PROVIDERS` (`['libretto']` now). The
  Kometa leg adds `'kometa'` to the enum + a second read/write adapter behind the SAME router — no
  schema change to the grants or suggestions tables. V1 is Libretto-only; the Kometa side is NOT
  built here.
- **C-07 — ref PREVIEW via validate (DESIGN-037 has no resolve endpoint).** The composer resolves a
  builder ref by POSTing a draft recipe to `POST /api/validate` before save and surfacing the
  resolved name + issues honestly (a 0-match container-series slug is the silent failure the plan
  notes call out — the preview makes it visible). No fabricated resolution; if validate can't resolve
  it, the UI says so.
- **C-08 — delete does not cascade — surface it.** `deleteRecipe` orphans the target collection
  (marker present, no recipe). The manager's delete uses `ConfirmButton` and explicitly warns the
  collection stays in the library unless the caller opts into `?deleteCollection=true`. The mirror
  keeps showing an orphaned collection until it is cleaned up (honest).
- **C-09 — live read, degrade honestly.** The manager reads Libretto live (no mirror; Libretto is
  stateless). A Libretto outage yields an `unreachable` health state in the manager (one card, no
  crash); the ADR-066 books-collections walls are unaffected (they read the Kavita/ABS mirror).
  Run history shows the last-50 caveat honestly.
- **C-10 — placement.** The manager is a Collections SUB-SECTION of the Integrations hub
  (`/integrations/collections`, the ADR-057/DESIGN-029 hub-card → pushed sub-section idiom), gated
  by the `integrations` section (visibility) AND the collection action grants (capability). The
  member contribution affordance rides the existing Books/Audiobooks collections walls (ADR-066) as
  a small trailing card AFTER the collections grid — no reflow (ADR-015).

### Consequences

| ID | Consequence |
|----|-------------|
| C-a | Good: the content-pulling surface is confined exactly like the *arr/LL writes — no browser path, one domain boundary, lint-enforced (arr-write-import-guard extended). |
| C-b | Good: the risk is graduated by role the way the owner asked — propose / manage / acquire are three separate grants, acquire double-checked at the call. |
| C-c | Good: ships Admin-only (no grant rows) — the owner opens each action per role after review, the books-Fix precedent. |
| C-d | Good: provider-shaped — the Kometa leg is a data + adapter addition, no migration (R2 satisfied structurally). |
| C-e | Good: mirror-only doctrine intact — no local recipe/collection duplication; Libretto's API is the read model, the ADR-066 mirror keeps rendering the walls. |
| C-f | Bad/accepted: reads are live per view (a Libretto call per manager load) — bounded by the small working set + honest unreachable degrade; acceptable (a management surface, not a hot wall). |
| C-g | Bad/accepted: run history is the last-50 Libretto keeps (DESIGN-037 D-03) — surfaced honestly, not deepened here. |
| C-h | Neutral: the only durable local state is the grants + the pending suggestions; an approved suggestion's recipe lives in Libretto, a declined one is a closed audit trail. |

## More information

- PLAN-052 (`.agents/plans/052-collection-manager-integration.md`) — the owner directive + the
  proven live-contract notes this ADR binds against.
- DESIGN-037 (`docs/designs/037-libretto-architecture.md`) — Libretto's shape + the provider-parity
  API contract (D-10) + Appendix A (the hnet binding sequence).
- DESIGN-042 (`docs/designs/042-collection-manager.md`) — the UI + the confined-client + suggestion
  flow this ADR realizes.
- ADR-066 / DESIGN-038 — the books-collections mirror (unchanged; the walls the contribution
  affordance rides on).
- PRD R-225..R-227 (authored with DESIGN-042). Glossary T-200..T-202. The guard idiom:
  `packages/domain/__tests__/arr-write-import-guard.test.ts` (extended) +
  `packages/domain/__tests__/no-direct-state-writes.test.ts` (extended for the two new tables).
