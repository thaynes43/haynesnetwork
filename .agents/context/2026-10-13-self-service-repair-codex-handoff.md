# Self-service media repair: handoff to Codex (2026-10-13)

The owner handed this program from a Claude Code coordinator session to a Codex agent, because Claude Code usage ran
low. This note is the cold-start resume point for the whole program. Read it first, then `.agents/HANDOFF.md` (newest
entries at the top), PLAN-077 and DESIGN-055.

## Goal (owner, 2026-10-12)

Steer Plex users to fix media problems themselves on haynesnetwork.com instead of filing Seerr issues for staff.
Before that becomes the default, the platform must reliably fix the kinds of problems people actually report.

- **Readiness is the owner's judgment, not a count** (ADR-112). Never build streak or metric gates, and never ask him
  metric-definition questions.
- **Working practice:** work each new Seerr issue through haynesnetwork.com's self-service tools first, as a user
  would. When a tool fixes it, the reply teaches the user that tool. When no tool can, staff fix it by hand, and the
  missing capability becomes plan work.

## Program docs and status

| Doc | Role |
|---|---|
| PLAN-077 | Phases P0 to P8 and the per-phase notes |
| DESIGN-055 | Decisions and rulings (Q-01 to Q-12) |
| ADR-109 to ADR-115 | Accepted. Every new *arr, Plex or Seerr write is listed in CLAUDE.md hard rule 4 |
| PRD R-262 to R-271, US-18 to US-19, AC-40 to AC-45 | Requirements |

| Phase | What | State |
|---|---|---|
| P0 | Janitor stops removing unextracted archives; SABnzbd extracts obfuscated 7z | Live |
| P1 | Fix safety guards (season pack, same-release refusal, audio check, play evidence) | Live |
| P2 | Queue-aware Force Search, Import Check, janitor `importable` / `title_mismatch` | Live; `importable` enforced on Sonarr and Radarr |
| P3 | Seerr issue mirror, `/r/seerr/<id>` onboarding, `/admin/seerr` | Live |
| P4 | Hourly Title Check, Episode Re-map, Mislabel Block, staff Season Re-map, Watch Carry | Live |
| P5 | Release Pick, including two-episode releases | Live |
| P6 | Language-aware Wrong language (Audio Preference, Language Replace) | Live |
| P7 | Seerr bridge: bot comments once per issue, resolves on completed repair | **Live and on in v0.125.0**, checked 2026-10-13 23:09Z |
| P8 | Working practice per ADR-112 | Admin guidance live in v0.125.1; practice only, owner readiness decision pending |

