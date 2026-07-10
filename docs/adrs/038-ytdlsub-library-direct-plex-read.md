# ADR-038: ytdl-sub Library content — direct read-only Plex reads (no ledger sync), section-gated, Plex-thumb proxy

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (PLAN-022 build run)
- **Relates:** [ADR-017](017-plex-library-self-service.md) / [DESIGN-007](../designs/007-plex-library-self-service.md)
  (the `@hnet/plex` read client + registry this extends), [OPS-002](../ops/002-plex-topology.md)
  (the k8plex/HAYNESKUBE server of record + its `HOps Peloton` / `HOps YT` / `HOps Music` libraries),
  [ADR-019](019-poster-proxy.md) (the authed poster **proxy** pattern this extends to Plex thumbs),
  [ADR-021](021-section-level-role-permissions.md) / [DESIGN-009](../designs/009-ledger-section.md)
  (the Section-Permission visibility mechanism this reuses), [ADR-037](037-metrics-section-access-and-prometheus-read-path.md)
  (the `disabled`-default ship-Admin-only rollout precedent + the `?tab=` sub-tab shell). Realized by
  [DESIGN-017](../designs/017-ytdlsub-library.md). Implements PRD **R-121..R-124**; glossary **T-110..T-112**.

## Context and problem statement

The owner's estate serves three Plex servers (OPS-002). The **k8plex / HAYNESKUBE** server holds
**non-standard content that has no \*arr**: exercise videos (**`HOps Peloton`**), a YouTube-dl archive
(**`HOps YT`**), and music (**`HOps Music`**, already surfaced as a shareable registry library). The app
shows the music library today but never lets a user **browse** the Peloton or YouTube content. The owner
wants both **surfaced as first-class Library content** — a poster grid under the existing **Library**
section — but reviewed by screenshot before any member sees it (`distinct visual identity` /
`screenshot-approval` discipline).

Two facts shape the decision:

