# PLAN-056: Books walls — Wanted items break sorting + a three-state Wanted selector

- **Status:** Queued (owner live report, 2026-07-16 eve). Build AFTER PLAN-051 merges (same
  wall/registry seams; PLAN-051 is mid-build).
- **Owner report (verbatim-in-intent):** "There seems to be a problem sorting books. Wanted is
  always at the top for Books and Audiobooks in Library, likely Comics too but we have none
  Wanted yet. We have the 'Wanted Only' button but I'd also like to work in 'Hide Wanted'
  somehow to the selector."

## Shape

1. **Sort bug first (triage in-plan):** the composed Library-Wanted view (PLAN-045 / ADR-057 —
   wanted items composed into the Books/Audiobooks/Comics walls) appears to pin Wanted rows
   above library rows regardless of the active sort. Determine whether that is deliberate
   composition order or a sort-key artifact (wanted rows lacking the sorted field, e.g. null
   author/added-at sorting first) and make the walls sort the COMPOSED set honestly: a Wanted
   item participates in the chosen sort like any other card.
2. **Three-state Wanted selector:** the existing "Wanted only" control becomes All · Wanted
   only · Hide wanted (segmented or chip cycle — pick the idiom the wall already uses; ADR-015
   reflow rules; URL param refinement semantics per D-19, replace-in-place). Server-side
   filtering (the wall reads are server-authoritative).
3. Applies to Books, Audiobooks, AND Comics walls (the composition is shared).

## Open questions

- Q-01: default state stays "All" (current behavior minus the pinning)? (Lean: yes.)
