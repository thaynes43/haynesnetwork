# OPS-018 — Failed-download retry: turning off Sonarr's and Radarr's own Redownload Failed

- **Status:** Active (2026-10-03). Written with ADR-098 / DESIGN-046 D-23 + D-24 (PLAN-065). The settings change in §2
  is the coordinator's, after the release that carries ADR-098 is deployed.
- **Scope:** the one *arr setting the janitor's failed-download retry depends on; how to change it, check it and roll it
  back. Nothing here changes the janitor's config. §6 records two related Radarr changes of 2026-10-06 (the file naming
  hint, and *Carlos* unmonitored).
- **Normative basis:** ADR-098, DESIGN-046 D-23 and D-24, PLAN-065 (ladder log, 2026-10-03).
- **Repos:** this app (the janitor, `sync-queue-cleanup`); the *arr settings live in each app's own database, not in
  haynes-ops git.

---

## 1. What changes

Before ADR-098, Sonarr and Radarr searched again by themselves, within seconds, after every failed download
(Settings > Download Clients > Failed Download Handling > **Redownload**, `autoRedownloadFailed`). Nothing bounded it: on
2026-10-02 one episode was grabbed 7 times in 5 minutes.

After the change, the janitor is the only thing that searches after a failure: once per failed download, at its hourly
run (`sync-queue-cleanup`, `25 * * * *`), and at most twice per title in any 30 days across all its searches; a third
failure inside those 30 days holds the title for a person and lists it in the nightly digest, and the janitor tries it
again once its oldest try is 30 days old. Lidarr is not changed: its Redownload stays on, and the janitor
does not retry Lidarr failures.

The janitor reads the setting on every run. While it is on, the retry records each failure and searches nothing, so
the deploy is safe before the change, and turning it back on is the rollback (§5).

## 2. The settings change (coordinator, once, after the deploy)

**Only after** the image carrying ADR-098 is running the janitor. Check: an hourly run logs
`queue-cleanup failed downloads` with `"arrRetries":true` (Loki, §3) once Sonarr or Radarr has a failed download in the
last 24 hours; or the deployed image tag is at or past the release that lists ADR-098.

1. Wait for an hourly janitor run to finish (`:25` past the hour; its pod is `haynesnetwork-sync-queue-cleanup-*` in
   namespace `frontend`).
2. Within a few minutes of it, in **Sonarr**: Settings > Download Clients > Failed Download Handling > **Redownload**:
   off. Save.
3. The same in **Radarr**: Settings > Download Clients > Failed Download Handling > **Redownload**: off. Save.
4. Leave Lidarr as it is.
5. Read both back (read-only):

   ```bash
   kubectl -n media exec deploy/sonarr -c app -- sh -c \
     'curl -s -H "X-Api-Key: $SONARR__AUTH__APIKEY" http://localhost:8989/api/v3/config/downloadclient' \
     | jq '{autoRedownloadFailed}'
   kubectl -n media exec deploy/radarr -c app -- sh -c \
     'curl -s -H "X-Api-Key: $RADARR__AUTH__APIKEY" http://localhost:7878/api/v3/config/downloadclient' \
     | jq '{autoRedownloadFailed}'
   ```

   Both must print `"autoRedownloadFailed": false`.

Why right after a run: a failure in the minutes between the last run and the change was already searched by the *arr.
The retry skips it when that search grabbed something, and searches it once more when it did not. Changing the setting
just after a run keeps that window to a minute or two.

## 3. Is it working?

- **Loki**, after the next run: `{namespace="frontend", app="haynesnetwork"} |= "queue-cleanup failed downloads"`.
  One line per instance that had a new failure: `arrRetries` must be `false`; `searched`, `held` and `errors` say what
  the run did. Loops: `{namespace="frontend", app="haynesnetwork"} |= "loop_detected"` (`kind` `skipped_loop` or
  `repeat_search`).
- **The rows** (read-only, on a replica): the retry's rows are `bad_release` rows with no queue item id.

  ```sql
  SELECT created_at, instance, download_id, target_id, action, outcome, left(reason, 60) AS reason
  FROM arr_queue_cleanup_actions
  WHERE queue_item_id IS NULL AND instance IN ('sonarr', 'radarr')
  ORDER BY created_at DESC LIMIT 20;
  ```

  `blocklisted_searched` / `done` is a retry that searched; `none` is a failure that needed no search (grabbed again
  since, another download queued, unmonitored, census, or the *arr's own Redownload still on); `skipped_loop` is a title
  held after two tries in 30 days.
- **The *arr's history**: after a `downloadFailed` record, no `grabbed` record within seconds (the *arr no longer
  searches by itself), then one search at the next `:25` run.

## 4. What people notice

- After a failed download, the next try waits for the janitor's hourly run (up to an hour). Accepted by the owner.
- In the Sonarr or Radarr queue, removing a download with **Blocklist and Search** no longer searches: that option uses
  the same setting. Search for the episode or movie by hand after removing it.
