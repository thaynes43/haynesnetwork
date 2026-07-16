# PLAN-049: About/Help page — "About haynesnetwork.com"

- **Status:** Completed (v0.62.0, 2026-07-16 — feat #307, release #306, haynes-ops #2068; owner morning review + Q-04/05/06/07 answers pending as fast-follow polish PRs)
- **Owner intent (2026-07-15, condensed from his brief):** a Help/About page reachable from a
  button at the TOP of the logged-in dashboard — styled like the SSO app cards but visually
  distinct ("a little cooler than the links, invert the colors or something") and separated
  from the SSO links by a **perforation line**. The page is mobile-first, organized as a brief
  intro + **collapsed headers that expand in place**, "easy for people only to read the section
  they need, and fun," written in the owner's tone. Take it live overnight for his morning
  review over remote-control — **no guesses or half-baked sections**; unknowns become owner
  questions pushed to his phone.
- **Depends on:** nothing (pure app-repo UI + content; no migration, no new write surface).
- **Docs:** ADR-063 (in-app About/Help content page), DESIGN-034 (dashboard About button +
  perforation + accordion page). PRD R-NN additions ride the same PR.

## Page content (owner's outline, verbatim where it matters)

1. **Intro** — media stack migrated to the cluster; reference
   https://github.com/thaynes43/haynes-ops in an information pane explaining what it is; the
   migration is what made this site possible ("thanks to how easy everything is to integrate
   now").
2. **Plex Servers** (collapsed section)
   - MAIN TAKEAWAY: user-menu circle → **My Plex** → pick which libraries appear at
     https://plex.tv (in-app link to My Plex).
   - **Haynestower** — original server, online September 2023; play totals by Movie/TV/Music
     if obtainable; last software on the NAS, stays as-is until that hardware retires.
   - **k8splex** — smaller-file server: Music, Peloton, YouTube ("things that are not TV and
     Movies").
   - **HOps Plex** — next-gen HNet Plex; hardware-failure tolerant; maintained indefinitely;
     software that used to integrate with Haynestower now integrates here (shared media
     library); k8splex + HOps Plex run on identical servers and can roll onto one if the other
     breaks; collections + poster overlays maintained here now. Concise.
3. **"Fix" broken media & find missing** — Fix (delete + re-grab), Fix→subtitles (subtitle-only
   grab; if that fails, plain Fix), Force Search (on-demand grab of missing media), and
   **Activity** states (Searching / Stuck / Blocked / In Progress — exact mapping from code,
   Agent-verified) with what a user should do about stuck/blocked/stuck-searching.
4. **Still have an issue?** — Tickets (Helpdesk) linked to the right library item; site bugs /
   feature requests → https://github.com/thaynes43/haynesnetwork/issues.
5. **Trash** — rule engine finds low-quality bucket → batched deletion with a save window
   (~7 days); saved (shield) items are excluded from ever being Trash candidates again and
   drop off the Trash page after backend sync; users can dig past the current batch into
   future candidates and save from there.
6. **Request media** — Seerr for TV/Movies; for books see Integrations → Goodreads.
7. **Integrations → Goodreads** — how to get there + link; one public Goodreads URL per user;
   backend fills the library from it; may take time when items aren't found immediately; both
   book AND audiobook are always searched (no need to distinguish).
8. **Consuming media**
   - **Reading ebooks & comics** — Kavita (https://kavita.haynesnetwork.com), quirks, iOS +
     Android reader-app instructions (iOS steps owner-tested before live), comics guidance.
   - **Listening to audiobooks** — https://audiobookshelf.haynesnetwork.com; AudioBooth
     iOS/Android steps: enter server link → OIDC Login → Log in with SSO → Plex account.
   - **Watching Movies & TV** — Plex apps everywhere; disable Discover/"Free" rows; pin
     libraries; Watchlist (linked to Seerr); language auto-select best practices (Opus
     research, owner validates); prefer SRT subtitles; other known gotchas.
   - **Listening to music** — Plexamp suggestion; the music library lives on k8splex (may
     need adding via My Plex).
9. **Deliberately out of scope:** role-gated dynamic content (e.g. Immich for the few) — the
   page is one static experience for all logged-in users; revisit later if wanted.

## Execution shape

1. Exploration wave (Opus ×3, DONE/underway): codebase fact sheet; Plex/Kavita/AudioBooth
   external-docs research; Haynestower play totals via Tautulli/Grafana.
2. Docs-first: ADR-063 + DESIGN-034 + PRD additions.
3. Build: dashboard About card (inverted variant + perforated separator, ADR-015-safe) +
   `/about` route with collapsible sections (in-place expansion is the sanctioned ADR-015
   exception).
4. Content: Fable-written copy in the owner's voice, strictly from the verified fact sheets.
5. Ship: five-green local gate → PR → release train → haynes-ops bump → live validation
   (390px + desktop, dark/light) → owner morning review via remote-control.

## Open questions (owner — answer over remote-control, defaults applied if asleep)

- **Q-01: Audience.** Logged-in users only (dashboard button), or also public pre-login?
  **Default: logged-in only** — the content assumes an authenticated member.
- **Q-02: Trash save-window copy.** Hard-code "7 days" or say "currently 7 days" (read from
  the live batch/settings value)? **Default: "currently 7 days"-style wording** that stays
  true if the knob changes.
- **Q-03: Haynestower play totals.** Static "as of <date>" snapshot (recommended, zero new
  API) vs a live counter (new endpoint + Tautulli dependency)? **Default: static snapshot**,
  refreshable in later releases.
- **Q-04: iOS Kavita reader app.** Research will propose a candidate; instructions stay
  flagged "pending owner test" until you validate on your phone — ship section with web-reader
  guidance + the app steps marked as owner-verified-pending? **Default: yes, flagged.**
- **Q-05: Plex language settings.** Researched setting names ship, owner validates in the
  morning (per your note "I can validate"). Research verdict to validate: Plex has NO
  "prefer original language" option — the recipe is auto-select ON + Preferred audio language
  English + Subtitle Mode "Shown with foreign audio", and a manual per-title track pick
  persists forever (the foreign-film answer).
- **Q-06: Haynestower play totals are NOT obtainable in-cluster** (the only Tautullis watch
  PlexOps/K8plex; Haynestower's history lives on the NAS). Easiest: your NAS Tautulli →
  Libraries page shows total plays per section — text the three numbers and they drop in by
  PR. **Default: ship the Haynestower blurb without numbers**, slot ready.

## Out of scope

- Role-dynamic page content (Immich et al.) — noted for later.
- Live play-total counters (unless Q-03 answered "live").
- Any write surface, migration, or permission change.
