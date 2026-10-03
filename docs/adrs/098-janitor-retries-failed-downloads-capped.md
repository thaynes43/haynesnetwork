# ADR-098: The janitor is the one retrier of failed Sonarr and Radarr downloads, within one search budget per title

- **Status:** Accepted (2026-10-03, owner ruling). No new cell: the retry rides each instance's existing `bad_release`
  cell, enforced since L2 (2026-09-29). It searches nothing while an *arr's own Redownload Failed is on, so it is
  inert until the coordinator turns that setting off in Sonarr and Radarr after the deploy (OPS-018).
- **Date:** 2026-10-03
- **Deciders:** Tom Haynes (owner ruling 2026-10-03, choice "App retries, capped": hitting an indexer twice for the same
  thing is very bad; recovery taking up to an hour longer is accepted; cascades must be impossible). The evidence is
  the coordinator's read-only audit of the same day, re-checked for this ADR against the live Sonarr history and the
  janitor's rows. A second ruling the same day answered DESIGN-046 Q-08 ("Reset after 30 days"): the budget is two
  tries per title in any rolling 30 days. Drafted by Opus 5.5.
- **Supersedes (in part):** ADR-083's class C action, "blocklist + owning-*arr re-search", which left the *arr's own
  search after a failed download outside the janitor; and ADR-083 C-04's write-back list, which gains a search with no
  removal (C-03 here). DESIGN-046 D-13 rule 4 (ADR-094): the loop guard's count becomes one budget across every janitor
  search, not only `manual_match` removals (C-02 here).
- **Amends:** hard rule 4's write-back list (CLAUDE.md), as ADR-083 C-04, ADR-094 C-03 and ADR-095 C-03 did.

## Context and problem statement

The janitor is at L2 on Sonarr, Radarr and Lidarr. For a `bad_release` it removes the download with blocklist and
`skipRedownload=true`, then runs its own search for the record's monitored targets (DESIGN-046 D-04, D-10, D-11). Two
loops were found on 2026-10-03:

- **The janitor's own search had no loop guard on Sonarr and Radarr.** The guard (D-13) covered only Lidarr's
  `manual_match` and, since ADR-095, the suite sources. Lidarr's `bad_release` was unguarded too.
- **The *arrs' own Redownload Failed turns one search into a cascade.** Both run `autoRedownloadFailed` (and its
  interactive-search twin) on. Every failed download is blocklisted and searched again within seconds, by the *arr,
  with no bound. On 2026-10-02 at 06:25Z the janitor removed 7 Paw Patrol downloads ("Found archive file", 13
  episodes) and sent one EpisodeSearch per episode: 13 searches, and no *arr search on the removals themselves
  (`skipRedownload` honored). Many of the new grabs then failed in SABnzbd ("Aborted, cannot be completed"), and
  Sonarr searched again within seconds of each failure: 15 failed downloads in 4 minutes, and 25 grabs in 5 minutes,
  11 from the janitor's searches and 14 from Sonarr's own. S05E16 was grabbed 7 times; S05E15, S05E19 and S05E20 5
  times each. Every one of those episodes already had a file: these were upgrade grabs.

Since 2026-09-25, 96 Sonarr and Radarr janitor removals were followed by 60 more grabs.

## Decision drivers

- Never hit an indexer twice for the same thing: one search per failure, and a hard bound per title.
- Cascades must be impossible, not merely rare. A bound that only some searches respect is not a bound.
- Slower recovery is acceptable: up to an hour after a failure.
- The *arrs are the source of truth (hard rule 4): the janitor adds one search command, no new kind of write.
- The live config (L2) and the ladder must not move, and the deploy must be safe before the *arr settings change.

## Considered options

1. **Keep the *arrs' Redownload Failed; guard only the janitor's searches.** The janitor stops looping, but the
   Paw Patrol cascade was the *arr's own, so it stays.
2. **Turn Redownload Failed off and let nothing retry.** No cascade, but a failed download waits for an RSS grab that
   may never come.
