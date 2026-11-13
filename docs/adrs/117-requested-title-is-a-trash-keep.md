# ADR-117: A title tagged `mediarequests` is a Trash keep

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** the owner (ruling of 2026-11-13, recorded on story 818 comment 8041 and story 844)

## Context and problem statement

On 2026-07-09 the owner ruled that Maintainerr's rules decide what is promoted and the app decides how much is deleted and when. [ADR-025](025-trash-curation-pipeline.md)'s errata of that date removed the requester keep from `classifyGuardian`. A personal requester tag stayed informational. [ADR-093](093-watchlists-protect-trash-and-fresh-rerequests.md) C-03 restates that, and C-11 says a Seerr add is tagged `mediarequests`, which keeps the title out of the Trash pools only because each Maintainerr rule excludes that tag.

That exclusion is one clause on each rule. The app does not read the tag, and the sweep's audit does not check that the clause is still there. A rule save that dropped the clause would let a requested title into the pool, and the guardian would then delete it. The owner's direction of 2026-11-13 is that a requested title is protected so it cannot be removed. This ADR records that direction for the `mediarequests` tag. It does not restore the retired requester auto-save, and it does not make a personal requester tag (`<n>-name`) a keep.

## Decision drivers

- A requested title must stay, even when Maintainerr's pool contains it.
- The protection is the tag. It lasts while the tag is on the title and ends when the tag is removed. There is no timer.
- A re-requested copy of a Trash-deleted title is tagged `mediarequests` by Seerr's add, except the two paths ADR-093 C-11 already names, and is then kept.
- No keep that already holds a title may be weakened or reordered so that title becomes deletable.
- An Accepted ADR is not edited. This record supersedes the conflicting sentences; ADR-025 and ADR-093 stay as they were accepted.

## Considered options

- **Leave the clause as the only protection.** Rejected: nothing in the app checks it, and the rule description has already drifted from the body.
- **Restore the 2026-07-09-before requester keep** (any personal requester tag, auto-save at batch build). Rejected: the ruling names the requested title, which is the `mediarequests` tag, and the restore routes are a separate story.
- **Keep the tag inside the guardian, and refuse a sweep when either rule has lost the clause.** Chosen.

## Decision outcome

Chosen option: **the tag is a guardian keep, and the audit requires the clause**, because the app then refuses the deletion itself and also refuses to run when the Maintainerr clause that should have kept the title out of the pool is gone.

### Consequences

| ID   | Consequence                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | **Supersedes, for this tag only, the 2026-07-09 errata of ADR-025 and the "requesters stay informational" sentence of ADR-093 C-03.** `classifyGuardian` keeps a title whose ledger tags include `mediarequests` (reason `media_request`). A personal requester tag stays informational and is not a keep. The retired auto-save is not restored. |
| C-02 | **Order.** The new keep sits after Save, the `dnd` tag, a recent watch, the Watchlist Keep and the Age Guard, and before the fail-closed `unevaluable` bucket. Those earlier keeps still win, in the same order, so a title kept today is kept for the same reason.                                                                               |
| C-03 | **Where.** The keep is the guardian's, so the batch build (a targeted batch gives it no slot; an untargeted batch snapshots it and the sweep keeps it), the sweep, Expedite (both scopes) and Expire now all honor it. The client preview mirrors it.                                                                                             |
| C-04 | **How long.** The keep lasts while `media_items.arr_tags` contains `mediarequests`. Removing the tag removes the keep. The app does not remove the tag. The guardian reads the ledger snapshot, the same way it reads `dnd`, so the keep appears on the next media sync after the tag changes.                                                    |
| C-05 | **The audit.** `auditMaintainerr` refuses a sweep, Expedite and Expire now when an armed movie or TV rule group has lost an active "tags do not contain `mediarequests`" clause, the same way it refuses when `listExclusions` or `forceSeerr` is off. A Leaving Soon shell is not a rule pool and is not held to the clause.                     |
| C-06 | **Descriptions.** A rule save the app writes sets the group's description from the clauses it is writing, so the text cannot name a threshold or a protection the body does not have. This ADR does not write to the live Maintainerr.                                                                                                            |

## More information

DESIGN-052 D-29. Glossary T-333. The measured counts and the live clauses are recorded in D-29 (read-only, 2026-11-13).
