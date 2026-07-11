# PLAN-030: Season posters in season rows + episode-thumbnail parity for TV

- **Status:** Queued (owner 2026-07-11) — **dispatch AFTER PLAN-028 merges** (hard data
  dependency below), before PLAN-029. Small train.
- **Relates:** PLAN-024 (poster guard — the restored Peloton duration/season art this surfaces),
  PLAN-022 (Peloton/YouTube drill-in, live k8plex reads incl. episode thumbs), PLAN-028 (the
  *arr→Plex ratingKey match that unlocks TV art), ADR-041 (the authed transcode/caching proxy —
  ALL art goes through this seam).

## Owner request (verbatim intent)

1. **Season rows should show the season poster as a small icon** in the Seasons table on show
   detail pages — both TV (e.g. Rick and Morty) and Peloton (where the restored duration posters
   — 5/10/…/120-minutes — would finally be VISIBLE in the app).
2. **Episode-thumbnail inconsistency:** Peloton's expanded seasons already show episode
   thumbnails; TV's expanded seasons show text-only rows. TV should show episode thumbs too.

## Why this waits for PLAN-028 (sequencing rationale)

- **Peloton**: season posters + episode thumbs are already reachable (live k8plex reads) — could
  ship today.
- **TV**: the *arr ledger has NO Plex linkage until PLAN-028's ratingKey match lands. Season
  posters + episode thumbs for TV come cleanest from Plex (exact art users see in Plex apps,
  served via the ADR-041 proxy, zero new external API dependencies). Alternative (TMDB stills via
  the PLAN-004 harvest) would duplicate what Plex gives us post-028. ONE train post-028 does both
  surfaces with one implementation.

## Shape

- Season row: small poster icon (reserved dimensions, ADR-015 reflow-free; fallback = current
  no-icon layout) from Plex season art via the match (TV) / live read (Peloton).
- Expanded season: TV episode rows gain the same thumb treatment Peloton already has (ADR-041
  `still` size class through the proxy).
- Respect PLAN-028's access invariant: art requests are per-library access-gated like everything
  else (the proxy already 401s unauthenticated; ensure the library-gate applies to TV art too).
- Docs: DESIGN amendment(s) only, unless the TV-art path needs an ADR note on the Plex-art
  source decision.

## Open questions (minor, resolvable at dispatch)

- **Q-01:** for TV shows with no Plex match (in *arr but not yet in Plex), season rows simply
  show no icon — confirm no TMDB fallback wanted in v1 (lean: no fallback, keep one source).
- **Q-02:** Specials/Season-0 art often missing — fallback tile or no icon (lean: no icon).