- The app's **Fix** searches exactly once, whatever the setting (DESIGN-005 D-25): it reads Redownload Failed before
  it marks the grab failed, and sends its own search only when the *arr will not. With the setting off (Sonarr and
  Radarr after this change) the Fix searches; with it on (Lidarr) the *arr's own search is the one. Before D-25 a Fix
  searched twice ([issue #646](https://github.com/thaynes43/haynesnetwork/issues/646)).
- A title held after two tries in 30 days (`skipped_loop`) is listed in the nightly digest under the loops, and the
  subject gains `[janitor: loop detected]`. A person can step in (an interactive search for a good release, or unmonitor
  it); otherwise the janitor tries it again once its oldest try is 30 days old.

## 5. Rollback

Turn **Redownload** back on in Sonarr and Radarr (§2 steps 2 and 3, on). The janitor reads the setting on its next run
and stops retrying; it records each failure as observed. No app change, no config change. To stop the janitor's
`bad_release` handling altogether (the queue removals too), set that cell to census for the instance through
`setArrQueueCleanupConfig` or the /admin janitor grid.

## 6. Related Radarr changes (2026-10-06): file naming and *Carlos*

Made while tracing why *Carlos* (2010) kept coming back unmatched in Plex. Like §2, they live in Radarr's database, not
in git.

**File naming uses the TMDB hint.** Settings > Media Management > Standard Movie Format: only `{imdb-{ImdbId}}` changed,
to `{tmdb-{TmdbId}}`. The rest of the template and the folder format (`{Movie Title} ({Release Year})`) are unchanged.

- Before: `{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}} {edition-{Edition Tags}} {[Custom Formats]}{[Quality Full]}{[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}[{Mediainfo VideoCodec}]{-Release Group}`
- After: `{Movie CleanTitle} {(Release Year)} {tmdb-{TmdbId}} {edition-{Edition Tags}} {[Custom Formats]}{[Quality Full]}{[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}[{Mediainfo VideoCodec}]{-Release Group}`

Why: Plex's movie agent takes the hint in the file name as the exact id. An IMDb id that IMDb files as a miniseries or
TV movie does not resolve to a Plex movie, so Plex leaves the item unmatched. For *Carlos*, a match search for
`imdb-tt1321865` returns no movie (Plex's TV agent resolves it to a show), while `tmdb-43434` returns the right movie.
The TMDB id is the id Radarr itself keys on, so it always names a movie. Every replaced file became a new Plex item, so
a hand Fix Match was lost each time Radarr replaced the file.

Files keep their old name until their next import or upgrade; the library was not mass-renamed. Only the 17 movies that
were unmatched in Plex were renamed (Radarr Rename, one movie at a time, file name only, no folder moves): *Abraham*
(1993), *Apocalypse: The Battle of Verdun* (2016), *Bugsy* (1991), *Carlos* (2010), *David* (1997), *Halo: Nightfall*
(2014), *I'm Gonna Git You Sucka* (1988), *Jesus* (1999), *Joseph* (1995), *Little Giants* (1994), *Solomon* (1997),
*The Snapper* (1993), *Untold: Chess Mates* (2026), *V.C. Andrews' All That Glitters* (2021), *V.C. Andrews' Hidden
Jewel* (2021), *V.C. Andrews' Pearl in the Mist* (2021) and *We Want the Funk!* (2025). Plex took each rename in place
(same item, no duplicates), and a metadata refresh then matched every one, on HaynesTower and HaynesOps, to the movie
with the same TMDB id.

Still unmatched in Plex, not renamed:

- *Moses* (1995) and *Rose Red* (2002): their Radarr records are the wrong titles. Movie 4707 is *Leningrad Cowboys
  Meet Moses* (1994, TMDB 30366) and movie 5847 is *Unlocking Rose Red: The Diary of Ellen Rimbauer* (2002, TMDB
  1368089), so a rename would write the wrong title and id. Both are monitored with the cutoff unmet, so an upgrade
  could replace the file with the wrong film. Open for a person: unmonitor them, or remove the Radarr record and keep
  the file for Plex only.
- *Samson and Delilah* (1996) and *The Stand* (1994): not in Radarr. TMDB has no movie for their IMDb ids (they are TV),
  so there is no movie to match them to.

***Carlos* (Radarr 9747) is unmonitored.** Kometa added it on 2026-09-15 for its seasonal Latinx Heritage Month
collection. The film runs 339 minutes in three parts. Its releases are three files, which Radarr cannot import
("suspected multi-part file"), or single parts, which replaced the whole film with one part (2026-09-29). The file in
place is the three Criterion parts joined into one 5:41:00 file (2026-10-03). It scores -8750: TMDB gives English as
the original language and the audio is French, so the profile's `Language: Not Original` (-10000) applies. The cutoff
is never met, so every new *Carlos* release would count as an upgrade. Unmonitored, Radarr grabs nothing for it, and
Kometa does not change a movie Radarr already has. Release profile 3 (tag `carlos-release-block`) still blocks
single-part names.

**Rollback:** put `{imdb-{ImdbId}}` back in the Standard Movie Format (renamed files keep the TMDB hint until their
next rename, which Plex matches either way). Monitor *Carlos* again only together with a profile whose cutoff the
joined file meets.
