**Adversarial review (Codex Astra), first pass — Verdict: needs the named corrections below before its Fable review.**

Reviewed `fa4bdc14c4897264b1fdfc3900d70e42ec83c6c6` against freshly fetched `main` `780fdeb1`, on 2026-11-14. This is a source review with local synthetic tests and production **reads**, not an installed correction or acceptance. The coordinator owns #855; I did not claim or close it. The mandatory Fable review remains outstanding.

All production counts below are **measured**, not estimated. Sources: `opwork show 855 --history --full`, including 8449/8454/8505; `opwork show 837 --history --full`, including 8447/8448; the retained PR inputs; replica `postgres16-11` SELECTs at 07:54:32Z, 07:56:20Z, 07:58:01Z and 08:03:04Z; and serial, page-bounded household Tautulli GETs starting 07:54:10Z. Every database capture checked `pg_is_in_recovery() = true`. Test fixture values below are explicitly synthetic. No account's viewing detail is reported.

**Corrections, most serious first**

**1. P1 — Paging completeness is insufficient authority for the new destructive viewer projection.** `watch-user-projection.ts:28–37` clears any existing mapped viewer's absent contribution to `play_count=0` (or null for an unidentifiable target), `last_viewed_at=null`, `watched=false`, `in_progress=false`. But `metadata-refresh.ts:662–679,706–708` still calls a read complete when metadata is unavailable, explicitly conflicts with the history kind, or has no usable ids. An empty successful first history page also establishes completeness without a baseline check. These are attribution gaps, not evidence that an existing viewer never watched.

Measured local reproductions on 2026-11-14, using the real `readHouseholdWatch` and `projectUserWatchRows`, embedded PostgreSQL 16 and stub Tautulli clients:

- Seed a synthetic genuine watched row, then return its movie history with `get_metadata=null`: `complete=true`, `unjoined=1`, proposed replacement `0/null/false/false`.
- Return that history's metadata as `media_type=clip` with the same otherwise usable id: the same clearing occurs. The kind refusal is correct; treating it as negative viewing evidence is not.
- Return an empty successful history: the existing row is cleared without distinguishing a genuinely empty source from an accidentally empty/reset history.

The **new** behavior is clearing absent viewer rows. The household harvest's incomplete-identity zero policy already existed; this PR extends its consequences. `TautulliClient.getMetadata` itself documents that null can also mean Plex is temporarily unreachable. This is not a claim that those failure conditions occurred during my production read.

**Required change:** make subtractive viewer repair depend on verified attribution/coverage, not solely `watchComplete`; preserve existing evidence when an identity/read is unresolved. A narrowly scoped repair of positively identified cross-kind/id-zero contamination is preferable to clearing every absent mapped viewer. Add real-harvest tests for rejected/unavailable metadata, unexpectedly empty history, and missing user attribution. Until that is implemented and dry-run evidence is reviewed, keep subtractive repair behind an explicit apply gate. Merely writing household null instead of zero would not retain a Trash keep: the guardian reads the last-viewed instant.

**2. P1 — The census collector can print response content on a JSON parse error.** `.agents/context/watch-join-855/read-household.mjs:31` calls `response.json()` outside its sanitized fetch catch, and line 80 prints arbitrary `error.message`. Node includes a response fragment in JSON syntax errors. A local VM execution of the actual committed script with a synthetic API key `K855` and `fetch` returning the invalid JSON text `K855 invalid-json` produced an error containing that canary. The measured assertion was `error_contains_canary=true`. This proves the claimed guarantee that no key can reach an error message is false if an upstream/proxy error echoes request data. No real key was used in this test, and I found no credential in the committed evidence.

**Required change:** catch JSON/body/URL parsing failures too, emit only an allowlisted stage/instance/status, and never print arbitrary exception messages or response snippets. Add a synthetic canary regression test. The collector must fail closed on API refusal, retaining the current serial GET-only behavior.

