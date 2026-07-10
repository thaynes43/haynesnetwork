# PLAN-022: Surface ytdl-sub content (Peloton + YouTube) in the Library section

- **Status:** Executing (2026-07-10, branch `feat/ytdl-sub-library`). <!-- Draft → Executing → Completed -->
  **IDs consumed (next-free at authoring):** ADR-038, DESIGN-017, migration 0032 (one CHECK rebuild —
  `role_section_permissions` admits `ytdlsub`; no new table/column), PRD R-121..R-124 + Q-06, glossary
  T-110..T-112. New `ytdlsub` Section-Permission (`disabled` default ⇒ ships Admin-only). Poster durable
  store DEFERRED (Q-01 → PRD Q-06); resilient display (proxy + fallback) shipped. Merge gate green; e2e
  data path validated hermetically (admin sees Peloton/YouTube shows, member gated out).
- **Satisfies:** PRD-001 new R-NN block (ytdl-sub libraries as first-class Library content; read
  direct from the Plex server; admin-gated at ship); new ADR-NN (direct-Plex read for
  non-*arr content — the *arrs-are-source rule is N/A here because this content has no *arr; owner
  ruling 2026-07-10); new DESIGN-NN (Library sub-tabs for ytdl-sub). Glossary (ytdl-sub library,
  time-based show, durable poster). Migration only if a poster-override/pin table is added (Part 3
  — prefer a non-DB durable store; ADR decides). **ID reconciliation:** ceilings at authoring —
  ADR-036, DESIGN-015, migration 0030, R-116, T-105, OPS-007. Take next-free at authoring; re-grep
  first — parallel round-2 plans consume numbers tonight.
- **Depends on:** none hard — Library section already exists and this reads Plex directly (no
  ledger). **017 landing first is NOT required** (different section). **But** the Library sub-tab
  nav + section-permission gating overlaps 017's Metrics sub-tab framework — **rebase onto 017's
  sub-tab/nav code after 017 merges** so both sections share one sub-tab primitive rather than
  forking it.
- **TODO source:** owner backlog `haynes-ops/zprompt.md` §"HaynesKube ytdl-sub content as a first
  class citizen" + owner decision 2026-07-10 (read Plex directly, not a sync).

---

## Goal

The app shows music-on-HaynesKube today but not the ytdl-sub libraries. Surface them under
**Library** as new sub-tabs. **Ships admin-gated** so the owner reviews screenshots before any
member sees it, then flips it on per role.

## Recon outcome (verified 2026-07-10)

- Two ytdl-sub libraries, both on the **k8plex** Plex server as **"TV Show by Date"** libraries the
  existing `@hnet/plex` `PlexReadClient` already reaches (same server it reads `/library/sections`
  from today):
  - **Peloton** — NFS `gasha01.haynesnetwork:/hdd-nfs-repl` subPath `data/media/peloton` (→
    `/media/peloton`). "Shows" are class types whose **seasons encode duration** (e.g. *Bike
    Bootcamp (30 min)* → season 30), driven by `peloton-config-manager`.
  - **YouTube** — subPath `data/media/youtube` (→ `/media/youtube`), channels grouped by genre
    (Animation, Cigars, Documentaries, …).
- **OWNER-DECIDED read model:** read the Plex server **directly via `@hnet/plex`** — NOT a
  `media_items`/ledger sync. The "*arrs are source of truth" rule (CLAUDE.md #4) does not apply
  because this content has **no *arr**; Plex IS the source here.

## Build

1. **`@hnet/plex` read extension:** add section-contents reads to `PlexReadClient` (list a library
   section's shows/seasons/episodes via `/library/sections/{key}/all` + children), returning a
   typed shape confined to the package (schemas.ts). Read-only — no write surface, no import
   confinement. Identify the two ytdl-sub sections by Plex library title/key (config or discovery),
   not by hardcoding server-specific ids. Poster/thumb images go through the existing **poster
   proxy (ADR-019)** so no Plex token leaks to the browser.
2. **tRPC:** `library.ytdlsub.list` / `library.ytdlsub.section` (read procedures) behind the
   **admin gate at ship** (see §4). Reuse the shared filter/table engine (PLAN-004 → `@hnet/ui`)
   for the show grid — do not re-port it.
3. **Durable posters (Part 3).** The owner keeps **losing posters for the time-based 'show' series
   under the 'show' library** and has replacements on hand. Design a durable poster store so a
   re-scan/re-download can't wipe them: candidate sinks are (a) a git repo (haynes-ops or
   ytdl-sub-config-manager), (b) a dedicated PVC on gasha01, or (c) a Kometa-style overlay applied
   after ytdl-sub writes. The app either **serves the durable poster in place of Plex's** (override
   map, poster-proxy fronts it) or the durable store is re-applied to Plex out-of-band and the app
   just reads Plex. **Pick the sink in the ADR after the owner answers Q-01** (where the poster
   files currently live + preferred durable home). Prefer a non-DB store (files/overlay) over a
   migration unless an override-pin table is clearly needed.
4. **UI + gating (DESIGN):** new Library sub-tabs (Peloton, YouTube) using the 017-shared sub-tab
   primitive (post-rebase). **Ship admin-only** (a new `library`/ytdl-sub sub-section grant, or an
   admin flag on the sub-tab) so only the owner sees it first; the owner flips visibility per role
   after screenshot review (screenshot-approval memory). Section contents update in place, no reflow
   (ADR-015).

## Verification

- Merge gate (lint, lint:css, typecheck, test, build). Unit tests: the new `@hnet/plex` section-read
  against a Plex stub (add the ytdl-sub library fixtures to `@hnet/test-utils`); the admin gate
  (member payload empty/denied until flipped); poster-override resolution (durable poster wins).
- LIVE on staging + public origin: the two ytdl-sub libraries render real shows/episodes read from
  k8plex; posters resolve (including a durable-override case); a non-admin sees nothing until the
  owner flips the role. Screenshots at 390px + desktop for the owner's morning review.

## Out of scope

- **ytdl-sub-config-manager cleanup ("a Kometa for ytdl-sub")** — the owner flags it needs a lot of
  cleanup/improvement to extend to more content. **Phase-2, do NOT spec here** — captured as
  TODO-questions only (see Q-02).
- Any write-back to Plex or ytdl-sub from the app (read-only surface); the Music library (already
  represented); bringing new ytdl-sub content types online; scheduling/triggering ytdl-sub runs.

## TODO-questions (owner, morning)

- **Q-01 (posters):** Where do the replacement poster files currently live, and where should the
  **durable** home be — a repo (which one), a PVC on gasha01, or a Kometa-style overlay re-applied
  after each ytdl-sub write? Should the app serve the durable poster directly, or just read Plex
  after the store re-applies it?
- **Q-02 (phase 2, not this round):** For the ytdl-sub-config-manager "Kometa" direction — what
  content beyond Peloton/YouTube do you want managed, and what are the top cleanup pain points? (Kept
  as a research note; not specced in this plan.)
- **Q-03:** Sub-tab identity — should Peloton and YouTube be two Library sub-tabs, or one "ytdl-sub"
  sub-tab with an internal switch? And which role(s) get it after your screenshot review?
