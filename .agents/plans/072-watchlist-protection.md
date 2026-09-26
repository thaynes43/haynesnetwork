# PLAN-072: Watchlists protect titles from Trash, and a re-request never re-fetches the deleted release: build, deploy, live-verify, enable, remediate

- **Status:** S0 running (interim protection by hand); S1 in review (docs PR). Nothing built yet.
- **ADRs:** ADR-093 (Proposed) · **Design:** DESIGN-052 · **PRD:** R-255..R-259, US-16, AC-33..AC-37, Q-15..Q-16
  (R-86 and R-92 annotated) · **Glossary:** T-261..T-266, T-70 and T-74 amended · **DDD-002:** BC-03 notes.
- **Owner:** whoever holds the session; this plan is the tracked owner.
- **Owner rulings (2026-09-26, issue #576 and on his phone):** (1) *"We should not be deleting things that are on
  anybody's watchlist across the server."* (2) *"We should be requesting things even if they were previously deleted
  but later added by someone else. We just need to grab a fresh index."* / *"We can't re-request the same index but
  we can the same title different index."* (3) **"Everyone's watchlist requests"** (Seerr watchlist sync on for
  every Seerr user, movies and TV).
- **Driver decisions** (recorded in ADR-093): the read paths and their limits, the Registry Gate, the release
  profile as the Release Block, enroll once, and the rollout order below.
- **Resolves:** issue #576 (closed at S11, not by the docs PR).
- **Cross-repo:** haynes-ops (the image tag, the `sync-watchlist-registry` CronJob, a Loki alert).
- **Research:** `.agents/context/2026-09-26-watchlist-trash-protection-research.md`.

## Evidence at authoring (2026-09-26)

- Next free ids, verified against `main` (`baba734`) and open PRs: ADR-093, DESIGN-052, PLAN-072, R-255, US-16,
  AC-33, Q-15, T-261, migration **0081**.
- 42 Plex accounts; 22 readable with certainty today, 20 not (3 managed, 17 friends that read empty through
  community with no Seerr user). 16 Seerr users, all with working tokens; only the owner has watchlist sync on.
- Movie pool 170 (6 watchlisted: Trap, Summer of 69, The Legend of Ochi, Influencers, Death of a Unicorn, The Alto
  Knights); TV pool 0. Radarr and Sonarr have 0 release profiles.
- Deleted while listed: Babygirl, Another Simple Favor, Terrifier. Open batch `08576e59` (expires
  2026-09-27T06:17Z, swept about 06:45Z): its three pending watchlisted titles were Saved at about 15:15Z.
- The sweep CronJob mounts `haynesnetwork-secret`, which carries `PLEX_HAYNESOPS_TOKEN`, `PLEX_HAYNESTOWER_TOKEN`,
  `SEERR_API_KEY`, `RADARR_API_KEY`, `SONARR_API_KEY`, `MAINTAINERR_API_KEY` (haynes-ops `externalsecret.yaml`).

## Steps

