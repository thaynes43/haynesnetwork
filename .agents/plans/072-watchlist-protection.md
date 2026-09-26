# PLAN-072: Watchlists protect titles from Trash, and a re-request never re-fetches the deleted release: build, deploy, live-verify, enable, remediate

- **Status:** S0 running (interim protection by hand); S1 done (docs PR #594: the design review's findings ruled
  into DESIGN-052 D-24). S2 in progress on `feat/watchlist-protection` (draft PR): part 1 built (migration 0081,
  the registry and its mode, the gate and snapshot, the guard, the D-10 surfaces; rulings in DESIGN-052 D-25);
  part 2 next (the Deleted-Release Record, the Release Block, the seed script, the Arm/Disarm fix, Seerr enrollment,
  the D-23 counts, CLAUDE.md hard rule 4).
- **ADRs:** ADR-093 (Proposed) · **Design:** DESIGN-052 · **PRD:** R-255..R-259, US-16, AC-33..AC-37, Q-15..Q-16
  (R-86 and R-92 annotated) · **Glossary:** T-261..T-266, T-70 and T-74 amended · **DDD-002:** BC-03 notes.
- **Owner:** whoever holds the session; this plan is the tracked owner.
- **Owner rulings (2026-09-26, issue #576 and on his phone):** (1) *"We should not be deleting things that are on
  anybody's watchlist across the server."* (2) *"We should be requesting things even if they were previously deleted
  but later added by someone else. We just need to grab a fresh index."* / *"We can't re-request the same index but
  we can the same title different index."* (3) **"Everyone's watchlist requests"** (Seerr watchlist sync on for
  every Seerr user, movies and TV).
- **Driver decisions** (recorded in ADR-093): the read paths and their limits, the Registry Gate, the release
  profile as the Release Block, enroll once, Seerr's anime tags, keeping an item whose release cannot be recorded,
  the unblockable past deletions (C-21), and the rollout order below.
- **Resolves:** issue #576 (closed at S11, not by the docs PR).
- **Cross-repo:** haynes-ops (the image tag, the `sync-watchlist-registry` CronJob, a Loki alert).
- **Research:** `.agents/context/2026-09-26-watchlist-trash-protection-research.md`.

## Evidence at authoring (2026-09-26)

- Next free ids, verified against `main` (`baba734`) and open PRs: ADR-093, DESIGN-052, PLAN-072, R-255, US-16,
  AC-33, Q-15, T-261, migration **0081**.
- 42 Plex accounts; 22 readable with certainty today, 20 not (3 managed, 17 friends that read empty through
  community with no Seerr user). 16 Seerr users, each with a stored token: the 15 whose lists answered with titles
  prove theirs works; the one that answered 0 is unverified, because Seerr answers a failed plex.tv read with the same
  empty list (DESIGN-052 D-02). Only the owner has watchlist sync on.
- Movie pool 170 (6 watchlisted: Trap, Summer of 69, The Legend of Ochi, Influencers, Death of a Unicorn, The Alto
  Knights); TV pool 0. Radarr and Sonarr have 0 release profiles.
- Deleted while listed: Babygirl, Another Simple Favor, Terrifier. Open batch `08576e59` (expires
  2026-09-27T06:17Z, swept about 06:45Z): its three pending watchlisted titles were Saved at about 15:15Z.
- The sweep CronJob mounts `haynesnetwork-secret`, which carries `PLEX_HAYNESOPS_TOKEN`, `PLEX_HAYNESTOWER_TOKEN`,
  `SEERR_API_KEY`, `RADARR_API_KEY`, `SONARR_API_KEY`, `MAINTAINERR_API_KEY` (haynes-ops `externalsecret.yaml`).

## Steps

