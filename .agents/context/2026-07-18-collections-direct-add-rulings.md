# 2026-07-18 ~04:40 UTC — OWNER RULINGS: Collections manager is DIRECT-ADD (suggest→approve is DEAD)

Captured live from the owner (remote control, pre-sleep). These SUPERSEDE the suggest→approve model
in DESIGN-042/DESIGN-043/ADR-069 — docs must be revised before build (docs-first).

## The rulings (verbatim intent)

1. **Placement — UPDATED (owner, minutes later):** Collection management is a **first-class citizen
   with its own tab/page and sub-sections** — NOT (just) an Integrations hub card. The earlier
   hub-card answer is overridden. Fable (coordinator) owns the IA/UX of the new page; direction:
   top-level `/collections` nav entry, sub-sections for the collection lists per media type +
   Tickets (over-cap requests) + admin Settings (cap value, grants).
1b. **The shipped in-wall "Suggest a collection" button is REJECTED** — the owner saw it live and
   does not want it. Remove the affordance immediately (`apps/web/app/(app)/library/
   suggest-collection.tsx` + its mount in `books-browser.tsx`); the whole suggest machinery
   (`collection_suggestions` table, suggest grant, manager queue) dies in the PR4 rework.
2. **NO suggest/approve flow.** "It's not suggesting, it's adding, removing and editing collections."
   - **All users** can ADD or EDIT collections directly, up to a **size cap of 25 items — make the 25
     configurable** (PR3's `collection_size_cap` app_setting already is).
   - **Over-cap:** the user files a **ticket right from the collection manager** requesting a larger
     collection. "Make it easy for the admin to just approve the ticket and the collection gets
     added" → the ticket must CARRY the full requested definition; **approve = materialize**.
   - **Admins only:** unbounded-size collections and **delete** collections.
3. **"Find missing" option at collection creation:** links to Kometa + Libretto so missing members
   **force a search when those apps' cron runs see them missing**. **Default users can NOT enable
   it; granted roles can choose find-missing or not.** (Self-serve /admin grant grid, the Books
   actions FLIP idiom — coordinator's call, matches the owner's established pattern.)
4. **Kometa write path for direct adds (movies/TV):** the app **auto-commits + auto-merges**
   within-cap adds to haynes-ops (bot writes the config); only over-cap tickets and find-missing
   need a human. Books/audiobooks go direct through the Libretto API (instant).
5. **Notifications:** no approval flow → nothing to notify. Over-cap requesters "can check their
   ticket" (rare path, no outbox machinery needed for v1).

## Consequences

- ADR-069's propose→approve contribution contract must be **superseded** (new ADR: direct-add +
  cap-ticket-materialize + Kometa auto-merge + find-missing grant). ADRs are immutable — supersede.
- DESIGN-042 (Draft) + DESIGN-043 (Accepted) revised to the direct-add model. `collection_suggestions`
  table is dead — do NOT build it. The ticket (PR3's `collection_override` category) is the only
  escalation, extended to carry the collection definition payload.
- PR3 (cap + override ticket) is the backbone — unchanged, ships as-is.
- Role model: everyone = add/edit ≤ cap · grant `find_missing` (a.k.a. acquire) = enable acquisition
  knob · admin = unbounded + delete + ticket approval.
- Migration ledger: 0067 = PR3 (claimed). **0068 = books wanted-tiles** (if needed). **0069+ = PR4.**
