# DESIGN-054: Personal evidence for agent-owned watch recommendations

- **Status:** Accepted
- **Last updated:** 2026-10-12
- **Satisfies:** PRD-001 R-242/R-244/R-245/R-261; governed by ADR-107, ADR-108, ADR-088 and ADR-091

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
(0..2000). Omitting `section` combines viewing and explicit feedback. Return bounded IDs, available genres, plays/completion evidence, current progress,
statements and freshness; include marks-only identities and page/coverage metadata. Exclude
`not_mine` from viewing pages and retain it in feedback. No computed taste score or liking inference.
Personal ratings explicitly report unavailable. `recent_history` describes plays truthfully;
single `watch_status` adopts improved read status where compatible. Action resolution is unchanged.

### D-04 — Shared workflow and bounds

Shared instructions/descriptions expose the workflow. New tools have <=1,200-character text plus
structured content <=64 KiB, with page/input caps and clipped optional metadata. Preserve candidate
results and indicate clipping. Other tools keep text. Schemas <=6,144 bytes; instructions <=600.
Maintain bounded lookup cost and the added voice latency target of 0.5 seconds.

Read context, research broadly, check candidates, then rank/explain for the request. Released
movies/shows beyond theatrical-only are eligible through the owner's acquisition setup regardless
of Plex, watchlist or commercial listings. Upcoming/theatrical-only titles need an explicit request.
Research release status where needed and disclose uncertainty; missing provider listings do not
prove unreleased status. Streaming/rental is optional convenience, never a default filter or ranking
boost. Membership restricts only explicit requests; Plex-only needs confirmed membership. Current
attention needs dated sources. Separate editorial fit, viewing evidence, membership and verified
acquisition status. Reads never call mutation/acquisition writers; explicit writes retain semantics.

### D-05 — Classification provenance

Add `viewingBasis`, a bounded fixed-enum list explaining the selected `viewing` classification:
`explicit_watched`, `plex_watched_state`, `plex_episode_state`, `completed_playback`,
`historical_completion`, `partial_playback`, `plex_resume`, `recorded_playback`,
`explicit_not_mine`, `ambiguous_attribution`. Derive it from complete rows/events/marks before
clipping displayed statements. For watched, include each supporting watched source; replay/resume
stays in progress rather than becoming a reason for watched. For partial, include relevant partial
sources; for played use recorded playback. Unknown attribution and not-mine use their own basis,
with not-mine overriding other personal classifications while counts/progress remain factual.
No recorded viewing has an empty basis. A retained movie/episode completion summary can establish
watched despite zero direct completed events. Plex episode flags/counts do not prove a whole show
finished. Completion denotes the source verdict, including the Tautulli watched threshold.
Spoken single-title and batch summaries name the supporting evidence without implying liking.

### D-06 — Canonical year alternatives

At local, catalog-search and post-hydration year mismatch, retain `unresolved/year_mismatch`,
`identity: null` and `evidence: null`. Offer at most five deduplicated identity-only options with the
same normalized exact title, requested kind, a known differing canonical year and consistency
with all supplied identifiers. Contradictory IDs never produce alternatives; missing years,
different kinds and fuzzy names are not suggestions. Strong local identities need no provider
call to establish mismatch. Preserve genuine ambiguity and numeric title literals. No automatic
year substitution or retry; the six-second shared lookup budget and two in-flight calls remain.

### D-07 — Neutral cached reasons

Cached hints describe similarity to titles in viewing records, without claiming the user liked
them or replacing the consuming agent's judgment. Do not alter scorer weights or candidate filters.

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

Also cover zero-direct-event Plex/retained completion, replay plus prior watched evidence, explicit
marks beyond displayed statements, episode versus whole-show evidence, not-mine precedence and
local/catalog/hydrated year recovery. Reject wrong kind/IDs/fuzzy titles/missing years; test option
deduplication/caps and ten maximal results with provenance under the unchanged response budgets.

## Open questions

| ID  | Question                                                                                  | Resolution                                                |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| —   | No unresolved design questions: the owner request decides recommendation ownership/scope. | Missing evidence and capabilities are reported as limits. |