| Step | What | Done when |
|---|---|---|
| S0 | **Interim protection until S7.** After each new Trash batch is created (the next movie batch forms about 30 minutes after the 2026-09-27 ~06:45Z sweep; the pool still holds Summer of 69, Influencers and The Alto Knights, friend-watchlisted), cross-check the batch's pending items against every readable watchlist (community GraphQL with the owner token plus Seerr's per-user reads, read-only, counts and batch titles only) and Save each match with `setBatchItemSaved` (actor null), logging each in this plan. Check again the day before each batch's expiry, and a final time in the 1 to 2 hours before the sweep that closes it (the first `:45` after `expires_at`), so a title listed in the last day is caught too. | S7 is done (the guard is live and has kept or skipped every watchlisted item on a real sweep); every batch created before then was checked, with the Saves logged below. |
| S1 | **Docs:** research note, ADR-093, DESIGN-052, this plan, PRD (R-255..R-259, US-16, AC-33..AC-37, Q-15..Q-16; R-86 and R-92 annotated), glossary (T-261..T-266; T-70, T-74 amended), DDD-002 BC-03 notes, status notes on ADR-073, ADR-084 and ADR-092, HANDOFF. | An Opus design review's findings are ruled into DESIGN-052 (a D-NN per ruling) and the docs PR is merged. |
| S2 | **Build** per DESIGN-052 (D-22 code map): migration 0081 and schema; the registry readers (D-01..D-04), `watchlist-registry` mode, gate and snapshot (D-06, D-07, D-19); the proposal and deletion guard with keep reasons and `ruleEvaluationFailed` (D-08, D-09); the wall note, skip tooltips, paused banner and Watchlists card (D-10; copy from the driving session's UX pass); the Deleted-Release Record, term derivation, Release Block writer and the two-phase sweep and Expedite (D-11..D-14); the seed script (D-15); the Arm/Disarm fix and invariant (D-16); Seerr enrollment, off (D-17); logging (D-21); stubs for `pnpm dev:local` (D-20); tests (DESIGN-052 test strategy); CLAUDE.md hard rule 4 (ADR-093 C-08). | PR green on `lint-and-typecheck`, `test`, `build`; an Opus code review's findings fixed or answered on the PR; `pnpm dev:local` walk: a watchlisted stub title kept by an expedite and a sweep, the release profile written before the handle, the Arm/Disarm toggle leaving the flags true; squash-merged. |
| S3 | **Release:** merge the release-please PR. | The next minor's image is published and signed (manifest and cosign `.sig` 200 in GHCR). |
| S4 | **Deploy** (haynes-ops, one PR): the image tag; the `sync-watchlist-registry` CronJob (`14,29,44,59 * * * *`, `haynesnetwork-secret`, Forbid); the Loki alerts (D-21). Deploy right after a movie sweep where possible (about 7 days of runway), and **suspend `haynesnetwork-sync-trash-batch-sweep`** from the deploy until S6 is green (`declare-activity` with scope `frontend,haynesnetwork`, operator-tier CronJob suspend; check daily that it stays suspended), so no real deletion runs on an unverified registry or unchecked terms. Batches that expire meanwhile wait in `leaving_soon`; S0 keeps checking them. | Flux rolled `haynesnetwork-main`; migration 0081 applied (the `migrate` init logs); the CronJob exists and its first run logs `run_complete status=ok`; the sweep CronJob shows `suspend: true`. |
| S5 | **Seerr and *arr preflight (read-only):** record Seerr `GET /api/v1/settings/main` `defaultQuotas` (Q-10); list Radarr/Sonarr release profiles (expect none but ours after S7); confirm Seerr user 2 has no settings row (the Q-09 canary target) or pick one that has none; confirm Seerr's local Watchlist table is still empty (DESIGN-052 D-02 rule 6); record Seerr's Sonarr `tags` and `animeTags` (expect `[1]` and `[]`, D-17). | Findings logged below; DESIGN-052 Q-10 answered. |
| S6 | **Live verification, read-only:** (a) the registry's counts match the research (42 accounts: owner read, 2 full Home read, 36 friends read or `empty_unverified`, 3 managed unresolvable; the 16 Seerr sources ok, the zero-list one `empty_unverified`); (b) the gate says verified; (c) the pool's watchlisted titles show "On a watchlist" on the Trash wall and `onWatchlist` in a dry-run guardian pass over the open batch; (d) a registry read of each Seerr user equals a direct Seerr read (Q-03); (e) the D-12 derivation over the 170 pool movies and the ledger's grabbed names: self-check misses, null groups, `low_confidence` terms and the items D-11 would keep as `release_unrecorded`, counted (Q-05, Q-12; Q-13 goes to the owner only if that share is material); (f) the CronJob pods reach plex.tv, community.plex.tv and discover.provider.plex.tv; (g) the rule pools still show `listExclusions` and `forceSeerr` true and the audit is SAFE; (h) over a day of runs, every Seerr `Failed to retrieve watchlist items` log line lines up with a registry `account_failed` (a failed or inconsistent Seerr read), never with an ok read that shrank a list. When all pass, resume the sweep CronJob and end the S4 declaration. | Every check's result is in the log below; DESIGN-052 Q-03, Q-05, Q-12 answered; any failure fixed in a follow-up PR before the sweep resumes; the sweep CronJob resumed. |
| S6a | **Managed Home users (DESIGN-052 Q-01, PRD Q-15):** put Q-15 to the owner with AskUserQuestion (it signs in as a managed user and mints a token and a session for them). On a yes: try the switch for one managed user, read-only otherwise, and check plex.tv's devices and sessions for side effects and that the owner token still works; if clean, enable the switch path and check that the three managed accounts read. On a no: they stay `unresolvable`. | The owner's answer and, on a yes, the probe's findings are logged below; the ruling is a D-NN in DESIGN-052 and Q-01 / Q-15 are resolved. |
| S7 | **The first guarded sweep** (the first due batch after the sweep resumes at S6): its log shows the inline refresh `ok`, `gate verified=true`, `kept … reason=watchlisted` for any listed item, `release-block recorded` per survivor, `reconciled … wrote=true` before the first Maintainerr handle, then the handles, each record turning `active` after its *arr `GET` 404s. Radarr's (or Sonarr's) profile holds the new terms (`GET /api/v3/releaseprofile`). Right after the first PUT, one ordinary search (an interactive search of a monitored title, no grab) still shows a non-blocked release as accepted, proving no term broke every decision (ADR-093 C-19). Record Radarr's RSS-sync and search durations the day before and after (Q-04). | One real sweep completed with those lines in that order; a read-only join of the batch's deleted items against the registry finds zero watchlisted deletions; the search check passed; Q-04 has before/after numbers; S0 ends. |
| S8 | **Seed the Release Block (D-15):** export both legacy HaynesTower SAB histories (`binhex-sabnzbdvpn`, `linuxserver-sabnzbd`) read-only over `hw-ssh` into a scratch file (never committed); `release-block-seed.ts --dry-run` with the ledger and `--legacy-sab` sources (counts per source, the rows skipped because their *arr record still exists, Silent Night and The Unholy Trinity by name, and what stays unblockable, ADR-093 C-21), then `--apply`; re-read the live legacy history for Babygirl, Another Simple Favor and Terrifier, confirm names by size and the tmdb and Radarr ids (Q-11), then `--manual` for their terms (and for either named title the bulk match missed). | Radarr's and Sonarr's profiles hold the seeded terms (read-back); the per-source and unblockable counts are in the log; Q-11 answered. |
| S9 | **Seerr enable (ruling 3), after S8.** Preflight: (1) set Seerr's Sonarr `animeTags` to `[1]` (`mediarequests`) with one `PUT /api/v1/settings/sonarr/{id}` echoing the whole GET body, logged and read back (DESIGN-052 D-17); (2) join every Seerr user's 20 newest titles (read-only) against deleted titles with no `active` or `in_flight` term; seed each match from the legacy SAB (`--manual`), and if any has no recoverable identity, hold the enable and ask the owner (AskUserQuestion) whether to enable anyway. Then set `seerr_watchlist_enroll` to `{enabled: true, onlyUserIds: [<canary>]}` (audited setting write, actor null); after the next registry run, read that user's settings back (both flags true) and user 1's unchanged (Q-09); watch one Seerr sync (3 minutes): "Created media request from user's Plex Watchlist" lines, the Radarr/Sonarr adds and their grabs, none matching a blocked term. Then `{enabled: true, onlyUserIds: null}` and one more cycle. | Seerr's Sonarr `animeTags` carries `mediarequests`; the preflight join is logged with every match seeded or ruled; 16 enrollment rows; `GET /api/v1/user/{id}/settings/main` shows both flags for every user; the first-enable requests are counted (expected at most about 34 movies and 48 shows) and every resulting grab is outside the Release Block; Q-09 answered. |
| S10 | **Remediation re-requests:** for Babygirl, Another Simple Favor and Terrifier, if S9 did not already request them (`GET /api/v1/movie/{tmdbId}`), `POST /api/v1/request {"mediaType":"movie","mediaId":<tmdbId>}` with the API key (DESIGN-052 D-18). | Each title is requested, grabbed with a release outside its blocked terms (Radarr history `sourceTitle`; the blocked group appears only as a rejection) and imported, still on a watchlist, and tagged `mediarequests`. |
| S11 | **Close-out:** ADR-093 and DESIGN-052 to Accepted; the status notes on ADR-025, ADR-036, ADR-073, ADR-084 and ADR-092, and the "Extended by" lines on DESIGN-010, DESIGN-011, DESIGN-014 and DESIGN-048, read "in effect since"; PRD, glossary and HANDOFF updated; issue #576 closed with a summary comment; this plan to `completed/`. Ask the owner (one AskUserQuestion) whether the S0 interim Saves stay permanent or are revoked now that the watchlist guard covers them. | The close-out docs PR is merged; #576 is closed; the owner's answer on the interim Saves is applied and logged. |

