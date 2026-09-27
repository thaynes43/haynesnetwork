# PLAN-072: Watchlists protect titles from Trash, and a re-request never re-fetches the deleted release: build, deploy, live-verify, enable, remediate

- **Status:** S0 running (interim protection by hand); S1 done (docs PR #594: the design review's findings ruled
  into DESIGN-052 D-24). S2 built on `feat/watchlist-protection` (PR #595): part 1 (migration 0081,
  the registry and its mode, the gate and snapshot, the guard, the D-10 surfaces) and part 2 (the Deleted-Release
  Record, the Release Block writer and the two-phase sweep and Expedite, the seed script, the Arm/Disarm fix and the
  grown invariant, Seerr enrollment off behind its setting, the D-23 counts, CLAUDE.md hard rule 4); rulings in
  DESIGN-052 D-25. The S2 Opus code review's findings are fixed on the PR (DESIGN-052 D-25ax..D-25bm; OPS-017 is the
  runbook), and so are the second review pass's (D-25bn..D-25bz) and the third's (D-25ca..D-25cq: among them the web
  delete paths held with the sweep until S6, `TRASH_WEB_DELETES_HELD`). S2 merged (PR #595); S3 done: v0.101.0
  released (PR #587), image and cosign `.sig` in GHCR. S4 done: haynes-ops #3223 merged 2026-09-27T01:18Z, with every
  CronJob suspend and resume of the rollout in git (DESIGN-052 D-25db). **S6 (a)..(g) passed live on v0.101.0
  (2026-09-27, log below); S6(h) is open** (a day of registry runs, from 2026-09-27T01:22Z). S6(e)'s one defect (345
  Sonarr and 3 Radarr ledger names the terms matched only folded) is fixed by DESIGN-052 D-25dd (PR #599). S6a
  answered by the owner (D-25de).
  **Before the resume PR:** S6(h) passes, S0's final cross-check of batch `08576e59` runs, and the release carrying
  D-25dd is deployed (before S7 where possible, before S8 in any case: the seed derives its terms from the ledger's
  real names).
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
| S4 | **Deploy** (haynes-ops, one PR): the image tag; the `sync-watchlist-registry` CronJob (`14,29,44,59 * * * *`, `haynesnetwork-secret`, Forbid, `backoffLimit: 0` so each slot logs at most one scheduled `run_failed`, D-25dc); the Loki alerts (D-21), each linking its section of OPS-017 (`docs/ops/017-watchlist-protection.md`, the runbook: the CronJob, every `sweep_paused` reason and step with its remedy (§3, matching the logged `reason`: `gate`, `release_block`, `audit_unsafe`, `arr`), the `readd` page (§4), the `account_unreadable` notice (§5), the `run_failed` streak (§6), the in-cluster scripts (§7)); OPS-017's status goes Active. Deploy right after a movie sweep where possible (about 7 days of runway). **Hold every real deletion until S6 is green**, so none runs on an unverified registry or unchecked terms: in this same haynes-ops PR, set **`suspend: true` on the `sync-trash-batch-sweep` CronJob** (`haynesnetwork-sync-trash-batch-sweep`) and **`TRASH_WEB_DELETES_HELD: "true"`** on the web pod. The suspend lives in git, never a `kubectl` suspend: the chart renders `suspend` on every CronJob, so each Helm upgrade puts the live value back to git's, and this very deploy would undo a hand-set one (every sweep suspend and resume below goes through haynes-ops the same way, D-25db). The env makes Expedite (item and all) and the manual Expire now refuse ("Deleting from Trash is on hold …", DESIGN-052 D-25cc; the admin role holds every Trash action, so revoking grants would hold nothing). Batches that expire meanwhile wait in `leaving_soon`; S0 keeps checking them. While the sweep is suspended the Release Block upkeep (the stranded settle, the expiry, the drift repair) keeps running in the registry CronJob every 15 minutes (D-25cf); the hourly re-add check pauses with the sweep, which is harmless while nothing is deleted. | Flux rolled `haynesnetwork-main`; migration 0081 applied (the `migrate` init logs); the CronJob exists and its first run logs `run_complete status=ok`; the sweep CronJob shows `suspend: true`; an Expedite attempt in the web app answers the hold (`TRASH_WEB_DELETES_HELD`). |
| S5 | **Seerr and *arr preflight (read-only):** record Seerr `GET /api/v1/settings/main` `defaultQuotas` (Q-10); list Radarr/Sonarr release profiles (expect none but ours after S7); confirm Seerr user 2 has no settings row (the Q-09 canary target) or pick one that has none; confirm Seerr's local Watchlist table is still empty (DESIGN-052 D-02 rule 6); record Seerr's Sonarr `tags` and `animeTags` (expect `[1]` and `[]`, D-17). | Findings logged below; DESIGN-052 Q-10 answered. |
| S6 | **Status 2026-09-27: (a)..(g) passed on v0.101.0; (h) open; the D-25dd fix of S6(e)'s finding awaits release and deploy (log below).** **Live verification, read-only:** (a) the registry's counts match the research (42 accounts: owner read, 2 full Home read, 36 friends read or `empty_unverified`, 3 managed unresolvable; the 16 Seerr sources ok, the zero-list one `empty_unverified`); (b) the gate says verified; (c) the pool's watchlisted titles show "On a watchlist" on the Trash wall and `onWatchlist` in a dry-run guardian pass over the open batch; (d) a registry read of each Seerr user equals a direct Seerr read (Q-03); (e) the D-12 derivation over the 170 pool movies and the ledger's grabbed names: self-check misses, null groups, `low_confidence` terms, renamed-only terms narrowed around a namesake's year (D-25cr) and the items D-11 would keep as `release_unrecorded`, counted (Q-05, Q-12; Q-13 goes to the owner only if that share is material), with the read-only `release-block-seed.ts --pool` report (DESIGN-052 D-25bj; OPS-017 §7), which writes nothing; (f) the CronJob pods reach plex.tv, community.plex.tv and discover.provider.plex.tv; (g) the rule pools still show `listExclusions` and `forceSeerr` true and the audit is SAFE; (h) over a day of runs, every Seerr `Failed to retrieve watchlist items` log line lines up with a registry `account_failed` (a failed or inconsistent Seerr read), never with an ok read that shrank a list. When all pass, one haynes-ops PR removes `TRASH_WEB_DELETES_HELD` from the web pod and sets the sweep CronJob's `suspend: false`. Never resume it with `kubectl`: while git still says `true`, the next release's Helm upgrade suspends it again without a sound (CronJobNotSucceeding skips a suspended CronJob, and a sweep that never runs logs no `sweep_paused`). | Every check's result is in the log below; DESIGN-052 Q-03, Q-05, Q-12 answered; any failure fixed in a follow-up PR before the sweep resumes; Flux applied the resume PR: the sweep CronJob shows `suspend: false` and the web hold is gone (an Expedite confirm opens again). |
| S6a | **Done 2026-09-26: the owner answered "Leave them out" (DESIGN-052 D-25de); nothing to probe.** **Managed Home users (DESIGN-052 Q-01, PRD Q-15):** put Q-15 to the owner with AskUserQuestion (it signs in as a managed user and mints a token and a session for them). On a yes: try the switch for one managed user, read-only otherwise, and check plex.tv's devices and sessions for side effects and that the owner token still works; if clean, enable the switch path and check that the three managed accounts read. On a no: they stay `unresolvable`. | The owner's answer and, on a yes, the probe's findings are logged below; the ruling is a D-NN in DESIGN-052 and Q-01 / Q-15 are resolved. |
| S7 | **The first guarded sweep** (the first due batch after the sweep resumes at S6): its log shows the inline refresh `ok`, `gate verified=true`, `kept … reason=watchlisted` for any listed item, `release-block recorded` per survivor, `reconciled … wrote=true` before the first Maintainerr handle, then the handles, each followed by its `[trash] deleted {…, handled: true, records: active}` line (the record turned `active` after its *arr `GET` 404ed; DESIGN-052 D-25az). Radarr's (or Sonarr's) profile holds the new terms (`GET /api/v3/releaseprofile`). Right after the first PUT, one ordinary search (an interactive search of a monitored title, no grab) still shows a non-blocked release as accepted, proving no term broke every decision (ADR-093 C-19). Record Radarr's RSS-sync and search durations the day before and after (Q-04). | One real sweep completed with those lines in that order; a read-only join of the batch's deleted items against the registry finds zero watchlisted deletions; the search check passed; Q-04 has before/after numbers; S0 ends. |
| S8 | **Seed the Release Block (D-15):** export both legacy HaynesTower SAB histories (`binhex-sabnzbdvpn`, `linuxserver-sabnzbd`) read-only over `hw-ssh` into a scratch file (never committed); `release-block-seed.ts --dry-run` with the ledger and `--legacy-sab` sources (counts per source, the rows skipped because their *arr record still exists, Silent Night and The Unholy Trinity by name, and what stays unblockable, ADR-093 C-21), then `--apply`; re-read the live legacy history for Babygirl, Another Simple Favor and Terrifier, confirm names by size and the tmdb and Radarr ids (Q-11), then `--manual` for their terms (and for either named title the bulk match missed); the manual terms take the *arr's years too (Terrifier `(?:2016|2018)`), and a batch row they cover is counted `manual.covered`, not unblockable (D-25cs). | Radarr's and Sonarr's profiles hold the seeded terms (read-back); the per-source and unblockable counts are in the log; Q-11 answered. |
| S9 | **Seerr enable (ruling 3), after S8.** Preflight: (1) set Seerr's Sonarr `animeTags` to `[1]` (`mediarequests`) with one `PUT /api/v1/settings/sonarr/{id}` echoing the whole GET body, logged and read back (DESIGN-052 D-17); (2) join every Seerr user's 20 newest titles (read-only) against deleted titles with no `active` or `in_flight` term; seed each match from the legacy SAB (`--manual`), and if any has no recoverable identity, hold the enable and ask the owner (AskUserQuestion) whether to enable anyway. Then set `seerr_watchlist_enroll` to `{enabled: true, onlyUserIds: [<canary>]}` (audited setting write, actor null); after the next registry run, read that user's settings back (both flags true) and user 1's unchanged (Q-09); watch one Seerr sync (3 minutes): "Created media request from user's Plex Watchlist" lines, the Radarr/Sonarr adds and their grabs, none matching a blocked term. Then `{enabled: true, onlyUserIds: null}` and one more cycle. | Seerr's Sonarr `animeTags` carries `mediarequests`; the preflight join is logged with every match seeded or ruled; one enrollment row per Seerr Plex user (17 on 2026-09-27, the owner's `already_on`); `GET /api/v1/user/{id}/settings/main` shows both flags for every user; the first-enable requests are counted (expected at most about 34 movies and 48 shows) and every resulting grab is outside the Release Block; Q-09 answered. |
| S10 | **Remediation re-requests:** for Babygirl, Another Simple Favor and Terrifier, if S9 did not already request them (`GET /api/v1/movie/{tmdbId}`), `POST /api/v1/request {"mediaType":"movie","mediaId":<tmdbId>}` with the API key (DESIGN-052 D-18). | Each title is requested, grabbed with a release outside its blocked terms (Radarr history `sourceTitle`; the blocked group appears only as a rejection) and imported, still on a watchlist, and tagged `mediarequests`. |
| S11 | **Close-out:** ADR-093 and DESIGN-052 to Accepted; the status notes on ADR-025, ADR-036, ADR-073, ADR-084 and ADR-092, and the "Extended by" lines on DESIGN-010, DESIGN-011, DESIGN-014 and DESIGN-048, read "in effect since"; PRD, glossary and HANDOFF updated; issue #576 closed with a summary comment; this plan to `completed/`. Ask the owner (one AskUserQuestion) whether the S0 interim Saves stay permanent or are revoked now that the watchlist guard covers them. | The close-out docs PR is merged; #576 is closed; the owner's answer on the interim Saves is applied and logged. |