**3. P2 — Remove the whole-library evidence from the public tree, as already directed in #855 comment 8505.** Remove `household-inventory.csv`, `before.json.gz`, `projection.json.gz`, and `history.json`. Their measured contents are respectively **10,715 data rows plus a header** (the advertised 10,716 is a line count), **18,450 live-item records**, **10,715 projection records**, and **1,792 joined household rating-key groups**. Household-only is not the same as necessary to publish. Keep the affected-title list, aggregate summary, queries and sanitized capture procedure. Update `summarize.py` and the README so reproduction accepts privately supplied inputs rather than requiring removed files in git. The affected list has **174 data rows** and is sufficient for this change's public review; explicitly document that `history.json` currently excludes unresolved groups, so it cannot prove their absence of viewing.

**4. P2 — Malformed raw numeric GUIDs can still become valid ids before the new normalizer sees them.** `guidsFromMetadata` calls `parseTautulliGuids` (`adapt-metadata.ts:251–260`), which uses `Number(id)`. The new `usableWatchGuids` then sees only a positive integer. Measured synthetic probes show `tmdb://0x10` and `tmdb://1.6e1` both become id **16** and are accepted; the same conversion applies to TVDB. Thus “malformed ids rejected on every route” is overstated. This coercion pre-exists in the parser, but rejecting malformed ids is an explicit claim of this fix.

**Required change:** validate the raw decimal GUID component before numeric conversion on the harvest metadata route (and mirror it in the census collector); then apply the safe-positive-integer check. Add malformed raw TMDB and TVDB cases, not just integer zero/missing/empty cases. No malformed live id was established by this review.

**Live plays: what the correction removes, and what it still cannot know**

I independently joined the retained `history.json` to `before.json.gz` using equal usable ids **and arr kind**, deduplicating a history group matched through multiple ids, then compared each result to `projection.json.gz`. There were **0 play-count mismatches**. The same calculation using fresh household inputs and a fresh replica projection gave the same played/zero populations:

| Live population | Stored played | Projected played | Projected zero | Projected null |
| --- | ---: | ---: | ---: | ---: |
| Radarr, 9,630 titles | 1,299 | 1,274 | 8,356 | 0 |
| Sonarr, 1,085 titles | 500 | 464 | 621 | 0 |

Counting rule: played means count greater than zero; zero and null are separate. Each projected row sums to its live population. **25 movies + 36 shows = 61** titles go from positive to zero. The other changed records remain positive. The retained collision/sentinel union is **174 = 2 × 76 + 22**; **73** of those change watch columns, and **3** other titles differ because of newer source results. The **76** TMDB cross-kind pairs include **46** with identical positive stored records; **0** remain identical positive after projection, including server attribution in the comparison. TVDB and IMDb cross-kind pair counts are **0**.

For the fresh read I ran the main and PR routing rules over the **same** paged source, preserving only household kind/rating-key aggregates and title identities. The cached inputs came from a replica SELECT of matches → libraries → servers → items. Both routes shared each metadata response. Unjoined means a movie/show rating-key group not admitted to the external-id index, **not** necessarily an indexed group that can join a live ledger title:

| Instance | Grouped history rows read | Main unjoined | PR unjoined |
| --- | ---: | ---: | ---: |
| HaynesOps | 218 | 1 | 1 |
| HaynesKube | 22 | 0 | 0 |
| HaynesTower | 39,050 | 640 | 640 |

The combined **641 = 635 metadata-unavailable + 6 no-usable-id** groups were unjoined on both routes. I found **0 previously admitted history groups newly rejected** by the PR in this snapshot. Source kinds totaled **32,876 episodes + 4,076 movies + 2,338 tracks = 39,290 rows**, matching the instance totals. No clip, missing-type or standalone-show history row occurred in this capture. There were **45 season-zero episode rows**; the join has no season exclusion. Cache/library kind conflicts measured **0**; returned usable metadata types were movie/show. Cached disagreement and unexpected metadata therefore require synthetic coverage, not claims of live validation.

Every movie's existing positive-to-zero record was attributable to another show's plays. Every show's corresponding record was attributable either to another movie (**16 shows**) or to the zero-TMDB fan-out (**20 shows**). The latter copies the plays of DuckTales (2017) and Condor; those retain their own **1** and **10** plays through alternate usable ids. No previously joined, correctly attributed real play was demonstrated to be newly lost by the kind/id correction.

