# ADR-053: Per-user watch/read-state attribution — the app-user↔account mapping seam, Tautulli per-user re-key, ABS read, Kavita deferred

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Tom Haynes (owner ruling 2026-07-11 — PLAN-029 **R7**: per-user watch/read-state, IN scope now,
  "the big option") · ratified by Fable 5 (PLAN-029 design phase)
- **Relates:** REUSES the [ADR-047](047-library-play-here-access-aware-deep-links.md) / [ADR-024](024-role-scoped-all-libraries.md)
  identity + access surfaces WITHOUT reinventing them — the `resolvePlexIdentity` hook (`plex_user_id` numeric
  claim + `users.plex_email`/`plex_username` overrides, `packages/auth/src/hooks/plex-identity.ts`) and the
  `packages/plex` friend matchers (`findFriendById`/`findFriendByIdentity`) that already map app users to plex.tv
  accounts for library sharing. Re-keys the [DESIGN-008](../designs/008-library-metadata-enrichment.md) **D-03**
  Tautulli harvest (today collapsed to a household SUM/MAX) and reads [ADR-046](046-books-library-ledger-source.md)
  book progress. Mirrors the synced-mirror single-writer + sync-mode shape of [ADR-044](044-ai-usage-metrics-ingestion.md)
  (`ai-usage-sync`). Feeds the watch/read-state FACETS of **ADR-051** (the registry). The **Feed-attribution
  backlog item reuses this mapping seam verbatim** (PLAN-029 R7 note). Realized by **DESIGN-026** (D-07).
  Implements PRD **R-170**; glossary **T-154, T-155**.

## Context and problem statement

The owner ruled (R7) that per-user watch/read-state is IN scope now: per-user **watched / in-progress** facets
on the video walls and per-user **read** facets on the book walls (Plex tracks these independently per Home/
managed user; any "Unplayed / Last Played / In Progress" sort or filter is inherently viewer-scoped). This
requires attributing a household's watch/read activity to the SIGNED-IN app user. The recon established, and this
session's live queries confirmed, the shape of the problem:

1. **The identity map is already solved and in production** — the app already maps an app user to their plex.tv
   account (numeric `plex_user_id` claim, strongest key; email/username claim or admin override; the friend-list
   matchers) for library sharing (ADR-024/047). R7 does not invent identity resolution — it REUSES it.
2. **The video watch signal is a household aggregate that throws away the per-user dimension.** The DESIGN-008
   D-03 metadata harvest collapses Tautulli `get_history` to `media_metadata.play_count` (SUM) / `last_viewed_at`
   (MAX) across all three instances — the per-`user` dimension in each history row is discarded. Live-verified:
   that household signal is also **thin** (play_count non-null on radarr **360/9569**, sonarr **193/1026**,
   lidarr **0**), so per-user slices will be sparser still — a design constraint, not a blocker.
3. **Book progress is per-user at the source but behind disjoint account systems.** ABS (`GET /api/users/{id}`
   → `mediaProgress[]`, `isFinished`/`progress`) is **admin/service-token readable for any user** — so with an
   app-user↔ABS-user map, audiobook read-state needs no per-user auth. Kavita progress is per-account with **no
   admin "progress for user X"** in the read surface we use (realistically needs per-user API keys or an
   OIDC-linked Kavita) — and Kavita/ABS accounts share no id with plex.tv.
4. **No per-user store exists** (live-verified) — the mapping table is genuinely new.

The question: **how do we attribute per-user watch/read-state across three disjoint identity systems (plex.tv,
ABS, Kavita), and how much is honestly feasible now?**

## Decision drivers

- **Owner ruling is normative** (R7, the big option) — per-user facets, now; build the mapping as its own domain
  seam because the Feed-attribution backlog item reuses it verbatim.
- **Reuse the built identity + access model** — do NOT fork `resolvePlexIdentity` or the friend matchers; the
  map is a persistence + per-source-handle layer ON TOP of them.
- **Be honest about feasibility** — video (Tautulli) and ABS are feasible now; Kavita is blocked on identity/
  tokens. R7 must ship what is real and record Kavita as a DEFERRED consequence, not promise it.
- **Do not regress the household signal** — the trash walls + item-detail card depend on the household
  SUM/MAX (`play_count`/`last_viewed_at`/`last_watched_*`). Per-user must be ADDITIVE, never a replacement.
- **Economical** — one mapping table + one per-user watch read-model + a schema field add to the Tautulli subset;
  reuse the `ai-usage-sync` mode shape. No new identity provider, no Kavita per-user token plumbing this plan.

## Considered options

### The mapping (which approach attributes activity to an app user)

- **A — Numeric-id join (strongest; video only).** app user → `resolvePlexIdentity.userId` (plex.tv numeric id)
  → Tautulli history `user_id`. Deterministic for accounts that map to a plex.tv id. *Gap:* our Tautulli zod
  subset pulls `user` (display name) but NOT `user_id` (a one-field add); local/guest plays have no id; video
  only.
- **B — Username/email fuzzy join (fallback; video).** Tautulli `user`/`friendly_name` ↔ the friend matchers ↔
  app user. *Gap:* friendly names are admin-editable free text — lower confidence; a secondary matcher only.
- **C — An explicit admin mapping table carrying per-source handles, AUTO-FILLED for video from A/B and
  admin-filled for the book servers** (chosen). One row per app `user_id` with: plex.tv numeric id (auto-filled
  from the OIDC claim / friend match when present), ABS user id, Kavita username. It mirrors the EXISTING
  `users.plex_email`/`plex_username` override pattern (the codebase already chose manual overrides as the
  reliable fallback). *Gap:* manual upkeep for the book handles; a new user is invisible until mapped. **But it
  is the ONLY approach that also joins ABS + Kavita**, and it is the seam the Feed-attribution backlog reuses.

