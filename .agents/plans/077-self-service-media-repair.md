# PLAN-077: Self-service media repair and the Seerr issue bridge — implementation

- **Status:** Active. Docs Accepted (owner, 2026-10-12: ADR-109, ADR-110, ADR-111, DESIGN-055). The owner ruled
  DESIGN-055 Q-01..Q-05 (the recommended option each time) and approved P1..P8 in this order, one phase per release,
  each verified live before the next. P0 (v0.111.2), P1 (v0.112.1), P2 (v0.113.1) and P3 (v0.114.0) are shipped and
  verified live; P0's week of census is owed (OC-048), P1's first guided Fixes OC-050, P2's first presses OC-051, P3's
  first real Seerr issue OC-052. P4 (v0.115.0, v0.115.1, v0.116.0) is shipped and verified live, remedy on; its first
  week of Title Check census and first person-run re-map are OC-053. DESIGN-055 Q-10 (the hand profile's five
  non-group blocks) is ruled A (owner, 2026-10-13, ADR-113): mislabelled-name terms shipped in v0.117.0, the five terms
  are adopted and the hand profile and its tag are gone (P4, "Q-10 ruling"). Q-11 (the library's whole-season
  reorderings, issue #916) is ruled A too: staff's Season Re-map shipped in v0.117.0 and ran on 29 seasons (P4's
  follow-up below; open flags 622 to 400). P5 (Release Pick) is shipped and verified live, remedy on: v0.118.0 ([#926](https://github.com/thaynes43/haynesnetwork/pull/926)), v0.118.1 ([#930](https://github.com/thaynes43/haynesnetwork/pull/930)) and v0.119.1 ([#935](https://github.com/thaynes43/haynesnetwork/pull/935)). Its first person's pick is OC-054. P6 is next.
- **Satisfies:** PRD-001 R-262..R-271, US-18, US-19, AC-40..AC-45 / DESIGN-055.
- **Owner goal (2026-10-12):** steer Plex users away from filing Seerr issues for staff and toward fixing problems
  themselves on haynesnetwork.com. It becomes a hard rule only once the platform reliably fixes what people report.
- **Absorbs:** issue [#597](https://github.com/thaynes43/haynesnetwork/issues/597) Part 1 (queue-aware Force Search)
  and Part 2 cause 3 (an "importable" janitor class). #597's library-state classes, Penguins of Madagascar and the
  has-file records stay in #597 and PLAN-065.
- **Related issues:** [#887](https://github.com/thaynes43/haynesnetwork/issues/887) (P0),
  [haynes-ops#3834](https://github.com/thaynes43/haynes-ops/issues/3834) (SABnzbd leaves obfuscated `.7z` posts
  un-extracted), [haynes-ops#3833](https://github.com/thaynes43/haynes-ops/issues/3833) (HaynesOps never
  hardware-transcodes; P1 triage).
- **Validation:** each phase's live check below, then P8's owner review.

## Why

Three Seerr issues worked by hand on 2026-10-12 (DESIGN-055 Overview has the full table) could not have been fixed by a
user: Case A (Regular Show: The Lost Tapes S01, mis-numbered files), Case B (The Paper 2x06, an import stuck for 18
days) and Case C (GoodFellas, a healthy file where a Fix would have deleted 88 GB for nothing). haynesnetwork's own
tools are barely used (2 Fix requests in 90 days, 1 Helpdesk ticket ever), and Seerr is where people report (4 issues
since 2026-07-11). Both recent reporters have no haynesnetwork.com account.

## Rules for every phase

- **Never `cd <dir> && ...` in Bash.** Use `git -C`, `gh --repo thaynes43/haynesnetwork` and absolute paths.
- **CPU budget (dev-env, 2026-10-06):** no CPU busy-loops, stress tools, or wide or looped parallel test runs in the
  dev-env pod. Run only the touched package's tests, at low parallelism under `nice -n 19`; CI runs the full suite. Fix
  a timing flake by reasoning and fake timers, not by load.
- **Hard rule 4.** Every new *arr, Plex or Seerr write goes through its confined write client from `packages/domain`
  only. The phase that lands a writer also updates CLAUDE.md hard rule 4 (and DESIGN-046 for janitor classes) in the
  same PR.
- **Each phase is its own PR and release**, docs amended in the same PR (DESIGN-055 decision rows, DESIGN-005 or
  DESIGN-046 pointers). New tables join the `no-direct-state-writes` guard list.
- **A kill switch per remedy.** One audited app setting, `repair_guide_remedies` (the ADR-082 pattern), turns each
  remedy on or off in `/admin` without a release; off means the guide falls back to today's dialogs for that remedy.
  Every remedy ships off and is turned on after its live check.
- **Tests** use embedded Postgres and stub clients (no Docker). Changes to `packages/domain`, `packages/arr` or
  `packages/sync` make `e2e-gate` run the Playwright suite; the stub *arr grows with each phase.

## Phases, in priority order

Priority is how often real reports need the remedy, and how much harm today's behaviour does.

| Phase | Scope (DESIGN-055) | Why this position | Owner gate |
|---|---|---|---|
| P0 | Janitor stops blocklisting "Found archive file" downloads (D-14) | Live harm: 82 Sonarr downloads removed and blocklisted since 2026-09-29, 9 episodes still missing | none |
| P1 | Fix safety guards: season guard, Replacement Preview, Same Release refusal, language check before destroy, playback triage (D-09, D-08 rules 1-2) | Today's destructive paths would have harmed Cases A and C | none |
| P2 | Queue-aware Force Search, the Import Check, the Title Evidence engine, janitor classes `importable` and `title_mismatch` (D-07, D-05 engine) | The most frequent failure: 262 stuck Sonarr records on 2026-09-27 (#597), Case B | none |
| P3 | Seerr Issue mirror (read-only), title page and admin surfaces, the onboarding link, admin issues list with linked repairs and a staff note (D-10 read, D-11, D-12) | The steering channel and the working record; no writes | none |
| P4 | Title Check census, Episode Re-map, Mislabel Block (D-04, D-05) | Case A; #597's Lioness and Penguins mis-identifications | none |
| P5 | Release Pick with guarded override (D-06) | Case A's two profile-rejected episodes | Q-01 ruled: anyone who can use Fix, missing items, within the budget, every reason overridable |
| P6 | Language-aware Wrong language: Plex preference, language-filtered search (D-08) | Case A's Portuguese default; the last wrong_language Fix deleted a file | Q-03 ruled: set the preference only for the original language |
| P7 | Seerr writes: comment and resolve (D-10 writes) | Brings reporters to the fix | Q-02 ruled: comment and resolve as a bot user |
| P8 | The rule: the owner's call (D-12) | Decides when "fix it yourself" is the default | Owner judgment (ADR-112); Q-05 ruled, Q-04 amended, Q-09 moot |

### P0: stop blocklisting releases SABnzbd failed to unpack (issue #887)

1. `packages/domain/src/queue-cleanup.ts`: "Found archive file, might need to be extracted" no longer matches
   `bad_release`; it classifies `unknown` with the reason "archive left unpacked". DESIGN-046 gains a dated decision
   row (the D-10 pattern) and a pointer to DESIGN-055 D-14.
2. Tests: `queue-cleanup.test.ts`: the archive message alone is `unknown`; a real release defect ("Sample", "Unable to
   parse") stays `bad_release`.
3. After the deploy: search again by hand the 9 missing episodes (The Loud House 7, The Really Loud House 2), and record
   it in the PLAN-065 ladder log.
4. Follow haynes-ops#3834; once SABnzbd extracts these posts, read 7 days of census for the message and record whether
   it should ever act again.
- **e2e:** none beyond the gate. **Live check:** the next hourly run records archive items as `unknown`, with no
  `blocklisted_searched` row for that reason.
- **Done when** a week of runs shows no archive removal and the 9 episodes are searched.
- **Status (2026-10-12): shipped; the week of census is owed.**
  - Steps 1 and 2: hnet #890 (DESIGN-046 D-26) shipped in v0.111.2, deployed by haynes-ops #3840 around 17:22Z. The
    17:25Z run ran on it.
  - Step 3: done the same day, by hand, with no app code; see #887 and the PLAN-065 ladder log. 83 false blocklist
    entries were removed (Sonarr 82, Radarr 1). Fixing the SABnzbd side also needed: the 83 janitor-removed jobs
    deleted from SABnzbd's archived history (its duplicate check failed every re-grab as "Duplicate NZB"), 4 resulting
    "Duplicate NZB" Sonarr entries removed, and 3 mislabelled TLHG files (S10E05, E09, E12, other episode pairs)
    moved to a hold folder. All 9 episodes have files.
  - Step 4: haynes-ops#3834 was fixed by haynes-ops #3836, a post-processing script on both SABnzbd instances. It
    extracted 5 obfuscated posts with no hand step. The 7-day census read is OC-048, and deleting the hold folder is
    OC-049.

### P1: Fix safety guards and playback triage

1. Reads: `listReleases` (episode, movie), file `mediaInfo` audio languages, Playback Evidence from the stored Tautulli
   `play`/`stop` notifications plus Tautulli history.
2. Season guard (D-09): episode choice, packs backing unchosen episodes are not marked; the same pack warning on an
   episode Fix.
3. Replacement Preview and Same Release refusal on every delete path; "nothing to replace it" refusal. Verify whether
   `GET /release` returns the *arr's decision order (DESIGN-055 Q-07); otherwise rank by the profile, and record which.
4. Wrong language rules 1-2 (D-08): read the audio first; with the language present, no blocklist and no delete,
   guidance only (P6 adds the Plex write).
5. Won't play triage (D-09): the no-play message with Watch-here links, the known-issues server list (an app setting,
   HaynesOps for haynes-ops#3833), then the guarded Fix.
6. The Repair Guide shell (D-01) with these entries, behind the kill switch.
7. Ops: confirm all three Tautulli instances post `play`/`stop` to `/api/webhooks/tautulli`; add the Playback Error
   trigger with the DESIGN-012 template. Record which instance posts what.
- **Tests:** `fix-guards.test.ts`, `language-check.test.ts`, guide component tests; DESIGN-005 D-15 gains a pointer.
- **e2e:** stub-arr gains the release list, `mediaInfo` and pack grab history. Journeys: the season guard on a stub
  season with a pack, and Case C (AC-42).
- **Live check:** as a non-admin test account on `haynesnetwork.haynesops.com`, open the Fix guide on GoodFellas and on
  The Lost Tapes S01 and stop at each preview: GoodFellas shows the no-play message, then the Same Release refusal; the
  season guide shows the pack warning. No write is sent.
- **Done when** the live previews match and the remedies are switched on.
- **Status (2026-10-12): shipped, verified live, remedies on.** [#897](https://github.com/thaynes43/haynesnetwork/pull/897)
  (v0.112.0) and [#901](https://github.com/thaynes43/haynesnetwork/pull/901) (v0.112.1: Playback Evidence matches the
  session's Plex identity; no user row carried a Plex username), deployed by haynes-ops
  [#3847](https://github.com/thaynes43/haynes-ops/pull/3847) and [#3848](https://github.com/thaynes43/haynes-ops/pull/3848),
  3/3 web pods on v0.112.1. The live checks (read-only, `tsx /sync/src/scripts/repair-guide.ts` in a web pod, 20:00Z):
  GoodFellas' preview refuses the Same Release (its next release is FraMeSToR's own Remux-2160p, a 99.48 GB Usenet post
  for the 87.61 GB file, basis `identity`); Ludwig (2024) S01, a live 6-episode pack, holds the pack back for a
  season Fix that chose only E01 (nothing safe: refused) and shows its 5-episode cost on an episode Fix; The Lost Tapes
  S01 (no pack left after the hand fix) marks E14's own download and leaves E12 (no download record) for an episode
  Fix; S01E12's audio reads Portuguese and English; Playback Evidence reads `no_play` for the non-admin test account on
  GoodFellas and `played` (HaynesOps history, by plex.tv id) for a play of the night before. Step 7 done the same day:
  the template gained `server` and Playback Error on HaynesOps and HaynesKube, and HaynesTower's Tautulli now posts
  the same webhook through the LAN route (`haynesnetwork.haynesops.com`); each read back. The four remedies were then
  switched on (audited, actor null, 20:05Z); the Known-Issue Servers stay empty (haynes-ops#3833 fixed). OC-050 watches
  the first webhooks and guided Fixes. The plan's UI walkthrough as a non-admin cannot run from inside the cluster
  (the sign-in goes through the public Authentik); e2e `repair-guide.spec.ts` covers the UI. Earlier status lines:
  build details below. What landed, and the decisions behind it, are DESIGN-055
  D-09's "P1 decisions" (items 1-9) and D-08's P1 note:
  - Steps 1-6: `fix-guards.ts` (pure), `fix-plan.ts` (the read-only plan, `fix.preview`), `language-check.ts`,
    `playback-evidence.ts`, the guarded path in `fix-flow.ts`, the guide (`repair-guide.tsx`, rules in
    `lib/repair-guide.ts`) and the admin card on `/admin/fixes`. Two audited settings, migration 0098:
    `repair_guide_remedies` (four remedies, all off) and `playback_known_issue_servers`.
  - Step 3, Q-07's order half: resolved (the *arr decision order). The Same Release rule was refined on GoodFellas' live
    release list (Usenet sizes, custom-format score; D-09 P1 decision 4).
  - Step 7, read 2026-10-12: the HaynesOps and HaynesKube Tautullis post `play` and `stop`; HaynesTower's posts nothing
    to the app. The template change (`server`, Playback Error) is applied after the deploy.
  - Tests: `fix-guards.test.ts` (domain, pure, on the live GoodFellas and Lost Tapes reads), `fix-guards.test.ts` (api,
    end to end on embedded Postgres), `release-clients.test.ts` (arr), `repair-guide.test.ts` (web rules),
    `repair-guide-script.test.ts` (sync); e2e `repair-guide.spec.ts`: Case C (AC-42) and the season guard (AC-40's
    season half). The live check runs `tsx /sync/src/scripts/repair-guide.ts` in a web pod (the app's sign-in cannot
    be driven from inside the cluster).

### P2: queue-aware Force Search, the Import Check and the janitor classes

1. Title Evidence engine (D-05 rules 1-5), pure, with the cases' real names as fixtures.
2. Reads: `getManualImport` by download id; queue records for a target. Write: `manualImport` (the `ManualImport`
   command), body pinned from Sonarr 4.0.20.3012 and Radarr 6.4.4.10685's own UI requests.
3. `repair_requests` aggregate and its single writer (D-02); budget and open-check changes.
4. Queue-aware Force Search (D-07 table) and the Import Check; "Import this download onto..." for `disagrees`.
5. Janitor (DESIGN-046 amendment): class `importable` with one enforce cell per instance, census by default; class
   `title_mismatch`, report-only. Migration widens the class CHECK. The PLAN-065 ladder log records the new cells.
6. CLAUDE.md hard rule 4: the ManualImport write-back (person and janitor) and queue removal from a person's Force
   Search.
- **Tests:** `title-evidence.test.ts`, `import-check.test.ts`, `repair-requests.test.ts`, `queue-cleanup.test.ts`
  (new classes), `write-clients.test.ts`.
- **e2e:** stub-arr gains manual import (read and command) and staged queue states with status messages. Journey: Case
  B (AC-41): Force Search on a missing episode with a blocked finished download imports it and sends no search.
- **Live check:** after the deploy, the census shows `importable` rows; spot-check every one against Sonarr's manual
  import view before any cell enforces (the PLAN-065 L0 to L1 pattern). Exercise Force Search on the next real stuck
  item, or record that none occurred.
- **Done when** the remedy is on, the census spot-check is recorded, and #597 Part 1 is closed with a link here.
- **Status (2026-10-12): shipped, verified live, remedy on.** [#905](https://github.com/thaynes43/haynesnetwork/pull/905)
  (v0.113.0) and [#907](https://github.com/thaynes43/haynesnetwork/pull/907) (v0.113.1: the file an import replaces is a
  ticked "gone afterwards" line, decision 15, found in this live check), deployed by haynes-ops
  [#3851](https://github.com/thaynes43/haynes-ops/pull/3851) and [#3853](https://github.com/thaynes43/haynes-ops/pull/3853):
  3/3 web pods, all 22 sync CronJobs, the owed-check runner and the Books Census on v0.113.1; migration 0099 applied.
  `import_check` switched on at 23:11Z (audited, actor null). Live checks (read-only, in a web pod):
  - `repair-guide.ts queue-check` over both queues: Sonarr 8 `importable`, 26 `title_mismatch`, 39 left for staff;
    Radarr 1 and 1. The 22:25Z janitor census wrote the same counts. Spot-check: 9 of 9 `importable` judged correct
    (PLAN-065 ladder log, 2026-10-12); the cells stay census (each import would replace a file on disk; OC-051 carries
    the flip).
  - `repair-guide.ts search-plan` on real stuck targets: Peppa Pig S09E30 and Franklin S01E05 go to staff (the release
    names another year); Butterbean's Cafe S01E62 goes to staff (the download holds only an unextracted `.7z`, never a
    removal); The Paper S02E06 (Case B, imported by hand on 2026-09-27) has nothing queued and searches; The Naked Gun 2½
    plans an import that lists its current WEBDL-2160p file as replaced.
  - No real Force Search press on a stuck item happened in the session; OC-051 records the first ones. The UI walkthrough
    as a member cannot run from inside the cluster (sign-in goes through the public Authentik); e2e
    `queue-aware-force-search.spec.ts` covers it.
  - #597 Part 1 closed by comment, with a link here.
- **Build (2026-10-12):** what landed, and the decisions behind it, are DESIGN-055 D-07's "P2 decisions" (items 1-15),
  D-05's and D-02's "As built" notes and DESIGN-046 D-27:
  - Steps 1-2: `title-evidence.ts` (pure, the live names of the motivating cases as fixtures, plus movie Title Evidence
    and the series-year rule), `import-check.ts` (pure), `getManualImport` (the download id only: Sonarr 4.0.20 lists
    the series folder when `seriesId` rides along), `getCommand`, and `manualImport` on both *arrs, its body pinned to
    each UI's own request.
  - Step 3: migration 0099 (`repair_requests`, the three ledger events, the janitor's class and action CHECKs);
    `repair-requests.ts`; the budget counts Repair Requests; the open check is shared both ways; the sync completes an
    import that outran the guide and times out a stale one.
  - Step 4: `queue-aware-search.ts` (`fix.searchPlan`, read-only; `fix.forceSearch` with the plan's digest), behind the
    new remedy `import_check` (ships off); the Force Search dialog's guide step, its copy, the `importDownload` media
    action, the admin switch, and a prefilled Helpdesk ticket for the staff path.
  - Step 5: DESIGN-046 D-27, `importable` (census) and `title_mismatch` (report only), at most 100 checks per instance
    per run, loop-guarded imports when enforced; `/admin/janitor` shows both rows.
  - Step 6: CLAUDE.md hard rule 4.
  - The in-cluster tool gains `tsx /sync/src/scripts/repair-guide.ts search-plan` (read-only, plans as if the remedy
    were on) for the live check.
  - Tests: `title-evidence.test.ts`, `import-check.test.ts`, `queue-aware-search.test.ts`, `repair-requests.test.ts`,
    `queue-cleanup.test.ts` (D-27), `manual-import-clients.test.ts` (arr), the router test in `fix-guards.test.ts` (api);
    e2e `queue-aware-force-search.spec.ts`: Case B (AC-41), a download on its way, the staff path with the prefilled ticket.

### P3: Seerr Issue mirror, surfaces, onboarding and metrics

1. Seerr reads `listIssues`, `getIssue`; table `seerr_issues`; sync mode `seerr-issues` (every 10 minutes) in
   haynes-ops (a new CronJob beside the other sync modes, short PR, no bare doc IDs in that repo).
2. Webhook: issue notifications trigger a read and are not stored in the Feed. Then, as a recorded and reversible step,
   set the Seerr webhook types from 204 to 4044 and read it back.
3. Title page banner, `/admin` Seerr issues list with "Mark fixed by hand" (staff note).
4. `/r/seerr/<id>` link route; verify the signed-out round trip through Authentik keeps the link.
5. Admin issues list shows the linked repairs (from the app's own records) and the staff note / "Mark fixed by hand" (D-12). No outcome scoring, streak or digest line (ADR-112).
6. Carried from P2 (DESIGN-055 D-07 P2 decision 13): Activity's admin row for a stuck *arr download shows its Import
   Check result (read-only, the same `checkSonarrImport` / `checkRadarrImport` the janitor runs).
- **Tests:** `seerr-issues-sync.test.ts`, `seerr-issues-admin.test.ts`, route tests for the link.
- **e2e:** stub Seerr issues; journey: a stub issue shows on its title page; the link after a stub sign-in opens the
  guide preselected (AC-43 read half); the admin Seerr issues view with linked repairs and the fixed-by-hand mark (AC-44).
- **Live check:** the four existing (resolved) Seerr issues appear in `/admin` with the right titles and episodes, and
  the link for issue 3 opens The Paper's S02E06 guide.
- **Done when** a new real issue appears within one run and its link works signed out.
- **Status (2026-10-13): shipped and verified live.** [#911](https://github.com/thaynes43/haynesnetwork/pull/911)
  (v0.114.0; the advisory review's one finding, a Sonarr read inside the mirror's write transaction, fixed in the PR),
  deployed by haynes-ops [#3857](https://github.com/thaynes43/haynes-ops/pull/3857): 3/3 web pods, all 23 sync CronJobs
  (the new `sync-seerr-issues` every 10 minutes at :06), the owed-check runner and the Books Census on v0.114.0;
  migration 0100 applied. Live checks (read-only toward Seerr except the webhook types below):
  - The first `seerr-issues` run (a Job from the CronJob, 00:40Z) mirrored all 4 issues, all resolved, with the right
    titles and grains: 4 Regular Show: The Lost Tapes Season 1, 3 The Paper (2025) S02E06 (Sonarr episode 85215),
    2 GoodFellas, 1 The Four Seasons (2025) Season 1. Issue 3 links one Force Search from the app's own records; the
    link for issue 3 resolves to The Paper's title page (S02E06 has a file now, so its guide is Fix on S02E06).
  - `/r/seerr/3` on the in-cluster route, signed out: the onboarding card, nothing about the report, at 1280 and 390
    wide. "Sign in with Plex" reached Authentik; the stored sign-in state's `callbackURL` is `/r/seerr/3` (and no
    new-user override), so the round trip comes back to the link. The signed-in leg cannot run from inside the cluster
    (Authentik with a real Plex account); e2e `seerr-issues.spec.ts` covers it with the stub sign-in.
  - Step 2, the recorded reversible step: Seerr's webhook types went from 204 to 4044 at 00:44Z (round-tripped, read
    back: URL, payload, auth header and custom headers unchanged by hash). To revert, POST the same object with
    `types: 204` to `/api/v1/settings/notifications/webhook`. An `ISSUE_COMMENT` for issue 3 posted to a web pod's
    webhook answered 202 `unchanged` (one fresh read, no Feed row).
  - Activity's admin Import Check read (P2 decision 13) on the open *arr failures: Rugrats 2021, Franklin 2025 and
    Peppa Pig 2022 read `title_mismatch` (needs staff), Aqua Teen and Pawn Stars `not_importable` with the *arr's
    rejection, a Lidarr failure is not offered. These match P2's census.
  - No new real Seerr issue was filed in the session, so "Done when" waits on OC-052.
- **Build (2026-10-12):** DESIGN-055's "P3 decisions" (items 1-12, after D-11) record what landed and why:
  - Step 1: `SeerrClient.listAllIssues` / `getIssue` (strip mode, fixture from the live read), migration 0100
    (`seerr_issues`, the run kind, the audit action), `packages/domain/src/seerr-issues.ts` (the single writer:
    `syncSeerrIssues`, `refreshSeerrIssue`, `setSeerrIssueStaffNote`, and the reads), sync mode `seerr-issues`.
  - Step 2: an `ISSUE_*` webhook triggers `refreshSeerrIssueFromEnv` and is never stored in the Feed.
  - Steps 3 and 5: the title page banner (`seerr-report-banner.tsx`, routed by `seerrGuideEntry`), `/admin/seerr`
    (linked repairs, the fix-it-yourself link, "Mark fixed by hand" with its audited note).
  - Step 4: `/r/seerr/<id>` (`lib/seerr-link.ts`): the onboarding card signed out, the title page with the guide open
    signed in, cards for the rest.
  - Step 6: `activity.importCheck` and the failure page's admin Import Check row.
  - Tests: `seerr-issues.test.ts` (arr), `seerr-issues-sync.test.ts` and `seerr-issues-admin.test.ts` (domain),
    `seerr-issues-sync.test.ts` (sync), `seerr-issues.test.ts` and `activity.test.ts` (api), `seerr-issues.test.ts`,
    `seerr-link.test.ts` and the webhook tests (web), migration 0100; e2e `seerr-issues.spec.ts` (AC-43 read half,
    AC-44, the link cards, the webhook), with stub Seerr issues in `stub-arr.ts` (also served by `dev:local`).

### P4: Title Check, Episode Re-map and the Mislabel Block

1. Sync mode `title-check` (hourly at :35) and table `title_checks`; read 7 days of census and tune the thresholds
   (DESIGN-055 Q-06) before the Import Check relies on `disagrees`.
2. Re-map plan (pure) and flow (D-04 rules 1-12); write `renameFiles`.
3. Mislabel Block: table, grammar and compile check, single writer, upkeep in `title-check`, the result-step offer.
4. Adopt Case A's hand profile: write its term into the Mislabel Block, read back, then delete the tag profile and the
   `lost-tapes-release-block` tag by hand and read back.
5. CLAUDE.md hard rule 4: RenameFiles and the Mislabel Block.
- **Tests:** `remap-plan.test.ts`, `remap-flow.test.ts`, `mislabel-block.test.ts`, `title-check.test.ts`.
- **e2e:** stub-arr gains episode files that can move and `RenameFiles`. Journey: Case A (AC-40) on a stub season with
  8 files one slot low: highest first, nothing lost, E11 left missing with the Release Pick offered.
- **Live check:** run a preview-only re-map on The Lost Tapes S01 (already fixed by hand, so the guide must find nothing
  to move) and read the first week's Title Check flags.
- **Done when** the remedy is on and the first Mislabel term is the adopted Lost Tapes one.
- **Status (2026-10-13): shipped, verified live, remedy on.** [#915](https://github.com/thaynes43/haynesnetwork/pull/915)
  (v0.115.0), [#918](https://github.com/thaynes43/haynesnetwork/pull/918) (v0.115.1: a flag a person cannot move goes
  to staff; a library's own file names are no evidence) and [#920](https://github.com/thaynes43/haynesnetwork/pull/920)
  (v0.116.0: staff run the re-map from the cluster; the in-cluster tools drain stdout before exiting), deployed by
  haynes-ops [#3861](https://github.com/thaynes43/haynes-ops/pull/3861), [#3873](https://github.com/thaynes43/haynes-ops/pull/3873)
  and [#3882](https://github.com/thaynes43/haynes-ops/pull/3882): 3/3 web pods and all 24 CronJobs (the new
  `sync-title-check` hourly at :35) on v0.116.0; migration 0101 applied. `episode_remap` switched on at 03:05Z (audited,
  actor null). Live checks:
  - Preview-only re-map of The Lost Tapes S01 (`repair-guide.ts remap-plan --tvdb 475718 --season 1`): nothing to move,
    no suggestion.
  - Library-wide Title Check (`title-check --backfill`, after a dry run): 18,205 files judged from 22,546 import records
    (529 series). 692 disagreed. 15 of those named the library's own earlier mapping (12 from The Loud House hand fix
    re-imported from a hold folder, 3 Be Cool, Scooby-Doo!); decision 16 records them silent, leaving 677 across 44
    series. Spot-checks against the files' subtitles confirmed the names 3 of 3 (Abbott Elementary S01E08 holds "Step
    Class", Guy's Grocery Games S03E05 holds "Around the World in Three Carts", Ben 10 (2016) S03E42 holds "My
    Bodyguard"). Plex orders TV by TMDB on both servers (The Loud House by TVDB); for 548 of the 692, Plex shows the
    slot's own title, so viewers saw one title and got another episode.
  - The first hourly run (02:35Z) judged 194 imports from the last 48 hours: 14 disagreed, 12 of them the Loud House
    hold-folder names (now silent).
  - Fixed through the re-map, as staff (`remap-run`, decision 17), the five seasons a single claim could fix, after
    checking no one had watch state on them: Ben 10 (2016) S3 (20 files, +1), Clarence (2014) S2 (32 files, -1), Guy's
    Grocery Games S32E10, The Practice S06E17, Bob the Builder S15E08. 55 moves, each read back, all renamed; file counts
    on disk unchanged; Plex shows the moved Ben 10 files on their right episodes. 622 flags stay open: 17 a person can
    move from the title page, 605 need staff because the episode the name points at keeps its own file (whole-season
    reorderings and rotations, issue #916, DESIGN-055 Q-11).
  - Mislabel adoption: the BiOMA term on The Lost Tapes is the first Mislabel term (profile id 4, read back). The hand
    profile (id 3, tag 31) stays with its five other blocks until Q-10 is ruled.
  - No Seerr issue or person pressed the re-map yet; e2e `remap-episodes.spec.ts` covers the UI, and dev:local
    screenshots at 1280 and 390 wide were checked (flags, the shift question, the preview, the result with the offer).
- **Build (2026-10-13):** DESIGN-055's "P4 decisions" (items 1-17, after D-05) record what landed and why.
  - Step 1: migration 0101 (`title_checks`, `mislabel_block_terms`, run kind `title-check`, audit action
    `remove_mislabel_term`); `title-check.ts` (`runTitleCheck`, `backfillTitleChecks`, `listTitleFlags`,
    `titleCheckSummary`); sync mode `title-check` (the census, then the Mislabel upkeep); the nightly digest line;
    `repair-guide.ts title-check --backfill [--dry-run]` and `--flags <seriesId>`; the import history read with the
    dropped path. Q-06 is read on the library-wide census (below), not on 7 days.
  - Step 2 (in-cluster preview: `tsx /sync/src/scripts/repair-guide.ts remap-plan --tvdb <id> --season <n> [--shift 11:+1[:18] | --move 24:23]`, read-only): `remap-plan.ts` (pure) and `remap-flow.ts` (`readRemapSeason`, `planEpisodeRemap`, `runEpisodeRemap`); the
    Sonarr reads `listSeasonImportCandidates`, `listRenamePreview`, `listCommands` and the write `renameFiles`;
    `appendRepairActions`; the fix router's `remapSeason`, `remapPlan`, `remap`, `titleFlags`; the remedy
    `episode_remap` (ships off). No discard tick: a re-map never deletes a file (owner ruling in the P4 work order).
  - Step 3: `mislabel-block.ts` (`deriveMislabelTerm`, `addMislabelTermFromRemap`, `adoptMislabelTerm`,
    `reconcileMislabelBlock`, `mislabelBlockUpkeep`, `removeMislabelTerm`), the term template `renderMislabelTerm` in
    `release-terms.ts`, the router's `mislabelBlock`, `mislabelTerms`, `removeMislabelTerm`, and the CLI
    `tsx /sync/src/scripts/mislabel-block.ts list|adopt|reconcile`.
  - Step 4 (adoption) is a live step after the deploy; only the BiOMA group term fits ADR-110 C-04, so the hand
    profile keeps its five other terms until the owner rules on DESIGN-055 Q-10.
  - Step 5: CLAUDE.md hard rule 4.
  - UI: the guide's "It's a different episode of this show" and "They're all off by one" paths, the preview, the
    result with Force Search for each emptied episode and the Mislabel offer, the title page flag ("Move it", a new
    `moveFile` media action), and `/admin/fixes` (the switch, a Mislabel Block card, a Title Check card).
  - Tests: `remap-plan.test.ts`, `remap-flow.test.ts`, `title-check.test.ts`, `mislabel-block.test.ts` (domain),
    `episode-remap.test.ts` (api), the arr client tests, `title-check-sync.test.ts` and the repair-guide script test
    (sync), migration 0101, `remap-guide.test.ts` and `repair-guide.test.ts` (web); e2e `remap-episodes.spec.ts`: Case A
    (AC-40) on a stub season, the flag's single move, the admin removal.
- **Q-10 ruling (owner, 2026-10-13: A, ADR-113): built in [#924](https://github.com/thaynes43/haynesnetwork/pull/924),
  live in v0.117.0, adopted 2026-10-13 12:26Z.** DESIGN-055 D-05 "Q-10 ruling decisions" record the design.
  - Build: migration 0102 (`mislabel_block_terms.kind`, `name_token`, `release_group` nullable, origin `staff`, the
    kind/field and kind/origin CHECKs, the active unique index per kind); `release-terms.ts` `renderMislabelNameTerm`,
    `mislabelNameKindOf`, `isMislabelNameTerm`; `mislabel-block.ts` `parseMislabelName`, `deriveMislabelNameTerm`,
    `addMislabelNameTerm`, `saveTerm` for both kinds, `isMislabelBlockTerm` for both, kind-aware reads and removal;
    the Sonarr series schema's `alternateTitles`; the CLI's `add-name` and `adopt` name flags; the `/admin/fixes`
    card's kind labels. Tests: `mislabel-block.test.ts`, `release-terms.test.ts`, migration 0102, the script test.
  - Read live before the build (2026-10-13, read-only): series 1061's alternate title is exactly "Regular Show Die
    verlorenen Videos"; its episodes 11, 13 and 24 are "Spice It Up", the Halloween special and "Don's Back", so none of
    the three pairs names its own episode. Profile 3 holds the six terms; the Mislabel profile (id 4) holds the
    sentinel and the BiOMA term.
  - **Done after the deploy (2026-10-13, 12:25Z to 12:27Z), in order.** All five dry runs derived the expected terms.
    The real adoptions saved five active terms (origin `adoption`, `total` 6 with BiOMA). Read back: profile 4 holds
    the sentinel, the BiOMA term and the five name terms. Profile 3 was deleted (`DELETE /releaseprofile/3`, 200;
    profiles now 1, 2, 4). Tag 31 was removed from series 1061 (series editor, `applyTags: remove`; tags now [1, 4]).
    Tag 31 was then deleted (200), and the tag list no longer holds it or its label. The steps as planned
    (staff, in the web pod:
    `kubectl -n frontend exec deploy/haynesnetwork-main -c app -- tsx /sync/src/scripts/mislabel-block.ts ...`):
    1. Each of the five with `--dry-run` first, then without: `adopt --series 1061 --alias "Regular Show Die verlorenen
       Videos"`, `adopt --series 1061 --double S01E13E14`, `adopt --series 1061 --pair "S01E11 Secret Menu"`,
       `adopt --series 1061 --pair "S01E13 Smoke Alarm"`, `adopt --series 1061 --pair "S01E24 All You Can Fit"`.
    2. Read back the Mislabel profile (id 4): the sentinel, the BiOMA term and the five name terms; `list` shows six
       active terms on series 1061.
    3. Delete release profile 3 by hand and read back that it is gone.
    4. Remove tag 31 from series 1061 and read back the series' tags.
    5. Delete tag 31 (`lost-tapes-release-block`) and read back the tag list.
  - Seen in the same read, outside Q-10: hand profile 2 ("T.O.T.S.: block mislabeled MULTI and DUTCH postings", tag 30
    on series 724) holds `\bMULTI\b`, `\bDUTCH\b` and `\bThe[ ._-]Case[ ._-]of[ ._-]the\b`. None is a group, a
    pair, a double or an alternate title, so it stays a hand profile; ADR-113 does not cover it.

### P4 follow-up: the Season Re-map (issue #916, DESIGN-055 Q-11 ruled A)

The library-wide Title Check left 622 open flags: 17 a person could move, 605 whole-season reorderings and rotations the
person's re-map refuses by design. Owner ruling (2026-10-13): staff fix them with a season re-map that follows the
names, never deleting a file, after a watch-state check on every Plex server and an evidence spot-check per season.

- **Build:** DESIGN-055 P4 decisions 18 to 24. `season-remap-plan.ts` (pure: names or staff placements, holds that
  never displace, the order with a Parking Episode for each cycle, the unplaced files with suggestions and the open
  episodes) and `season-remap-flow.ts` (`planSeasonRemap`, `runSeasonRemap`: the Plex check against every server that
  carries the series, then one ManualImport and one RenameFiles per step, each read back, the file's Title Check carried
  to its new id (`carryTitleCheckForward`), the file count checked after);
  `remap-flow.ts` exports its season read with every source name. Staff tool: `repair-guide.ts season-plan | season-run`
  (`--place`, `--keep`, `--digest`, `--ignore-plex`). Glossary T-316 Season Re-map and T-317 Parking Episode.
- **Tests:** `season-remap-plan.test.ts` (chains, a swap, a rotation, two swaps through one parking episode, no parking,
  second copies, collisions, an unplaced file and its placement, a two-episode placement, keep, refusals, the Plex check)
  and `season-remap-flow.test.ts` (embedded Postgres and a stateful stub Sonarr: a swap and a rotation end on their own
  episodes under their own names with nothing orphaned; a skipped rename stops the run and reports the parked file; a
  changed plan, a failed Plex check and the switch off refuse); the repair-guide script test.
- **Shipped:** [#923](https://github.com/thaynes43/haynesnetwork/pull/923), v0.117.0 (with Q-10's #924), deployed by
  haynes-ops [#3888](https://github.com/thaynes43/haynes-ops/pull/3888). 3/3 web pods, all 24 CronJobs, the owed-check
  runner and the Books Census run v0.117.0, and migration 0102 is applied.
- **Second-Copy Fix (DESIGN-055 P4 decision 25, issue #928):** `second-copy-fix.ts` (`planSecondCopyFix`,
  `runSecondCopyFix`) and `repair-guide.ts copy-plan | copy-run`; `createFixRequest` takes a null requester for the
  staff tool. Tests: `second-copy-fix.test.ts` (the delete, read-back and search as staff; only copy, content elsewhere,
  a name that agrees, `--copy-of`, a changed plan, no evidence) and the script test. Its live run is in #928.
- **Live run (2026-10-13, 12:26Z to 13:20Z, declared `act-122609-88358`).**
  - **Census before:** 622 open flags (40 series, 92 seasons). **After:** 400 (35 series, 73 seasons).
  - **Checks first.** Plex watch state was read from both server databases (read only, every account) at 07:20Z, at
    12:07Z, and again at 12:34Z before the second half; every season run was clear. Evidence came from five read-only
    passes over the files' own subtitle streams, or title-card frames where a file had none (short reads,
    `nice -n 19`, one at a time). They confirmed the names in every season run. They also placed the files whose names
    say nothing, and found the second copies.
  - **Moved:** 29 seasons, 263 files, each read back and renamed, with nothing orphaned. Sonarr's file count and the
    disk's video-file count per series were unchanged after every season.
    - 237 files now sit on their own episodes.
    - 26 are second copies or other content that staff moved aside to the episode their chain left open (decision 19).
      They are still wrong there, and that episode's own file is missing.
    - Plex (HaynesOps and HaynesTower) holds every file of all 29 seasons on the episode Sonarr has it on: 0 wrong and
      0 missing. Every moved season's Plex titles follow TVDB.
  - **Seasons run (placements and keeps in brackets):**
    - Married... with Children S4 [13:11], S5 [14:13, 19:21, 20:22, 22:23, 23:24], S6, S8, S9 [13:12, 19:18, 18:17,
      17:16], S10 [17:18, 18:19] and S11.
    - Law & Order S9, Bluey Book Reads S1, My Little Pony S3, Fireman Sam S11 and Lilo & Stitch S2. In Lilo & Stitch S2,
      Plex calls one file's episode "Woops" before and after, so it is no worse.
    - Guy's Grocery Games:
      - S6 [keep 13; 12:10] and S8 [keep 11; 10:5].
      - S16 [1:6, 11:10]: a holiday special and S17E06 moved aside.
      - S17: its one free move.
      - S19 [14:15, 15:16, 18:13] and S20 [keep 21, 28; 20:3, 27:22].
      - S37.
    - Alaskan Bush People S2 [1:8] and S6 [1:8] (specials moved aside), and S9 [1:2, 4:5].
    - American Dad! S12 [1:12, 2:13, 3:14]: three files of other episodes moved aside.
    - Ben 10 (2016) S4 [18:10, 26:23].
    - Stuck in the Middle S2 [2:6, 8:12, 14:20] and S3 [4:10, 12:17].
    - Henry Danger S5 [4:21, 23:32, 34:35, 37:38].
    - Star Wars Rebels S1 [9:7] and Batman: The Animated Series S1 [21:23].
  - **Left open (400 flags), by reason.** Issue #916 has the per-season list; follow-up issue #928 carries what needs a
    decision.
    - Watch state, not moved by owner rule (135 flags, 31 seasons). Seasons with a person's play, watched mark or resume
      point on HaynesTower: Abbott Elementary S1-S2, Anthony Bourdain S5 and S8, Bob the Builder S1-S2, Bubble Guppies
      S1 and S5, Daniel Tiger S4-S5, Fireman Sam S6, Guy's Grocery Games S12-S15, Malcolm in the Middle S5, Married...
      with Children S2-S3, Mecha Builders S1, Mickey Mouse S1, Paw Patrol S5-S6, Pokémon S3 and S5, Sister Wives S6,
      South Park S14, Spidey S1, The Simpsons S38 and The Wild Thornberrys S1-S3.
    - Plex numbers the season like the release, or differently from TVDB, so a move would not fix what viewers see or
      would make it wrong (90 flags): Alaskan Bush People S4; Fireman Sam S7, S9 and S10; Leah Remini S3; One Piece S22;
      Pokémon S8; The Thundermans S4; Midsomer Murders S12; The Fairly OddParents S3-S5.
    - Evidence contradicts the names or cannot place the files (95 flags): 60 Days In S2; Alaskan Bush People S5;
      Ben 10 (2016) S1; Henry Danger S4; SpongeBob S16; Midsomer Murders S5; Guy's Grocery Games S3 and S17;
      Pokémon S6 and S11; The Fairly OddParents S7.
    - Second copies whose own episode is missing (34 flags, including the 26 moved aside where they are flagged).
      Before the run: Henry Danger S2, Law & Order S3, Deadliest Catch S6, The Fairly OddParents S1. After it:
      Guy's Grocery Games S6, S8 and S20; Alaskan Bush People S9; Ben 10 (2016) S4; Henry Danger S5; Stuck in the
      Middle S2-S3; Batman S1. American Dad! S12's three and Alaskan Bush People S2 and S6's specials carry only the
      library's own names, so they are not flagged.
    - Ben 10 (2016) S2 (24 flags): six second copies block chains with only four free episodes.
    - Two-segment files that a name cannot place (20 flags): Arthur S19, New Looney Tunes S1-S2, Spidey S3.
    - No free episode in the whole series to pass a swap through (2 flags): S.W.A.T. (2017) S5.
  - **The 17 flags a person could move:** 7 were fixed in the same pass: Ben 10 (2016) S4 (5), Fireman Sam S11 (1) and
    Guy's Grocery Games S17 (1). The other 10 stay open:
    - The watch-state rule holds Spidey S1 (2) and The Wild Thornberrys S2 (1).
    - Evidence contradicts the names for Ben 10 (2016) S1 (2).
    - Each of the rest is a file holding two segments whose name names only one, so it needs a two-episode mapping:
      Spidey S3 (3) and New Looney Tunes S2 (2).

### P5: Release Pick

1. Release list display, plain-words rejection mapping, the three row states, hard refusals (D-06).
2. Write `grabRelease`, approved and override bodies pinned (DESIGN-055 Q-07); the import follow-through through P2's
   Import Check.
3. Apply Q-01's ruling: Override for anyone who can use Fix, missing items only, within the hourly Fix budget, when
   every rejection reason is overridable; Not allowed rows offer "Ask staff".
4. CLAUDE.md hard rule 4: the interactive grab.
- **Tests:** `release-pick.test.ts`; budget counting of `release_list_requested`.
- **e2e:** stub release list with approved, overridable and refused rows. Journey: grab an approved release; an
  override row's state follows the Q-01 ruling (Override for anyone who can use Fix, within the budget).
- **Live check:** open the list for a real missing episode as a non-admin and check that each row's state matches
  Sonarr's own interactive search for the same episode.
- **Status (2026-10-13): shipped, verified live, remedy on.**
  - Releases:
    - [#926](https://github.com/thaynes43/haynesnetwork/pull/926) (v0.118.0).
    - [#930](https://github.com/thaynes43/haynesnetwork/pull/930) (v0.118.1): a movie row whose name carries none of the
      movie's titles is a Hard Refusal; a disc image is never a pick. This is P5 decision 15, found in this live check.
    - [#935](https://github.com/thaynes43/haynesnetwork/pull/935) (v0.119.1): the recommended override weighs the
      library's custom formats. This is P5 decision 16, found in this live check.
  - Deployed by haynes-ops [#3889](https://github.com/thaynes43/haynes-ops/pull/3889),
    [#3890](https://github.com/thaynes43/haynes-ops/pull/3890) and [#3892](https://github.com/thaynes43/haynes-ops/pull/3892):
    3/3 web pods, all sync CronJobs, the owed-check runner and the Books Census on v0.119.1 (26 CronJobs). Migration 0103
    is applied. On v0.119.1 the recommended pick for SpongeBob S17E17 is the HDTV 1080p h264 release, not the x265 one.
  - `release_pick` was switched on at 13:35Z (audited, actor null).
  - The live checks used `repair-guide.ts release-list` in a web pod, read-only, against Sonarr's own `GET /release`:
    - **SpongeBob SquarePants S17E18** (missing, monitored): Sonarr's episode search returned 22 rows, all rejected for
      reasons on the overridable list (x265 at custom-format -9925, HDTV not wanted, 720p LQ, SDTV). The list showed 7
      Override rows grouped from 23 sources. The 23rd source, the season search's S17 pack of Unknown quality, showed as
      Not allowed. The states match Sonarr's.
    - **Real override grab** (staff `release-grab`, requester null): the HDTV 1080p h264 release
      (`...S17E18.Farmers.Market.Feud.1080p.HDTV.AAC2.0.x264-Slurpuff`) was grabbed at 13:35Z. Sonarr imported it onto
      S17E18 "Farmers Market Feud" at 13:37Z, and the 13:45Z sync completed the Repair Request from the ingested import.
      The x265 release the list had recommended led to decision 16.
    - **Zom 100: Bucket List of the Dead** (movie, missing): Radarr approved 33 releases of *The Convert* and *The List*
      (2023), because an indexer tagged them with its id. The list recommended *The Convert*, which led to decision 15.
      On v0.118.1 they are Not allowed and the pick is a real Zom 100 release. Radarr's own search still takes them, and
      it grabbed *The Convert* on 2026-10-01: issue [#931](https://github.com/thaynes43/haynesnetwork/issues/931).
    - **LEGO Ninjago: Dragons Rising S04E16:** one approved release is a Grab, and its blocklisted posting is refused.
    - **Spidey and His Amazing Friends S05E20:** only two-episode files (scene `E09E10`, TVDB E19 and E20). Both
      episodes are missing, but a release holding more than one episode is Not allowed under D-06. This is parked as
      issue [#936](https://github.com/thaynes43/haynesnetwork/issues/936).
    - **Peppa Pig S09E34:** the queue has a stuck download, so the list is not opened. It is P2's `title_mismatch`.
    - **The Loud House S10E19, S10E23, WWE SmackDown S28E41 and Bluey Book Reads S03E05:** nothing on the indexers, the
      same as Sonarr's own search.
  - Not run against the deployed site: the UI as a member. The app's sign-in goes through the public Authentik and
    cannot be driven from inside the cluster. Instead:
    - The e2e `release-pick.spec.ts` passed in CI (252/252).
    - The UI was driven on dev:local, with screenshots at 390 and 1280 wide checked: the list, the closed section, each
      confirm step, a refusal, the grabbed step, on-its-way and admin.
  - No person has picked yet. The first person's pick is OC-054.
- **Build (2026-10-13):** DESIGN-055's "P5 decisions" (items 1-16, after D-06) record what landed and why.
  - Step 1: `release-pick.ts` (`describeRejection`, the plain words, `RELEASE_REASONS_VERSION` 1; `classifyReleases`, the
    three row states, hard refusals winning, rows of one release on several sites grouped, the recommended pick;
    `openReleaseList`, `previewReleaseList`). The read is Sonarr's season list narrowed to the episode (P5 decision 2: Case
    A's E10-numbered pick never comes back from an episode search). Migration 0103: `release_pick_lists` (T-319, the guid
    kept server-side) and the `release_list_requested` ledger event; the budget counts it; the remedy `release_pick`
    (ships off, not a Fix remedy).
  - Step 2: `grabRelease` on both write clients, Q-07's override half resolved from the UIs' source at the running tags
    and pinned in `release-grab-clients.test.ts`; `grabFromReleaseList` (one `release_pick` Repair Request, then the plain
    or the override body); the follow-through is P2's Import Check; `settleReleasePicks` closes a pick whose download
    failed and `completeRepairRequests` completes one that imported (both in the sync post-steps); `computeRepairProgress`
    and `fix.repairProgress` for the live chip. The open check for an episode remedy is its episode (P5 decision 6).
  - Step 3: Q-01 in `classifyReleases` and `openReleaseList` (missing items only, every reason overridable, `canPick` from
    the budget); Not allowed rows offer "Ask staff" (a prefilled Helpdesk ticket).
  - Step 4: CLAUDE.md hard rule 4.
  - The router's `releaseList` (a mutation), `releaseGrab`, `repairProgress`; the in-cluster tools
    `tsx /sync/src/scripts/repair-guide.ts release-list (--tmdb <id> | --tvdb <id> --episode S01E05) [--json]` (read-only)
    and `release-grab ... --key <row key>` (staff's Release Pick, requester null, P5 decision 14).
  - Tests: `release-pick.test.ts` (domain: the plain words, Case A's E11 and E13 lists read live, the end-to-end list,
    grab, follow-through, settling and completion, the refusals, the budget, a movie), `repair-requests.test.ts` (the
    per-episode open check), `release-grab-clients.test.ts` (arr), `release-pick.test.ts` (api), the migration 0103 test,
    the repair-guide script test.

### P6: language-aware Wrong language

1. Check whether Plex offers a movie-level preferred audio language (DESIGN-055 Q-08).
2. Under Q-03's ruling: `setItemPreference` through `@hnet/plex/write` with a read-back on every server that has the
   title; ADR-017's confined surface notes the new call.
3. Language-filtered grab when the language is missing (D-08 rule 4), through P5's grab.
- **Tests:** `language-check.test.ts` (the write and its read-back), `write-clients.test.ts` for Plex.
- **e2e:** stub Plex preferences. Journey: a file with the wanted language sets the preference (or shows guidance,
  per Q-03); one without it grabs a matching release.
- **Live check:** read back The Lost Tapes' show-level preference on each server; no other title changes.

### P7: Seerr writes

1. Q-02 ruled B (owner, 2026-10-12). Staff create the Seerr bridge user with `MANAGE_ISSUES`; store its id in
   `seerr_bridge_user_id`.
2. `seerr_issue_writes` table and single writer; comment and resolve as in D-10; `X-API-User` on every call.
3. CLAUDE.md hard rule 4: the Seerr issue comment and resolve.
- **Tests:** `seerr-issue-writes.test.ts`: one comment across a crash and a retry; resolve only after completion.
- **e2e:** stub Seerr records the acting user. Journey: AC-43's write half.
- **Live check:** the next real issue gets exactly one comment from the bridge user, and is resolved after its repair.

### P8: the rule (owner's judgment)

Owner clarification, 2026-10-12 (ADR-112, DESIGN-055 D-12): "The gate is a judgment call, not a count. The intention is to keep building haynesnetwork.com until it can handle the kinds of problems people actually report, then steer users to fix things themselves instead of staff fixing them. Working practice: every new Seerr issue is worked through haynesnetwork.com's self-service tools first, as a user would. When a tool fixes it, the reply teaches the user that tool. When no tool can, staff fix it by hand and the missing capability is added to the plan. The owner decides when coverage is good enough to make self-service the default."

1. From P3 on, work every new Seerr issue through haynesnetwork.com's self-service tools first, as a user would. When a
   tool fixes it, the reply teaches that tool. When none can, fix it by hand, mark it in `/admin` with a note, and add
   the missing capability to this plan.
2. When the owner decides coverage is good enough, record it here and in HANDOFF, then apply Q-05's ruling: Seerr filing
   stays open; the Seerr comment wording, the About page and the MOTD copy say to try fixing it on haynesnetwork.com
   first.
- **Done when** the owner confirms the rule is in effect. Then move this plan to `completed/`.

## Out of scope

- Books, audiobooks and comics (ADR-062 owns book Fix) and Lidarr; PLAN-041 keeps the parity goal.
- Any automatic re-map, or any automatic Mislabel Block term (each needs its own ADR and owner ruling).
- Subtitle-text and title-card evidence (DESIGN-055 Alternatives).
- Changing Tautulli's 120-second history filter (the play webhooks already see short sessions).
- #597's library-state janitor classes, the Penguins of Madagascar decision and the has-file records (PLAN-065).

## Rollback

Each remedy has its kill switch (`repair_guide_remedies`); off restores today's dialog for that remedy. Janitor cells
go back to census through `/admin/janitor`. Seerr writes stop when `seerr_bridge_user_id` is cleared. New tables are
additive; a code revert leaves them unread. The Mislabel Block's terms can be removed by its writer (expire all) or by
deleting the managed profile in Sonarr, which only lifts blocks.
