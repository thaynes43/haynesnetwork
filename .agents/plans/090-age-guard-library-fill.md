# PLAN-090 — Age Guard library fill (story 836)

- **Status:** Proposed. One change, design and code together. The setting ships off.
- **Design:** ADR-117, DESIGN-052 D-29. Evidence: `.agents/context/2026-11-13-age-guard-library-fill.md`.

## What this change does

1. Admit `age_guard_ignore_library_fill` (migration 0108). No row is inserted. The default is false.
2. Off: `loadAgeEvidence` returns the 2026-10-03 newest Plex date and does not read fill days.
3. On: a library-day of at least 100 titles with at most 5% nearby download imports is a fill. A fill stamp is
   left out when another Plex server has a strictly older date and this title has no download import within 6
   hours of the stamp. A download import inside 180 days still protects. One server keeps today's behaviour.
4. Domain tests cover the rule, the setting off, and each case D-29 says could be wrong.
5. The paper census is in D-29: 389 shows and 40 movies would lose the Age Guard. Other keeps are not subtracted.

## What this change does not do

- It does not turn the setting on.
- It does not change Save, `dnd`, the watchlist, recent watch, or the request tag.
- It does not write to a live system.
- Enablement is a later story, after a person has looked at the twenty largest shows and the movie list.

## Q-15

Why 46 live Radarr rows match into HaynesOps TV Shows on the July 2026 fill days is open. Recommendation: do not
block this change on it. The Age Guard already reads those matches.
