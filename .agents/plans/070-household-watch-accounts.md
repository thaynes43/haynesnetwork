# PLAN-070: Household watch accounts: track every mapped household Plex account in the `watch` sync

- **Status:** Draft (queued stub; picked up after PLAN-069 closes)
- **Why:** ADR-091 C-04 (owner ruling 2026-09-23, _"The auth path needs to be user aware too"_): a
  connector answers for its own user's Tracked Account (DDD-001 T-259). Today only the Server Owner is
  tracked, so every other user who connects is told "Watch history isn't set up for your account yet."
  This plan gives them history to answer from.
- **Depends on:** PLAN-069 (the user-aware principal, the "isn't set up" answer, the non-owner mark
  that never calls Plex). **PRD:** Q-12 (answered for connectors by ADR-091 C-04); the requirement
  rows land with this plan's docs. **Design home:** a DESIGN-049 amendment (the `watch` sync, D-09) or
  a new design, decided at the docs step. Needs an ADR only if it changes ADR-088's read-model rules.

## Scope

1. **Which accounts.** Every app user with a Plex Account Map row (`user_account_map.plex_user_id`;
   12 mapped users on 2026-09-23, the owner included) gets a `watch_accounts` row with role
   `household` (the enum value already exists) and `tracked = true`. `tracked = false` stops ingest
   without dropping history (the existing schema rule). The owner row is unchanged.
2. **Events.** The `watch` sync reads each tracked household account's history from all three
   Tautullis (Tautulli already holds everyone's plays), incrementally, never capped, never re-read,
   exactly as it does for the owner (DESIGN-049 D-09).
3. **Title States from events only.** Plex progress is not readable for them: the sync reads Plex
   with the owner's server tokens, which see only the owner's watched flags, and nobody else's token is
   held. So a household account's Title State is built from its Watch Events alone (Tautulli's watched
   verdict per episode, the last event's percent for a movie's resume point), using the owner-token
   Plex reads only for show structure (the episode list, specials excluded). No plex.tv watchlist for
   them (it needs their token); recommendations use their events-only Ever Watched and Taste Profile
   plus TMDB seeds from their recent titles.
4. **Unchanged:** the hop and the Movie Room agent answer for the Server Owner; Plex write-back stays
   owner-only (PLAN-069 S4); no tool takes an account id.

## Open questions (for the docs step, each asked when it arises)

| ID   | Question                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-01 | Track every mapped account automatically, or only once that user connects an app (opt-in)?                                                                                 |
| Q-02 | One Tautulli history pass for all tracked accounts (split by `user_id`), or one filtered pass per account? The cursor today is per instance for one account.               |
| Q-03 | Reuse or retire ADR-053's household harvest (`user_media_watch`, capped at the newest 10k rows per instance, its own GitHub issue), which reads the same Tautulli history? |
| Q-04 | Managed Plex Home users and friends without an app login have no Map row: leave them untracked (the default of item 1)?                                                    |

## Stages and gate

| #   | Stage                                                                                                        | Gate                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Docs: the questions above ruled; PRD rows, glossary, design amendment                                        | docs PR merged                                                                                                                                                                                                                                                      |
| S2  | Sync + read-model: household rows, per-account event ingest, events-only Title States, recommendation inputs | embedded-PG tests with a stub Tautulli holding two accounts: each account sees only its own events; the owner's Title States, answers and Voice Budget are byte-identical to before; a household account never triggers a Plex progress read under its own identity |
| S3  | Release + deploy                                                                                             | the first run's per-account event counts match Tautulli's `get_history` totals per `user_id`; the sync still fits its 15-minute slot                                                                                                                                |
| S4  | Live gate                                                                                                    | a household member's connector (PLAN-069 S8 step 4 again) answers `unfinished` and `recommend` from their own history; a `mark_watched` from them records history only and Plex is unchanged; the owner's Movie Room answers are unchanged                          |