3. **Turn it off in Sonarr and Radarr; the janitor retries each failure once, at its hourly run, under one budget of
   two tries per title in any rolling 30 days, shared with its own removals** (chosen).

## Decision outcome

Chosen option: **3**, because it is the only one where every search after a failure passes one bound.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: **the failed-download retry** (DESIGN-046 D-24). Each hourly run reads Sonarr's and Radarr's `downloadFailed` history of the last 24 hours and searches once per failed download (one EpisodeSearch or MoviesSearch for its monitored targets). It skips a removal through the *arr's API (`Manually marked as failed`: the janitor's own removals, a Fix, a person), a target grabbed again since, a target with another download in the queue, and a target already searched in the same run. Each failure is recorded once, so a later read of it does nothing. |
| C-02 | Good: **one budget per title.** The loop guard counts the janitor's tries for a target (Sonarr's episode, Radarr's movie, Lidarr's album) across every class whose action ends in a search: `bad_release` on all three *arrs, Lidarr's `manual_match`, and the retry. A try is a removal that landed or a retry that searched. A target already tried on two earlier downloads is `skipped_loop`: no removal, no search, listed in the nightly digest and logged once as `[queue-cleanup] loop_detected`. Tries count for a rolling 30 days (owner ruling on DESIGN-046 Q-08, 2026-10-03, "Reset after 30 days"): at most two automatic tries per title in any 30 days, for every loop guard, Lidarr's `manual_match` and the suite sources included. This supersedes D-13 rule 4's "the hold does not expire". |
| C-03 | **Hard rule 4 is amended**: the janitor's write-back surface gains the failed-download retry, one search command per failed Sonarr or Radarr download, with no removal (the *arr removed and blocklisted the download when it failed). It runs only where the instance's `bad_release` cell is enforced and only while the *arr's Redownload Failed is off. |
| C-04 | Good: **exactly one search per failure.** The janitor's removals keep `skipRedownload=true`, so they never depend on the *arr's setting. The queue path no longer searches a download the *arr has marked failed itself (`failed`, `failedPending`, Lidarr's `downloadFailed`): its own handling searched (setting on) or the retry will (setting off). A target is searched at most once per run, whichever download asks. |
| C-05 | Bad: after a failure, the next try waits for the janitor's hourly run (up to an hour). Accepted by the owner. |
| C-06 | Bad: with Redownload Failed off, the *arr's own queue removal option "Blocklist and Search" no longer searches; a person who removes a download by hand searches by hand. The app's Fix searches by itself, so it keeps working, and its double search on Sonarr and Radarr (the *arr's search after Fix marks the grab failed, plus Fix's own) ends. |
| C-07 | Neutral: Lidarr keeps Redownload Failed on (the ruling covers Sonarr and Radarr). The janitor does not retry Lidarr failures, and the queue path still never searches a Lidarr download the *arr failed itself. Lidarr's Fix still searches twice ([issue #646](https://github.com/thaynes43/haynesnetwork/issues/646)). |
| C-08 | Neutral: rollout. No new cell, no config change, no migration: the retry rows are `bad_release` rows with no queue item id, the derived ladder level stays L2. While an *arr's Redownload Failed is on (read every run), the retry records each failure as observed and searches nothing, so the deploy is safe before the settings change. The coordinator turns the setting off in both apps right after a janitor run (OPS-018). |

## More information

- DESIGN-046 D-23 (one budget, one search per failure) and D-24 (the retry); PLAN-065 ladder log, 2026-10-03.
- OPS-018: the settings change, its order, and how to check the retry in Loki and in the rows.
- Upstream, at the running tags (Sonarr v4.0.20.3014, Radarr v6.4.4.10685, Lidarr v3.1.6.5078):
  `FailedDownloadService.ProcessFailed` sets the tracked download `Failed` and publishes `DownloadFailedEvent`;
  `RedownloadFailedDownloadService` searches unless `SkipRedownload` is set or `AutoRedownloadFailed` is off;
  `MarkAsFailed` (queue removal with blocklist, `POST /history/failed/{id}`) records `Manually marked as failed`.
