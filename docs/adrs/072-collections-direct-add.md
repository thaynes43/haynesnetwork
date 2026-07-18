# ADR-072: Collections are direct-add — capped self-serve add/edit, over-cap cap-ticket-materialize, a find-missing grant, and Kometa auto-merge (supersedes ADR-069 + ADR-070)

- **Status:** Accepted <!-- owner rulings 2026-07-18 are binding; docs-first, build follows -->
- **Date:** 2026-07-18
- **Deciders:** Tom Haynes (owner rulings 2026-07-18, captured live pre-sleep —
  `.agents/context/2026-07-18-collections-direct-add-rulings.md`), Fable (coordinator — delegated
  IA/UX authority for the new first-class page).
- **Supersedes:** **ADR-069** (Kometa collection contribution — git-PR managed include with a
  propose→approve suggestion pipeline; Proposed) AND **ADR-070** (Collection-manager integration —
  the confined `@hnet/libretto` write surface with a `suggest`/`manage`/`acquire` grant triad and a
  propose→approve member-contribution flow; Accepted). Both encoded the suggest→approve model the
  owner has now killed, and both placed the manager as a sub-section of the Integrations hub. The
  parts they got right (mirror-only doctrine, the confined write clients, the git-PR managed include,
  the allowlisted-builder + validated-ref discipline, the Libretto live API contract, the shared
  `collection_suggestions`-table-as-provider-shaped idea reborn as the ticket payload) survive here,
  re-pointed at the direct-add model.
- **Relates:** **ADR-064 / DESIGN-035** (mirror-only doctrine — external software ALWAYS owns
  collections; the app writes a RECIPE, never a Plex/library collection; UNCHANGED) · **ADR-050 /
  DESIGN-050** (the helpdesk ticket domain — the over-cap escalation rides its `tickets` aggregate,
  new category `collection_override`) · **ADR-062 / DESIGN-033** (the books-Fix self-serve `/admin`
  role-grant GRID — "the FLIP" idiom this copies for the find-missing grant) · **ADR-023 / ADR-059**
  (the `role_*_action_grants` + `*ActionProcedure` machinery) · **DESIGN-037 / Libretto** (the books
  provider's live API — the direct write target) · **DESIGN-042** (the Kometa provider, revised for
  auto-merge) · **DESIGN-043** (the collection manager, revised to this model + the first-class
  page) · **hard rules 4** (external software is the source of truth; the only write-back is
  explicit) **6** (audit rows in the same transaction) **8/9** (Modal/ConfirmButton; no reflow).

## Context and problem statement

ADR-070 shipped a books collection manager at `/integrations/collections` (v0.70.0, migration 0059)
and ADR-069 designed the Kometa (movies/TV) sibling, both on a **propose→approve** model: a member
files an inert `collection_suggestions` row, an admin reviews a queue and materializes it. The owner
saw the shipped in-wall **"Suggest a collection"** affordance live and **rejected the entire model**
(rulings 2026-07-18, verbatim intent):

> "It's not suggesting, it's **adding, removing and editing** collections."

The suggest→approve pipeline is dead. In its place the owner ruled a **direct-add** model with a
**size cap** as the only friction, an **easy one-click over-cap approval**, a **role-gated
find-missing** acquisition knob, and — for Kometa — **automatic** config writes for the safe
(within-cap) case so members do not wait on a human for ordinary curation. He also ruled the manager
is a **first-class citizen**: its own top-level `/collections` page with sub-sections, not an
Integrations hub card.

The decisions this ADR must make, all superseding ADR-069/ADR-070:

1. **Who can write, and with what friction?** (replaces the `suggest`/`manage`/`acquire` triad)
2. **What happens over the cap?** (replaces the admin suggestion queue)
3. **How is the content-pulling knob gated now?** (replaces `acquire`)
4. **Does a within-cap Kometa write still need a human to merge the haynes-ops PR?** (replaces
   ADR-069 Q-01, which left human-vs-auto merge open)
