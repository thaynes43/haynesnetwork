# 2026-08-19 — NZB Finder duplicate-download warning #2: SAB Discard-mode grab loop (root-caused, fixed)

Owner received a second NZB Finder "Action Required" email (first: 2026-07-21): 83 duplicate
downloads of 23 releases in a day, all UA `Sonarr/4.0.19.3001 (alpine 3.24.1)`, single home
WAN IP. Repeat warnings terminate the account — estate-critical.

## Root cause (proven end to end)

**SAB duplicate handling was set to Discard (`no_dupes=1`) on both instances — the 07-21
incident's own remediation — and Discard is incompatible with *arr failed-download handling:**

1. The *arr (Sonarr/Radarr/Lidarr) RSS sync or search decides to grab → fetches the NZB
   through Prowlarr (grabMethod Redirect, so the indexer sees the *arr's UA and counts the
   fetch) → POSTs it to SAB.
2. SAB's duplicate detection recognizes the NZB (SAB ≥ 4.5 keeps a **separate persistent
   duplicates database** — any NZB ever added counts forever, even if discarded and absent
   from visible history) and **Discard rejects the add**: `WARNING Ignoring duplicate NZB`,
   error response to the API caller.
3. The *arr logs `Couldn't add release … to download queue` (a failed **add**, not a failed
   **download**) → **no history row, no blocklist entry**.
4. Next RSS sync (~15 min) still wants the item, the release is still in the feed → grab the
   same NZB again → goto 2. The loop is invisible in *arr history AND SAB history; it only
   shows in *arr text logs, Prowlarr `releaseGrabbed` history, and the indexer's tally.

## Evidence

- **Sonarr / NZB Finder (the email):** 25 `T.O.T.S.` S01 episodes (AndreMor MULTI re-posts)
  grabbed 3–5× each from NZB Finder + 6–11× each from NZBgeek on 08-18 18:24–20:05Z, every
  ~16 min — Sonarr RSS Sync cadence (`RssSyncService` lines bracket each wave). Loop
  self-ended only when the releases aged out of the 400-report RSS window. Radarr did the
  same to `The.New.Mutants.2020` on 08-16 (8× NZB Finder, 22× NZBgeek). Sonarr log shows the
  `Sabnzbd|Adding report` → `ProcessDownloadDecisions|Couldn't add release` pair for every
  attempt; zero grab rows in Sonarr history for any of them.
