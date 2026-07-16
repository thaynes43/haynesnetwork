# ADR-063: In-app About/Help page as a static, ungated content route

- **Status:** Accepted
- **Date:** 2026-07-16
- **Deciders:** Tom Haynes (intent brief 2026-07-15 night), Fable 5

## Context and problem statement

The site has grown a large member-facing surface (three Plex servers, Fix/Force Search,
Activity, Trash batches, Tickets, Goodreads integration, Kavita/ABS reading and listening
apps) with no self-serve documentation. Household members learn by text message. The owner
wants an "About haynesnetwork.com" page: reachable from the top of the dashboard, mobile-first,
sectioned behind collapsed headers, written in his tone, and accurate enough to hand to a new
member. Where should this content live and how should it be served?

## Decision drivers

- Members are already authenticated here — help must meet them inside the SSO context.
- Content references live app routes (My Plex, Library detail, Trash, Integrations) and
  should deep-link them.
- The repo is docs-first; behavior and its documentation already travel in the same PR.
- No appetite for new write surfaces, migrations, or admin editors for v1.
- Phone-first consumption ("easy for people only to read the section they need").

## Considered options

1. **In-app static content route** — a `/about` page of TSX content components, collapsible
   sections, tokens-only styling, entry card on the dashboard.
2. **External docs** (GitHub wiki/README link) — zero app code.
3. **DB-backed editable content** (MOTD-style admin editor).
4. **Role-dynamic help** — sections filtered by the caller's grants.

## Decision outcome

Chosen option: **1 — in-app static content route**, because it keeps help inside the
authenticated experience with working deep links and the site's own theming, and content
updates ride the same PR flow as the features they describe. Option 2 breaks tone, theming,
and SSO context (and members won't find it). Option 3 adds a write surface and editor UX for
content that changes exactly when code changes anyway. Option 4 is real but premature — the
page deliberately documents only surfaces every member holds; it is **ungated beyond
authentication** (no section-permission row), and gating can be layered later without
restructuring (consequence C-04).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: help deep-links live routes (My Plex, `/trash`, `/integrations/goodreads`) and inherits `data-theme` tokens, light/dark for free. |
| C-02 | Good: no migration, no write surface, no new permission machinery — a pure UI release. |
| C-03 | Bad/risk: content can drift from behavior. Mitigation: `/about` is docs — a PR that changes a member-visible flow described there updates the page in the same change (PROCESS.md docs-first rule applies to this page like any doc). |
| C-04 | Neutral: page is visible to ALL authenticated members and only documents universally-granted surfaces; per-role sections (e.g. Immich) are explicitly deferred and would arrive as a server-resolved filter, not a rewrite. |
| C-05 | Neutral: collapsed-header expansion is an in-place expansion — the sanctioned ADR-015 exception (deliberate, user-initiated, no neighbor re-orientation outside the expanded region). |
| C-06 | Neutral: factual claims embedded in copy (play totals, external app steps) are snapshots labeled as such; they update by PR, not by live query (owner Q-03 default — a live stats endpoint is a possible later ADR). |

## More information

PLAN-049 (execution), DESIGN-034 (dashboard entry card + perforation + accordion visuals),
PRD 001 (R-NN additions ride the same PR). Owner brief 2026-07-15 night; open questions
Q-01..Q-05 tracked in PLAN-049.
