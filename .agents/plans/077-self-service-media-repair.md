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
  follow-up below; open flags 622 to 400, then 321 after the #928 round, then 155 after the Watch Carry run). The owner's ruling on #928 ("Carry marks, then move") is ADR-114, the Watch Carry: shipped in v0.122.0 and v0.123.0, and run live 2026-10-13 (P4 follow-up). P5 (Release Pick) is shipped and verified live, remedy on: v0.118.0 ([#926](https://github.com/thaynes43/haynesnetwork/pull/926)), v0.118.1 ([#930](https://github.com/thaynes43/haynesnetwork/pull/930)) and v0.119.1 ([#935](https://github.com/thaynes43/haynesnetwork/pull/935)). Its first person's pick is OC-054. P6 (language-aware Wrong language) is shipped and verified live, both remedies on: v0.121.0 ([#942](https://github.com/thaynes43/haynesnetwork/pull/942)), v0.122.1 ([#951](https://github.com/thaynes43/haynesnetwork/pull/951), [#953](https://github.com/thaynes43/haynesnetwork/pull/953)) and v0.122.2 ([#954](https://github.com/thaynes43/haynesnetwork/pull/954)); 144 English originals set to English as staff; its first person's report is OC-055, and the 13 non-English originals got the owner's "English if present" ruling ([#955](https://github.com/thaynes43/haynesnetwork/issues/955), ADR-115), applied in v0.123.1. P7 is next.
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
- **Live run (2026-10-13, 12:26Z to 12:49Z, declared `act-122609-88358`).**
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
    - Watch state, not moved by owner rule (135 flags, 31 seasons; the #928 round below later moved Bob the Builder S1
      and Married... with Children S2, which every account with state had watched in full). Seasons with a person's play, watched mark or resume
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
- **The #928 round (2026-10-13, 13:05Z to 15:05Z, declared `act-130511-110073`; coordinator rulings on #928 items 1
  to 3).** Open flags 400 to 321 (32 series, 61 seasons).
  - **Plex ordering, staff hand op (item 1; no app write, so no ADR).**
    - Watch state was read on both servers' databases at 13:04Z for every account and every season of each show.
    - Four shows had none. Each was switched to TheTVDB (Aired) (`PUT /library/metadata/<show>/prefs?showOrdering=tvdbAiring`,
      then `.../refresh`) on HaynesOps and HaynesTower, and the titles were read back per season:
      - Midsomer Murders: 143 of 144 items carry the TVDB title.
      - The Fairly OddParents: 258 of 268; the rest are spelling variants.
      - Leah Remini: Scientology and the Aftermath: 24 of 25.
      - One Piece: all 1179 items numbered as Sonarr numbers them (translation variants of the titles).
    - The re-maps then ran: Midsomer S12 (2 files), The Fairly OddParents S3 (2), S4 (2) and S5 (4), Leah Remini S3
      (11, of which 2 are extra episodes TVDB does not list, moved aside), One Piece S22 (9, of which 2 are copies moved
      aside).
    - The Thundermans was switched, then set back to the library default. Plex's own TVDB data for S4 runs one
      episode off Sonarr's, so neither ordering titles S4 right.
    - Left for the owner because someone has watch state on the show: Alaskan Bush People (one account, S14), Fireman
      Sam (one account, S1 to S6) and Pokémon (seven accounts, S1 to S5).
  - **Second-Copy Fix (item 2; DESIGN-055 P4 decision 25; #932, v0.119.0, haynes-ops #3891).**
    - Two read-only evidence passes compared each suspected copy with the file on its named episode (subtitle
      windows, durations, frame fingerprints). 27 were confirmed copies. 23 were not, and stay: 13 were different
      content and 10 were the only copy of their content.
    - Ben 10 (2016) S2 and S4 were rechecked after their files moved: all nine "copies" hold other content, because
      the WEBDL mp4 files on the named episodes are themselves misfiled. They are only copies, kept, and left as
      evidence work.
    - 37 slots were fixed as staff (Fix Request, requester null, delete, read-back, EpisodeSearch), one at a time,
      waiting for each season's queue to empty.
      - The first searches grabbed the same mislabelled releases again, numbered for another episode. SABnzbd failed
        most as Duplicate NZB, and Sonarr blocklisted them.
      - Three imported anyway: Batman S1E09, Henry Danger S2E18 and Law & Order S3E16. Staff removed each again; Law
        & Order's release was also blocklisted by hand (`POST /history/failed/66106`).
      - To stop the loop, staff added 23 Mislabel Block pair terms (ADR-113, origin `staff`) for the exact mislabelled
        names: The Thundermans 4, Deadliest Catch 1, Guy's Grocery Games 4, Stuck in the Middle 4, Batman 10. Law &
        Order's term was refused (`names_other_series`).
    - Bounded wait to 15:04Z. 27 slots now hold their own episode: Batman 10, Guy's Grocery Games 4, Stuck in the
      Middle 4, One Piece 7, Henry Danger S5E35 and E38. Each import's name agrees, or its subtitles were checked.
    - 10 are missing, honestly, with no correct release found yet: Batman S1E59, Deadliest Catch S6E16, Henry Danger
      S2E18, Law & Order S3E16, The Fairly OddParents S1E05 and E08, The Thundermans S4E07, E19, E25 and E26.
    - Batman S1E54 and E59 were swapped first (a re-map), so the Zatanna copy could be removed from E59.
    - No wrong import remains.
  - **Watched seasons (item 3; facts, plus a move only where every account with state has watched the whole season).**
    - 11 accounts, all on HaynesTower, hold 42 account-season pairs across the 31 seasons: 8 complete, 34 partial.
    - Fully watched by every account with state, and moved: Bob the Builder S1 (9 files) and Married... with
      Children S2 (7).
    - Not moved:
      - The Simpsons S38: its only flag is a second copy, and a Fix would leave a mark on an episode nobody watched.
      - Daniel Tiger S5 and Mickey Mouse S1: re-pairing two-episode files can create new, unwatched Plex episodes.
    - Moving each account's marks and resume points is technically possible for all 11 (the owner, and 10 friends
      through their per-server tokens on plex.tv's shared_servers), but not today. The app writes Plex only as the
      owner, cannot set a resume point, and drops friend tokens. That needs new code and an owner decision (#928).
  - Ben 10 (2016) S2 was re-mapped once its copies were placed on open episodes: 22 files, 18 now right.
- **The Watch Carry (ADR-114, DESIGN-055 P4 decisions 26 to 34; owner ruling on #928, 2026-10-13: "Carry marks, then
  move").** Every staff move now carries every person's Plex watch state onto the content they watched, so the held
  watched seasons and the three held shows' ordering can move.
  - **Build:** `@hnet/plex` reads `listLeafFiles` (each item's files and the token account's state),
    `getShowOrdering` and `listSharedServerAccess` (each friend's per-server token, never stored), and writes
    `setProgress`, `setShowOrdering` and `refreshMetadata` (`carry-read.ts`, `write.ts`). Migration 0104
    (`watch_carries`, `watch_carry_states`, `watch_carry_marks`). `watch-carry.ts` (snapshot, pre-clear, wait, carry,
    verify, revert; the pure `carryCalls`, `contentStates`, `planCarryTargets`), `watch-carry-plex.ts` (the clients from
    the env, one per account), `show-ordering.ts` (`planShowOrdering`, `runShowOrdering`). `runSeasonRemap` and
    `runSecondCopyFix` take `watchCarry`; the planner parks a two-episode file (decision 34). Staff tool:
    `season-run` and `copy-run` always carry; `ordering-plan | ordering-run`, `carry-status`, `carry-finish`,
    `carry-revert`. Glossary T-326 Watch Carry and T-327 Carry Snapshot; PRD R-272; hard rule 4.
  - **Tests:** `watch-carry.test.ts` (the pure plan; over embedded Postgres, a stub Sonarr and an in-memory Plex whose
    state follows the guid: a swap two friends watched ends with each mark on its content and no stale mark; an
    unreadable account refuses the move with nothing written; a failed clear puts every clear back and refuses; a view
    after the snapshot is left alone and `carry-finish` writes nothing more; `carry-revert` restores; the Second-Copy
    Fix credits the original and clears the slot; an ordering switch re-matches and the carry follows), the Plex client
    tests (`carry.test.ts`), the parking test in `season-remap-plan.test.ts`, migration 0104 and the script test.
  - **Tool gaps the evidence found (DESIGN-055 P4 decisions 35 to 37):** a placement may change the episode count or name
    episodes apart (`17:33-34`, `5-8:3-4`, `29-30:25+32`); a second open cycle parks on a second free episode; the
    Second-Copy Fix takes a copy that sits on several episodes. Tests: `season-remap-plan.test.ts` (one onto two, two
    onto one, two cycles sharing a file), `second-copy-fix.test.ts` (a two-episode copy), the script test.

  - **Shipped:** [#944](https://github.com/thaynes43/haynesnetwork/pull/944) (v0.122.0) and
    [#950](https://github.com/thaynes43/haynesnetwork/pull/950) (v0.123.0: decisions 35 to 37, and a byte-identical copy
    told apart by file name), deployed by haynes-ops [#3897](https://github.com/thaynes43/haynes-ops/pull/3897) and
    [#3901](https://github.com/thaynes43/haynes-ops/pull/3901). Migration 0104 is applied.
  - **Live run (2026-10-13, 17:14Z to 20:10Z, declared `act-171435-245325`).** One season at a time, each a Job or a pod
    exec of `repair-guide.ts`, after the read-only evidence passes (subtitles, title cards, durations; notes kept with
    each run's evidence line).
    - **Carries:** 66 verified, 6 refused, with nothing written or everything put back. The refused runs were a season
      re-map whose parking episode had an open Fix, and copy fixes whose episode had one. 0 mismatches, 0 failed writes.
      There were 117 pre-clears and 116 carried marks, each one a `watch_carry_marks` row.
    - **Per account** (12 people: the owner on both servers and 11 friends; counts only): 0 mismatches for every
      account. In all, 359 watched files sit on the item that plays them, 35 resume points sit on their file's item, and
      no item whose file an account never played carries a mark.
    - **Spot-checked against the Plex database** (read only):
      - Malcolm in the Middle S5: E18 and E19 swapped with their marks.
      - Sister Wives S6: a one-step shift; each watched story and the resume point followed its file.
      - The Simpsons S38: E01 has both plays, and E02 is cleared before its real episode arrives.
    - **Seasons re-mapped with the carry:**
      - Malcolm S5, Abbott Elementary S1 and Parts Unknown S5.
      - The Wild Thornberrys S1 to S3, Guy's Grocery Games S12 to S15 and Married... with Children S3.
      - Pokémon S3 (the T0Bi pair only) and S5 (E41 to E64 one step up), and Sister Wives S6.
      - Daniel Tiger's Neighborhood S4 and S5 (E10-E17 by two-episode swaps, then E18-E25 through two parking episodes).
      - Fireman Sam S6, S7, S9 (with `--ignore-plex`: five Plex items keep Plex's own old titles; Plex titles matching
        their file went from 9 of 25 to 20 of 25) and S10.
      - Paw Patrol S5 (two runs), Bob the Builder S2, and Spidey and His Amazing Friends S1 (every file placed on its
        two TVDB segments) and S5.
    - **Second-Copy Fixes with the carry:**
      - Abbott S2E14, Parts Unknown S8E07, and Guy's Grocery Games S12E06, S14E04 and S15E05.
      - Pokémon S5E41, South Park S14E12, Fireman Sam S6E03 and S10E22.
      - Bubble Guppies S1E11, E12 and E14, and Paw Patrol S5E11, E12, E15, E17, E25 and E44.
      - Paw Patrol S6E48-49 (`--copy-of 46-47`), The Simpsons S38E02 (byte-identical) and Spidey S5E09-12.
    - **Plex ordering switched to TheTVDB (Aired) with whole-show carries:** Alaskan Bush People, Fireman Sam, Pokémon
      (1329 of 1346 items now titled as TVDB, up from 613), and Bob the Builder. Plex numbered Bob S2 like the release, so
      Bob is one more show than #928 named.
    - **Re-grabs of mislabelled releases:**
      - Fireman Sam S06E03 re-imported BurCyg's "S06E03 Dinosaur Hunt" (E16).
      - Pokémon S05E41 re-imported JC's "Beauty is Skin Deep" (E42).
      - Paw Patrol S05E25 re-imported NF's "Pups Save the Tigers" (E26).
      - Each was removed again with a second copy fix.
      - Staff pair terms were added: Fireman Sam "S06E03 Dinosaur Hunt", Paw Patrol "S05E12 Snowshoeing Goodways" and "S05E25 Pups Save the Tigers". Pokémon's term was refused (`names_other_series`: Pokémon Concierge).
      - Paw Patrol S05E44's search imported NICK's "S05E44E45" (TVDB E43 and E44) over E45. E45's story (Stargazer) still lives in the LAZY E46 copy, so that copy was kept.
    - **Ben 10 (2016) (the #928 secondary item; no account has watch state on the show):**
      - Re-maps from title cards and subtitles:
        - S1: `--place 1:6,3:1,6:3 --keep 12,16,23,24`. Most flagged S1 mp4s hold their own slot; their flags are
          false positives.
        - S2: three cycles.
        - S4: the two-part E01 and E02 files go onto two episodes each.
      - Copy fixes: S1E03, and S2E10, E14, E21, E27 and E35-36.
      - Re-grabs, removed again: the S2 searches re-imported LAZY's own mislabels, byte-identical copies of E11, E25
        and E26. Staff pair terms now block "S02E10 High Stress Express", "S02E14 Bounty Ball" and "S02E21 The Charm
        Offensive".
      - Held: S1E10 and E12 hold Ben 10 (2005) episodes. A delete and search is not a second-copy fix, so they wait for
        the owner.
    - **Title Check:** 321 open flags at the start of the work order, 310 just before the first run, 155 after (Ben 10's
      re-maps cleared flags, and the hourly census re-judges the files that moved).
    - **The Wrong-Content Replace** (DESIGN-055 P4 decision 38; coordinator ruling on #928: "they are bugs, fix them",
      C then A): `wrong-content-replace.ts`, `previewReplacementList` and `sendReleaseGrab` in `release-pick.ts`,
      migration 0106 (Watch Carry kind `wrong_content`), the carry's `droppedDetail`, and `repair-guide.ts replace-plan |
      replace-run`. Tests: `watch-carry.test.ts`: a replace that drops a mark on content held nowhere else; and a slot
      kept while no release names it, then replaced with its mark credited to the copy elsewhere; two files replaced at
      once from parts, with a renumbered release judged by its own name and one search for the run. Also migration 0106
      and the script test (`--also`, `--key a,b`, `--slots`, `replace-batch`).
      Review recovery: deletion failures stop grabs; the persisted carry separates confirmed removed, retained and
      unresolved files. `carry-finish` reads Sonarr again before reconciling a Wrong-Content Replace; a retained file's
      marks are restored only to that same file, and unresolved outcomes keep the carry open. Failure-path tests cover
      total and partial deletion failure, unverified read-back and failed grabs. No automatic search is promised.
    - **Held** (#928 and OC-056 list them with reasons):
      - Waiting for open Fix requests to close (48 hours): Bubble Guppies S5, whose only parking episodes are the
        emptied S1 slots, and Paw Patrol S5 E43-E47 (`--place 44-45:43-44,46:45,47:46-47`).
      - Needs no tool change, needs the owner:
        - Mickey Mouse: Mixed-Up Adventures S1: its files are Season 3 stories, and the real S1 is mostly missing.
        - Pokémon S3: E01-E34 hold Pokémon Horizons episodes.
      - Cannot run:
        - Mecha Builders S1: no free episode in the series.
        - Alaskan Bush People S4: Plex's own metadata keeps the old numbering even under TVDB, so a move would make all
          8 titles wrong.
        - Fireman Sam S6E01-E13: copies of S7 stories in another season.
        - Pokémon S8: the flag is a false positive; the title card shows E32 is right.
        - Paw Patrol S5E29-30: holds E25's story and a copy of E32.

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
    is applied. Decision 16 checked live on v0.119.1: E18 had a file by then, so it was read on S17E17 "Duct Tape Dystopia",
    the next missing episode, which has the same release shape. Its recommended pick is the HDTV 1080p h264 release, not
    the x265 one.
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
- **Follow-ups (2026-10-13, 14:30Z to 16:30Z): issues #931 and #936.**
  - **#931, Radarr grabbing another movie for Zom 100.**
    - **Zom 100:** staff picks with `release-grab`. The recommended 2160p NF WEB-DL DUAL failed in SABnzbd ("Aborted,
      cannot be completed", an old post), and its pick closed as failed from the history. The OzONE 1080p NF WEB-DL
      (Grab) imported at 14:45Z onto Radarr movie 9830, and both Repair Requests closed as they should. Plex HaynesTower
      and PlexOps show the 130-minute film. The Convert runs about 107 minutes.
    - **Find the rest:** read-only, every Radarr grab since 2026-07-03 (1362 grabs) through `movieTitleEvidence`.
      Eight movies had another movie's release grabbed:
      - The four still missing: Zom 100 (The Convert), Croc (Supergator, DrunkenSlug), A Movie of Eggs (Alatriste) and
        Star Wars Rebels: Spark of Rebellion (four Star Wars Rebels season packs).
      - Croc: staff override pick of the English `Croc.2007.720p.WEB.x264-ASSOCiATE` (the only real releases are 720p or
        below), imported 14:41Z. Plex on both servers shows the 88-minute film.
      - A Movie of Eggs and Spark of Rebellion: no indexer has a real release. Every listed one is the wrong title and is
        blocklisted or below the profile, so Radarr cannot grab one on its own.
      - The other four have a file that is not the wrong grab. Hannibal Rising, Horrible Bosses 2 and Scooby-Doo carry
        their own scene names, and Josee's file predates the grabs. That grab was probably the Korean live-action Josee
        (2020).
    - **`title_mismatch` not enforced:** there is no cell (ADR-110 C-02), and the fresh spot-check fails the ladder's
      bar. Radarr's only row is a right release (Hope, `Hopeu.2026`), and 10 of Sonarr's 26 are probably right
      (Peppa.Pig.2022). Evidence is in PLAN-065's ladder log, 2026-10-13.
    - **The Radarr Mislabel Block:** not built. Release names carry nothing of the movie they were tagged for, so it
      needs movie tags, a new write kind. Radarr never imports these on its own ("matched to movie by ID"). The
      decision is parked with evidence and options in [#940](https://github.com/thaynes43/haynesnetwork/issues/940).
    - **NinjaCentral:** not reported. Its per-release report needs a signed-in browser session; there is no other
      channel from the cluster.
  - **#936, a multi-episode release fills every missing episode it holds (DESIGN-055 P5 decision 17).**
    - [#939](https://github.com/thaynes43/haynesnetwork/pull/939) (v0.120.0, deployed by haynes-ops
      [#3894](https://github.com/thaynes43/haynes-ops/pull/3894)). The override lists every episode, one Repair Request
      holds them all, the confirm names each, and completion and the live chip wait for every import.
    - **Live check, 15:50Z: the motivating case was wrong.** Spidey S05E20's list offered the untitled `S05E09E10`
      files for E17 to E20, because Sonarr's scene mapping files them there. Staff picked RBB's, and it imported onto
      E17 to E20. Its own subtitles open with "Aunt May's Flying House" and "Spiders Versus Flies": TVDB E09 and E10.
      The file was deleted by hand at 15:56Z and read back. E17 to E20 are missing again, PlexOps' Season 5 was
      rescanned, and no Plex account had watched any S5 episode.
    - [#945](https://github.com/thaynes43/haynesnetwork/pull/945) (v0.120.1, haynes-ops [#3895](https://github.com/thaynes43/haynes-ops/pull/3895)): a multi-episode
      release the *arr renumbers (mapped numbers other than the name's) is never a pick, code `renumbered`. Read live
      on v0.120.1: S05E20's JFF and RBB rows are Not allowed with that reason. S05E17 to E20 cannot be fixed from the
      app: no indexer has their content.
    - **The rest of Spidey S5 was already misfiled:** five of its six 24-minute files sit on the wrong episodes. The
      subtitle evidence and the right placement are on
      [#928](https://github.com/thaynes43/haynesnetwork/issues/928#issuecomment-6149686202). This needs hand
      ManualImports: the Season Re-map's `--place` cannot shrink a four-episode mapping to two.
- **Build (2026-10-13):** DESIGN-055's "P5 decisions" (items 1-16, after D-06, and 17 from the follow-ups) record what
  landed and why.
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
- **Status (2026-10-13): shipped, verified live, both remedies on; 144 English originals set to English as staff.**
  - Releases:
    - [#942](https://github.com/thaynes43/haynesnetwork/pull/942) (v0.121.0): the Audio Preference, the Language Replace,
      the guide and the staff tools.
    - [#951](https://github.com/thaynes43/haynesnetwork/pull/951) and [#953](https://github.com/thaynes43/haynesnetwork/pull/953)
      (v0.122.1), found in this live check:
      - The daily full sync's Sonarr run had failed since 2026-10-09: Sonarr sent "Zodiac (2028)" without
        `statistics`, which failed the whole `GET /series` parse. The scan failed the same way. A missing `statistics`
        now reads as nothing on disk, and Radarr falls back to `hasFile`.
      - The Language Replace never takes another post of the file's own release (DESIGN-055 P6 decision 13).
    - [#954](https://github.com/thaynes43/haynesnetwork/pull/954) (v0.122.2): the Audio Preference reads a show's own Plex
      item, not a same-named movie in a movie library. Twelve Sonarr titles have one; Love, Death & Robots is the case
      found.
  - Deployed by haynes-ops [#3896](https://github.com/thaynes43/haynes-ops/pull/3896),
    [#3899](https://github.com/thaynes43/haynes-ops/pull/3899) and [#3900](https://github.com/thaynes43/haynes-ops/pull/3900). Web pods, all 26 CronJobs, the
    owed-check runner and the Books Census are on each version. There is no migration.
  - A one-off full sync on v0.122.1 (17:47Z) ran Sonarr cleanly again: 1,069 series, 2 inserted, 322 history rows
    relinked.
  - **Live reads** (staff tools in a web pod, read-only), on v0.121.0:
    - **Regular Show: The Lost Tapes S01E12, English:** `already_set`. The original is English, the file is `present`,
      and HaynesTower 552877 and HaynesOps 106050 both read `en-US`. Plex's own tracks: Português (EAC3 5.1) is the
      default, English (EAC3 5.1) is second.
    - **Butterbean's Cafe season 1, English:** `already_set` on both servers.
    - **Boruto S01E01, English:** guidance, `not_original` (the original is Japanese; the English track is the file's
      default).
    - **JUJUTSU KAISEN S02E06, Japanese:** `set` would write `ja` on both servers. Asking for English there is
      `not_present` (the file is Portuguese and Japanese).
    - **GoodFellas:** guidance, `movie` (Q-08).
  - **Language Replace** (`language-plan`, read-only), JUJUTSU KAISEN S02E06, English:
    - On v0.121.0 the pick was OLYMPUS's "MULTi" post of the file's own release. That led to decision 13.
    - On v0.122.1 the pick is `...REPACK.1080p.BluRay.DUAL.FLAC.2.0.x264-Kitsune` (English and Japanese).
  - **Remedies:** `audio_preference` was switched on at 16:54Z and `language_search` at 17:49Z (each audited, actor
    null).
  - **The staff sweep** (`repair-guide.ts audio-scan`, then `--apply-original eng`, 17:50Z to 17:52Z):
    - The scan read 965 series and 63,648 files. 181 have files that carry the original language behind another one.
      For 143 English originals, Plex confirmed that the sample file starts in another language: Star Trek: Voyager in
      German on 107 episodes, Jessie in Czech, SpongeBob, Mickey Mouse Clubhouse, ER, Paw Patrol, and others.
    - All 143 were set to English as staff. Each is a completed `audio_preference` Repair Request (requester null), read
      back on HaynesTower and HaynesOps, with no failure.
    - The re-scan afterwards shows 145 set (with The Lost Tapes and Butterbean's Cafe) and no English original left
      open. Twenty more have files that lead with another language, but Plex starts the sample in English (the file's
      own default flag), so they need nothing.
    - Love, Death & Robots could not be read on the first pass (its HaynesOps match was a same-named movie). On v0.122.2
      it was set to English as staff (preview, then `--digest`) and reads back `en` on both servers.
    - The final re-scan on v0.122.2 shows 146 set and no English original open. Two remain unread: Sugar has no Plex
      match at all, so there is nothing to write, and Ranma ½ (2024) is a Japanese original.
    - The 13 non-English originals went to the owner as [#955](https://github.com/thaynes43/haynesnetwork/issues/955). The
      ruling (2026-10-13) was **"English if present"**, recorded in ADR-115 and DESIGN-055 P6 decision 14 (it amends
      ADR-109 C-07 for staff writes only).
  - **The household sweep** (`audio-scan --apply-household`, v0.123.1, 19:38Z to 19:40Z), from #958 and #960:
    - 30 shows were set, each a completed Repair Request with the rule recorded and read back on every server that
      carries the show.
      - 11 non-English originals now play English first: One Piece, Dragon Ball, Alpha Males, Demon Slayer, JUJUTSU
        KAISEN, 30 Coins, Iron Reign, Attack on Titan, Gudetama, Berlin (2023) and Sweet Home. Every one of them has
        English tracks, so none needed the original language.
      - 19 English originals had some files that still started in another language: DuckTales, Henry Danger, Phineas
        and Ferb, and others.
    - 3 no-ops, where every English file already starts in English: Boruto, Pokémon: Twilight Wings and Frieren.
    - 146 shows were already set. 2 have no Plex match (Sugar; Ranma ½ (2024)), so there was nothing to write.
    - Boruto reads as a no-op, as expected. One Piece does not: some of its files start in German, French or Hindi, so
      it was set to English.
  - **UI:** the deployed site's sign-in cannot be driven from inside the cluster. Instead:
    - e2e `wrong-language.spec.ts` passed in CI.
    - The guide was walked on dev:local at 390 and 1280 wide, and the screenshots were checked: the language question,
      the offer, its result, already set, another language, the season list, the Language Replace preview, its refusal
      and its result.
  - First person's report: OC-055.
- **Build (2026-10-13):** DESIGN-055's "P6 decisions" (items 1-12, after D-08) record what landed and why. No migration:
  the Repair Request kind `audio_preference` was already allowed (0099), and the two remedies are keys of
  `repair_guide_remedies` (`audio_preference`, `language_search`, both ship off).
  - Step 1: Q-08 answered live: a show only (P6 decision 1). A movie gets the guidance.
  - Step 2: `@hnet/plex` `getAudioLanguagePreference`, `getAudioTracks` (read) and `setAudioLanguagePreference` (write,
    `PUT /library/metadata/{key}/prefs?audioLanguage=`); the domain's `audio-preference.ts` (`decideAudioPreference`,
    `previewAudioPreference`, the single writer `setAudioPreference` with its Repair Request and per-server read-back);
    the router's `fix.audioPreference` (read-only) and `fix.setAudioPreference`; the *arrs' `originalLanguage`.
  - Step 3: the Language Replace (`language-replace.ts`: `readLanguagePlan`, `pickLanguageRelease`,
    `previewRepairPlan`; `fix-flow.ts` `runLanguageFix`), its own plan kind in `fix.preview`.
  - The guide: the track advice per player, the offer and its result, the season's episode list, the Language Replace
    preview and its refusal; the admin card gains both remedies. CLAUDE.md hard rule 4 names both writes.
  - Staff tools in a web pod: `tsx /sync/src/scripts/repair-guide.ts audio-preference (--tmdb <id> | --tvdb <id>
    (--episode S01E05 | --season <n>)) --language eng` (read-only; with `--digest` it writes as staff), `language-plan`
    (read-only) and `audio-scan [--json] [--apply-original eng]`.
  - Tests: `language-aware.test.ts` (domain), `audio-language.test.ts` (plex), `repair-guide.test.ts` (web rules),
    `repair-guide-script.test.ts` (sync), the remedies list in `fix-guards.test.ts` (api); e2e `wrong-language.spec.ts`
    (the stub *arr's `POST /_stub/language`, the stub Plex's show preferences and S01E03's tracks).
  - dev:local walk at 390 and 1280 wide: the offer, its result, already set, another language, the season list, the
    Language Replace preview, its refusal and its result.

### P7: Seerr writes

1. Q-02 ruled B (owner, 2026-10-12). Staff create the Seerr bridge user with `MANAGE_ISSUES`; store its id in
   `seerr_issue_bridge` (P7 decision 2: the setting also holds the comment and resolve switches).
2. `seerr_issue_writes` table and single writer; comment and resolve as in D-10; `X-API-User` on every call.
3. CLAUDE.md hard rule 4: the Seerr issue comment and resolve.
- **Tests:** `seerr-issue-writes.test.ts`: one comment across a crash and a retry; resolve only after completion.
- **e2e:** stub Seerr records the acting user. Journey: AC-43's write half.
- **Live check:** the next real issue gets exactly one comment from the bridge user, and is resolved after its repair.
- **Staff smoke preparation (2026-10-13):** DESIGN-055 P7 decision 11 adds the audited, bounded
  `seerr-bridge.ts --smoke` / `--smoke-cleanup` fixture tool, migration 0107. It creates only media 10974's marked
  staff test as user 19, distinguishes the invitation from the initial test report, simulates a linked repair with
  no library writes, checks one resolve, and deletes only its own fixture. The test does not satisfy OC-052.
- **Bridge user (staff one-off, 2026-10-13 20:18Z, P7 decision 1):** `POST /api/v1/user` on Seerr (local user, username
  "haynesnetwork.com", email `seerr-bridge@haynesnetwork.com`, random password never stored; Seerr's local login is off),
  then `POST /api/v1/user/19/settings/permissions` with `1048576` (MANAGE_ISSUES only), read back: Seerr user 19,
  `userType` 2, permissions 1048576. Undo: `DELETE /api/v1/user/19` (and clear the setting first).
- **Build (2026-10-13):** DESIGN-055 "P7 decisions" (items 1-10, after D-11) record what landed and why:
  - Migration 0105: `seerr_issue_writes` (one row per issue and kind, never user 1), `fix_requests.seerr_issue_id`, the
    partial indexes on both link columns, and the `seerr_issue_bridge` setting key.
  - `@hnet/arr`: `SeerrClient.getUser`, `SeerrWriteClient.commentOnIssue` / `resolveIssue` (with `X-API-User`; user 1 is
    refused before any call), and per-request headers in `ArrHttp`.
  - `packages/domain/src/seerr-issue-writes.ts`: the setting (`getSeerrIssueBridge`, `setSeerrIssueBridge`), the words,
    the single writer (`runSeerrIssueBridge`: claim, read fresh, adopt or post, complete), `resolveSourceFor`, and the
    admin reads. `seerr-issue-link.ts`: the exact link the repair and Fix writers keep (`seerrIssueLinkFor`).
  - The bridge runs after every `seerr-issues` sync and after an issue webhook that changed the mirror (`after`).
  - Staff tool `tsx /sync/src/scripts/seerr-bridge.ts`: `--show` (the setting, the bridge user, recent writes),
    `--set [--user <id>|none] [--comment on|off] [--resolve on|off]` (audited, actor null), `--run [--issue <id>]`.
  - The guide sends `seerrIssueId` from a report's banner or link (`SeerrIssueLinkContext`); `/admin/seerr` gains the
    "Replies in Seerr" card and each report's replies.
  - Tests: `seerr-issue-writes.test.ts` (domain), the bridge clients in `seerr-issues.test.ts` (arr), the bridge pass in
    `seerr-issues-sync.test.ts` (sync), the settings in `seerr-issues.test.ts` (api), the webhook's pass in
    `webhook-route.test.ts` (web), migration 0105; e2e `seerr-bridge.spec.ts` (AC-43's write half: one comment as the
    bridge user, then the note and the resolve after Case B's import from the report's link), with the stub Seerr
    recording `X-API-User`.

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
go back to census through `/admin/janitor`. The Seerr comment stops when its switch in `seerr_issue_bridge` is turned off on
`/admin/seerr` (or `seerr-bridge.ts --set --comment off`), the resolve likewise; both off stops every Seerr write, and
deleting Seerr user 19 stops them too (each pass checks the user first). New tables are
additive; a code revert leaves them unread. The Mislabel Block's terms can be removed by its writer (expire all) or by
deleting the managed profile in Sonarr, which only lifts blocks.
