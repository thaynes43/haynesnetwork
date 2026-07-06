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