# TODO

Hand written brain dump which will be derived to plans in /home/thaynes/workspace/frontend/haynesnetwork/.agents/plans for Fable 5 agent to tackle Monday 07/06

1. "Fix" for subtitle issues should trigger Bazarr to pull subtitles instead of re-grabbing from Sonarr/Radarr (use BAZARR_API_KEY from media-stack in 1Password). Mustic should not provide a "Missing Subtitles" option when you click Fix (currently does) so we don't integrat this piece with Music.
2. Users should be able to add / remove Plex libraries across the three servers. However, Admin should be able to assigin which libraries each "Role" can access. Users can only add/remove libraries their role can see.
3. Library should pull more metadata from Radarr/Lidarr/Sonarr and store it in our database. Later we will add the ability to retrieve this metadata independent of Radarr/Lidarr/Sonarr but for what is in library this is the fastest source. This should include

- IMBD rating
- TMBD rating
- IMDB / TMBD vote counts
- RT tomatoe and popcorn meter
- Posters
- Etc

We should tie this data to the libary entites and offer sorting and filtering by it. Posters should be used in the Library section instead of generic thumbnails if possible and should be stored server side not pulled from the web (kept small though). I want all of the properties https://github.com/maintainerr/Maintainerr offers for it's auto deletion rules, as much as we can harvest. We can host Manitainerr too and pull from it's metadata if possible. 

4. Add a top level section for Trash which will replace the "Restore" section of the Admin interface. Roles will be given different level of how they can interact with the trash. First, trash will either interface with https://github.com/maintainerr/Maintainerr or adopt some of it's functionality. I find Maintainerr on it's own to be far too complex for what it does. The Trash section will let users with permissions set up rules for how the server deletes unwanted media. Roles can be Edit, Read Only, Disabled for the rule section. Next it will have a tabs with tables that lets users see which items are marked for deletion (tab for Movies and a tab for TV, no reason to combine and fiter one table), when they will be deleted, and how much total space each item frees up plus how much space the complete set of items marked for deletion frees up. Users should be able to filter this table by our metadata and the filtering should be similar to what I documented in #5 as same high powered filters you will find in /home/thaynes/workspace/frontend/demo-console Work and Inventory tab (see Work -> Discover and Work -> Explore plus WMS -> Inventory). Users should be able to save an item from being deleted. If an item is saved the entity deciding what to delete (likely Maintainerr) should whitelist the item never to delete it. Users should be able to perma-save Movies and TV (we won't delete music at this time) from the Library page as well, we can use an icon for this like a pin or foppy disk, something people will know means never delete this movie (thing of something good here). Users can also expidite deletion for the full list or an individual item in the pending list. Permissions here will be more fine grained per role, with an option per action an user can take and then Disabled if the user can't use it at all. All of the Trash should be disablable for a role and the tab wil not appear, but individual portions could also be disabled so users could be restricted to something like only whitelisting (or saving) movies pending deletion.  

5. Add a top level Ledger section that has history across Movies / Shows / Artists and can be drilled down from there. I want this spreadsheet style with the same high powered filters you will find in /home/thaynes/workspace/frontend/demo-console Work and Inventory tab (see Work -> Discover and Work -> Explore plus WMS -> Inventory). The ledger should contain everything that was ever once on the server or is on the server. It should contain all metadata we have collected from Radarr / Lidarr / Sonarr plus we fill in that same missing meta data for items not in those sources (we don't need posters for the ledger). A key part of the ledger is after you apply filters you can add and search for what's filtered in the corresponding *aar. Ledger should be broken into Movie / TV / Music like Library, there is no point combining those. Access to the Ledger should be at the Role level with the same Edit, Read Only, Disabled as Trash rules. /home/thaynes/workspace/frontend/haynesnetwork/.agents/plans/radarr-fileless-backlog.md should be added to the Ledger, these were deleted items we saved to a file which is what the ledger is there for. The ledger should be exportable to disk as well to save as an emergency Radarr/Sonarr/Lidarr list if a catastrophic failure happened and I wanted to know what was on server and what was trash.

----------------------------------------

We need to make sure everything is in 1Password for Fable 5 before tomorrow. This likely means:

1. Host https://github.com/maintainerr/Maintainerr so we know the API key OR setting up the API key in 1Password and injecting as env like some *aars allow (see /home/thaynes/workspace/haynes-ops/kubernetes/main/apps/media/sonarr/app/helmrelease.yaml:93) and then having Fable 5 host.

- Maintainerr would live here: /home/thaynes/workspace/haynes-ops/kubernetes/main/apps/media/maintainerr
- Maintainerr can use tautulli data, if it can't interface with multiple interfaces the legacy haynestower instance has by far the most data, API key here: TAUTULLI_HAYNESTOWER_API_KEY

2. API keys for any services like RT/TMDB/IMDB that are needed for metadata, though if Radarr and Sonarr can get that data maybe we don't need a direct key just rate limited logic on public APIs
3. TBD?

----------------------------------------

## Parked 2026-09-14 (each needs an owner ruling before build — cold-start context in
`.agents/context/2026-09-14-trash-wall-age-guard-and-phantom-saves.md` §4/§5)