### The video per-user signal

- **Re-key the Tautulli harvest by user, additively** (chosen). Add `user_id` to the Tautulli history subset and
  attribute per-user watched/in-progress alongside the existing household SUM/MAX — a per-user watch read-model
  (or a per-user rollup keyed by `(media_item, app_user)`), NOT a replacement of the household columns the trash
  walls depend on. Alternative — replacing the household aggregate with per-user — rejected (C-04: regresses
  trash).

### Book read-state

- **ABS now via admin token + the map; Kavita DEFERRED** (chosen). ABS admin token reads any user's
  `mediaProgress[]` (join key `books_items.external_id` = ABS libraryItemId) → audiobook read-state with no
  per-user auth. Kavita has no admin per-user progress read → deferred to a future OIDC-linked Kavita or per-user
  tokens. Alternative — block ALL book read-state until Kavita is solved — rejected (needlessly withholds the
  feasible ABS half).

## Decision outcome

Chosen: **C (the explicit mapping table, auto-filled for video, admin-filled for books) + Tautulli per-user
re-key (additive) + ABS admin-read + Kavita deferred.** This is the smallest honest realization of R7 and the
reusable seam the Feed-attribution backlog consumes.

- **The mapping seam** (DESIGN-026 D-07). A new per-user table keyed by app `user_id`, carrying per-source
  handles: plex.tv numeric id (auto-populated from `resolvePlexIdentity`/the friend matchers when resolvable),
  ABS user id, Kavita username (admin-set). It is a domain seam — `@hnet/domain` owns its single-writer and the
  resolution helpers — so the Feed-attribution backlog reuses it without change.
- **Video** — the Tautulli history subset gains `user_id`; the harvest attributes per-user watched/in-progress
  through the map into a per-user watch read-model, ALONGSIDE the untouched household `play_count`/
  `last_viewed_at`/`last_watched_*`. The ADR-051 registry's per-user Watched / In-Progress facets read this;
  when a wall/kind has no per-user data (music today, sparse video), the facet is populated-value-gated off.
- **Books** — ABS read-state via the admin token + the map (join on `external_id`); a per-user Read / In-Progress
  facet on the Audiobooks wall. **Kavita read-state is DEFERRED** (recorded as C-05, not promised): the Books/
  Comics walls ship without per-user read facets until Kavita identity is solved.
- **Reuse, not reinvention** — `resolvePlexIdentity` + the friend matchers stay the identity authority; this ADR
  adds persistence (the map) + attribution (the re-key + ABS read), nothing more. The ADR-047 access gate is
  unaffected (per-user state is a facet on already-gated content).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the app-user↔account map is a reusable DOMAIN SEAM — the Feed-attribution backlog item consumes it verbatim (owner's explicit intent), so R7 pays for itself twice. |
| C-02 | Good: identity is REUSED, not reinvented — the numeric-id claim + friend matchers (in production for sharing) auto-fill the video half; only the book-server handles need admin entry (the existing `users.plex_email`/`plex_username` override pattern). |
| C-03 | Good: additive — per-user watch state sits ALONGSIDE the household SUM/MAX; the trash walls, guardian keep, and item-detail "last watched" (DESIGN-010 D-12) are untouched (C-04 rejected the replacement option). |
| C-04 | Cost/accepted: **coverage is thin.** Live-verified household watch is sparse (radarr 3.8%, sonarr 18.8%, music 0%); per-user slices are sparser, and non-mapped/guest plays attribute to nobody. The per-user facets are populated-value-gated so a wall with no per-user data shows no dead facet — honest, not broken. |
| C-05 | Bad/DEFERRED (recorded, not promised): **Kavita per-user read-state is out of scope** — Kavita exposes no admin per-user progress read; it needs per-user API keys or an OIDC-linked Kavita (a bigger, cleaner future play). Books/Comics ship without read facets; ABS audiobooks get them. This is a known gap, surfaced here so it is not mistaken for an oversight. |
| C-06 | Cost: new surfaces — the mapping table + a per-user watch read-model (migrations next-free at build), a one-field Tautulli subset add (`user_id`), an ABS `GET /api/users/{id}` read in a bounded sync mode (the `ai-usage-sync` shape). Guard-listed writes, single-writer-confined. No new identity provider. |
| C-07 | Neutral/security: per-user state is a FACET on content the ADR-047 gate already filtered — a user still only ever sees items in libraries their role grants; the map never widens access, it only attributes activity. Handle entry is admin-only. |

## More information

- Realized by **DESIGN-026 D-07** (the mapping table + resolution, the Tautulli re-key, the ABS read, the
  per-user facets, and the Kavita-deferred note).
- Reuse points (unchanged): `resolvePlexIdentity`/`plexIdentityFromIdToken` (`@hnet/auth`), `findFriendById`/
  `findFriendByIdentity` (`@hnet/plex`), the DESIGN-008 D-03 Tautulli client/harvest, ADR-046 `@hnet/books`.
- Numbering: **ADR-053**; the mapping + per-user watch tables and the Tautulli-subset change take next-free
  migration numbers at build (see ADR-051 numbering note).
- Deferred (tracked, not scoped here): Kavita per-user read-state (needs identity unification); a per-user rating
  dimension (`userRating` — not harvested; out of R7).
