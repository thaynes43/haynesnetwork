# Trash re-add audit: adversarial review (Fable 5.2), 2026-11-13

Companion to [2026-11-13-trash-readd-audit.md](2026-11-13-trash-readd-audit.md), OpenProject story **#818**. The audit was written by a Grok worker; this review was written by an independent Fable 5.2 session that re-measured the live systems. It is reproduced as the reviewer recorded it on the story and on pull request 1060. **Where the two differ, this review governs.**


**Verdict: the report can be relied on only after the corrections named below.** Its counts are right. Its answer to the ToS question (claim 3) is wrong, its route table omits three routes this app owns, and two of its questions rest on premises it did not check. Faster Trash should not be ruled on from the report as it stands.

Reviewer: session `haynesnetwork-1113-170938`. Every number is measured on 2026-11-13 between 17:10Z and 17:30Z unless marked. Reads: CNPG replica `postgres16-11` (`pg_is_in_recovery()` true, `SELECT` only); Radarr and Sonarr `GET` inside their pods; Maintainerr `GET /api/rules`, `/api/rules/constants`, `/api/collections`; Loki through Grafana. Nothing was written anywhere. The order and the story do not conflict.

## Findings, most serious first

### F1. Claim 3 is wrong: the same release was fetched again, and three of the four "unproven" rows are provable

The app's ledger keeps `grabbed` events (`sourceTitle`, `indexer`) after Radarr forgets them. Query: for each `trash_expedited` event, the title's grabs after it compared with its grabs before it and with its Deleted-Release Record, names reduced to letters and digits. Second check: `trash_batch_items.deleted_size_bytes` (frozen at batch creation, `trash-batches.ts:1932`) against Radarr's current `movieFile.size`.

