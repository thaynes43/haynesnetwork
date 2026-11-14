# ADR-121: A Trash-deleted title returns through Seerr or an admin Restore

- **Status:** Proposed
- **Date:** 2026-11-14
- **Deciders:** the owner, ruling recorded on story 818 comment 8041 (2026-11-13T17:57Z); implementation proposed for story 843
- **Supersedes:** ADR-023 C-03 only for the grantable `restore_deleted` action; ADR-022 only for bulk eligibility of Trash-deleted titles. The Accepted records remain unchanged.

## Context and problem statement

Trash Restore, Ledger Add & search and the failsafe diff can re-add a deliberately deleted title. A requester must still be able to request it in Seerr. The owner requires admin-only Restore and no re-grab of a previously grabbed release. ADR-117 governs verified posted names; ADR-118 already protects requests.

## Decision drivers

Preserve the deliberate admin act, the Release Block, every existing guardian and Seerr's automation-only Title Exclusion exception. Permission mutations use the domain single writer with an audit in the same transaction.

## Considered options

- Keep grantable Restore and the Age Guard alone.
- Block Seerr requests as well.
- Reserve Restore for Admin, retain a durable app keep and exclude Trash history from bulk recovery.

## Decision outcome

Chosen option: **admin Restore with a durable keep, bulk exclusion, and unchanged Seerr**.

### Consequences

| ID   | Consequence                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | `restore_deleted` is reserved for Admin. Stored non-admin grants are revoked through `setRoleTrashActions`, with their audit in the same transaction. Server gates reject stale sessions independently of cleanup. The role editor cannot grant it.                                                                                               |
| C-02 | The Restore Keep is recorded against the restore-run intent after successful pre-checks, immediately before the external add attempt. It has no age limit and ends only through an audited admin removal. A known pre-check refusal creates no keep; failed or uncertain add attempts conservatively retain it; retrying never clears it. It writes no *arr tag or Maintainerr exclusion.                                                                 |
| C-03 | Every guardian reads this keep: the wall, batch construction, sweep, Expedite and Expire now. Existing keeps retain precedence.                                                                                                                                                                                                                   |
| C-04 | Both bulk routes skip any title with a Deleted-Release Record (any state), a `trash_expedited` event or a deleted batch item. Stable external identity catches a record attached to another ledger row. Preview and execution report counts and titles. Ordinary disaster tombstones remain eligible.                                             |
| C-05 | Before admin Restore adds a Trash-deleted title, a read verifies the managed Release Block and all its currently live terms for that title. Missing/drifted protection refuses the add. Restore never reconciles, expires, removes or edits a term. Searches remain off: the monitored add can subsequently receive RSS, subject to that profile. |
| C-06 | The Title Exclusion is retained, as on main: no exclusion deletion exists. It continues to block automation while Seerr and explicit admin Restore can add. Seerr's path and Request Keep are unchanged.                                                                                                                                          |
| C-07 | Installed and accepted evidence belong to the coordinator. This PR supplies source and local/CI evidence; the independent adversarial review is a merge prerequisite.                                                                                                                                                                             |

## More information

[DESIGN-052 D-32](../designs/052-watchlist-protection-and-release-block.md#d-32--trash-return-routes-adr-121-story-843), [permission matrix](../designs/010-trash-and-maintainerr.md#d-03--permission-matrix-adr-023-c-03), ADR-097, ADR-117, ADR-118. Evidence and executable work plan: `.agents/context/2026-11-14-story-843.md`.
