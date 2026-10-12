# ADR-108: Recommendation eligibility and explained viewing evidence

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Tom Haynes
- **Refines:** ADR-107; supersedes its mandatory regional streaming/rental availability step

## Context and problem statement

The v0.111.0 acceptance test confirmed broad discovery and outside-Plex candidate checks.
An agent nevertheless excluded The Vast of Night (2019) because a commercial provider did
not list it. ADR-107's availability wording reinforced that mistake. The owner's acceptance
feedback clarifies that released media beyond theatrical-only is eligible through his existing
acquisition/request setup; commercial streaming or rental listings are optional convenience.

The same test exposed unclear provenance when a title is recorded watched but has zero direct
completed plays, and empty canonical options when an exact title has a different release year.
Plex state, retained playback summaries and explicit statements can legitimately establish
recorded watched status independently of that direct-event count. They do not establish liking
or complete lifetime history.

## Decision drivers

- Choose for the current request and evidence-backed taste hypotheses without membership or provider bias.
- Explain personal classifications without changing their established semantics.
- Recover title identities without silently relaxing year, kind or identifier checks.
- Keep the eleven tools, voice budgets, read-only boundary and existing acquisition behavior.

## Considered options

- Require commercial streaming/rental listings as a default eligibility gate.
- Add an availability filter or rebuild the cached recommendation scorer.
- Correct shared guidance and add bounded evidence/identity explanations.

## Decision outcome

Chosen option: **correct shared guidance and add bounded explanations**. The owner explicitly
defines eligibility; no new discovery, rating, streaming or acquisition service is needed.

Released movies/shows no longer theatrical-only are eligible regardless of Plex, watchlist or
commercial provider membership. Exclude upcoming and theatrical-only media by default unless
requested. Research release status when it matters and disclose uncertainty; an absent provider
listing does not establish unreleased status. Commercial listings may be reported as optional
convenience but give no default eligibility or ranking advantage. Plex-only requests restrict to
confirmed Plex membership. Rank by the request, personal evidence and dated contextual research;
ratings/popularity alone are not personal judgment. Separate editorial fit, viewing evidence,
membership and any verified acquisition status. Reads never request, download or mark titles.

Add `viewingBasis` to personal evidence, computed from full records before statement clipping.
It explains the selected classification: explicit watched statements, Plex watched state, Plex
episode state, direct completed playback, retained historical completion, partial playback,
Plex resume, recorded playback, explicit not-mine or ambiguous attribution. Completion here is
the source's recorded verdict (including Tautulli's watched threshold), not observed 100% viewing.
Episode evidence is not a whole-show completion claim. `not_mine` overrides personal attribution
while retaining underlying counts/progress; no recorded viewing has an empty basis.

For exact-name year mismatches, return up to five canonical identity-only alternatives while
remaining unresolved with no personal evidence. Require the same normalized name, requested
kind and consistency with every supplied identifier. Never choose a different year automatically,
use fuzzy alternatives, leak household evidence or add lookups/retries beyond existing bounds.
Cached similarity hints name their recorded source neutrally without asserting personal affinity.

### Consequences

| ID   | Consequence                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| C-01 | Good: strong editorial candidates are not rejected because a commercial provider or Plex lacks them.                     |
| C-02 | Good: recorded watched status is explainable even when the direct completed-play count is zero.                          |
| C-03 | Good: year corrections are inspectable and preserve strict identity/account boundaries.                                  |
| C-04 | Limit: release research and suitability remain agent work; incomplete records and acquisition uncertainty stay explicit. |

## More information

PRD-001 R-242/R-244/R-245/R-261; ADR-107; DESIGN-054 D-04..D-07; PLAN-076.