There is nevertheless a real false-“never played” example **inside the keep-loss list: Troy (2004)**. Fresh bounded `get_history` GETs for retired rating keys `548208` and `456114` returned **2 household grouped plays**, both movie/Troy/year 2004 with the same Plex movie GUID. Their household instants were 2026-08-04T18:56:43Z and 2025-03-10T03:15:07Z. The replica identifies the live Radarr title as TMDB 652, IMDb `tt0332452`, year 2004. Both old rating keys lack retrievable metadata, so both main and the PR omit those genuine historical plays. Main's stored **7** instead came from *What's New Scooby-Doo?*; the PR removes those unrelated plays and writes zero, not Troy's actual recorded history. **Troy is the named real-play gap I verified; it is not a newly dropped correct join.** Its own observed last play is outside the recent-watch window and it retains the Age Guard.

The **61** positive-to-zero titles were checked individually against their contributing household title identities. For compact auditability, the names are:

- **25 movies:** Green Lantern: Emerald Knights; Mirror; Galaxy Quest; Porgy and Bess; Kiss of the Dragon; Dragon Ball Z: Fusion Reborn; P.O.W. The Escape; David; Sister Act; 2001: A Space Odyssey; Be Cool; All Star Superman; Black Gunn; Beautiful Thing; A Nightmare on Elm Street: The Dream Child; Debug; Pan's Labyrinth; The Man Who Came Back; Citizen Kane; The Host; Troy; Revenge of the Green Dragons; The Black Cauldron; Stalker; The Bridges of Madison County.
- **16 shows losing cross-kind movie plays:** Taxi; Rome; Sex and the City; Buffy the Vampire Slayer; Star Trek; Jonathan Creek; Valley of the Boom; Midsomer Murders; Jackie Chan Adventures; The Bachelorette; The Rockford Files; My Little Pony 'n Friends; Muppet Babies; Bear in the Big Blue House; Cheers; X-Men: Evolution.
- **20 shows losing the zero-id fan-out:** Playmakers; Grey’s Anatomy Texas Spinoff; Legends (2027); Lioness (2021); Star Wars: Icons of the Force; I Am Groot; The Corner; Swamp Thing (2019); The State Funeral of HM Queen Elizabeth II; Weg Met Ons Ma; People Like Us; Forky Asks a Question; Dancing with the Stars; Lincoln: Divided We Stand; War and Remembrance; My World and Welcome to It; Dragon Ball Super Friends; Gravity Falls (Shorts); The Régi.G; TILT.

These lists include animation/anime-related titles and same-name movie/show franchises; a name or franchise match is not authority to transfer plays across kinds. I did not identify an additional real lost play among those titles. Name matches among unresolved histories elsewhere in the library are leads, not proven identity matches, and are not counted as verified losses.

**Zero versus null.** In the measured live ledger every video title has a usable external id, so no video newly stores null. The **7,735 Lidarr titles** stay null; music remains outside this join. The **22** zero-TMDB shows still have usable TVDB/IMDb identity: **20** project to zero and **2** stay played. Synthetic targets with no usable id store null as designed. However, an external id existing in the ledger does not mean the harvest can identify all that title's history: the mismatched-id synthetic case (Sonarr TMDB 0/TVDB 456 versus Plex TMDB 123 only) remains unmatched while the read is complete, and an indexed-but-unmatched group does not increment `unjoined`. Zero must be described as “no attributable play found,” not proof of never played. This qualifies the story's no-play evidence; it does not justify inventing an id bridge or restoring cross-kind matching.

**Trash: fresh replica reconstruction**

I reran the PR's read-only `projection.sql` with the fresh household input, then independently evaluated its booleans against `buildPendingItems`/`classifyGuardian`: recent means `last_viewed_at >= measured_at - 720 hours`; other keeps mean Save, dnd, watchlist, Request Keep, Age Guard, or unverified release name. The library-fill setting remained off. There were **11 losses, 0 gains**, and **6** with no other database keep. All losses were outside the pool and every open batch.