5. **Where does the manager live?** (replaces ADR-070 C-10 / ADR-069's hub-card placement)

The three doctrines that survive intact: **mirror-only (ADR-064)** — the app still writes a recipe,
never a collection; **confined write clients** — Libretto/Kometa writes still route through
`@hnet/domain` only, never the browser; **audit-in-same-tx (hard rule 6)**.

## Decision drivers

- **Owner rulings 2026-07-18 (binding, verbatim above).** Direct add/edit/remove; a configurable
  size cap; over-cap = a ticket that carries the full definition and materializes on one-click
  approve; find-missing is a role grant, default users cannot enable it; Kometa within-cap writes
  auto-commit + auto-merge; first-class `/collections` page.
- **PR3 is the backbone (ships as-is).** `collection_size_cap` app_setting (migration 0067,
  configurable, default 25), domain `assertWithinCollectionSizeCap`, `collections.requestOverride`
  → an ADR-050 ticket of category `collection_override`. This ADR EXTENDS the ticket to carry the
  collection definition and materialize on approve — it does not re-decide the cap machinery.
- **The blast radius is still storage, but re-located.** Under ADR-069/070 the sharp edge was the
  `acquire` grant. Here, ordinary curation (grouping-only, within cap) is SAFE — a member's 25-item
  collection cannot flood Radarr, because acquisition is a SEPARATE per-collection knob (find
  missing) that default users cannot turn on. So the auto-merge is safe exactly because acquisition
  is decoupled from adding.
- **GitOps doctrine (CLAUDE.md).** Kometa config lives in a git ConfigMap; a write is a haynes-ops
  PR, Flux-applied. The owner ruled the SAFE case may auto-merge (bot-authored, app-owned file,
  allowlisted builders) — the audit trail is the merged PR, not a human review gate.
- **Provider parity (the surviving PLAN-052 R2).** One manager, two write paths: Libretto is a
  direct API (instant); Kometa is a git-PR (auto-merged within-cap). The UI is provider-agnostic;
  the write adapter is the only provider-specific surface.
- **The FLIP idiom (ADR-062 / DESIGN-033).** New role capabilities ship behind a self-serve
  `/admin` role-grant grid the owner opens per role — the proven, forget-proof rollout.

## Considered options

**Who writes / friction model:**
1. **Keep suggest→approve** (ADR-069/070). REJECTED by the owner outright — the affordance he saw is
   the thing being torn out tonight.
2. **Direct add/edit for everyone, capped; over-cap escalates to a ticket** (CHOSEN). The cap is the
   only friction on the safe path; the ticket is the rare escalation.

**Over-cap handling:**
3. An admin suggestion QUEUE (ADR-070 C-05). REJECTED — that is the dead model.
4. **A `collection_override` ticket (ADR-050) that CARRIES the full requested collection definition;
   admin approve = the collection materializes automatically** (CHOSEN). One escalation surface
   (the helpdesk the owner already runs), one-click approve, no new queue to administer.

**Content-pull gating:**
5. The `acquire` grant on the whole manager (ADR-069/070). REJECTED — it gated the wrong thing
   (all editing), and the owner decoupled adding from acquiring.
6. **A per-collection "find missing" knob, enabled only by a granted role, chosen per collection**
   (CHOSEN). Default users add/edit freely but can never enable acquisition; granted roles flip it
   per collection. Ships behind the self-serve `/admin` grant grid (the FLIP idiom).

**Kometa within-cap write merge:**
7. Human merges every haynes-ops config PR (ADR-069's leaning). REJECTED for the safe case — it
   makes ordinary curation wait on a person, which contradicts "adding, not suggesting".
8. **The app auto-commits AND auto-merges within-cap, grouping-only Kometa adds** (bot-authored,
   app-owned managed file, allowlisted builder types); **over-cap tickets and find-missing enables
   still need a human** (CHOSEN). The auto-merge is safe precisely because acquisition is decoupled
   and the file is machine-owned + CI-validated.

**Placement:**
9. A Collections sub-section of the Integrations hub (ADR-070 C-10). REJECTED — the owner ruled it a
   first-class citizen.
10. **A top-level `/collections` page with sub-navigation** (CHOSEN): per-media-type lists (Movies /
    TV / Books / Audiobooks), a **Tickets** sub-section (over-cap requests), and admin **Settings**
    (the cap value + the find-missing grant grid).

## Decision outcome

Chosen: **2 + 4 + 6 + 8 + 10**. Collections become **direct-add**, capped, with an over-cap
cap-ticket-materialize escalation, a per-collection find-missing grant, Kometa auto-merge for the
safe case, on a first-class `/collections` page.

- **Everyone adds/edits directly, capped.** Any authenticated user with the section may create or
  edit a collection up to the `collection_size_cap` (migration 0067; configurable; default 25).
  `assertWithinCollectionSizeCap` enforces it in the domain writer; there is NO per-user grant to
  add/edit within the cap. The write goes straight to the provider: Libretto via its direct API
  (instant); Kometa via an auto-merged haynes-ops PR (below).
- **Admins only: unbounded collections + delete.** An `is_admin` role bypasses the cap and is the
  only role that may DELETE a collection (delete stays a `ConfirmButton`, orphan-warned per the
  surviving ADR-069 C-08 / ADR-070 C-08 semantics).
- **Over-cap → a `collection_override` ticket that materializes on approve.** A within-reach add that
  would exceed the cap opens a ticket (ADR-050, category `collection_override`) FROM the manager,
  carrying the FULL requested collection definition (builder + ref + variables + target + requested
  size) as a payload. The requester sees their ticket state under the `/collections` Tickets
  sub-section. An admin approves with ONE click → the domain materializes the collection unbounded
  (the same confined writer as a direct add, cap-bypassed) and the ticket transitions to complete;
  the materialization + the transition + the audit row commit in ONE transaction (hard rule 6).
  Rejecting the ticket materializes nothing (ADR-050 state machine unchanged otherwise).
- **Find missing is a per-collection knob behind a role grant.** A collection may opt into "find
  missing": Kometa (movies/TV) sets `radarr_add_missing`/`sonarr_add_missing` and Libretto
  (books/audiobooks) sets `acquisitionEnabled`, so the provider force-searches the collection's
  missing members on its cron runs. **Default users CANNOT enable it**; a granted role chooses it per
  collection. It ships behind a self-serve `/admin` role-grant GRID (the DESIGN-033 "Books actions"
  FLIP idiom), a single `find_missing` action in `role_collection_action_grants` (the table survives;
  its action set is rebuilt from `suggest`/`manage`/`acquire` to just `find_missing` — migration
  0069). Admin implies it. Enabling it is still confirmed through an explanatory Modal (the
  surviving "this makes the estate acquire the missing titles" warning).
- **Kometa within-cap adds auto-commit + auto-merge.** The app regenerates the app-owned managed
  include (the surviving Kometa Managed Include, T-197) from the enabled recipes, opens a
  bot-authored haynes-ops PR, and — for a within-cap, grouping-only (find-missing OFF) add — the app
  AUTO-MERGES it after the `--validate-file` CI gate goes green (DESIGN-042 D-10). Flux applies it,
  the next Kometa run produces the collection, `collections-sync` mirrors it back with
  `provenance: kometa` (unchanged). **Two cases still need a human to merge:** an over-cap ticket
  materialization (admin-approved, but the config PR is human-merged) and any find-missing enable
  (the acquisition lever). Books/audiobooks have no PR — Libretto's API is a direct instant write.
- **First-class `/collections` page.** A top-level nav entry pushes to `/collections` with
  sub-navigation: **Movies / TV / Books / Audiobooks** (each the provider-backed collection list
  with health/counts + add/edit), **Tickets** (over-cap requests — users see their own state, admins
  get one-click approve→materialize), and admin **Settings** (the configurable cap + the
  find-missing grant grid, or a link to `/admin` roles). The old `/integrations/collections` manager
  MOVES here (not duplicated); the Integrations hub Collections card is removed. IA detail is
  DESIGN-043 (Fable owns the UX).
- **The suggest machinery is fully torn down.** `collection_suggestions` (table + enum), the suggest
  routers/grants/manager-queue, and the in-wall "Suggest a collection" affordance
  (`apps/web/app/(app)/library/suggest-collection.tsx` + its `books-browser.tsx` mount) are removed.
  Migration 0069 drops the table and rebuilds the grant action CHECK; the teardown spec is DESIGN-043
  D-15 and PLAN-052 PR4a.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: mirror-only (ADR-064) STILL holds — the app writes a Libretto/Kometa recipe, never a Plex/library collection; DESIGN-035/038 remain the only read paths. Direct-add did not weaken the doctrine; the write target is still a recipe. |
| C-02 | Good: the friction is a single cap, not a human approval, so ordinary curation is instant (Libretto) or auto-merged (Kometa within-cap). "Adding, not suggesting" is the lived behavior. |
| C-03 | Good: the storage blast radius is DECOUPLED from adding and re-gated at find-missing. A capped grouping-only collection cannot flood Radarr/LazyLibrarian, which is exactly what makes the Kometa auto-merge safe. The 2023-flood / theatrical-window incident class still cannot originate from a default user. |
| C-04 | Good: one escalation surface — the over-cap ticket rides the helpdesk the owner already runs (ADR-050), carries the definition, and materializes on one click. No second queue, no notification/outbox machinery (rare path; the requester checks their ticket). |
| C-05 | Good: the find-missing grant ships behind the proven self-serve `/admin` FLIP grid (DESIGN-033) — forget-proof, per-role, Admin-only until opened. |
| C-06 | Cost/accepted: the app now AUTO-MERGES haynes-ops config PRs for the safe case, a new automation the GitOps repo previously left to humans. Bounded to ONE app-owned machine-generated file, allowlisted builders, find-missing OFF, behind the `--validate-file` CI gate; the merged PR is the audit trail and a `git revert` is the undo. Over-cap and find-missing writes still human-merge. |
| C-07 | Cost/accepted: the shipped v0.70.0 suggest surface + migration 0059's `collection_suggestions` table are torn out (migration 0069 drops the table, rebuilds the grant action set). The role_collection_action_grants table survives with a new single `find_missing` action; the Libretto confined client + the mirror + the recipe nouns survive. |
| C-08 | Good: provider parity survives (PLAN-052 R2) — one manager, two write adapters (Libretto direct, Kometa auto-merged git-PR); the UI is provider-agnostic and the cap/ticket/find-missing model is identical across all four media types. |
| C-09 | Neutral: ADR-069 (Proposed) and ADR-070 (Accepted) are both superseded here. ADR-070's H1 is mislabeled "ADR-069" in its body (a known two-track collision, glossary changelog 2026-07-17) — left as-is (ADRs are immutable beyond the status line); this ADR's supersession is unambiguous by file number. |

## More information

- Realized by **DESIGN-043** (the collection manager + first-class `/collections` IA, direct-add,
  tickets, settings) and **DESIGN-042** (the Kometa auto-merge write path). Executed by **PLAN-052**
  (PR4a teardown + shell + Libretto direct + tickets; PR4b Kometa auto-merge; PR4c find-missing grant
  + cron force-search).
- Backbone: **PR3** — `collection_size_cap` app_setting (migration 0067), `assertWithinCollectionSizeCap`,
  `collections.requestOverride` → ADR-050 `collection_override` ticket category (ships as-is; this
  ADR extends the ticket to carry the definition + materialize on approve).
- Owner rulings: `.agents/context/2026-07-18-collections-direct-add-rulings.md` (binding).
- Superseded predecessors: **ADR-069** (`docs/adrs/069-kometa-collection-contribution-contract.md`),
  **ADR-070** (`docs/adrs/070-collection-manager-integration.md`).
- Glossary: this change supersedes T-199 / T-200 / T-202 (the suggestion + old grant triad) and adds
  the direct-add terms (Collection Size Cap, Collection Ticket, Find Missing, Kometa Collection
  Auto-Merge, the rebuilt Collection Action Grant). Migration ledger: 0067 = PR3 (claimed), 0068 =
  reserved (books wanted-tiles), 0069+ = PR4.
</content>
</invoke>