**Latest repair state, 2026-10-14 11:21Z:** Pokemon E28/E29 passed finishes 36/43; twenty-six approved replacements are complete, six remain, with E8/E31
held. E30 replacement 44 was delivered once at 11:18:05.361Z and is in progress. Mickey E29/E30, E31/E32,
E33/E34 and E35/E36 passed finishes 74/80/85/90; fifteen initial slots are complete and E37 is in progress.
These four pairs imported natively, with no ManualImport, regrab or invented owned-import intent. Source/English,
whole native files, original normal completion, strict captured-account marks and protected identities passed.
[PR 987](https://github.com/thaynes43/haynesnetwork/pull/987) merged as
`6f431991d1e2dc167166a253203236b5e1255d8e` at 11:08:27Z after all four required checks and renewed reviews
without findings. It includes conservative unresolved-queue holds, accurate private diagnostics and read-only
adoption when both parts natively import before either audit. [Release 988](https://github.com/thaynes43/haynesnetwork/pull/988),
v0.125.4, merged as `ab8181c36b00d389dbdb05db534b0a10845b6178` at 11:20:44Z after all four required checks.
Publisher [38555912857](https://github.com/thaynes43/haynesnetwork/actions/runs/38555912857) subsequently
verified cosign on attempt 1 at 11:25:00.644Z. Root independently fetched matching image and signature manifests
at 11:26:10Z, both HTTP 200; exact digests are recorded in the runtime proof. Deployment remains pending. Signed v0.125.3 and both immutable initial workers remain
live. Final Mickey E13 to E16 runs last after every initial slot, fresh root mapping and verified signed D40 deployment.
The prepared final-only envelope is disabled and contains no future capture, expiry, signed digest or prefix proof.
See the [runtime proof](2026-10-14-self-service-repair-runtime-proof.md) and
[completed-slot table](2026-10-14-pokemon-completed-slot-proof.md). Actual cutoffs and declaration remain
unchanged. Q-12 is asked and unanswered; OC-056 remains held until 2026-10-15T20:10Z and closed blocking Fixes,
with Paw Patrol ordering inside its verified Carry first. Final owed evidence follows the repairs and formal hold.
P8 stays staff practice, with readiness judged by the owner.

**Earlier repair state, 2026-10-14 10:42Z:** Pokemon E24/E26 completed normally and passed finishes 23/29; twenty-four approved slots are complete.
E28 is in progress, with its distinct S03E28 to S20E28 same-content mapping retained. Eight approved replacements
remain, with E8/E31 held. Mickey E21/E22, E23/E24 and E25/E26 passed finishes 56/62/68; eleven initial slots are
complete. E29/E30 has natively imported under its original download and awaits physical story/English ratification;
never replay it as ManualImport. Final E13 to E16 stays last, after all twenty-three initial slots and fresh root
mapping on the signed recovery release. [PR 987](https://github.com/thaynes43/haynesnetwork/pull/987) contains the
decision-40 multipart recovery change; local focused checks passed and two actual advisory findings are being
fixed before renewed review and required checks. It is not deployed yet. Signed v0.125.3, the actual finite worker
cutoffs and activity declaration remain unchanged. Exact full identities are in the
[runtime proof](2026-10-14-self-service-repair-runtime-proof.md) and
[completed-slot table](2026-10-14-pokemon-completed-slot-proof.md). Q-12 remains asked and unanswered;
OC-056 stays held until 2026-10-15T20:10Z and closed blocking Fixes, with Paw Patrol ordering inside its verified
Carry first. Final owed evidence follows the repairs and formal hold. P8 remains staff practice, with readiness
judged by the owner.

**Earlier repair state, 2026-10-14 10:04Z:** Pokemon E22/E23 completed normally and passed finishes 12/18;
twenty-two approved slots are complete and E24 is in progress. Mickey E17/E18 and E19/E20 completed normally and
passed finishes 44/50; eight initial slots are complete and E21/E22 is next. Final E13 to E16 remains last. The
decision-40 recovery implementation has passed focused and existing recovery cases, with boundary, CLI and
type/lint checks in progress; root review, required PR checks and a verified signed release still precede the final
run. See the [runtime record](2026-10-14-self-service-repair-runtime-proof.md) and
[completed-slot table](2026-10-14-pokemon-completed-slot-proof.md) for current exact evidence. Existing worker
cutoffs, declaration, holds, unanswered Q-12 and P8 staff practice are unchanged.

**Earlier repair state, 2026-10-14 09:37Z:** Pokemon E21 is normally complete and finish 6 passed; E22 is in
progress. Mickey E9/E10 is normally complete and finish 32 passed. E11/E12's sole untagged AAC track has positive
English dialogue evidence from two bounded internal speech checks, and both literal cards were viewed. Import 36
was accepted once at 09:29:49Z; actual library, native imports 66924/66925 and normal completion then passed.
Actual Plex contexts naturally exposed one default English track, without a metadata or preference write.
Finish 38 passed at 09:34:58.909Z under unchanged strict guards; E17/E18 is next. Never replay the import, forge its
metadata language or bypass a failed strict finish. Final E13 to E16 remains
last; its [proposed mapping](2026-10-14-mickey-final13-16-carry-review.md) uses the proved new E7/E8 copy. A
docs-first recovery change for a failed part in the supported two-release path was reviewed and authorized for
implementation at 09:36Z, with tests, required checks and a verified signed release still ahead. The exact
[runtime record](2026-10-14-self-service-repair-runtime-proof.md) and
[completed-slot proof](2026-10-14-pokemon-completed-slot-proof.md) take precedence over the older snapshot below.

Production [v0.125.3](https://github.com/thaynes43/haynesnetwork/pull/980) is verified as of 2026-10-14 09:06Z,
deployed by [haynes-ops 3922](https://github.com/thaynes43/haynes-ops/pull/3922), with its actual report merged in
[3924](https://github.com/thaynes43/haynes-ops/pull/3924). All three web replicas and migrators, twenty-four frontend
and two downloads CronJob templates, health, migrations 0105 to 0107, reviewed source hashes and both bounded
verification Jobs passed. The earlier v0.125.2 paired-file audio previews matched the real physical Plex tracks.
Its finite Pokemon continuation
completed E20, held the verified checkpoint, then stopped with actual Job/Pod absence confirmed. Retained finished
Job pods are historical evidence; runner completion does not satisfy dated or member-use observations. Read the newer
[runtime proof](2026-10-14-self-service-repair-runtime-proof.md) for exact current state.

At 09:06Z, [978](https://github.com/thaynes43/haynesnetwork/pull/978) and
[release 980](https://github.com/thaynes43/haynesnetwork/pull/980) have merged, all four required checks passed, and
v0.125.3's exact GHCR digest and actual successful cosign verification are independently confirmed. Its deployment
is verified live; interim notes merged in [982](https://github.com/thaynes43/haynesnetwork/pull/982). Both corrected
cold continuations actually launched on the signed image. Pokemon E21's normal completion and Plex proof remain pending; Mickey
E1 to E8 is normally complete and E9/E10 is in progress. Preserve the distinction between source proof, an accepted
write and full normal completion.

## Resume steps, in order

1. **Complete:** [#965](https://github.com/thaynes43/haynesnetwork/pull/965) and
   [release #968](https://github.com/thaynes43/haynesnetwork/pull/968) merged. v0.125.0 includes P7 and the audited
   wrong-content recovery and owned-smoke helper. Its GHCR image and signature were verified, including the
   publisher's explicit cosign verification. [haynes-ops #3905](https://github.com/thaynes43/haynes-ops/pull/3905)
   deployed all three pins; pods, templates, migrations, health and bounded job executions passed.
2. **Complete:** P7 is on as user 19, comment and resolve on. Owned Ghost media 10974 fixture issue 5 received
   exactly one invitation and one outcome/resolve as user 19, then was deleted. Pending did not resolve. The
   simulated repair made no library writes; issues 1 to 4 were untouched. The signed-out link showed Plex
   onboarding. OC-052 excludes this removed, marked fixture. Use only the audited `seerr-bridge.ts --smoke` and
   `--smoke-cleanup` for any future test, never arbitrary Seerr create/delete calls.
3. **Asked, answer pending:** Q-12 (DESIGN-055) was sent through the owner's question tool after the live check,
   recommending Seerr web push. Email and web push were read back off, so reporters currently see the comment
   only when opening their issue. The requested receipt page was delivered, which did not authorize changing
   Seerr notifications. No notification writes occurred. Do not change delivery without the ruling; continue the
   independent repairs.
4. **In progress, 2026-10-14 09:06Z:** do not rerun any original batch. Signed v0.125.1 deployed
   [#970](https://github.com/thaynes43/haynesnetwork/pull/970) and
   [#972](https://github.com/thaynes43/haynesnetwork/pull/972); the original owned downloads resumed under their
   existing parents and verified Carries. See the [runtime proof](2026-10-14-self-service-repair-runtime-proof.md).
   - Ben E12 is complete: file 79992/709759175, English and literal Adventures in Babysitting card. Ben E10's
     correct but Arabic-only first import was replaced through the existing Language Replace writer; final
     80009/454603103 is the reboot Animo Farm story with English and both-server proof. Its Fix completed normally.
   - Pokemon E1 to E7 and E9 to E20 completed normally with actual whole imports, physical English/story and
     per-account Plex proof. Fresh strict audit includes both owners, every captured affected account and complete
     nonempty physical coverage. Finish 39 reached a verified idle checkpoint before E21. Former Job
     `frontend/pokemon-owned-cont-v1252-20261014-0530`, UID `adcad698-99a1-4b2d-9092-50c8f6e1ba29`, and its Pod
     were confirmed gone before complete fresh post-deletion proof. Complete fresh four-component proof finished
     at 08:37:13Z; root reviewed the frozen source, seed and actual manifest before native creation at 08:42:01Z.
     Current Job `frontend/pokemon-owned-cont-v1253-20261014-0830`, UID
     `998d39b1-cf59-42bb-bec1-9f32126635a3`, adopted only those nineteen completed slots and starts new controls
     at 1. Preserve the actual original capture and checkpoint; never replay the completed slots. Its absolute
     expiry is 13:40:21.983Z and every actual write checks the 13:25:21.983Z cutoff.
   - Pokemon E21 replacement is in progress under Fix `34e35777-d724-4a28-a34c-706953558413`, verified Carry
     `f2c2b02c-6e83-4339-800d-c6e557d26dbe`, download `0be8b42d-2d16-4181-923e-c5aad351e3b7`. Actual source
     is 1920x1080/1469914845 bytes with English AAC stream 4. Root viewed 300s/750s frames; caretaker, net
     enclosure and collapsed house support the Foul Weather Friends story inference, without an unseen title-card
     claim. At 09:03Z root authorized one owned import after fresh guards; IMPORT4 was delivered once under root
     authorization and accepted at 09:05:01.977Z after fresh PLAN3, source and protected-file checks.
     **Normal completion and Plex proof remain pending.**
   - Mickey E1/E2, E3/E4, E5/E6 and E7/E8 are the first four fully proved and normally completed initial slots.
     The failed first cold startup and original terminal predecessor remain preserved. The corrected worker binds
     production's native source-event/episode/download ledger identity to bounded imports and audited whole-slot
     files, without inventing a ledger file ID. Fifteen focused cases, affected types and actual three-prefix
     read-only validation passed before reviewed signed Job `frontend/p077-mickey-resume-v1253-r2`, UID
     `5c04bbf3-135e-4330-a52a-cb6fce15a56e`, started at 08:14:03Z. Its expiry/cutoff is
     14:10:35.213Z/13:55:35.213Z. E7/E8 reused original Fix `d26e411f-7b47-42e4-a363-2633de493d64` and verified
     Carry `76419c02-7b27-41e7-afba-baac49a21d24`: one audited retry removed only the proved wrong queue item,
     with blocklist on, client deletion off and no search, then grabbed distinct download
     `04f547da-7099-42e8-b396-aff4ac1aa00c`. Actual native grabs 66897/66898 and imports 66899/66900 bind file
     80038/599908341 to the whole pair 37187/37188. Root viewed Agent Double-O-Goof at 60s and Egg-xasperating!
     at 691.54s; English EAC3 stream 1 and equal source/library whole-file hashes passed. Normal completion event
     `dcb744aa-22af-4f4d-a635-14fe337e1e83`, both Plex servers' actual index-7 pair coverage, every captured
     account's current-zero state and the correct S3 copy's five plays are verified. Protected final file 65359
     is unchanged. Finish was accepted at 08:42:17Z. E9/E10 is now in progress; source story/English remain pending
     and no import is authorized. E13 to E16 runs last after all twenty-three initial slots and fresh root-reviewed
     physical same-content mapping.
   - Pokémon E8 and E31 remain untouched. Two bounded NZB reads found only obfuscated split-archive and parity
     subjects; correct story, release group and English are unproved. Do not describe this as no release existing.
   Use the audited `owned-import-plan` / `owned-import-run` on the existing parent and exact download. A native
   import is adopted only through actual history, full-target file and physical proof, with no invented command.
   Verify actual English, story, file identity, unchanged protected files, both Plex servers and per-account carry
   marks before the next individually approved replacement. Fresh plans must still match the exact approved source.
   Current activity is `act-073758-527071`, expiry 2026-10-14T14:37:58Z; root renews and ends it. Long work runs
   as bounded, CPU-limited worker Jobs. The declaration covers frontend, media, downloads, Plex, PlexOps, Sonarr,
   SABnzbd and HaynesTower. Preserve logs and merge per-slot proof to main in the same session.
   - **Original repair scope, not current file status:** Ben 10 (2016), tvdb 318145, S1 E10 and E12 held Ben 10
     (2005) episodes.
   - Pokémon, tvdb 76703: original S3 E01-24, E26, E28-34, E36 and E38 held Pokémon Horizons. Never pick the Saon x265
     releases.
   - Mickey Mouse, tvdb 320725: twenty-three original S1 slots held Season 3 stories. Do E13-16 last.
   - **Durable content proofs:** [Ben 10 and Mickey mappings](2026-10-13-ben-mickey-wrong-content-copy-mappings.md)
     and [Pokémon mappings](2026-10-13-pokemon-wrong-content-copy-mappings.md). These anchor source and destination
     IDs, names, bytes and independent content evidence. Recheck them against the fresh plan; an unchanged episode
     number or a new digest alone is not content proof.
   - **Coordinator ruling for these slots:**
     - Find a correct release first, through the Release Pick tool as a staff request.
     - Only then replace the slot, using the wrong-content Fix inside a Watch Carry.
     - A watched mark on the wrong content does not carry onto the replacement. If that content lives correctly
       elsewhere in the library, carry the mark there; otherwise drop it, with the drop audited.
     - If no correct release exists, keep the wrong file and leave it flagged. An empty slot helps nobody.
5. **OC-056** cannot run before **2026-10-15T20:10Z**.
   - Run the Bubble Guppies S5 and Paw Patrol S5 E43-47 season re-maps once their open Fix requests close.
   - Paw Patrol's Plex ordering is not TVDB: only 7 of 26 S5 titles are right. Switch it to tvdbAiring with
     `ordering-run` inside a verified Watch Carry, then regenerate its season plan. Preserve the only Runaway
     Stargazer copy. That is a bug fix, not an owner question.
6. **Owed checks.** OC-048 (archive census week, from 2026-10-19), OC-050 (P1's first webhooks and guided Fixes),
   OC-051 (first real queue-aware Force Search), OC-052 (first real Seerr issue after P3), OC-053 (first person's
   re-map, and a week of hourly Title Checks), OC-054 (first person's Release Pick), OC-055 (first person's Wrong
   language) and OC-056. Issue #853 tracks overdue owed checks. The final step-6 snapshot follows current repairs
   and the formal dated hold; verification Job completion does not satisfy first-member evidence.
7. **P8.** The staff lead is live in the admin view from v0.125.1. Record its linked working practice and the final
   owed evidence in the docs; no counters or readiness gate. The owner has not ruled that self-service is the default.
8. **The original handoff census recorded 155 open flags; re-read current flags during the final snapshot.**
   [#928](https://github.com/thaynes43/haynesnetwork/issues/928) holds the list of held items and why each is held:
   - Mecha Builders S1: no free episode to park on.
   - Alaskan Bush People S4: Plex's own data keeps the old numbering.
   - Fireman Sam S6E01-13: copies across seasons.
   - Pokémon S8: a false positive.
   - The Thundermans S4: Plex's TVDB data is off by one.
   - Copies and empty slots:
     - 10 empty slots wait for a correct release.
     - 23 suspected copies: 13 hold different content and 10 are the only copy.
   - Spidey and His Amazing Friends S05 (tvdb 404491): files sit on the wrong episodes, and E19 and E20 exist on no
     indexer. Check #928 for its state.

## Owner rulings (2026-10-12 and 2026-10-13)

| Question | Ruling |
|---|---|
| Q-01 | Anyone who can use Fix may override a rejected release. Missing items only, within the hourly budget, and only when every rejection reason can be overridden. The hard-refusal list applies to everyone. |
| Q-02 | The Seerr bridge comments and resolves as a dedicated bot user, never as the owner's account. |
| Q-03 | When a person's Wrong-language Fix finds the file already has the wanted audio, set the Plex show preference only when that language is the show's original one. |
| Q-04 and Q-09 | Replaced by ADR-112: the owner judges readiness. |
| Q-05 | Seerr issue filing stays open. Staff step in only after a self-service attempt fails. |
| #955 / ADR-115 | Staff household default for a show's audio: English wherever the files carry it, otherwise the original language. |
| #928 | Carry watch marks, then move. |
| #940 | Coordinator decision: leave it. The Release Pick covers wrong-movie grabs. Revisit with a per-movie Radarr block if one keeps a movie missing. |

All four Seerr issues are resolved. Each got a self-service reply on 2026-10-12.

## Ops facts

- **Seerr:**
  - Runs in ns `media`, port 5055. The pod has no curl but has node.
  - The API key is at `/app/config/settings.json` `main.apiKey`. Never print it.
  - Its key acts as user 1, the owner's account, unless the request sends `X-API-User`.
  - The user-facing URL is https://overseerr.haynesnetwork.com.
- **Sonarr and Radarr:** ns `media`. The keys are in pod env `$SONARR__AUTH__APIKEY` and `$RADARR__AUTH__APIKEY`, and
  curl is in the image.
- **Plex servers:**
  - HaynesTower is Unraid, reached by LAN route; machine id `a5ec8cb2…`.
  - HaynesOps is the `plexops` pod; `80b33acb…`.
  - HaynesKube is the `plex` pod; `c1b23d68…`. It has no ordinary TV-series library, but its TV-type Peloton and YouTube sections must be included in an all-server inventory (read 2026-10-13 23:16Z).
- **Staff tools** run in a web pod as `tsx /sync/src/scripts/<tool>.ts`: `repair-guide.ts`, `seerr-bridge.ts`, and
  the season, copy and ordering runs. Long runs go as a Job, so a rollout cannot kill them.
- **Signed-in UI** cannot be driven from the cluster, because sign-in goes through the public Authentik. Check
  signed-out pages on https://haynesnetwork.haynesops.com and signed-in pages on `pnpm dev:local`. Stop only the
  dev processes you started, by PID. A broad `pkill` killed another agent's dev stack once.
- **Janitor ladder:**
  - `bad_release` is enforced.
  - "Found archive file" is report-only.
  - `importable` is enforced on Sonarr and Radarr.
  - `title_mismatch` is report-only by design. Its spot-check failed: the right film under a Korean title, and the
    right Peppa Pig episodes.
- **SABnzbd** runs a post-processing script that extracts leftover obfuscated 7z archives (haynes-ops #3836).
- **The canonical clones' working trees under `~/repos/` are months stale.** Read from `origin/main` or a fresh
  worktree.
- **CPU budget:** this pod shares a node with production. Run only the affected packages' tests, under
  `nice -n 19`. Never run wide parallel suites or loops.
