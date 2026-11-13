# PLAN-091 — Age Guard library fill (story 836)

- **Status:** Proposed. One change, design and code together. The setting ships off. This is not a release to dispatch.
- **Design:** ADR-119, DESIGN-052 D-31. Evidence: `.agents/context/2026-11-13-age-guard-library-fill.md`.

## What this change does

1. Admit `age_guard_ignore_library_fill` (migration 0109, journal index 107). No row is inserted. The default is false.
2. Off: `loadAgeEvidence` returns the 2026-10-03 newest Plex date and does not read fill days. A title with no Plex match is `unknown` either way. That is the one change that alters today's behaviour, and it only ever keeps more.
3. On, and only when that *arr's first download import is at least 180 days old: a library-day of at least 100 titles with at most 5% nearby download imports is a fill. A fill stamp is left out when another Plex server has a strictly older date in a library of the fitting type and this title has no download import within 6 hours of the stamp. A download import inside 180 days still protects. One server keeps today's behaviour. With the guard the July 2026 fill is left alone.
4. `setAgeGuardIgnoreLibraryFill`, through the admin mutation `trash.settings.set`, sets the value and sets it back, with an audit row in the same transaction. This plan does not turn the setting on and does not add a settings-page control.
5. Domain tests cover the rule, both sides of the ledger guard, a Sonarr show, the day boundary, the database thresholds, a wrong-type older date, the absent and non-boolean rows, the no-match `unknown` verdict, and a sweep and an Expedite with the setting on.
6. The paper census is in D-31. 389 shows and 40 movies is the Age Guard alone, as if the ledger already covered the window. Under the live pools the switch changes no deletion today.

## What this change does not do

- It does not turn the setting on.
- It does not change Save, `dnd`, the watchlist, recent watch, or the request tag.
- It does not write to a live system.
- It does not fix the matcher. That is story 847.
- Enablement is story 823, after the five conditions in D-31, including a person reading the census against the pool the TV rule in force would build.

## Q-24 and Q-25

Q-24 (wrong-type matches) and Q-25 (the 2026-10-30 "7 movies" row) are in DESIGN-052. Neither blocks this change.
