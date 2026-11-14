# ADR-122: Release Block terms never expire or yield room to newer terms

- **Status:** Proposed (story 845; design only, implementation held by DESIGN-052 Q-37)
- **Date:** 2026-11-14
- **Deciders:** the owner, ruling recorded on story 818, comment 8041, 2026-11-13T17:57Z: "We cannot, however, re-grab an index we already grabbed EVER".
- **Supersedes:** ADR-093 C-09 and DESIGN-052 D-13's age expiry and oldest-term pruning, including the earlier "keep 365 days" ruling recorded in commit `b8c1518e`. The Accepted ADR's body is unchanged. Extends ADR-117 C-07's no-prune rule to every reconcile, including upkeep, and supersedes C-09's fixed lifetime for the posted-name backfill. DESIGN-052 D-33 specifies the amendment.

## Context and problem statement

The Release Block must remember a grabbed-and-deleted release permanently. Today the single writer can remove its term after the legacy lifetime or during upkeep to make room. Both violate the newer ruling. A failed delete is different: its abandoned records must still stop contributing terms, because the title was kept.

Measured on 2026-11-14, by read-only replica SQL and an in-pod profile GET per service, Radarr holds **1,151 release terms** and Sonarr **195**, plus a sentinel each. There are **no expired or pruned records** in either service. The cap is **3,000 release terms**, excluding the sentinel (source inspection on the same date). Queries, the full distributions, weekly growth, source citations and the reproducible projection are in the [measurement note](../../.agents/context/2026-11-14-release-block-permanence.md).

The original cap was a driver choice in ADR-093, subsequently retained using an extrapolation from a smaller-profile timing measurement; it was not an upstream acceptance limit measured at capacity. Splitting profiles does not avoid the total matcher work. No safe higher limit follows from the present evidence.

## Decision drivers

- Never forget a grabbed-and-deleted release because of age or capacity.
- Keep a title whose complete terms cannot be written and read back. Keep `release_block_full` visible and counted.
- Preserve the existing single writer, grammar, term identity and delete ordering.
- Separate measured upstream behavior from an unperformed capacity experiment.

## Considered options

1. **Remove expiry and all pruning; retain the current cap and fail closed.** Chosen for the bounded implementation after the design gate.
2. **Several app-owned profiles, each under the current cap.** Recommended capacity successor to investigate under Q-35. It preserves terms but requires ownership, partial-write recovery and read-back across profiles, and still evaluates all terms. It is not included in this implementation.
3. **Shorter terms.** Not selected: an equivalent representation needs proof against the existing grammar and accepted name coverage. Changing which names are recorded is outside this story.
4. **Raise or remove the cap without measurement.** Not selected. Source inspection is not a latency, memory or request-size measurement.
5. **Expire or prune the oldest terms.** Rejected by the owner's ruling.

## Decision outcome

Chosen option: **permanent terms with the existing capacity refusal**. D-33 defines the source changes and tests; Q-37 gates when they may be written. This PR contains the design and evidence, not an installed behavior change.

### Consequences

| ID   | Consequence                                                                                                                                                                                                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | **No age eviction.** A Release Block term contributes for as long as any `active`, `in_flight`, legacy `expired` or legacy `pruned` record carries it. Neither scheduled upkeep nor a delete path transitions a record to `expired` or `pruned`.                                                                                                         |
| C-02 | **Recover historical omissions.** Legacy `expired` and `pruned` states retain their historic meaning and timestamps but contribute desired terms again. The normal writer grammar-checks, writes and reads them back. An overflow refuses before writing; it never clips the desired set.                                                                |
| C-03 | **No capacity eviction.** Retain the existing cap, excluding the sentinel. Every reconcile refuses over capacity, and every delete reserves all of its title's terms beside the complete permanent set before proceeding. A title that cannot fit stays `release_block_full`; nothing older is removed to admit it.                                      |
| C-04 | **Abandoned cleanup survives.** Failed or ineffective deletes still settle to `abandoned`; such a record contributes nothing, while a shared term backed by a protected record remains. An ambiguous delete keeps its in-flight terms until the existing settle decides it.                                                                              |
| C-05 | **Retire the expiry clock.** Preserve old `expires_at` values as historical metadata; make the column nullable and write null for new records. No retention or selection decision depends on it. Remove the seed's expiry origin, age skips in backfill and the upkeep's expiring counts. D-33 specifies how legacy deletion-time evidence is preserved. |
| C-06 | **Capacity remains bounded and visible.** A full profile may stop Trash freeing space. That is an intentional keep, not permission to weaken protection. Q-35 requires an isolated capacity experiment before recommending a new total limit or implementing multiple profiles.                                                                          |
| C-07 | **Other blocks are unchanged.** Q-36 asks whether permanence should apply to the Janitor Release Block and Mislabel Block, with their own semantics and measured totals. This ADR grants neither writer new behavior.                                                                                                                                    |
| C-08 | **Evidence remains separate.** The source, test, installed and accepted states are recorded independently. The coordinator reviews, obtains the required adversarial review and accepts; this worker does not merge or deploy.                                                                                                                           |

## More information

- [DESIGN-052 D-33 and Q-35–Q-37](../designs/052-watchlist-protection-and-release-block.md#d-33--release-block-terms-are-permanent-story-845-adr-122).
- [ADR-093](093-watchlists-protect-trash-and-fresh-rerequests.md), [ADR-117](117-release-block-every-posted-name.md), [ADR-094](094-janitor-manual-match-release-name-block.md), [ADR-110](110-episode-title-evidence-guards-grabs-and-imports.md).
- OpenProject story 845 is the scope and acceptance record; its design-before-code merge requirement takes precedence over the work order's single-PR sequence (Q-37).