## Rollback

Reverting the image alone restores today's behaviour, which is the problem: the sweep would delete watchlisted
titles again (against ruling 1) and delete without recording or blocking the release (against ruling 2), and after
S9 every enrolled user's Seerr would re-request a deleted title and fetch the same release (#576's loop). So roll
back in this order:

1. In one haynes-ops PR, set `suspend: true` on the `sync-trash-batch-sweep` CronJob (before S6 it already is) and
   `TRASH_WEB_DELETES_HELD: "true"` on the web pod (it holds Expedite and Expire now while an image that knows it
   runs, DESIGN-052 D-25cc), and restart S0's manual cross-check for every open batch. The PR lands before step 4's
   image revert, or at the latest in that same change. Never suspend the sweep with `kubectl` instead: once S6 has
   set `suspend: false` in git, a hand-set suspend lasts only until the next Helm upgrade (a hold PR without the
   suspend, or step 4's revert), which puts it back to unsuspended, and the older image would then delete
   watchlisted titles without recording or blocking the release (D-25db). The older image ignores the flag: once
   step 4 reverts it, Expedite and Expire now delete unguarded as before ADR-093, so nobody uses them until the guard
   is back (S0 covers batches only).
2. If S9 has run: set `seerr_watchlist_enroll` off (audited setting write; it stops new enrollments). Turning users'
   sync back off is a per-user `POST /api/v1/user/{id}/settings/main` (the whole GET body echoed) with each flag set
   back to the row's `movies_before` / `tv_before` (the user's own flags before the app's write, DESIGN-052 D-25cj),
   done by hand only on an owner ruling. The users the app turned on are the `seerr_watchlist_enrollments` rows with
   `already_on` false, including pending ones (`confirmed_at` null: a write whose answer was lost, D-25bs).
3. Stop the `haynesnetwork-sync-watchlist-registry` CronJob through haynes-ops, never with a `kubectl` suspend (a
   Helm upgrade undoes it): remove it in step 4's change, so the same Helm upgrade that reverts the image deletes it,
   or set its `suspend: true` in an earlier change. The older image's `sync.ts` rejects `--mode=watchlist-registry`
   (`CliUsageError`, exit 2), so a registry CronJob left running on it would fail a Job every 15 minutes and trip
   job-failure alerting.
4. Revert the image tag in haynes-ops, and in the same change remove the `sync-watchlist-registry` CronJob and the
   D-21 Loki alerts (with the older image they go silent: it logs none of their lines, so they would neither page nor
   clear). Keep the sweep's `suspend: true` from step 1: edit the tag, never a wholesale `git revert` of the S4
   change, which would take that line out. From the revert on, arm or disarm a Trash rule only in Maintainerr's own
   rule editor (it saves the whole rule), never from the app's Rules tab: the older image's toggle PUTs the rule
   group without its top-level `listExclusions`, `forceSeerr` and `arrAction`, Maintainerr 3.29.0 then stores
   `false`, `false` and `0` (the defect DESIGN-052 D-16 fixed), and the older audit checks only `arrAction` and the
   horizon, so it still reads safe (D-25cu).
5. Only once no running image reconciles them (a live image re-creates a deleted profile on its next reconcile),
   delete the release profiles by hand if the block itself is the problem; otherwise leave them blocking.
6. Resume the sweep only when S0's check covers the open batches or the guard is back, and only after
   `GET /api/collections` on Maintainerr shows, on every active pool, `listExclusions: true` and `arrAction` 0 on a
   rule pool, `forceSeerr: true` on a rule pool that is not an episode pool (D-25bt), and `arrAction` 4 on Leaving
   Soon. A pool that lost a flag to a Rules-tab toggle would otherwise delete with no import-list exclusion and no
   Seerr clear, and nothing would say so; set it back in Maintainerr's rule editor first. Resume it with a haynes-ops
   PR that sets its `suspend: false` (and, once a guarded image runs again, removes `TRASH_WEB_DELETES_HELD`), never
   with `kubectl`: git's `true` would suspend it again on the next Helm upgrade, and a suspended sweep raises no
   alert.

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
- 2026-09-26: S2 part 2 built on `feat/watchlist-protection`: the Deleted-Release Record and D-12 terms (whitelist
  grammar, self-check, year alternation, low-confidence renamed-only records), the Release Block writer (one app-owned
  profile per *arr, validate, create or PUT, read-back, expiry, the 3,000 cap, the stranded in-flight settle) and the
  two-phase sweep and Expedite (identity → record → profile write and read-back → claim → handle → *arr GET → active;
  a failed write pauses cleanly, a failed handle or a present item abandons, no term keeps `release_unrecorded`), the
  seed script (`release-block-seed.ts`: ledger, `--legacy-sab`, `--manual`, `--dry-run`), the Arm/Disarm fix and the
  invariant requiring `listExclusions` and `forceSeerr`, Seerr enrollment (off; the `seerr-watchlist.ts` switch and the
  anime-tags preflight), the D-23 re-add check and card counts, the *arr and Seerr half of the D-20 stubs, and CLAUDE.md
  hard rule 4. Rulings in DESIGN-052 D-25ad..D-25aw.
- 2026-09-26: S2 code review (Opus, PR #595; each finding checked by three skeptics): a handle whose answer is lost
  after Maintainerr deleted the item now keeps the block (the settle always asks the *arr; an ambiguous failure stays
  in flight), the D-19 overlay has its 5-minute margin and a late re-read before each claim, `seerr_only` accounts are
  re-decided while Seerr's user list fails, every name of a series key and of a ledger key is recorded, a stale ledger
  import no longer names a disk-imported file, a short name gives no exact term, a pause ends once its batch leaves,
  the card's "Lists" group splits accounts like the headline, re-adds count titles, the phone tile note is the
  bookmark alone, the sweep logs one `[trash] deleted` line per delete, S6(e) has its read-only `--pool` report, the
  Phase A seam is shared, the web surfaces have render, API and e2e tests, OPS-017 is the runbook, and this plan's
  rollback suspends the registry CronJob. Rulings in DESIGN-052 D-25ax..D-25bm.
- 2026-09-26: S2 second review pass (Opus, PR #595; each finding checked by three skeptics): the owner's list that
  shifts between page reads is read again, never returned short; the re-add window runs from its own sighting; a
  movie whose names differ gets a record per name when its term falls back to exact; fold-only terms are counted; the
  sweep job runs the Release Block upkeep hourly (the stranded settle and the expiry); a Seerr enrollment row goes in
  pending before the write (`confirmed_at`); an episode pool is not held to `forceSeerr`; the Expedite and gate
  refusals have their own copy and appCode; the Expire report names what stopped it; the card's first-failed
  headline; OPS-017's alerts match the logged reasons. Rulings in DESIGN-052 D-25bn..D-25bz.
- 2026-09-26: S2 third review pass (Opus, PR #595; each finding checked by three skeptics): the D-19 overlay takes an
  add whose outcome plex.tv never confirmed and an undone remove; Expedite and Expire now are held with the sweep until
  S6 (`TRASH_WEB_DELETES_HELD`, S4 and the rollback); a Phase A that failed after its write landed cleans that *arr;
  the upkeep reads each profile every run and repairs drift, and also runs in the registry CronJob (it keeps going
  while the sweep is suspended); a sweep that throws for any other reason records its pause; the seed records one
  term once (BYNDR blocked for Another Simple Favor); identity and the settles check the external id; an enrollment
  keeps the user's own flags for the rollback; the registry failure lines log the status; the card's exclusion counts
  never wait on a hung *arr; the Expire now preview, the tile view and the Library notice know the watchlist keep;
  the dev:local stubs serve The Fixture's grab history and the stored pool flags; hard rule 4 names every write.
  Rulings in DESIGN-052 D-25ca..D-25cq.
- 2026-09-26: S2 fourth review pass (Opus, PR #595; each finding checked by three skeptics): a renamed-only term's
  widened years leave out a year where the ledger holds another title of the same name (The Killer 2024 would have
  blocked The Killer 2023's FLUX release; S6(e) counts `namesakeNarrowed`); the `--manual` seed's term takes the
  batch row's, the ledger's and Radarr's years (Terrifier `(?:2016|2018)`) and a covered batch row is not counted
  unblockable; a season-less ledger import is blocked by its exact name or keeps the series; the rollback forbids the
  older image's Rules-tab Arm/Disarm and checks the pool flags before the sweep resumes; the Library notice keeps the
  watchlist note on Save; the Start-a-batch preview counts only freeable bytes and mirrors the `propose` filter; the
  Expedite-all protected line and the Expire now outcome lines are pinned and dash-free; the dev:local stubs keep a
  release profile per *arr; ADR-093 C-13 and glossary T-73 catch up. Rulings in DESIGN-052 D-25cr..D-25da.
- 2026-09-26: S3 done: release PR #587 merged and v0.101.0 published (00:50Z 2026-09-27); its manifest and cosign
  `.sig` answer 200 in GHCR. S4 opened as haynes-ops #3223. Its review: the chart renders `suspend` on every CronJob
  and a Helm upgrade puts the live value back to git's, so this plan's `kubectl` suspend and resume of the sweep would
  be undone (the S4 deploy lifts a hand suspend; a rollback's hand suspend is lifted by the hold PR or the image
  revert, and the older image then deletes watchlisted titles unrecorded; a hand resume is silently re-suspended by
  the next release). S4, S6 and Rollback steps 1, 3, 4 and 6 now suspend and resume through haynes-ops git, S4's
  declaration and daily check are gone, and the registry CronJob runs `backoffLimit: 0` so the `run_failed` streak
  counts slots; OPS-017 is Active. Rulings in DESIGN-052 D-25db, D-25dc.

- 2026-09-26, about 16:33Z: Summer of 69, Influencers and The Alto Knights (the friend-watchlisted titles left in the
  pool) were Saved from the pool (save intents, origin `user`, actor null), so no later batch can draw them. Found by
  S6(c) (their intents open, Maintainerr's exclusions live) and logged here for S0.
- 2026-09-26: S6a done. The owner answered Q-15 on his phone: "Leave them out just make sure to automatically pickup
  new users. I'll move everyone on Plex Home to their own account linked with the server." The managed-user switch is
  never built or probed; the three managed users stay `unresolvable`. New users need no change: every registry run
  re-reads the roster from plex.tv, and once enrollment is on, every run enrolls each Seerr Plex user without a
  confirmed row (a person gets auto-requests after signing in to Seerr once). DESIGN-052 D-25de, PRD Q-15.
- 2026-09-27: S4 done. haynes-ops #3223 merged at 01:18Z (`594fbb1`); Flux rolled v0.101.0; the registry CronJob's
  first run (01:22Z, `wl-registry-first`) logged `run_complete` ok, so migration 0081 is in; `sync-trash-batch-sweep`
  shows `suspend: true` live and in git, and the web pod carries `TRASH_WEB_DELETES_HELD=true` (the Expedite refusal
  itself was not exercised). Batch `08576e59` expired at 06:17Z and waits in `leaving_soon` while the sweep is
  suspended.
- 2026-09-27: S6 (a)..(g) passed, 01:21..02:00Z on v0.101.0, read-only: every script ran in a web pod with
  `default_transaction_read_only=on` and `BEGIN READ ONLY` (a write probe was refused), and HTTP GETs only; a second,
  independent pass reproduced each check.
  - (a) 42 accounts (owner, 2 full Home, 36 friends, 3 managed), equal to plex.tv's `/api/users` and
    `/api/home/users` read independently (class and uuid 41 of 41; all three owner tokens give the same roster); 39
    read, 3 `unresolvable`. The owner reads through discover (151 titles); both full Home members read through
    community with titles; of the 36 friends, 15 read through community with titles and 21 answer empty (17 with no
    Seerr user, 3 read through Seerr with titles, 1 whose Seerr list answers 0); the managed users are
    `not_applicable`. The 16 Seerr sources (2 full Home, 14 friends) read ok, the zero-list one `empty_unverified`.
    Seerr now has 17 Plex users: user 17, the second full Home member, joined 2026-09-26T18:27Z; the owner's link is
    read through discover, so the sources stay 16. The Watchlists card reads 21 read / 21 can't be read, not the
    research's 22 / 20 (DESIGN-052 D-25dg). The first run left 69 titles unmapped (63 shows, 6 movies: its 200 discover
    lookups were spent); the 01:29Z run mapped all of them. None is in the pool, and every pool item carries a
    `plex://` guid (164 of 164), so every item stayed evaluable.
  - (b) The delete gate said verified with nothing blocking at 01:30, 01:31, 01:34, 01:50Z and after the 01:44Z run;
    `propose` filtered; no `trash_sweep_status` row.
  - (c) Movie pool 164 (170 less the six Saved), TV 0. A dry-run guardian pass over the delete snapshot: 164
    evaluable, 0 `ruleEvaluationFailed`, 0 `onWatchlist`, none kept. An independent union of direct reads (38
    community, 16 Seerr sources and the owner's, the owner's discover list; matched by discover id, tmdb and title
    and year) lists none of the 164 and none of batch `08576e59`'s 45 pending items, which stay deletable. Its five
    Saved items: Trap, Death of a Unicorn, The Legend of Ochi and The Toxic Avenger Unrated `onWatchlist` true (the
    direct reads agree), Paranormal Activity 2 not listed. The six watchlisted titles known at authoring are all Saved
    and out of the pool, `onWatchlist` true on the delete and display snapshots and on the direct reads. The wall's
    read model (refreshed 01:30Z by v0.101.0, 164 of 164 guids) shows no "On a watchlist" note, right for this pool;
    the batch wall's data marks the 4 listed Saved tiles `onWatchlist` (checked in `getBatchDetail`, not on screen).
    Caveat: no listed title is in the pool today, so the pool side of this check is vacuous.
  - (d) After the 01:29Z and 01:44Z runs, each of the 16 Seerr sources equals a direct sequential Seerr read (the same
    `ratingKey` sets, each read twice, `totalResults` equal to the distinct count, no inconsistent page); the owner's
    Seerr list equals the discover list (151); community 38 of 38 equal. DESIGN-052 Q-03 answered for today's load.
  - (e) `release-block-seed.ts --pool` (writes nothing): movie pool 164, 162 recordable (shape group 162; 6 verified
    from grab history, 156 `low_confidence` renamed-only), 2 `no_term` (Whaledreamers, The Specials: DVD files with no
    resolution token), `unrecordedShare` 0.012, `foldOnly` 0, `namesakeNarrowed` 3 (Stolen 2023, The Killer 2023, The
    Conference 2022), no null group; every stored term matches its own name. Over the ledger's 20,593 real names: Radarr
    1,159 (group 1,109, exact 40, none 10; 3 fold-only), Sonarr 19,434 (group 17,466, exact 1,763, none 205; 345
    fold-only, 1.8%: names with an apostrophe, an accent or `&` that Sonarr, testing the raw title, would not block;
    85 season-less). A renamed-only term blocks 1,027 of 1,123 real Radarr names in simulation (91.5%). Q-05 and Q-12
    answered; 1.2% kept is not material, so Q-13 is not asked (DESIGN-052 D-25df); the renamed-only reach is an
    accepted limit (D-25dh, ADR-093 C-22). The fold-only defect is fixed by D-25dd: re-run off-cluster over a
    read-only dump of the same ledger (20,594 names) and of the pool's D-11 inputs (the old derivation reproduces all
    164 live identities), `foldOnly` falls from 348 to 0 with every shape count unchanged, the pool's counts are
    unchanged, and the simulation rises to 1,035 of 1,124 (92.1%).
  - (f) The registry CronJob's pods reach plex.tv (roster 42), community.plex.tv (38 ok) and
    discover.provider.plex.tv (lookups 200 and 183 resolved, 0 failed); Loki shows three `run_complete` ok (01:22,
    01:29, 01:44Z) and no `roster_read_failed`, `owner_read_failed` or `account_failed`; no egress policy selects
    these pods in `frontend`.
  - (g) The Maintainerr audit is safe (3.29.0, every integration up, 4 armed rules, 4 active collections, 0 aging
    violations); `GET /api/collections` shows pools 1 (movies) and 3 (TV) with `arrAction` 0, `deleteAfterDays` 9999,
    `listExclusions` and `forceSeerr` true, and Leaving Soon 22 and 23 with `arrAction` 4.
  - Still open: (h) needs a day of registry runs (from 2026-09-27T01:22Z) lined up with Seerr's `Failed to retrieve
    watchlist items` lines (none since the registry started; the last two, 2026-09-26 02:30Z and 05:18Z, came from
    the owner-only sync). Then S0's final cross-check of batch `08576e59` (45 pending), in the 1 to 2 hours before the
    resume PR merges, since the first sweep after the resume closes it. The resume PR (haynes-ops: the sweep's
    `suspend: false`, `TRASH_WEB_DELETES_HELD` removed) waits on both and on the D-25dd release's deploy.