| Movie clearing the database keeps | Own attributable history after correction | Other database keep | Pool / open batch / November 20 batch |
| --- | --- | --- | --- |
| 2001: A Space Odyssey | 0; no identifiable last play | none | no / no / no |
| Beautiful Thing | 0; no identifiable last play | none | no / no / no |
| Citizen Kane | 0; no identifiable last play | none | no / no / no |
| Das Boot | 2; last 2026-07-05T09:51:48Z, outside the window | none | no / no / no |
| Sister Act | 0; no identifiable last play | none | no / no / no |
| The Bridges of Madison County | 0; no identifiable last play | none | no / no / no |

For the zero rows, “no identifiable last play” is deliberately not a claim that an actual last play was measured and was old. Their contaminated recent plays belong respectively to The Challenge, Bob the Builder, Mister Rogers' Neighborhood, The New Adventures of Winnie the Pooh, and The West Wing. Das Boot's recent contamination belongs to SpongeBob SquarePants; its own movie plays remain. No own-title history candidate was found for the zero rows in the fresh capture.

The other losses are Galaxy Quest and Pan's Labyrinth (watchlist), Troy and Muppet Babies (Age Guard), and Hacks (Age Guard; its own latest attributable play is 2026-10-14T02:06:46Z, just outside the window at measurement). These **6 + 5 = 11** account for every loss. The replica's batch due **2026-11-20T17:17:11.329Z** is `leaving_soon`, contains **50** items, and contains **0** of the six movies. The replica snapshot alone does not establish future pool membership or live exclusion/rule/registry gates.

**Release judgment:** do not let this build perform unrestricted subtractive repair automatically on its first harvest. The current household keep-loss list is reproducible, and comment 8505 records that the coordinator has read it; the automatic release mechanism is explicitly permitted by the story's constraints after acceptance. I am **not** inventing a separate-backfill requirement from acceptance item 7. My additional hold is based on finding 1 and the unreviewed viewer reductions: first fix the coverage/clearing behavior, produce a dry run using the actual writers' planning logic, and have the coordinator review its household and aggregate viewer deltas. A default-off apply switch is a reasonable way to separate installation from that step. The mandatory Fable review is still required before merge. Absence from today's pool is not a permanent safety control.

**Per-viewer semantics and readers**

No `user_media_watch` row is deleted. The projection calls `@hnet/domain`'s existing `upsertUserMediaWatchBatch`, which replaces the fields listed in finding 1 and updates `updated_at`, in its normal chunked transaction. Existing absent rows for currently mapped viewers are cleared on a complete read; no absent zero rows are newly created. Equal rows are untouched. An unmapped viewer's old rows remain. A changed Plex mapping recomputes against the new Plex id and can zero an app user's previous rows when that id has no contribution; there is no stored mapping provenance/confirmation check in this repair.

A failed/partial read preserves **absent** contributions, but can still overwrite a **present** viewer with only the surviving sources. A measured synthetic case with an existing count **7**, one returning source contributing **1** partial play, and another source failing produced `complete=false` yet proposed `playCount=1, watched=false, inProgress=true`. This replacement behavior already existed before this PR; do not describe the PR as introducing it or as protecting all partial-read data. Add the missing multi-instance regression/coverage policy when fixing the new clearing path.

Replica aggregate SELECTs measured **1,587** existing viewer rows, all mapped, all positive; **193** in-progress and **1,281** watched. **122** rows belong to the collision/sentinel union. These are aggregate exposure counts, **not** a prediction that 122 rows will change. No production per-viewer dry run was performed.

`rg` over production TypeScript/TSX confirms:

- `packages/api/src/ledger-query.ts` reads this table for watched, unwatched and in-progress facets, including exports using that shared predicate. Clearing a row removes its watched/in-progress membership and can add unwatched membership. `viewerHasWatchData` checks row existence, so zeroing keeps the facet available.
- `getUserMediaWatch` exists but has no application caller in the searched tree; its current `playCount ?? 0` also collapses an unknown count if a caller uses it. The evidence's Library per-viewer-detail claim is overstated; distinguish the helper from a wired UI reader.
- MCP/watch progress uses separate `watch_titles`/`watch_events` and live Plex data. This harvest does not change those records or watch marks. The direct Trash guardian uses household last-viewed data, **not** `user_media_watch.in_progress`.
- Household ledger metadata, sorting, watch indicators and Trash wall/batch badges read `media_metadata` and will reflect the corrected counts/dates. Batch state itself is not rewritten.

