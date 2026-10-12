# PLAN-077: Self-service media repair and the Seerr issue bridge — implementation

- **Status:** Active. Docs Accepted (owner, 2026-10-12: ADR-109, ADR-110, ADR-111, DESIGN-055). The owner ruled
  DESIGN-055 Q-01..Q-05 (the recommended option each time) and approved P1..P8 in this order, one phase per release,
  each verified live before the next. P0 is shipped (v0.111.2); its week of census is owed (OC-048). P1 is next.
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
- **Build (2026-10-12):** what landed, and the decisions behind it, are DESIGN-055 D-07's "P2 decisions" (items 1-14),
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
    e2e `force-search-guide.spec.ts`: Case B (AC-41), a download on its way, the staff path with the prefilled ticket.

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
