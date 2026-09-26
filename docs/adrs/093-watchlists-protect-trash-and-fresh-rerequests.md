# ADR-093: Watchlists protect titles from Trash, and a re-request never re-fetches the deleted release

- **Status:** Proposed
- **Date:** 2026-09-26
- **Revised:** 2026-09-26, while Proposed, by the PR #594 design review (DESIGN-052 D-24): C-04, C-05, C-07, C-11,
  C-13, C-15 and C-19 revised, C-21 added, C-06, C-10 and C-11 marked as driver decisions.
- **Deciders:** Tom Haynes (three owner rulings, 2026-09-26, recorded on issue #576 and asked on his phone) ·
  drafted by Opus 5.5. The options below the rulings (the read paths, the fail-closed rule, the release profile, the
  rollout order) are **driver decisions**, marked as such.
- **Supersedes (in part):** ADR-073 C-01 (the autonomous cycle's sweep now also waits on the Registry Gate, and its
  proposals leave out watchlisted titles; C-02 here), ADR-084 D-1 and errata E-1 (the release memory is a Release
  Block, not a re-applied blocklist; C-07 here), and ADR-092 C-03 and C-04 in part (Seerr auto-requests every
  enrolled user's watchlist, the app writes Seerr user settings, and other people's watchlists are read as Trash
  guard input; C-11, C-12 here).
- **Amends:** hard rule 4's write-back list (CLAUDE.md), as ADR-083 C-04 did, with the Release Block (C-08); the
  ADR-036 aging invariant (C-10); the ADR-025 errata of 2026-07-09 ("Maintainerr rules decide what gets promoted; the
  app controls how much and when"), which gains one owner-ruled exception (C-03).
- **Relates:** ADR-023 (Trash, the fail-closed safety audit), ADR-025 / DESIGN-011 (batches, the windowed sweep),
  ADR-035 (the candidate read-model), ADR-036 (aging invariant), ADR-083 (queue janitor), ADR-084 (Trash write-back),
  ADR-086 / DESIGN-048 (durable saves, the one expedite derivation), ADR-088 / ADR-092 (the owner's watchlist and
  Watchlist Changes). Realized by DESIGN-052; built by PLAN-072. PRD-001 R-255..R-259, US-16, AC-33..AC-37,
  Q-15..Q-16. Resolves issue #576 (closed at PLAN-072's close-out). Research:
  `.agents/context/2026-09-26-watchlist-trash-protection-research.md`.

## Context and problem statement

The Trash cycle (ADR-073) deletes about 50 movies a week, unattended, from two Maintainerr rule pools. A delete
goes through Maintainerr's per-item handle and removes the whole Radarr/Sonarr record with its files, writes an
import-list exclusion and deletes the Seerr media record. Nothing in that chain looks at a Plex watchlist.

Verified live on 2026-09-26 (research note §4): three titles were deleted while on somebody's watchlist and are
still listed today (Babygirl, Another Simple Favor, Terrifier), and the open movie batch held three more (saved by
hand the same day). HaynesOps and HaynesTower serve the same files, so a delete removes a title for all 42 Plex
accounts that can see the servers.

The owner ruled, on issue #576:

1. *"We should not be deleting things that are on anybody's watchlist across the server."*
2. *"We should be requesting things even if they were previously deleted but later added by someone else. We just
   need to grab a fresh index."* and *"We can't re-request the same index but we can the same title different
   index."*
3. Asked on his phone which watchlists should auto-request: **"Everyone's watchlist requests"**.

Two facts make the rulings hard. First, **nobody holds everyone's watchlist**: the app reads only the owner's,
Maintainerr's built-in rule sees 4 of 42 accounts, community.plex.tv resolves 39 but returns a hidden list as an
empty one, and only Seerr (with each user's own stored token) sees private lists, for its 16 users. Second, **no
release memory survives a delete**: the *arr drops the title's blocklist and history with the record, its blocklist
API cannot create entries, and after a re-add the first search grabs the same top release within 3 to 84 seconds,
before any sync could react. SABnzbd's duplicate guard does not reliably catch it (a Seerr re-request downloads on
the other SAB instance, and most deleted titles came from disk with no SAB record) and costs a counted indexer fetch
when it does.

## Decision drivers

- **Ruling 1, across all 42 accounts**, not only the owner's or one server's.
- **Fail closed at the deletion moment** (P4, ADR-023 C-04): a delete happens only when the watchlists it depends
  on were read recently; a read failure never removes protection.
- **Honest about limits:** accounts that cannot be read are counted and documented, not guessed.
- **Privacy:** private watchlists read through Seerr's stored tokens are guard input only, never displayed, never
  logged per person.
- **Ruling 2:** a re-request must not fetch the deleted release even once (every fetch counts against the indexer),
  and must still find a different release of the same title.
- **Hard rule 4 stays narrow:** any new write-back is explicit, confined to `packages/domain`, audited.
- **Survive the rest of the stack:** Recyclarr's nightly sync, Maintainerr's runtime config (not in git), the
  one-way ledger sync.
- **Order matters:** the guard and the release block must be live and verified before everyone's watchlists start
  requesting (ruling 3), or the enable itself re-fetches deleted releases.

## Considered options

### A. Protecting watchlisted titles

1. **Maintainerr's "Is Watchlisted" rule** (`[0,30]`, as the last AND clause of both pools). Cheap, but it sees 4 of
   42 accounts (only accounts of the one server Maintainerr manages), re-evaluates every 8 hours, and a lookup
   failure keeps an already-pooled title deletable through the per-item handle the app uses. It would have caught 1
   of the 6 watchlisted titles in today's pool.
2. **An app guard fed by a Watchlist Registry, applied at proposal time and at the deletion moment.** (chosen) The app
   reads every watchlist it can reach every 15 minutes and again right before a sweep deletes, and the shared
   guardian keeps any title on any of them.
3. **Remove the title from watchlists when it is Trashed** (issue #576 option 2). The app can write only the
   owner's watchlist; it contradicts ruling 1 outright.
4. **Accept** (issue #576 option 3): let Seerr re-request what it deletes. Ruling 1 rejects it for Trash; ruling 2
   keeps it for re-requests.

### B. Making a re-request fetch a different release

1. **Re-apply the *arr blocklist when the sync sees the re-add** (ADR-084 E-1). Impossible: no create API, and the
   grab lands seconds after the add.
2. **SABnzbd duplicate memory** (merge the two instances' histories). Still one counted fetch per copy, and covers
   only the minority of titles SAB ever downloaded.
3. **Seerr `preventSearch` with an app-picked grab** (`GET /release`, drop the deleted release, `POST /release`).
   Works, but every Seerr request then depends on the app.
4. **A custom format with a negative score.** Recyclarr resets unmanaged scores every night.
5. **A Radarr/Sonarr release profile of "must not contain" terms, written from an identity recorded before the
   delete.** (chosen) Rejected before any fetch, on every path (Seerr, Kometa, RSS, upgrades, manual search),
   untouched by Recyclarr.

## Decision outcome

Chosen: **A2 + B5**, in BC-03 Media Ledger (the Trash section). A1 cannot reach the accounts the ruling names; A3
and A4 contradict ruling 1; B1 cannot be built; B2 and B4 do not block the first fetch; B3 moves every request
behind the app.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **The Watchlist Registry** (T-261; driver decision). A new `watchlist-registry` sync mode, every 15 minutes, reads every watchlist the app can reach and stores, per account, what it read and when: the **owner** through the discover provider (as today); **friends and full Home members** through community.plex.tv GraphQL with the owner token; **Seerr users** through Seerr's `GET /api/v1/user/{id}/watchlist` (their stored Plex tokens, which see private lists); **managed Home users** through a Plex Home switch token only if PLAN-072 proves it safe (DESIGN-052 Q-01, PRD Q-15). A title is keyed by its plex.tv discover id, with tmdb/tvdb/imdb ids mapped when known. |
| C-02 | **Supersedes ADR-073 C-01 in part.** The space policy still proposes and promotes on its own, but its proposal leaves out a watchlisted title (it does not take a cap slot), and the windowed sweep deletes only after the full window **and** when the Registry Gate (C-04) is verified. A sweep the gate refuses waits for the next hourly run; the batch stays `leaving_soon`. |
| C-03 | **The Watchlist Keep** (T-263). The one guardian shared by the batch sweep and Expedite (`classifyGuardian`, ADR-086 D-11) keeps any title on any read watchlist (reason `watchlisted`), for movies and shows alike (a show on a watchlist keeps the whole series). An item skipped this way records why (`keep_reason`). This is an explicit, owner-ruled exception to the ADR-025 errata principle that the app never overrules the Maintainerr rules on *what* is deleted; requesters stay informational. A watchlist is not a Save: when the title leaves every watchlist it is deletable again, and only a Save is permanent. |
| C-04 | **Fail closed, precisely (the Registry Gate, T-262; driver decision).** A delete needs a registry refresh that read the account roster and the owner's whole list and finished at most 30 minutes earlier (the scheduled sweep refreshes inline first; Expedite and the manual Expire now use the CronJob's run), and no readable source (an account's community, Seerr or other read) whose last good read is older than 24 hours. A failed read never removes a title from the registry: the source's last good list is carried forward. An empty answer from a source whose last good read had titles is a failed read, because community.plex.tv returns a hidden list as an empty one and Seerr answers every failed plex.tv read (a revoked token, a 5xx, a 429) as an HTTP 200 empty list; Seerr answers are therefore classified by their content, never by status (DESIGN-052 D-02). State is kept per account **and source**, so one failing source never changes what another contributes or blocks. A source that has failed continuously for 72 hours is reclassified **unreadable**, stops blocking, keeps its frozen list, and is counted; a stored title is never deleted because a source became unreadable or not applicable. An item whose watchlist status cannot be evaluated (no `plex://` guid while some registry entry of its kind is unmapped, or Maintainerr's `ruleEvaluationFailed`) is kept as `unevaluable`. Full rules: DESIGN-052 D-07. |
| C-05 | **Documented limits: accounts whose list cannot be read do not block** (driver decision). Today that is up to 20 of 42: 3 managed users (until C-01's switch path is proven) and 17 friends whose community read is empty and who have no Seerr user, so a hidden list is indistinguishable from an empty one. Every refresh counts them; the Trash status shows the counts, never who. Any friend who signs in to Seerr once becomes readable. Seerr also drops, from each page it serves, every title with no tmdb id and every title plex.tv answers 404 for, and it serves a user's Seerr-local watchlist rows instead of the Plex list when the user has any (none today); those titles are not seen. **Accepted cost of failing closed:** the registry cannot tell a hidden list or a failed Seerr read from a list its owner truly emptied, so a list that goes from titles to empty keeps its last titles, pauses deletion from 24 to 72 hours, then stays frozen (unreadable) until it has titles again (DESIGN-052 D-04). |
| C-06 | **Privacy** (driver decision). Other people's watchlists, public or private, are guard input only: stored per account for the carry-forward rule, never shown, never exposed by an API or tool, never logged by title or by person. The Trash wall says only "On a watchlist". |
| C-07 | **Supersedes ADR-084 D-1 and E-1: the Release Block** (T-265; driver decision). Before the Maintainerr handle, the sweep and Expedite record the deleted release's identity (the **Deleted-Release Record**, T-264: grabbed release name, release group, quality, size, file name, from the *arr and the ledger) and add a derived "must not contain" term to **one app-owned release profile per Radarr and Sonarr**. The term blocks that release of that title in every post and on every indexer, so a re-request, a Kometa re-add, RSS or an upgrade picks a different release with no fetch of the deleted one. The profile is written and read back **before** the delete; if it cannot be, nothing is deleted this hour. A record turns active only once the delete is verified (the *arr no longer has the item), so a failed delete never leaves its current release blocked. ADR-084's unmonitor half is moot (the record is deleted); its D-2, D-3, D-4 and errata E-2..E-6 stand: D-4's audit row for this write-back is the Deleted-Release Record, inserted before the write and tied to the deletion audit in the claim transaction, and hard rule 4 is amended in the writer's PR (C-08); E-6's ordering is exactly what this does; E-4 (exclusion visibility) and E-5 (a signal when a deleted title comes back) are delivered by DESIGN-052 D-23. |
| C-08 | **Hard rule 4 is amended** (as ADR-083 C-04 did): the write-back list gains the Release Block, a single app-owned release profile per Radarr and Sonarr holding "must not contain" terms only, written through `@hnet/arr/write` from `packages/domain`. CLAUDE.md changes in the PR that lands the writer (PLAN-072). The block never touches library files, quality profiles or custom formats. |
| C-09 | **Bounded growth.** One term per deleted movie (per season, group and resolution for a show); a term lives 365 days and the profile holds at most 3,000 terms per *arr, oldest pruned first (DESIGN-052 D-13). A re-request after a year may fetch the old release again; a loop cannot. |
| C-10 | **The Arm/Disarm defect is fixed, and the aging invariant grows** (driver decision: fixed in this plan because the rollout depends on the two flags staying true). Every app-side rule-group save lifts the top-level-only flags (`listExclusions`, `forceSeerr`, `arrAction` and the rest) from the live group before the PUT and verifies them after. The Maintainerr safety audit (ADR-036) also requires `listExclusions` and `forceSeerr` on both rule pools, so a drift refuses the sweep instead of silently changing what a delete does. |
| C-11 | **Supersedes ADR-092 C-03 in part: everyone's watchlist requests** (ruling 3; the mechanism is a driver decision). The app turns on Seerr's watchlist sync (movies and TV) for every Seerr user through `POST /api/v1/user/{id}/settings/main`, once per user, behind an audited setting that stays off until the guard and the Release Block are verified. A user who later turns it off in Seerr is left off: that is the driver's reading of ruling 3, which names whose lists request, not whether a user may opt out (DESIGN-052 Q-08). ADR-092 C-03's "the app never calls Seerr" narrows to "the watch tools never call Seerr". Seerr reads each user's 20 newest titles every 3 minutes, so the first enable requests at most about 34 movies and 48 whole shows (an upper bound from every readable list), all auto-approved; TV requests ask for every season. A Seerr request tags its add `mediarequests`, which keeps it out of both Trash pools, **except** for anime series (Seerr applies its `animeTags`, empty on this install; PLAN-072 S9 sets them to `mediarequests` before the enable, driver decision), a request an admin overrides in Seerr's request form, and a request of a movie Radarr already has (Seerr only searches it). The watchlist keep still covers those titles while they stay listed. |
| C-12 | **Supersedes ADR-092 C-04 in part.** The watch tools stay owner-only (`watchlist`, `set_watchlist`), but the app now reads other people's watchlists: with the owner token through community.plex.tv and with their own stored tokens through Seerr, for the Trash guard only (C-06). The owner's own Watchlist Changes count at once: a `watchlist_add` since the last refresh protects the title before the next read. |
| C-13 | **Rollout order is part of the decision** (driver decision): the guard and the Release Block ship and are verified on a live sweep, with the sweep held until the read-only checks pass; then the Release Block is seeded from the ledger's release history of past Trash deletions, from the legacy HaynesTower SAB histories for every deletion the ledger cannot identify, and from the legacy SAB names of the three watchlisted titles already deleted; then the Seerr enable (one user first, then all), which waits on that seed; then those three titles are re-requested explicitly if the enable did not request them. |
| C-14 | Good: the deletion that ruling 1 forbids cannot happen for any account the app can read, including a title watchlisted minutes before the sweep; the watchlist becomes a soft Save anyone can use. |
| C-15 | Good: a re-request never fetches a deleted release the app recorded or seeded, on any path, and never costs a duplicate indexer fetch. Every delete this design performs is recorded first: an item whose release cannot be recorded is kept, not deleted (DESIGN-052 D-11). The exception is past deletions no source can identify (C-21). |
| C-16 | Bad/accepted: more moving parts on the deletion path (plex.tv, community.plex.tv and Seerr must answer before a sweep deletes), and a plex.tv outage longer than the gate's bounds pauses reclaim. The pause is logged every hour, shown on the Trash page and paged once it has lasted 6 hours, for any reason; the batch simply waits. |
| C-17 | Bad/accepted: a watchlisted title stays in the pool and in Leaving Soon views (the pool is Maintainerr's); if many pool titles are watchlisted, batches shrink and reclaim slows. That is the ruling's cost. |
| C-18 | Risk/accepted: the Release Block over-blocks a little (every post and variant of the same group's release at that resolution for that title), which is the ruling's "same title, different index". A title whose only releases are blocked stays missing until a new release appears or a term expires; an admin can still grab a blocked release by hand. |
| C-19 | Risk: hundreds to thousands of regex terms on every release decision; the cost is measured in PLAN-072 (DESIGN-052 Q-04) before the cap is trusted. Risk: Radarr and Sonarr never validate a term, and a regex that does not compile in .NET makes every release decision on that *arr fail, so one malformed term stops all grabs, visible only in an error log. Terms are therefore built only from a whitelist grammar and re-validated before every write (DESIGN-052 D-12, D-13), and PLAN-072 S7 checks that an ordinary search still accepts a release after the first write. |
| C-20 | Cost: one migration (0081), one sync mode and CronJob, community and Seerr readers, the registry and gate, guardian and wall changes, the Deleted-Release Record, the Release Block writer and a Seerr settings writer on the confined surfaces, and their tests. No new credential: every key is already in `haynesnetwork-secret`. |
| C-21 | **Documented limit: some past deletions cannot be blocked** (driver decision). Deletions made before this design whose release no source can identify (no ledger grab or import and no legacy SAB match; about 43 movies and a few series today) get no term, so a re-request of one fetches whatever ranks first, possibly the deleted release. The seed counts them (PLAN-072 S8); before the Seerr enable, a join of every Seerr user's 20 newest titles against them holds the enable and asks the owner if any match; DESIGN-052 D-23's re-add check reports any later one. |

## More information

- Research, live evidence and corrections: `.agents/context/2026-09-26-watchlist-trash-protection-research.md`.
- Upstream code read at the deployed versions: Maintainerr 3.29.0 (`plex-getter.service`, `plex-api.service`,
  `rule.comparator.service`, `rules.service` `updateRules`, `collection-handler`), Seerr 3.4.1
  (`server/lib/watchlistsync.ts`, `server/routes/user/index.ts` watchlist route, `usersettings.ts` `/main`),
  Radarr 6.4.4 / Sonarr 4.0.20 (`ReleaseProfileController`, `ReleaseRestrictionsSpecification`,
  `TermMatcherService`, `BlocklistService`).
- Issue #576 carries the rulings; issue #593 (household watchlists for the tools) is unchanged by this ADR.
