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
- **Validation:** each phase's live check below, then P8's gate.

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
| P3 | Seerr Issue mirror (read-only), title page and admin surfaces, the onboarding link, readiness metrics (D-10 read, D-11, D-12) | The steering channel and the measurement; no writes | none |
| P4 | Title Check census, Episode Re-map, Mislabel Block (D-04, D-05) | Case A; #597's Lioness and Penguins mis-identifications | none |
| P5 | Release Pick with guarded override (D-06) | Case A's two profile-rejected episodes | Q-01 ruled: anyone who can use Fix, missing items, within the budget, every reason overridable |
| P6 | Language-aware Wrong language: Plex preference, language-filtered search (D-08) | Case A's Portuguese default; the last wrong_language Fix deleted a file | Q-03 ruled: set the preference only for the original language |
| P7 | Seerr writes: comment and resolve (D-10 writes) | Brings reporters to the fix | Q-02 ruled: comment and resolve as a bot user |
| P8 | Readiness gate and the rule (D-12) | Decides when "fix it yourself" is the rule | Q-04, Q-05 ruled (DESIGN-055 D-12) |

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

### P3: Seerr Issue mirror, surfaces, onboarding and metrics

1. Seerr reads `listIssues`, `getIssue`; table `seerr_issues`; sync mode `seerr-issues` (every 10 minutes) in
   haynes-ops (a new CronJob beside the other sync modes, short PR, no bare doc IDs in that repo).
2. Webhook: issue notifications trigger a read and are not stored in the Feed. Then, as a recorded and reversible step,
   set the Seerr webhook types from 204 to 4044 and read it back.
3. Title page banner, `/admin` Seerr issues list with "Mark staff-assisted".
4. `/r/seerr/<id>` link route; verify the signed-out round trip through Authentik keeps the link.
5. Outcomes (D-12) nightly, the admin readiness view, one digest line.
- **Tests:** `seerr-issues-sync.test.ts`, `self-service-outcomes.test.ts`, route tests for the link.
- **e2e:** stub Seerr issues; journey: a stub issue shows on its title page; the link after a stub sign-in opens the
  guide preselected (AC-43 read half); the readiness view (AC-44).
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
  override row's state follows the Q-01 setting.
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

### P8: readiness gate and the rule

1. Implement Q-04's gate in the admin readiness view (the streak, the replays) and run the replays it names.
2. When the gate passes, record it here and in HANDOFF, then apply Q-05's ruling (Seerr comment wording, permissions,
   About page and MOTD copy as it says).
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