- **Duplicate-NZB fetches are dominated by upgrade/re-post loops, not trash.** 234 "Duplicate NZB"
  `downloadFailed` events across the *arrs since the 08-19 SAB Fail-mode fix: Sonarr 186 (Tiny Ones
  Transport Service alone **164**, the same AndreMor MULTI re-posts the 08-19 note named, still
  recurring 09-11), Radarr 17 (Terminator 3: one release fetched **10× in two minutes** because
  Prowlarr serves the same NZB from four indexers and Radarr's blocklist keys on release+indexer),
  Lidarr 31. Only 3 of 234 came from trash re-adds. Remedy needs a ruling: a Sonarr release profile
  that blocks the re-post group, per-series unmonitor, or a Prowlarr-side de-dupe. Evidence command:
  `kubectl -n media exec deploy/sonarr -c app -- sh -c 'curl -s -H "X-Api-Key: $SONARR__AUTH__APIKEY" "localhost:8989/api/v3/history?page=1&pageSize=2000&sortKey=date&sortDirection=descending&eventType=4"'`.
- **ADR-084 build (D-1 as amended by errata E-1/E-4/E-5/E-6):** app-side release memory on the
  deletion snapshot + re-blocklist on re-add detection, an exclusion-list prune surface, and a
  "re-added after trash delete" ledger signal. E-3 (`listExclusions` on both pools) is live; the
  Seerr re-request path is the one still able to fetch an identical NZB once.
- **Green Lantern's save intent still records the dead key 95267** (exclusion lives on 102261 from
  the 08-29 hand repair; the reconciler is pool-scoped so it never re-points it). One-line fix in
  the next `fix:` touching `trash-save-intents.ts`; also correct the `sameKeyCensus` docstring — it
  counts fresh saves awaiting Maintainerr's next rule run, not lapses.

## Parked 2026-09-25 (needs a design call; cold-start context in DESIGN-051 D-15p, PR #580 third review pass)

- **Header-only per-attempt timers in the other HTTP wrappers.** `PlexHttp` now keeps each attempt's abort
  timer armed until the body is read (a body that stalls after its headers is a timeout at the attempt bound,
  not undici's 300 s `bodyTimeout`). `ArrHttp` got the same bound only as an opt-in (`timeoutCoversBody`,
  turned on for the MCP's TMDB searches in `packages/mcp/src/deps.ts`); its default, and the wrappers in
  `packages/{authentik,kapowarr,openwebui,goodreads,books,haynesops,libretto,lazylibrarian}/src/http.ts` and
  `packages/sync/src/openwebui.ts`, still clear the timer once the headers arrive (`clearTimeout` in the fetch's
  `finally`), so a stalled body holds the caller up to about 5 minutes. Not flipped blindly: the syncs read list
  bodies (Sonarr `/series`, Radarr `/movie`, a PMS section) that may stream longer than their 30 s per-attempt
  timeout, so a whole-attempt bound needs either a separate, longer body timeout or per-caller sizing. Decide:
  (a) a `bodyTimeoutMs` per wrapper (default ~ `timeoutMs` × N), or (b) opt-in per latency-bound caller only.
  Related: the MCP's 9 s deadline (`packages/mcp/src/http.ts` `runTool`) answers the caller but passes no
  `AbortSignal` into the domain call, so abandoned work keeps running; threading a signal through
  `changeWatchlist` / `markWatched` / `undoLastChange` into the Plex and TMDB clients would stop a write from
  going out after its caller was answered.

## Smaller backlog items

- **Global collection totals (from PLAN-053 owner review, 2026-07-17).** The per-chip Type
  counts were removed from the Collections wall chip row (they bloated the mobile banner). The
  owner's call: "if we were going to do totals we'd do it globally." So the backlog item is a
  SINGLE global count of accessible collections shown once (not one number per Type chip) — e.g.
  a "N collections" label on the Collections view header. The gated aggregate already exists on
  the wire (`ledger.collectionGroups` still returns the ADR-047-gated `typeCounts`), so this is a
  small display add, not new data plumbing.