- **38 movies** have a grab after a Trash delete: 30 of the 34 present ones, plus **8 that came back and were deleted a second time**. The report has no row for those 8. (17 titles have two deleted rows, 643 rows for 626 titles: these 8, and 9 that were not deleted the first time, F9.)
- **Annabelle (250546), present now.** Grabbed 2026-07-03 from indexer A; deleted 2026-08-29; grabbed three times on 2026-08-30 10:31Z, same name, same indexer A (two failed, one imported). Radarr `history/movie?movieId=9696` agrees. Report: "Unproven".
- **Do Not Enter (999136), present now.** 16,914,556,814 bytes at delete; 16,914,556,814 bytes now; re-downloaded 2026-07-26. Report: "Unproven".
- **Jay and Silent Bob Reboot (440762), present now.** 29,891,264,579 bytes at delete; 29,891,264,592 now. Report: "Unproven".
- **Mother Mary (1102883).** The first grab after the delete was the deleted file's own release from the same indexer (it failed); the file now is a different release.
- **Came back and were deleted again:** Aliens vs Predator: Requiem, The Mummy: Tomb of the Dragon Emperor, The Nun (same name and same indexer as before the delete), Sharknado (same name as its record), Ghost Rider: Spirit of Vengeance (same name with a suffix, another indexer). Each returned the morning after its delete, at Kometa's run time, between 2026-07-19 and 2026-08-23.
- **After the Release Block went live** (first records 2026-09-27 22:45 ET): no return matches the deleted file's name. Two cases remain. **Scooby-Doo (9637), 2026-10-01:** Radarr fetched from indexer B a mislabelled release, named for another film, that it had already fetched from indexer B and failed on 2026-07-08. The term starts with Scooby-Doo's title, so it cannot match; the record is stamped "different". **We Bury the Dead:** a name with no group, 1.24 MB off the deleted 52.75 GB remux. Not proven either way (The Astronaut, another group's remux, is 12 MB off).
- **Frankie Freako** can be closed: 9.59 GB deleted, 15.57 GB now. Different.

**Change:** rewrite claim 3 and those rows; add the 8. The true statement is: eight titles re-fetched the deleted release (one of them as a suffixed repost on another indexer), and a ninth tried and failed, all before the Release Block (latest 2026-09-13). Since it went live: none by name, one re-fetch of a release the block does not model, one unresolved. Indexer letters are this review's own.

### F2. "Zero same-release stamps" is not evidence

`checkReleaseBlockReadds` (`release-block.ts:1711-1810`) tests a returned title's grabs against the record's own term, the same pattern the release profile already rejects. It can fire only when the block itself failed. It cannot see a title with no record (the report's four), a name the term does not match, or any grab after its first verdict. **Change:** drop it as support for claim 3. The ledger comparison in F1 is the independent test, and belongs in a follow-up story as the standing check.

### F3. The route table omits three routes this app owns

All three call `POST /movie` or `POST /series` through `@hnet/arr/write`. None reads the exclusion list or any Trash state. Tags are copied from the ledger row and no Save is recorded, so the returned copy is not a request and has only the Age Guard.

| Route | Code | Who | Search |
| --- | --- | --- | --- |
| Trash, Recently deleted, **Restore** | `trash.restoreDeleted`, `trash-flow.ts:2262`, `restore-flow.ts:557` | 3 roles hold `restore_deleted` | Off; added monitored, so RSS takes it (Radarr every 30 min, Sonarr 15) |
| Ledger, **bulk Add & search** | `ledgerAdmin.bulkAddAndSearch`, `restore-flow.ts:363` | Ledger `edit` | On; up to 1,000 titles a run, tombstoned rows included |
| Failsafe **Restore diff** | `restore` router, `computeRestoreDiff` | Admin, API only | Off |

557 Trash-deleted movies are tombstoned, monitored ledger rows today, which is what the diff and the Ledger offer. Not used so far: 0 `trash_restored` or `restored` events; `restore_runs` holds one `ledger_add` run of 2 titles on 2026-07-06. **Verdict to add:** unguarded for the title, partly guarded for the release, and not protected afterwards.

Also unnamed: Radarr's own Collections (0 of 1,079 monitored today; a monitored one adds its missing films, and whether it honours exclusions was not read). Checked and guarded: Release Pick refuses "Contains these ignored terms" for everyone (`release-pick.ts:206`).

### F4. The Release Block remembers only the file on disk at the delete

Radarr's history for a deleted movie is gone (read live: a returned movie's history starts at its re-add), and Scooby-Doo shows its blocklist did not carry over. So earlier failed grabs and files replaced by an upgrade are forgotten. Measured: the ledger holds 103 distinct grab names from before the delete for 84 deleted movies. Tested against the live terms on the replica: 75 blocked; 13 not blocked on titles that have a term; 15 on titles with no term. 25 titles have at least one release fetched before that nothing blocks. Scooby-Doo is the live case. This is in neither the gap list nor the questions.

### F5. Low-confidence terms are the norm, not a subset

Since the Release Block went live, 223 of 227 sweep deletions carry a renamed-file term; since 2026-10-04, **183 of 183**. Radarr was rebuilt from disk on 2026-07-03 (`trash-age-guard.ts` header) and the rule only takes titles older than 180 days, so almost no pool title has grab history in Radarr. **The report's recommended answer to Q-05 therefore stops Trash almost entirely, and it does not say so.** All 223 terms do carry a release group. The missing option: take real names before the delete from the legacy download history, which gave the backfill 338 verified records.

### F6. Claim 2 holds today, on one clause nothing audits

Read live: the movie rule has an active clause on Radarr tags (property `[1,2]`, action 9, `mediarequests`); the TV rule has the same on Sonarr tags. Both pools: `arrAction` 0, `listExclusions` true, `forceSeerr` true. So the report's 2026-10-30 claim is confirmed for 2026-11-13. In practice it has not been breached: 0 deletions follow a Seerr request event, and of 524 pool movies 0 are tagged, 0 have a request, 0 were deleted before.

The weakness: `mediarequests` is read nowhere in `packages/domain`, and `auditMaintainerr` does not check the clause. The rule body has already changed without its description: the live IMDb threshold is 6.5, the description says 6.0. That description also says the app's guardian enforces requester protection; the code says the opposite (`trash-flow.ts:1352`, ruling of 2026-07-09: a requester is informational only). The report lists this as gap 7 and asks no question.

### F7. TV is under-reported

- 6 of the 13 deleted shows have no Deleted-Release Record; the 63 records cover 7 shows. The report counts only the 50 movies.
- Kometa's skip on Sonarr is unproven live: 0 "Sonarr's Exclusion List" lines in 7 days (the Radarr line appears 7 times in each of the last three runs).
- The TV pool is type `show` today. Epic 814 expects a new TV rule, and ADR-097 C-07 says the exclusion and the Release Block both assume a whole-show delete. The report does not mention it.

### F8. Q-04 rests on an unchecked premise

Of the 45 absent movies with no record, **11 have a grab and an import in the app's ledger before the delete** (Village of the Giants, The Outer Threat, Swamp Thing, Black Box, 72 Hours, The Bay, Deep Water, The Last House, Rosebush Pruning, Bury the Devil, Lesbian Space Princess). A verified term can be derived for them; it is not a guess. Why the 2026-09-28 backfill left them out was not investigated.

### F9. Smaller corrections

- 10 of the 613 movie deletes recorded before 2026-11-12 left the title in Radarr (no tombstone within 36 hours): 4 on 2026-07-25 and 6 on 2026-09-12. Nine were deleted a week later; The Devil's Mouth is still recorded deleted and present. None since the Release Block went live.
- `trash_title_exclusions` has 183 sweep rows, not 151 (the report's figure predates today's sweep).
- Three of the four Seerr movie returns arrived within two minutes on 2026-09-28 from two Seerr users: the watchlist sync being switched on, not three people pressing Request. That bears on Q-01.

## Confirmed by re-measurement

626, 34, 592 and 0 absent without exclusion; 595 Radarr exclusions; 13 shows, all excluded, 1 present; 50 movies with no record; 638 records and 619 terms (Radarr), 63 and 63 (Sonarr), profiles at 620 and 64; zero same-release stamps; today's 32 deletions all low-confidence; no import lists on either *arr; `autoRedownloadFailed` false on both; nothing added after 2026-10-27; earliest expiry 2027-07-09; Lucky Strike kept its tag through the 2026-10-29 replacement. Six regression tests sampled all exist. Code citations sampled are correct.

## The questions

| Q | Judgement | Gates go-live? |
| --- | --- | --- |
| Q-01 | Right question. Cite ruling 3 of 2026-09-26, which already allows it, and F9. | No |
| Q-02 | Right question. "Keep 365 days" contradicts the owner's sentence as he wrote it; it is his trade to make. | No (first expiry 2027-07-09) |
| Q-03 | **Drop.** Settled on 2026-10-03 (ADR-097 C-06, C-10); no new evidence. | No |
| Q-04 | Reframe: seed the 11 from the ledger, try the legacy history for the other 34 and the 6 shows, then ask about the remainder. | No |
| Q-05 | Right question, **wrong framing**: state that "no" halts Trash (F5) and offer the third option. | **Yes** |
| Q-06 | Fine for a hand add in the *arr. The app's own routes need their own question. | No |
| Q-07 | Not a gate: the logs show Kometa adding and skipping daily, and the exclusion holds whatever the flags are. | No |

**Missing questions.**

- **Q-08 (gates).** May Restore and Ledger Add & search bring back a Trash-deleted title, and is that copy then protected? Recommendation: keep Restore as a deliberate act, admin only, and protect the copy as a request.
- **Q-09 (gates).** Should `mediarequests` be a keep inside the app, with the sweep's audit checking the clause? Recommendation: yes to both. Today's sentence and the 2026-07-09 ruling disagree, so Tom must choose.
- **Q-10 (gates the TV rule only).** Must the TV pool stay whole-show? Recommendation: yes until ADR-097 C-07 is revisited.
- **Q-11.** Does "the same release" cover every release fetched for the title before, or only the last file (F4)? Recommendation: every grab the ledger holds gets a term at delete. Need not gate.

**Before faster Trash may go live:** claim 3 corrected (F1, F2), and Q-05, Q-08 and Q-09 ruled.

## Not checked, and why

- **Seerr.** No read route. Its tag settings, and the two untagged cases, rest on ADR-093 and the five tagged returns.
- **Kometa's live `config.yml`.** Forbidden. Q-07 stands.
- **Upstream behaviour with no live case:** a hand add in the *arr ignoring the exclusion list; Radarr Collections honouring it; Radarr dropping its blocklist on delete (Scooby-Doo is consistent with it).
- **Byte identity.** Sizes and names only. Do Not Enter's and Jay and Silent Bob Reboot's earlier names predate the ledger (2026-07-03).
- **F4's regex test** ran in Postgres, not .NET; treat 13 and 15 as close estimates.
- **Maintainerr action code 9** is read as "does not contain" from the rule's own description, not from its source.
- No tests were run.