**Evidence hygiene, documents, validation and gaps**

I read every text file under `watch-join-855`, decompressed both inputs, parsed every JSON/CSV record, checked field allowlists and scanned string values for email, URL and credential-assignment shapes. I found no account identifiers, per-account viewing fields, requester/viewer names, credentials or keyed URLs in the retained data. This is a content/shape inspection, not a guarantee that arbitrary free text could never contain a person's name. The collector vulnerability is a separate error-path finding. The unnecessary whole-library files should still be removed.

Running the supplied `summarize.py` reproduced `summary.json` and both CSVs byte-for-byte. I independently checked the join counts, exact elapsed watch cutoff, affected-set arithmetic and the lists above. One implementation/document discrepancy is harmless **in this measurement**: `identical_positive_after` in the summarizer compares count and instant but omits the server promised by the README; independently including server still gives **0**. Fix the predicate or description for reuse. The inventory's 10,716 figure is lines, not titles. No other table-count discrepancy was found.

The full diff changes DESIGN-008 while its status is **Draft**, adds D-15 and Q-13–Q-15, and edits no Accepted ADR. Its main kind/id and null rules describe the code. The zero meaning, partial-read limits and reader claims need the qualifications above. No new ADR, migration, glossary term or design decision was introduced by this review.

Measured local validation on 2026-11-14, suites sequentially with at most two workers:

- `pnpm --filter @hnet/sync exec vitest run watch-join-identity lifetime-watch-harvest per-user-watch-harvest --maxWorkers=2 --no-file-parallelism`: **3 files, 11 tests passed**.
- `pnpm --filter @hnet/sync exec vitest run plex-match --maxWorkers=2`: **2 files, 12 tests passed** (also selects plex-match-phase).
- Reviewer-only `vitest run review-855-adversarial --maxWorkers=2`: **1 file, 7 reproduction tests passed**. These assert the problematic current outputs; they are not safety-regression passes. Cases: partial present viewer, unavailable metadata, conflicting metadata, empty history, unmapped/changed mapping, disjoint Plex/ledger ids, and malformed raw numeric GUIDs. The collector canary was a separate local Node VM test.
- `git diff --check`: passed. `gh pr view 1077 --json headRefOid,statusCheckRollup` confirmed the pinned head and successful required lint/typecheck, test, build and e2e-gate checks. CI image build was skipped; no deployment claim follows.

The PR's tests do not cover the risky end-to-end outcomes above. Its cache-disagreement test does exercise fallback, but there is no regression proving that a rejected identity cannot clear a real existing viewer row. Anime/special-specific live fixtures and same-work movie/show alternate catalog classification are also not established by that suite.

Review questions (record-local Q-16–Q-18, following this branch's reserved questions; no DESIGN-008 renumbering):

- **Q-16:** What negative evidence permits clearing an existing viewer row when history identity is unresolved? Recommendation: preserve it unless the correction can positively establish contamination; use explicit coverage/provenance and an aggregate dry run.
- **Q-17:** May “known never played” be used for deletion/audit conclusions when retired keys such as Troy's remain unresolved? Recommendation: no; label the measured result “no attributable play,” record the existing gap, and require a separately scoped identity-recovery decision rather than guessing from names or restoring id-zero matches. Story acceptance 4 currently permits zero for no identifiable play, so changing that storage contract requires coordinator resolution.
- **Q-18:** What production baseline distinguishes genuinely empty history or an intentional mapping change from an incomplete/reset source? Recommendation: an explicit apply decision for subtractive reconciliation plus a tested completeness policy before unattended clearing.

I could not prove the absolute absence of historical viewing for unresolved/retired keys, identify arbitrary aliases from title strings alone, or predict future deletion eligibility. I did not write to the app/media services, run a production backfill, alter mappings, deploy, merge, or launch another session. Grafana tools were available but no additional log/metric evidence was required for the demonstrated findings; I make no historical error-rate claim. The next safe step is the author’s correction round, coordinator review of the resulting dry-run deltas, then the required Fable review.