## Rollback

Reverting the image alone restores today's behaviour, which is the problem: the sweep would delete watchlisted
titles again (against ruling 1) and delete without recording or blocking the release (against ruling 2), and after
S9 every enrolled user's Seerr would re-request a deleted title and fetch the same release (#576's loop). So roll
back in this order:

1. `declare-activity`, then suspend the `haynesnetwork-sync-trash-batch-sweep` CronJob (operator-tier CronJob
   suspend), and restart S0's manual cross-check for every open batch.
2. If S9 has run: set `seerr_watchlist_enroll` off (audited setting write; it stops new enrollments). Turning users'
   sync back off is a per-user `POST /api/v1/user/{id}/settings/main` with the flags false, done by hand only on an
   owner ruling.
3. Revert the image tag in haynes-ops.
4. Only once no running image reconciles them (a live image re-creates a deleted profile on its next reconcile),
   delete the release profiles by hand if the block itself is the problem; otherwise leave them blocking.
5. Resume the sweep only when S0's check covers the open batches or the guard is back.

Migration 0081 is additive and stays; the older image ignores its tables and columns.

## Log

- 2026-09-26: research (four tracks, per-claim skeptics, critic) done; owner rulings 1 and 2 on #576, ruling 3 on his
  phone. Interim: Trap, Death of a Unicorn and The Legend of Ochi (batch `08576e59`) Saved at about 15:15Z by the
  coordinator (`setBatchItemSaved`, actor null). S1 docs written (ADR-093, DESIGN-052, this plan).
- 2026-09-26: S1 design review (Opus, against the code, the live install and the deployed upstream sources): three
  blocker issues, each reported more than once (Seerr answers a failed read as an empty list; the backfill left about
  255 identifiable deleted releases unblocked), and the should-fix items and nits, all ruled into DESIGN-052 D-24 and
  folded into D-02..D-22, ADR-093 (C-21 added), the PRD and this plan (S0 final check, S4 holds the sweep until S6,
  S6a added, S8 bulk legacy seed, S9 preflight, ordered rollback). Docs PR #594 merged.
- 2026-09-26: S2 part 1 built on `feat/watchlist-protection` (draft PR): migration 0081 with every D-05 table and
  column; the Watchlist Registry (roster, discover, community GraphQL, Seerr content rules, per-source state machine,
  discover-id map) and its `watchlist-registry` mode; the Registry Gate and the typed snapshot with the D-19 overlay;
  the proposal and deletion guard with keep reasons, `ruleEvaluationFailed` and the sweep's required `registry`
  input and `trash_sweep_status`; the wall note, kept tooltips, Expedite breakdown, paused banner and Watchlists card
  (copy from the driving session's UX pass); the registry half of the D-20 stubs. Rulings in DESIGN-052 D-25.