1. **This content has no \*arr.** CLAUDE.md hard-rule 4 ("the \*arrs are the source of truth for media
   lists; the ledger is a synced copy") is scoped to \*arr-managed content. Peloton/YouTube are produced
   by `ytdl-sub` (via `peloton-config-manager` / the ytdl-sub-config-manager) and land directly on the
   Plex server — **Plex is the only source of record for them**. There is nothing to sync from, no Fix
   flow, and no failsafe restore. The owner ruled (2026-07-10) that the app should **read the Plex server
   directly**, not fabricate a ledger sync for content the ledger can't own.
2. **Both are "TV Show by Date" libraries** (Plex `type: show`): Peloton "shows" are class types whose
   **seasons encode duration** (e.g. *Bike Bootcamp (30 min)* → season 30); YouTube "shows" are channels
   grouped by genre. The existing `@hnet/plex` `PlexReadClient` already reaches this server and reads
   `/library/sections`, but has **no section-contents read** (`/library/sections/{key}/all`).

The questions to settle before code: **where the data comes from**, **who sees it at ship**, and **how
posters render without leaking the Plex token**.

## Decision drivers

- **Owner ruling is normative** — read Plex directly; do **not** sync this into `media_items`/ledger.
- **Ship-safe rollout** — deliver **Admin-only at deploy**; the owner opens it per role after a morning
  390px + desktop screenshot review (the ADR-037 rollout, reused verbatim).
- **Reuse the Library look, add no visual language** — poster grids, the `@hnet/ui` filter engine, the
  `.library-tabs` sub-tab grammar, the `MediaPoster` fallback tile. No new hex (hard rule 2).
- **Read-only, no new attack surface** — no write to Plex or ytdl-sub; the Plex owner token never reaches
  the browser (the ADR-019 privacy posture); the poster proxy must not become an open image proxy.
- **Don't over-build** — the owner keeps **losing posters** for the time-based "show" series and has
  replacements on hand, but the durable-poster **sink is unknown until he answers Q-01**. Build resilient
  *display* now (proxy + graceful fallback); defer the durable *store*.

## Considered options

### Read model — where Peloton/YouTube content comes from

1. **Read the k8plex Plex server directly via `@hnet/plex` read clients** (chosen). Add a
   `listSectionContents(sectionKey)` read to `PlexReadClient` (`GET /library/sections/{key}/all`, JSON,
   zod-validated — the existing `listSections` pattern). The tRPC layer resolves the two section keys by
   **library title** (`/peloton/i`, `/(youtube|yt)/i`) via `listSections`, so no server-specific id is
   hardcoded, and maps the shows into poster-grid rows. **No new table, no ledger row, no sync job.**
2. **Sync Peloton/YouTube into `media_items`/ledger** like the \*arr content. Rejected: the ledger's
   identity, attribution, Fix, tombstone, and restore machinery all assume an \*arr of record; this content
   has none. A sync would invent a fake source, duplicate Plex as a second store, and violate the spirit of
   hard-rule 4 (the ledger mirrors the \*arrs — not "anything on a Plex server"). The owner explicitly
   ruled this out.
3. **A dedicated ytdl-sub sidecar/service** the app queries. Rejected — Plex already indexes this content
   with posters and hierarchy; a second index is pure duplication (ytdl-sub-config-manager cleanup is a
   deliberate Phase-2 non-goal, PRD Q-06 / plan Q-02).

### Visibility — how "Admin-only at deploy, then per-role" is achieved

4. **A new `ytdlsub` Section-Permission id with a `disabled` no-row default** (chosen). Library itself is a
   universal, ungated top-level nav item (there is no `library` section id) — so the ytdl-sub **sub-tabs**
   get their own section-permission key. `SECTION_IDS += 'ytdlsub'`, `SECTION_DEFAULT_LEVELS.ytdlsub =
   'disabled'`. At deploy no role has a `ytdlsub` row ⇒ only Admin (who implies `edit`) sees the tabs; the
   owner opens the Default (or any) role to `read_only` in the existing role editor after his review — one
   audited, reversible action. This is the exact ADR-037 C-02 mechanism.
5. **A hardcoded admin-only flag.** Rejected — the owner wants to **flip visibility per role himself**
   after the screenshot review, without a redeploy. The section mechanism gives that (audited) for free.
6. **Reuse the ADR-017 per-role Plex *library grants*** (which libraries a role may share to their Plex
   account). Rejected — that axis governs *self-service sharing*, not *in-app browse visibility*; the two
   are orthogonal (a role could browse the grid without being able to add the library to its Plex).

### Posters — rendering Plex art without leaking the token

7. **Extend the ADR-019 authed-proxy pattern to a Plex-thumb route** (chosen). The existing
   `/api/posters/[mediaItemId]` route is keyed on a `media_items` UUID and streams from the \*arrs/TMDB — it
   **cannot** serve Plex thumbs (this content has no `media_items` row). A sibling **`/api/ytdlsub/poster`**
   route streams `{hayneskube.baseUrl}{thumb}` with the `X-Plex-Token` in a server-side header, is
   **session-gated AND `ytdlsub`-section-gated**, and validates the `thumb` is a Plex-metadata path
   (`^/library/…`, no scheme, no `..`) restricted to the k8plex server — so it is not an open image proxy.
   A miss → **404 → `MediaPoster` KindIcon fallback tile** (ADR-019 C-03). No image storage.
8. **Hot-link Plex thumbs from the browser** (token in the URL). Rejected — leaks the owner token
   (CLAUDE.md privacy intent, ADR-019 driver).
9. **Store/cache the posters in a PVC or `bytea`.** Rejected for the same reasons as ADR-019 (storage +
   backup + eviction weight for a cache Plex already maintains).

### Durable posters (the owner's lost-poster pain) — build now or defer

10. **Ship resilient display now; defer the durable store** (chosen). The proxy + graceful fallback means a
    wiped Plex poster degrades to a clean fallback tile, never a broken grid. The durable *sink* (a git
    repo, a PVC, or a Kometa-style overlay re-applied after each ytdl-sub write; and whether the app serves
    the durable file or Plex re-reads it) **depends on where the replacement files live** — unknown until
    the owner answers **PRD Q-06 / plan Q-01**. Building a poster-override store tonight would guess the
    sink and likely need a migration for an override-pin table; premature.
11. **Build a poster-override table + admin upload tonight.** Rejected — guesses the durable home before the
    owner answers; a DB override table is the heaviest of the candidate sinks and the plan prefers a
    non-DB store. Deferred to a Phase-2 follow-up once Q-06 is answered.

## Decision outcome

Chosen options **1 + 4 + 7 + 10**: read the k8plex Plex libraries **directly, read-only** via a new
`@hnet/plex` `listSectionContents` read (no ledger sync); gate the new Library sub-tabs with a new
**`ytdlsub` Section-Permission** defaulting to `disabled` (Admin-only at ship, owner flips per role);
render posters through a new **session- + section-gated Plex-thumb proxy** that extends the ADR-019
pattern, with a graceful fallback tile; and **defer the durable-poster store** to a Q-06 follow-up while
shipping resilient display now.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **No sync, no ledger, no new content table.** Peloton/YouTube are read live from k8plex on each request; they never enter `media_items`/`media_metadata`/`ledger_events`. The `no-direct-state-writes` guard is untouched (no new state table). The `@hnet/sync` jobs and \*arr write-back are unaffected. |
| C-02 | **`@hnet/plex` gains a read-only `listSectionContents(sectionKey)`** on `PlexReadClient` (`GET {baseUrl}/library/sections/{key}/all`, `Accept: application/json`, zod-validated by a new `sectionContentsSchema`; token stays in the `X-Plex-Token` header). It is a READ — it lands in `read.ts` (`@hnet/plex/read`), needs **no `/write` surface and no import-confinement** (the arr/plex-write import guard is unaffected). |
| C-03 | **Section keys are resolved by library TITLE, not a hardcoded id** (OPS-002 identity discipline). The router calls `listSections()` and matches `/peloton/i` / `/(youtube\|yt)/i` (k8plex titles are `HOps Peloton` / `HOps YT`). A library the server does not report ⇒ that tab renders an **empty-state**, never a crash — the graceful-degrade contingency if k8plex lacks the expected library. |
| C-04 | **Visibility reuses `role_section_permissions`.** `'ytdlsub'` joins `SECTION_IDS` with a **`disabled`** no-row default (`SECTION_DEFAULT_LEVELS.ytdlsub`), so at deploy only Admin sees the sub-tabs (admin implies `edit`). Migration **0032** rebuilds ONLY the `role_section_permissions` section CHECK to admit `'ytdlsub'` (one additive change; no new column, no new table, no new audit action — the flip reuses the existing `setSectionPermission` single-writer + its `update_section_permission` audit row). Session hydration already loops `SECTION_IDS`, so `sectionPermissions.ytdlsub` flows with no extra query. |
| C-05 | **Server-authoritative gating.** The read procedures live behind `ytdlsubProcedure = sectionProcedure('ytdlsub','read_only')`; the `/library` route resolves `effectiveSectionLevel(role,'ytdlsub')` server-side and only renders the Peloton/YouTube tabs when it is not `disabled`. A non-permitted caller gets neither the tabs (UI) nor the data (`FORBIDDEN` from tRPC) — visibility is never client-hidden only (the AC-13 posture). The poster proxy applies the SAME section check. |
| C-06 | **Posters via a new authed Plex-thumb proxy** `apps/web/app/api/ytdlsub/poster/route.ts` (Node runtime, session- + `ytdlsub`-section-gated). It streams `{hayneskube.baseUrl}{thumb}` with the `X-Plex-Token` header server-side, validating `thumb` is a `^/library/…` Plex path (no scheme, no `..`) on the k8plex server only — not an open proxy. `Cache-Control: private, max-age=86400`; any miss → 404 → the `MediaPoster` KindIcon fallback tile (reused verbatim; `kind: 'show'` added to `KindIcon`, currentColor only). No image storage (ADR-019). |
| C-07 | **UI reuses the Library idioms wholesale** — the `.library-tabs` `role="tablist"` grammar, the `.poster-grid`/`.poster-card`/`.poster-box` classes, `MediaPoster`, and the `@hnet/ui` `FilterChip`/`nextSort`/`arrowFor` filter engine (client-side over the fetched shows — the show counts are small, so no keyset/facets server round-trips). No new hex; ADR-015 reserved-space, dim-in-place, no-reflow idioms inherited from the grid CSS. |
| C-08 | **Bounded reads.** `listSectionContents` requests a capped container (`X-Plex-Container-Size`) and the grid is a one-shot load (not a live poll) — filter/sort are client-side. A slow/unreachable k8plex degrades the tab to a muted note, never a hung page. |
| C-09 | **Durable posters are deferred (PRD Q-06 / plan Q-01).** The resilient display ships now; the durable-store sink (repo / PVC / overlay, and serve-vs-reapply) is an owner decision + a Phase-2 follow-up. Recorded so a later reader knows the fallback tile is a *known interim*, not the final answer to the lost-poster pain. |
| C-10 | (Cost/risk) **The grid depends on k8plex being reachable and its libraries keeping recognizable titles.** A rename that defeats the title regex ⇒ the affected tab empties (C-03); a server outage ⇒ a muted note. Both are non-fatal and self-heal when the server/title returns. No second store guards against it (by design — that is the deferred durable-poster work). |

## More information

- **Ship gate / rollout.** Deploy with `ytdlsub` `disabled` for all non-admin roles (Admin-only). After the
  owner's morning 390px + desktop screenshot review he sets the chosen role(s)' `ytdlsub` section to
  `read_only` in the admin role editor. PLAN-022 is **not Complete** until the data path is validated live
  against k8plex; opening it to members is the owner's call (plan Q-03).
- **Owner morning decisions (carried as PRD Q-06 / plan Q-01, Q-03):** where the replacement poster files
  live + the preferred durable home (and serve-vs-reapply); whether Peloton and YouTube are two sub-tabs or
  one; and which role(s) get the section after review.
- **Out of scope (Phase-2, not specced here):** the ytdl-sub-config-manager "Kometa for ytdl-sub" cleanup
  (plan Q-02); any write-back to Plex/ytdl-sub; drill-in beyond the show grid + season/episode counts;
  onboarding new ytdl-sub content types.
- **Why not admin-only forever (like Storage, 013).** Peloton/YouTube are member-*watchable* content, not
  operator tooling — the section is meant to open to members after review, so it carries the member-facing
  section-visibility model rather than a permanent `adminProcedure`.
