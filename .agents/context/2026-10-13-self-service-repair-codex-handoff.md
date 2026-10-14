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

Production [v0.125.3](https://github.com/thaynes43/haynesnetwork/pull/980) is verified as of 2026-10-14 07:45Z,
deployed by [haynes-ops 3922](https://github.com/thaynes43/haynes-ops/pull/3922), with its actual report merged in
[3924](https://github.com/thaynes43/haynes-ops/pull/3924). All three web replicas and migrators, all 26 app CronJob
templates, health, migrations 0105 to 0107, reviewed source hashes and both bounded verification Jobs passed. The
earlier v0.125.2 paired-file audio previews matched the real physical Plex tracks. Its finite Pokemon continuation
completed E20, held the verified checkpoint, then stopped with actual Job/Pod absence confirmed. Retained finished
Job pods are historical evidence. Read the newer
[runtime proof](2026-10-14-self-service-repair-runtime-proof.md) for exact current state.

At 07:56Z, [978](https://github.com/thaynes43/haynesnetwork/pull/978) and
[release 980](https://github.com/thaynes43/haynesnetwork/pull/980) have merged, all four required checks passed, and
v0.125.3's exact GHCR digest and actual successful cosign verification are independently confirmed. Its deployment
is verified live. Cold Pokemon launch-contract review and the Mickey startup ledger-binding fix remain in progress.
Do not treat a prepared continuation as launched.

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
   only when opening their issue. Do not change delivery without the ruling; continue the independent repairs.
4. **In progress, 2026-10-14 07:56Z:** do not rerun any original batch. Signed v0.125.1 deployed
   [#970](https://github.com/thaynes43/haynesnetwork/pull/970) and
   [#972](https://github.com/thaynes43/haynesnetwork/pull/972); the original owned downloads resumed under their
   existing parents and verified Carries. See the [runtime proof](2026-10-14-self-service-repair-runtime-proof.md).
   - Ben E12 is complete: file 79992/709759175, English and literal Adventures in Babysitting card. Ben E10's
     correct but Arabic-only first import was replaced through the existing Language Replace writer; final
     80009/454603103 is the reboot Animo Farm story with English and both-server proof. Its Fix completed normally.
   - Pokemon E1 to E7 and E9 to E20 completed normally with actual whole imports, physical English/story and
     per-account Plex proof. Fresh strict audit includes both owners, every captured affected account and complete
     nonempty physical coverage. The corrected continuation adopted the sealed, freshly revalidated prefix without
     replay. Finish 39 reached a verified idle checkpoint before E21. Former Job
     `frontend/pokemon-owned-cont-v1252-20261014-0530`, UID `adcad698-99a1-4b2d-9092-50c8f6e1ba29`, and its Pod
     were confirmed gone before complete fresh post-deletion proof. The corrected cold v0.125.3 worker passed
     independent review; generator/seed/control-contract review and fresh complete proof still precede launch.
     Preserve the actual original capture and checkpoint; never replay the nineteen completed slots.
   - Mickey E1/E2, E3/E4 and E5/E6 are complete with actual paired imports, literal cards, English and strict Plex
     proof. E7/E8 failed as Duplicate NZB after the verified Carry and old-file removal. No import was claimed.
     Janitor re-search fetched physically wrong Season 3 stories. P4 decision 39 specifies an audited retry under the
     same Fix/Carry and a janitor hold, before implementation. Do not import that wrong source, borrow a member actor,
     delete again or create a second Carry. A distinct iVy English offer exists in the proper replacing-mode plan;
     v0.125.3 is verified live and its fresh exact iVy plan was reviewed. The first cold recovery Job refused startup
     before any media command because its prefix guard expected a file ID in the normal ledger payload. Correct that
     temporary contract against actual native import and immutable whole-slot file proof. Keep both predecessors
     terminal and revalidate the fresh exact plan, complete physical/account proof and actual declaration lifetime
     before a new reviewed launch. The controller also refuses late transport writes and unbounded history.
   - Pokémon E8 and E31 remain untouched. Two bounded NZB reads found only obfuscated split-archive and parity
     subjects; correct story, release group and English are unproved. Do not describe this as no release existing.
   Use the audited `owned-import-plan` / `owned-import-run` on the existing parent and exact download. A native
   import is adopted only through actual history, full-target file and physical proof, with no invented command.
   Verify actual English, story, file identity, unchanged protected files, both Plex servers and per-account carry
   marks before the next individually approved replacement. Fresh plans must still match the exact approved source.
   Current activity is `act-073758-527071`, expiry 2026-10-14T14:37:58Z; root renews and ends it. Long work runs
   as bounded, CPU-limited worker Jobs. Preserve logs and merge per-slot proof to main in the same session.
   - Ben 10 (2016), tvdb 318145: S1 E10 and E12 hold Ben 10 (2005) episodes.
   - Pokémon, tvdb 76703: S3 E01-24, E26, E28-34, E36 and E38 hold Pokémon Horizons. Never pick the Saon x265
     releases.
   - Mickey Mouse, tvdb 320725: 23 S1 slots hold Season 3 stories. Do E13-16 last.
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
   - Paw Patrol's Plex ordering is not TVDB: only 7 of 26 S5 titles are right. Switch it with `ordering-run`, which
     runs inside a Watch Carry. That is a bug fix, not an owner question.
6. **Owed checks.** OC-048 (archive census week, from 2026-10-19), OC-050 (P1's first webhooks and guided Fixes),
   OC-051 (first real queue-aware Force Search), OC-052 (first real Seerr issue after P3), OC-053 (first person's
   re-map, and a week of hourly Title Checks), OC-054 (first person's Release Pick), OC-055 (first person's Wrong
   language) and OC-056. Issue #853 tracks overdue owed checks.
7. **P8.** The staff lead is live in the admin view from v0.125.1. Record its linked working practice and the final
   owed evidence in the docs; no counters or readiness gate. The owner has not ruled that self-service is the default.
8. **The Title Check has 155 open flags.** #928 holds the list of held items and why each is held:
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
