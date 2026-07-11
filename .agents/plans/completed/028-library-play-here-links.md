# PLAN-028: "Play/Read/Listen here" — access-aware deep links from Library to the app that serves it

- **Status:** Completed (2026-07-11) — **v0.40.0 + v0.40.1 live.** ADR-047 / DESIGN-025 / R-157 /
  T-139..T-141 / migration 0038. THE INVARIANT enforced server-side (reusing the ADR-024 resolver) across
  every media_items read + the poster proxy + per-library ytdl-sub; `media_plex_matches` GUID match
  (one row per (item, library)) + hourly `sync-plex-match` CronJob — live match rate radarr 5,445/9,564
  (57%) · sonarr 840/1,026 (82%) · lidarr 4,428/7,208 (61%), 17,071 rows (unmatched = wanted/missing
  items never in Plex, gated by their kind's home libraries, no link — never hidden by match state).
  Owner UX amendment shipped: detail-page-only ↗ buttons, ONE "Watch on Plex — <library>" per accessible
  library (multi-library titles get several, gated independently), new Books/Audiobooks/Comics detail
  pages ("Read in Kavita" / "Listen on Audiobookshelf"). Live invariant proof (hnet-e2e-member on a
  throwaway role deliberately withholding HOps Music, via the app's own audited writers): ZERO items via
  search/text-query/pagination/facets/wanted, 404 on direct-id detail/events/children AND the poster
  proxy (accessible control 200), Music tab ABSENT (390px + desktop screenshots); accessible movie
  showed BOTH library buttons live; everything restored + sessions cleaned after. v0.40.1 fix: Plex
  omits the external Guid array from section listings without `includeGuids=1` (the first sweep matched
  0/17,269 — root-caused live against k8plex, one-line fix on the paged reader).
- **Relates:** ADR-017/024 (Plex share + role-library-grant model — the access data), ADR-038/041
  (ytdl-sub live Plex reads + ratingKeys), ADR-046/PLAN-023 (books ledger with deep_link_url),
  ADR-013 (catalog app cards), the My Plex self-service flow (the "request access" target).

## The idea (owner, verbatim intent)

Library shows lots of read-only content but nothing ties an item back to WHERE you actually
consume it. Want: from a non-"missing" Library item, go straight to the page you can
watch/listen/read it on (Plex / Audiobookshelf / Kavita) — seamless, "people shouldn't even have
to think about it." Access-control dependency: if a role can't access a library (e.g. HOps YouTube
on Plex — known from the My Plex toggle config), don't surface that content / its play link to them.

## What already exists (de-risks this — verified 2026-07-11)

- **Books/audiobooks/comics ALREADY carry `books_items.deep_link_url`** (823/823 ABS item links,
  1283 book + comic Kavita series links). The "Listen/Read on <app>" action is near-pure UI there.
- **Access model exists:** `role_library_grants`, `role_plex_server_all_grants`, `plex_libraries`,
  `plex_servers`, `plex_share_audit` — we can already resolve "can this role access library X on
  server Y." This is the hard half of the access dependency, already built.
- **ytdl-sub (Peloton/YouTube) resolves live Plex ratingKeys** (the PLAN-022 drill-in) → Plex deep
  links constructible now.

## The gap

- `media_items` has NO stored Plex ratingKey/library link (verified). *arr-backed Movies/TV/Music
  need a Plex match (by GUID/title) or a stored ratingKey from a sync to build a Plex deep link.
  Plex web URL shape: `https://app.plex.tv/desktop/#!/server/<machineIdentifier>/details?key=/library/metadata/<ratingKey>`.

## Shape (for scoping)

An **availability resolver** per Library item → { app, library, accessibleToUser, present }:
1. **Books/AV path (easy, mostly done):** surface `deep_link_url` as a primary action; gate on the
   role's Kavita/ABS catalog app-grant (and the section they already have). Kavita/ABS OIDC also
   hard-gates at the destination, so it degrades safely.
2. **Plex path (moderate):** resolve item → Plex server+library+ratingKey (ytdl-sub: live; *arr:
   match/sync), build the deep link, gate on `role_library_grants` / `role_plex_server_all_grants`.
3. **Three render states** (the key design decision — owner Q):
   - **accessible + present** → "Watch/Listen/Read on <app>" deep link.
   - **not accessible** → HIDE (owner's instinct) **or** show as a teaser with "request access"
     wired to the existing My Plex self-service toggle (may drive MORE library usage — the goal).
   - **missing / not present** → no play link (owner: "that is not 'missing'").

## Decisions (owner, 2026-07-11 — LOCKED, dispatched)

- **Q-01 → HIDE.** Content in a Plex library the user's role can't access is intentionally
  withheld → never shown (no teaser, no request-flow). This is a SECURITY invariant, not a UI nicety.
- **Q-A → gate ALL Plex-backed tabs:** Movies/TV/Music (map each *arr ledger item to its Plex
  library) + Peloton/YouTube (direct k8plex, per-library grant). Books/AV gated by their section grant.
- **Q-B → exact item links everywhere:** build an *arr→Plex ratingKey match (shared GUID/tmdb/imdb
  ids) so Movies/TV/Music deep-link to the exact title, like books/AV/ytdl-sub already do.
- **Q-C → web targets:** `app.plex.tv` URLs for Plex; the existing audiobookshelf/kavita web URLs
  for books/AV. Reliable cross-platform, hands off to native apps where installed.
- **Q-D → detail-view primary button, app-specific verbs:** "Watch on Plex" / "Listen on
  Audiobookshelf" / "Read on Kavita" on the item drill-in/detail.

## THE INVARIANT (non-negotiable, must be provable)

A user must NEVER receive — in any API payload — a Library item that lives in a Plex library their
role cannot access. Enforce SERVER-SIDE in the query/resolver (not UI filtering). Reuse the EXISTING
effective-library-access resolution (ADR-024 role-library-grants + role-plex-server-all-grants + the
"All libraries" state), do NOT reinvent access logic. Prove with: unit tests (a role without library
X's grant gets zero items from X across every tab) AND a live test (hnet-e2e, a deliberately-withheld
library → 0 items + no tab).

## Out of scope

Teaser/request-access path (owner chose hide). Write-back to Plex/Kavita/ABS. Non-Plex-backed
access models beyond the section grant already shipped.