| Step | What | Done when |
|---|---|---|
| S0 | **Interim protection until S7.** After each new Trash batch is created (the next movie batch forms about 30 minutes after the 2026-09-27 ~06:45Z sweep; the pool still holds Summer of 69, Influencers and The Alto Knights, friend-watchlisted), cross-check the batch's pending items against every readable watchlist (community GraphQL with the owner token plus Seerr's per-user reads, read-only, counts and batch titles only) and Save each match with `setBatchItemSaved` (actor null), logging each in this plan. Check again the day before each batch's expiry. | S7 is done (the guard is live and has kept or skipped every watchlisted item on a real sweep); every batch created before then was checked, with the Saves logged below. |
| S1 | **Docs:** research note, ADR-093, DESIGN-052, this plan, PRD (R-255..R-259, US-16, AC-33..AC-37, Q-15..Q-16; R-86 and R-92 annotated), glossary (T-261..T-266; T-70, T-74 amended), DDD-002 BC-03 notes, status notes on ADR-073, ADR-084 and ADR-092, HANDOFF. | An Opus design review's findings are ruled into DESIGN-052 (a D-NN per ruling) and the docs PR is merged. |
| S2 | **Build** per DESIGN-052 (D-22 code map): migration 0081 and schema; the registry readers (D-01..D-04), `watchlist-registry` mode, gate and snapshot (D-06, D-07, D-19); the proposal and deletion guard with keep reasons and `ruleEvaluationFailed` (D-08, D-09); the wall note, skip tooltips, paused banner and Watchlists card (D-10; copy from the driving session's UX pass); the Deleted-Release Record, term derivation, Release Block writer and the two-phase sweep and Expedite (D-11..D-14); the seed script (D-15); the Arm/Disarm fix and invariant (D-16); Seerr enrollment, off (D-17); logging (D-21); stubs for `pnpm dev:local` (D-20); tests (DESIGN-052 test strategy); CLAUDE.md hard rule 4 (ADR-093 C-08). | PR green on `lint-and-typecheck`, `test`, `build`; an Opus code review's findings fixed or answered on the PR; `pnpm dev:local` walk: a watchlisted stub title kept by an expedite and a sweep, the release profile written before the handle, the Arm/Disarm toggle leaving the flags true; squash-merged. |
| S3 | **Release:** merge the release-please PR. | The next minor's image is published and signed (manifest and cosign `.sig` 200 in GHCR). |
| S4 | **Deploy** (haynes-ops, one PR): the image tag; the `sync-watchlist-registry` CronJob (`14,29,44,59 * * * *`, `haynesnetwork-secret`, Forbid); the Loki alert for a paused sweep (D-21). | Flux rolled `haynesnetwork-main`; migration 0081 applied (the `migrate` init logs); the CronJob exists and its first run logs `run_complete status=ok`. |
| S5 | **Seerr and *arr preflight (read-only):** record Seerr `GET /api/v1/settings/main` `defaultQuotas` (Q-10); list Radarr/Sonarr release profiles (expect none but ours after S7); confirm Seerr user 2 has no settings row (the Q-09 canary target) or pick one that has none. | Findings logged below; DESIGN-052 Q-10 answered. |
| S6 | **Live verification, read-only:** (a) the registry's counts match the research (42 accounts: owner read, 2 full Home read, 36 friends read or empty_unverified, 3 managed unresolvable; 16 Seerr users read); (b) the gate says verified; (c) the pool's watchlisted titles show "On a watchlist" on the Trash wall and `onWatchlist` in a dry-run guardian pass over the open batch; (d) a registry read of each Seerr user equals a direct Seerr read (Q-03); (e) the D-12 derivation over the 170 pool movies and the ledger's grabbed names: self-check misses and null groups counted (Q-05, Q-12); (f) the CronJob pods reach plex.tv, community.plex.tv and discover.provider.plex.tv; (g) the rule pools still show `listExclusions` and `forceSeerr` true and the audit is SAFE. | Every check's result is in the log below; DESIGN-052 Q-03, Q-05, Q-12 answered; any failure fixed in a follow-up PR before S7. |
| S7 | **The first guarded sweep** (the first batch that expires after S4): its log shows the inline refresh `ok`, `gate verified=true`, `kept … reason=watchlisted` for any listed item, `release-block recorded` per survivor, `reconciled … wrote=true` before the first Maintainerr handle, then the handles. Radarr's (or Sonarr's) profile holds the new terms (`GET /api/v3/releaseprofile`). Record Radarr's RSS-sync and search durations the day before and after (Q-04). | One real sweep completed with those lines in that order; a read-only join of the batch's deleted items against the registry finds zero watchlisted deletions; Q-04 has before/after numbers; S0 ends. |
| S8 | **Seed the Release Block:** `release-block-seed.ts --dry-run` (counts), then `--apply` for the backfill (D-15); re-read the legacy HaynesTower SAB history read-only over `hw-ssh` for Babygirl, Another Simple Favor and Terrifier, confirm names by size and the tmdb and Radarr ids (Q-11), then `--manual` for their terms. | Radarr's profile holds the backfill and the three titles' terms (read-back); the record counts are in the log; Q-11 answered. |
| S9 | **Seerr enable (ruling 3):** set `seerr_watchlist_enroll` to `{enabled: true, onlyUserIds: [<canary>]}` (audited setting write, actor null); after the next registry run, read that user's settings back (both flags true) and user 1's unchanged (Q-09); watch one Seerr sync (3 minutes): "Created media request from user's Plex Watchlist" lines, the Radarr/Sonarr adds and their grabs, none matching a blocked term. Then `{enabled: true, onlyUserIds: null}` and one more cycle. | 16 enrollment rows; `GET /api/v1/user/{id}/settings/main` shows both flags for every user; the first-enable requests are counted (expected at most about 34 movies and 48 shows) and every resulting grab is outside the Release Block; Q-09 answered. |
| S10 | **Remediation re-requests:** for Babygirl, Another Simple Favor and Terrifier, if S9 did not already request them (`GET /api/v1/movie/{tmdbId}`), `POST /api/v1/request {"mediaType":"movie","mediaId":<tmdbId>}` with the API key (DESIGN-052 D-18). | Each title is requested, grabbed with a release outside its blocked terms (Radarr history `sourceTitle`; the blocked group appears only as a rejection) and imported, still on a watchlist, and tagged `mediarequests`. |
| S11 | **Close-out:** ADR-093 and DESIGN-052 to Accepted; the status notes on ADR-073, ADR-084 and ADR-092 read "in effect since"; PRD, glossary and HANDOFF updated; issue #576 closed with a summary comment; this plan to `completed/`. Ask the owner (one AskUserQuestion) whether the S0 interim Saves stay permanent or are revoked now that the watchlist guard covers them. | The close-out docs PR is merged; #576 is closed; the owner's answer on the interim Saves is applied and logged. |

## Rollback

- The guard is additive: reverting the image restores today's behaviour (no watchlist check). The release profiles
  stay in Radarr/Sonarr and keep blocking; deleting them by hand is the rollback for the block.
- Seerr enrollment: set `seerr_watchlist_enroll` off (stops new enrollments); turning users' sync back off is a
  per-user `POST /api/v1/user/{id}/settings/main` with the flags false, done by hand only on an owner ruling.

## Log

- 2026-09-26: research (four tracks, per-claim skeptics, critic) done; owner rulings 1 and 2 on #576, ruling 3 on his
  phone. Interim: Trap, Death of a Unicorn and The Legend of Ochi (batch `08576e59`) Saved at about 15:15Z by the
  coordinator (`setBatchItemSaved`, actor null). S1 docs written (ADR-093, DESIGN-052, this plan).
