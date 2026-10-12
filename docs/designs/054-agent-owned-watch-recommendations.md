# DESIGN-054: Personal evidence for agent-owned watch recommendations

- **Status:** Accepted
- **Last updated:** 2026-10-11
- **Satisfies:** PRD-001 R-242/R-244/R-245/R-261; governed by ADR-107, ADR-088 and ADR-091

## Overview

Agents choose using the current request, factual personal context and research. The MCP checks
external candidates and labels cached coverage. No new scoring engine or acquisition workflow.

## Detailed design

### D-01 — Compatible cached scope

Keep `recommend` arguments; add `scope: catalog|plex|watchlist`. Default coverage is the bounded
Plex ledger selection, account watchlist and cached TMDB seed recommendations. Filter before
pagination; keep viewing/dismissal and children's exclusions. Remove watchlist/recent-Plex boosts
and membership reasons; paginate uniformly. Every answer names its limited scope, including empty pages.

### D-02 — Batch checks

`check_titles` takes `titles`, one to ten objects with optional `title`, `year`, `kind` (`movie|show`),
`tmdbId`, `tvdbId`, `imdbId` and `plexGuid`. Require sufficient identity, validate lengths/positive
IDs, and disambiguate movie/TV IDs by kind. Return one result per input: resolved, ambiguous,
unresolved or unavailable identity; canonical identifiers; personal evidence and coverage.
Contradictory IDs never fall through to name matching. Respect named years; duplicate exact matches
are ambiguous. Provider failure does not mean not found.

Load one account snapshot per batch. Match IDs across title states, direct events, active marks,
ledger/watchlist, including marks/events-only identities. Catalog lookup supplies facts only.
Bound calls and isolate failures. Aggregate duplicate states. Expose watched/partial/played/
no-recorded-viewing evidence, current progress, explicit watched statements, dismissal reason,
Plex/watchlist membership, real source timestamps and unavailable personal ratings. Preserve
`not_mine` evidence but exclude that household viewing from personal taste/watched exclusions.
Empty watchlist caches without successful-fetch markers cannot prove absence.

### D-03 — Factual context

`viewing_context` supports optional `kind`, `section: viewing|feedback`, `limit` (1..20) and `offset`
(0..2000). Return bounded IDs, available genres, plays/completion evidence, current progress,
statements and freshness; include marks-only identities and page/coverage metadata. Exclude
`not_mine` from viewing pages and retain it in feedback. No computed taste score or liking inference.
Personal ratings explicitly report unavailable. `recent_history` describes plays truthfully;
single `watch_status` adopts improved read status where compatible. Action resolution is unchanged.

### D-04 — Shared workflow and bounds

Shared instructions/descriptions expose the workflow. New tools have <=1,200-character text plus
structured content <=64 KiB, with page/input caps and clipped optional metadata. Preserve candidate
results and indicate clipping. Other tools keep text. Schemas <=6,144 bytes; instructions <=600.
Maintain bounded lookup cost and the added voice latency target of 0.5 seconds.

Read context, research broadly, check candidates, verify current regional home availability, then
rank/explain for the request. Membership restricts only explicit requests. Current attention needs
dated sources; theatrical release does not prove rental availability. Reads never call mutation or
acquisition writers; existing explicit writes keep their audited owner-aware semantics.

## Alternatives considered

JSON-encoded string batches hide identity validation. Separate voice/agent lists cannot distinguish
Home Assistant from dev-env because both share the hop principal. Web tools provide discovery and
availability without adding a service.

## Test strategy

Cover cross-ID/marks-only/events-only identities, ambiguity/year mismatch/failure/conflicting IDs,
partial plays/unknown sources, mixed order/account isolation, explicit scopes, membership-neutral
score/pagination, no mutations, schemas/bounds and both endpoints. Tests run serially under
`nice -n 19`; no busy loops, stress tools or wide parallel/looped tests in this shared pod.
Complete required CI and verify deployed tools with read-only live results.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| — | No unresolved design questions: the owner request decides recommendation ownership/scope. | Missing evidence and capabilities are reported as limits. |
