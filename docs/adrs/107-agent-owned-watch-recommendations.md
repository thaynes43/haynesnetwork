# ADR-107: Agents own recommendation research and judgment; the MCP supplies personal evidence

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Tom Haynes
- **Supersedes:** ADR-089 for general recommendation ownership, membership boosts and Plex-first presentation; amends ADR-087 / ADR-092 schema and response budgets below. ADR-088 remains normative for history and explicit writes.

## Context and problem statement

The owner wants recommendations suited to his request across titles he can stream or rent. The
current helper searches a limited ledger/watchlist/TMDB cache, boosts watchlist membership and
recent Plex arrival, and gives Plex titles most of each page. Agents mistake this for broad discovery.
Personal viewing records supply context and help avoid repeats. Plays and population ratings do
not establish that the owner liked a title. Membership is descriptive metadata.

## Decision drivers

- Let agents research broadly, investigate current discussion and explain their choices.
- Check externally discovered identities against personal records in a bounded read.
- Distinguish recorded viewing, partial plays, explicit feedback and missing evidence.
- Preserve explicit Plex/watchlist scope, callers, account isolation and audited actions.

## Considered options

1. Expand the scorer into a server-side discovery/recommendation service.
2. Correct cached scope and provide factual context and batch checks.
3. Return all history and the catalog on every call.

## Decision outcome

Chosen option: **2**. The consuming agent owns general discovery, research, ranking and explanation.
The MCP supplies personal evidence, identity resolution, explicit actions and a limited cached helper.

Keep `recommend` and its existing arguments. Add `scope: catalog|plex|watchlist`, defaulting to the
cached catalog. Remove membership boosts, membership-based reasons and Plex-separated pagination.
Descriptions and answers identify coverage. Legacy heuristic ordering supplies candidate hints;
it is not the general recommendation workflow.

Add `viewing_context` for paginated factual viewing/explicit feedback and `check_titles` for up to
ten external candidates in input order. Preserve ambiguity, unavailable lookups and unknown source
coverage. No recorded viewing does not mean never watched. Distinguish `not_mine` household viewing
from `not_interested`. Numeric personal ratings are unavailable; never infer rating or liking.

Both tools are shared by public and hop consumers. Existing tools retain plain text responses.
The new tools return <=1,200-character text plus bounded `structuredContent` (<=64 KiB serialized).
`check_titles` deliberately permits a bounded array of candidate objects, amending the flat-schema
restriction. Eleven tools/list must fit 6,144 bytes; instructions remain <=600 characters. Preserve
the 0.5-second additional Movie Room voice latency target; bound external calls and isolate failures.

General workflow: read context; discover broadly with web/catalog tools; check candidates; verify
regional streaming/rental availability; rank for taste, mood, runtime and audience; explain choices.
Current buzz requires dated, attributable evidence, not a popularity value alone. Agents without
broad discovery state their limited scope. No new availability service or server-side LLM is required.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: agents can check titles outside Plex, watchlists and cached recommendations. |
| C-02 | Good: membership no longer improves scores or presentation allocation. |
| C-03 | Good: explicit viewing/feedback remain separate from taste inference. |
| C-04 | Cost: bounded tool schemas and factual structured responses grow. |
| C-05 | Limit: records cover tracked sources; empty caches and failed lookups retain unknown states. |
| C-06 | Limit: agents use other tools for current discussion and regional availability. |
| C-07 | Good: reads never edit watchlists, mark watched, dismiss, request downloads or purchase. |

## More information

PRD-001 R-242/R-244/R-245/R-261; DESIGN-054; PLAN-075. ADR-091 principal isolation and ADR-092
explicit actions remain in force. Earlier accepted ADRs are preserved as history.
