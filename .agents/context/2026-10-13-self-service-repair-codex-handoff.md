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
| P8 | Working practice per ADR-112 | Not started; keep it lightweight |

Production runs **v0.125.0** as of 2026-10-13 23:09Z. All three web replicas, every active frontend app pod and all 26 app CronJob templates use it; migrations 0105 to 0107 and the bounded verification Jobs passed. Retained finished Job pods are historical evidence.

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
4. **In progress, 2026-10-13 23:20Z:** Ben's approved batch Job is
   `frontend/p077-ben10-replace-batch-10132320` (E10/E12). Mickey's 23 initial slots are approved and follow Ben's
   verified carries; Pokémon's fresh plan and alternatives are under final review. The media declaration is
   `act-231926-392897`, expiry 2026-10-14T01:19:26Z. Inspect jobs and domain audits before resuming; never replay
   completed slots. Actual imported stories, episode coverage and watch-state verification are owed.
   **Replace the wrong-content files.** This is #928, and the PR #965 comment has the exact slot lists, release
   preferences and copy mappings. Run `declare-activity` first, then `replace-plan --slots`, then one `replace-batch`
   Job per season. Stream each Job's logs while it runs, because finished staff Jobs vanish quickly.
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
7. **P8.** Write the working practice into the docs and the admin view only. No counters.
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