- **Lidarr / NZBgeek (the next email if unfixed):** `Juicy J-The Clock Dont Go Back-2026`
  (one NZB id) fetched **769×** since 08-15, 2×/15-min tick, still live at diagnosis time
  (~190 fetches/day — NZBgeek's warning was a matter of days).
- SAB slow log at each tick: `Ignoring duplicate NZB "Juicy J-…"` + purge. Neither release
  appears in either SAB's visible history (the separate dupes DB is the matcher).
- One Sonarr, one Lidarr (the second Prowlarr `host` for Lidarr was its pre-restart pod IP).
  Not stolen keys, not multiple instances, not a reverse-proxy body cap.

## Not the cause (checked)

- **The ADR-083 queue janitor:** census-only confirmed live (`actionsTaken: 0` on all three
  instances, every run) — exonerated.
- **The app trash / space-policy sweeps (owner's initial hypothesis):** all 782
  `episodeFileDeleted` events in the 08-14→08-19 Sonarr history window are reason=Upgrade
  (import-time replacements); recent sweeps deleted 0. The loops were driven by re-posted
  releases + upgrade wants, not trash deletions. The owner's directive still stands as a
  waste-prevention feature — see follow-ups.

## Actions taken (2026-08-20 ~01:50Z)

- **`no_dupes` 1 → 3 (Fail job) on BOTH SAB instances** via `set_config`, verified via
  `get_config`. Fail mode: the dupe lands in SAB history as Failed → the *arr's
  failed-download handling **blocklists the release** and re-searches alternatives — dupe
  protection kept, loop structurally broken. (SAB config is PVC state, not GitOps; same
  lever as the 07-21 flip.) Revert: `value=1`.
- Verification: watcher armed on the next Lidarr tick — expect a Failed `Juicy J` SAB
  history entry + a Lidarr blocklist row, then no further Prowlarr fetches of that NZB id.
  Result recorded below.

## Verification (live, 2026-08-20 02:08–02:30Z)

- **Fail mode ENGAGED:** the 02:08:55Z Lidarr tick's add was ACCEPTED by SAB, marked
  `Failed — Duplicate NZB`, written to SAB history (nzo `74feed70…`), failure notification
  fired. Lidarr wrote its **first-ever `grabbed` history row** for the release (proving the
  769 prior fetches were invisible failed adds). The 01:53Z tick still discarded — a race
  with the config flip, not a restart requirement.
- **Loop DEAD:** the next tick (02:24Z) grabbed only an unrelated release; zero Juicy J
  fetches after 02:08:54Z.
- **One residual found:** Lidarr never processed the failure into `downloadFailed` +
  blocklist — its `DownloadMonitoringService` throws `MultipleArtistsFoundException` on four
  OTHER tracked downloads (duplicate artist records: Lukas Graham, Role Model, Karol G,
  Willow), and the Juicy J failure sat unprocessed even after a forced
  `RefreshMonitoredDownloads`. Belt over suspenders: **album 57081 ("The Clock Don't Go
  Back") unmonitored** (API PUT, verified) so the loop cannot re-arm regardless.
- **Positive control for the fix's end-to-end path:** Radarr's The New Mutants on 08-16 —
  `grabbed 10:32Z → downloadFailed 12:11Z → re-grab → downloadFolderImported 18:31Z`. When
  the failed-download path fires, the *arr routes around the dupe wall correctly.
- Both *arrs verified `enableCompletedDownloadHandling: true` + `autoRedownloadFailed: true`.

## The New Mutants nuance (owner flagged it)

The movie was **added to Radarr 2026-08-16 10:31:36Z — 37 s before its first grab** (a fresh
re-request, likely Seerr), yet SAB's dupes DB already knew its NZB → it WAS downloaded in a
past life and later removed entirely. Same shape as T.O.T.S. (S01 NZBs known to SAB; series
freshly grabbing on 08-18, removed again by 08-19). So the loop's precondition is
**"previously-downloaded media comes back as wanted"** — via re-request OR via
trash-delete-while-monitored. Two implications: (a) legitimate re-requests MUST be able to
re-download — Fail mode handles this (blocklist the dupe-walled release, take another copy);
(b) the owner's unmonitor-on-trash-delete feature (Q-02) prevents the UNWANTED variant. What
deleted these originally is not recoverable from remaining records.

## 2026-08-20 rulings + execution (owner answered via AskUserQuestion, one at a time)

- **Q-02 RULED + ADR DRAFTED:** write-back = **unmonitor + blocklist** on app deletes;
  **import-list exclusions** on sync-detected full removals; **Seerr re-requests must keep
  working** (binding acceptance criterion). → **ADR-084** (Proposed, this PR). Build follows
  docs-first.
- **Pushover audit notification REJECTED** ("way too many notifications"). Chosen instead
  (owner's own design): **Prometheus/Alertmanager + dashboard** — `SonarrSeriesRemoved`
  PrometheusRule at severity=warning (timestamped in Alertmanager, below the Pushover paging
  threshold; haynes-ops **#2536**) + the **`arr-library-audit` Grafana dashboard** (Media
  folder, `/d/arr-library-audit`): library counts with removal dips, alert-firing history,
  24h deltas, stuck-queue trend. The Q-01 Pushover recommendation below is SUPERSEDED.
- **Queue cleanup EXECUTED (owner: "Clean them"):** the orphan cohort turned out to span
  **five silently-removed series** — Los Pingüinos de Madagascar (60 items), T.O.T.S. (46),
  The Rookie 2025+2026 (3), Monster (1). All **110 orphans bulk-removed** from Sonarr's queue
  (no blocklist, no client removal); queue **131 → 10** (the 10 legit pending items
  untouched). Henry Danger's every-30s "path does not exist" spam killed by deleting its two
  dead SAB-fast history entries (both packs had imported 08-14; folders long gone) —
  verified silent. Census evidence was already captured in `arr_queue_cleanup_actions`.
- **Churn scale finding:** The Rookie IS in Sonarr's exclusion list while T.O.T.S./Pingüinos
  are NOT → at least two different delete flavors (with and without exclusion). The deleter
  remains unidentified; the new alert timestamps the next occurrence.

## Follow-ups

- **Q-01 (owner): who removed the `T.O.T.S.` SERIES from Sonarr — INVESTIGATED, UNRESOLVED
  (owner says not them).** Its removal orphaned **107 queue items** stuck `importBlocked`
  ("release was matched to series by ID") — they can never import and are janitor food (see
  the PLAN-065 ladder log entry, same date). Attribution sweep (2026-08-20, all with positive
  evidence, not absence-of-logs):
  - Series present at 21:23Z 08-18 (still grabbing); **files still on disk**
    (`…/TV Shows/T.O.T.S` exists) → whatever deleted it used deleteFiles=false, ruling out
    the delete-with-files automations.
  - **Maintainerr:** every CollectionWorker run in the window logs "No data was altered";
    Leaving-Soon rules are action='Do Nothing'; the `hnet — unwatched low-value TV` rule had
    "no due media". Exonerated.
  - **Kometa:** python-requests caller of Sonarr's deprecated ImportListExclusion endpoint at
    exactly its cron times (03:00/04:00/06:30 ET) — but those are READS in its add flow;
    Kometa has no Sonarr series-delete capability. It is however almost certainly what ADDED
    T.O.T.S. (global `sonarr: add_missing: true, search: true`; dynamic chart lists; the
    Kometa-Added tag design). Exonerated for the delete.
  - **Seerr:** 4,338 log lines in the window, zero removal events. **Janitor:** census-only.
    **App sync:** read-only. **Sonarr import lists:** none configured, listSyncLevel
    disabled. All exonerated.
  - Remaining explanations: a human Sonarr UI/API action (another household admin?) or an
    unlogged direct API call. Sonarr does not log series deletes at Info and no notification
    has `onSeriesDelete` — **recommendation: add a Pushover/webhook Sonarr connection with
    `onSeriesDelete` + `onSeriesAdd` enabled so the next silent add/delete is timestamped and
    attributed.** Re-add risk: T.O.T.S. is NOT in Sonarr's exclusion list and not in any
    git-managed Kometa list, but a dynamic chart list could resurface it — harmless for the
    indexer under Fail mode (one fetch → blocklist), but the add/delete churn source should
    be identified before the janitor enforces on the orphan class.
- **Q-02 (owner directive 2026-08-19, needs an ADR):** "ignore-list anything the trash
  deletes" — when the app's trash/space-policy (and/or Maintainerr) deletes media, write back
  **unmonitor** to the owning *arr (episodes/movie/album) so deleted media can't silently
  re-download. Expands the hard-rule-4 write-back surface (failsafe restore + fix + janitor)
  → ADR + design amendment before code. Open scoping: unmonitor only, or also blocklist the
  exact prior release? Which delete paths count (space-policy batch, manual trash, Maintainerr
  Leaving-Soon)?
- **LL watch:** Fail-mode dupes re-enter LazyLibrarian's fail→re-snatch surface; the 07-21
  "LL failed-download blacklist audit" follow-up is now load-bearing — verify LL blacklists
  failed downloads instead of re-snatching the same release.
- **Lidarr duplicate-artist jank:** `DownloadMonitoringService` throws
  `MultipleArtistsFoundException` on 4 tracked downloads (Lukas Graham / Role Model /
  Karol G / Willow — two artist records each in the Lidarr DB), which also blocks
  failed-download processing for OTHER items. Dedupe those artist records; part of the
  Lidarr 61-item stuck pile the janitor census counts.
- **Henry Danger residual (separate, local-only):** `Henry.Danger.S02/S03` completed-folder
  paths are gone but Sonarr keeps rescanning — 1,861 `Import failed, path does not exist`
  errors across two log files (~every 30 s). No indexer traffic; queue-hygiene class
  (janitor `retry_import`/`bad_release` families).
- Memory `nzb-dupe-guard-doctrine` rewritten with the corrected doctrine (Fail, never
  Discard).
