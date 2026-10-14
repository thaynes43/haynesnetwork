# PLAN-077 live repair proof, 2026-10-14

This records actual work in the Codex takeover. PLAN-077 stays active. The owner judges readiness under ADR-112.
Staff work each new report through the member tools first, teach the tool that succeeds, and record a missing
capability when a hand repair is needed. There is no readiness counter or default-policy ruling here.

## Signed deployment

- Initial takeover: PRs [965](https://github.com/thaynes43/haynesnetwork/pull/965) and
  [968](https://github.com/thaynes43/haynesnetwork/pull/968), v0.125.0, deployed by
  [haynes-ops 3905](https://github.com/thaynes43/haynes-ops/pull/3905).
- Corrective writers and consumer: [970](https://github.com/thaynes43/haynesnetwork/pull/970) and
  [972](https://github.com/thaynes43/haynesnetwork/pull/972), all four required checks passed. Release
  [971](https://github.com/thaynes43/haynesnetwork/pull/971) merged as
  `11906545fdc9e894d5d3bea77595c4a09300c0ad`. Signed v0.125.1 deployed by
  [haynes-ops 3908](https://github.com/thaynes43/haynes-ops/pull/3908).
- Actual deployment proof is merged in [haynes-ops 3918](https://github.com/thaynes43/haynes-ops/pull/3918).
  Three Ready web replicas and successful migrators, all active frontend app containers, all 24 frontend and both
  downloads templates use the verified image. Historical finished Job pods were retained.
- GHCR image and digest signature returned HTTP 200. Publisher
  [38497376028](https://github.com/thaynes43/haynesnetwork/actions/runs/38497376028) explicitly verified the exact
  workflow identity and image digest on its first attempt at 01:48:38Z:
  `sha256:5d0a28c69b7ff6ed745a09032d17b7ef72aacd3a3c988d6ab710a946252e165f`.
- Migration journal has 107 rows; baked 0105/0106/0107 hashes match, each migrator exited zero, and public/internal
  health returned 200/ok. Bounded Books Census and owed-checks Jobs completed natively with exit zero on that digest.
  Census findings and owed waits/failures remain recorded observations, not repaired state.
- Paired-file Audio Preference hints were corrected in [974](https://github.com/thaynes43/haynesnetwork/pull/974).
  The second episode now resolves the same physical Plex item, with exact file name, bytes and full Sonarr coverage
  independently checked. Missing, stale or ambiguous physical matches retain the generic link.
- [976](https://github.com/thaynes43/haynesnetwork/pull/976) fixes PostgreSQL test teardown at the real client socket
  boundary. All assertions had passed before the old teardown stopped PostgreSQL early. Public connect/remove events
  now track clients through actual closure; genuine failures remain visible. All four required checks passed.
- [Release 975](https://github.com/thaynes43/haynesnetwork/pull/975), v0.125.2, merged as
  `531df0efed0fba9695341cb46b1f4e861d4b7aa0` at 04:14:03Z. Publisher
  [38510333350](https://github.com/thaynes43/haynesnetwork/actions/runs/38510333350) explicitly verified cosign on
  attempt 1; image and signature manifests returned HTTP 200 with matching body digests at 04:26Z. The verified
  image is `sha256:b57e1a6a3a5f37151b9f193c01356169ca94b4cc4eddf68bc3589bd7f4654981`.
  Deployment and the live paired-file hint check are pending in this interim record.

## P7 and notifications

P7 comment and resolve remain on as user 19. Owned Ghost fixture 5 received one invitation and one outcome/resolve,
then was deleted on 2026-10-13 at 23:09Z. It made no library writes and is excluded from real-report/member evidence.
Read-only follow-up at 01:34Z preserved issues 1 to 4 exactly: resolved, comment counts 1/3/3/2, unchanged full
comment hashes and zero bridge-write rows. Closed historical issues are ineligible. Q-12 was asked with web push
recommended; answer pending. Email and web push remain off.

## Ben 10 (2016), S1 E10 and E12

Both wrong 2005 stories were replaced inside verified Watch Carries. Fresh all-server TV inventory found no correct
2005 copies to map to; all 47 account contexts had zero old state, so the permitted audited drop lost no marks.

| Slot | Final file / bytes | Actual content and English proof | Final state |
| --- | --- | --- | --- |
| E10 | 80009 / 454603103 | Reboot Animo Farm: mutant cow/boar and imprisoned Stinkfly at 250s; smaller barn mutants at 400s. English AAC stream 1, English CC stream 2. Canonical TVDB episode 5793263; story inference, no unseen title card claimed. | Language Fix `45785362-e400-4c23-b293-c8b30166f0b1` completed normally; both Plex physical copies and English default verified, all 47 current account contexts unmarked. |
| E12 | 79992 / 709759175 | Literal Adventures in Babysitting title card; English AC3 and English SDH, 679.52s. | Physical import and both-server proof verified. |

The first E10 replacement, 79991/342394594, was the correct reboot story but Arabic only. The P6 fix now rejects
ambiguous episode titles. Fresh Language Replace accepted only the reviewed English Animo Farm key
`d1937044088c21f3`, then the existing audited writer performed that repair. No old wrong-story state was credited
onto the new file.

## First owned-download continuations

The old batches were not replayed. The held downloads resumed under their original Fixes and verified Carries.
Source proof, full target coverage, protected files, actual import history and Plex state are separate checks.

| Continuation | Immutable actual import | Watch proof and protected state |
| --- | --- | --- |
| Pokemon S3 E1 | Fix `ac29d8ad-fd56-439f-810d-51a86e170ae3`, download `7d744369-583d-4764-a8d2-87bfd4535cb7`, grab 66760, import 66794, episode 49199 to file 80008/1563438952. One original ManualImport claim, observed to completion. | Classic Suicune/Professor Elm/Totodile story, 1289.856s, actual Hindi/Telugu/Tamil/English track 4. Both Plex new-file identities and relevant marks verified; new E1 unmarked, old resumes 225159/212000ms remain on S20 E90. Raw E12 file 33229/1108994733 unchanged on disk. Parent completed normally. |
| Pokemon S3 E2 | Fix `57e72c7e-cdba-4687-bb26-4481614c3b4b`, download `baef7bd5-df2b-48b4-bc2e-3af4b149820a`, grab 66802, import 66807, episode 49200 to file 80011/1516287508. | Classic baseball-uniform rookie/Chikorita and Charizard battle; [distributor synopsis](https://www.primevideo.com/-/id/detail/0GM9QCIMFK74P80LT0RGR4CLIC?tr=aq) corroborates the story inference. Actual English track 4, both Plex/current-zero/S20 E91 state verified. Raw E13 file 33272/1110595405 unchanged on disk. One bounded true-history ingestion completed the parent normally at 02:40:12Z. |
| Mickey S1 E1/E2 | Fix `634962cc-05dc-4cb9-bcf6-eea6116a2adb`, download `c2b268d1-9a61-4bc1-8653-7fd81724b64c`, file 80010/1476355129. Authoritative transient check and one existing-parent import; full two-episode read-back, then owned neutral queue cleanup. | Literal Mickey's Wild Tire! and Sittin' Kitty cards; English AAC stream 7 and English SDH stream 28. Both Plex actual paired items 58493/556243 have the new physical file and zero current marks. Correct S3 paired copy retains its strictly verified marks. Protected E3/E4 file 24800/1565636010 unchanged. Parent completed normally; first worker slot finished 02:38:38Z. |

Pokemon E1/E2 queue absence was adopted and read back; neither trail contains a queue DELETE intent/result.
Mickey's raw queue claimed four episodes while the file covers two. Its neutral cleanup occurs only after actual
whole-file import proof, without client deletion, blocklisting or search. Plex represents each Mickey paired file
as one metadata item; proof records that actual item separately from its independently proved Sonarr episode pair.
A new physical item absent from the old-content carry plan must have zero watched/resume state. Recent timestamps
alone never prove a new play; changed marks require playback evidence tied to the new file before acceptance.

## Continuing slots and held sources

Pokemon E1 to E7 are physically verified and their original Fixes completed normally. Later proof includes the actual
English track, both Plex copies, the new slot's unmarked state, the old story's correct-copy marks and protected files.
E3 is A Sappy Ending (80012/1541428706); E4 is Roll On, Pokemon! (80014/1589568449); E5 is Illusion Confusion
(80016/1541624177); E6 is Flower Power (80017/1550397917); E7 is Spinarak Attack (80021/1523071195). These story
identities use observed scenes and canonical synopsis evidence, not invented title cards.

The first finite worker was stopped only at an idle, verified prefix. Its exact UID and successful deletion are bound
to the saved checkpoint; a fresh read-only revalidation at 04:09Z checked the completed parents, full Carries, files,
protected identities, Plex copies and marks. Continuation `frontend/pokemon-owned-cont-v1251-20261014-0415`, UID
`ba9e6537-1546-47e5-bcfc-3488270913b7`, started at 04:14:16Z on a worker node with a 500m CPU limit. It verified
the sealed seed and worker hashes and adopted E1 to E7 before its first new control. Next is E9; E8 stays held.
The continuation intentionally uses the verified v0.125.1 helper, with a finite deadline of 09:14:16Z. Its running
image must be reported honestly during the v0.125.2 rollout. It is not restarted to make an inventory look uniform.

Mickey's initial slots E1/E2, E3/E4 and E5/E6 are physically verified and normally completed, with literal cards,
English, full paired imports, actual queue cleanup and strict per-account Plex proof. The next slot, E7/E8, is held.
Append the final per-slot proof before merging this note; a grab or prepared script does not establish completion.

### Mickey E7/E8 failed-download recovery

Original Fix `d26e411f-7b47-42e4-a363-2633de493d64` has verified version-1 Carry
`76419c02-7b27-41e7-afba-baac49a21d24`. The old file was removed only after its one existing mark was verified on
the correct same-content copy. The chosen release then failed with Duplicate NZB: actual grab records 66838/66839,
failure records 66840/66841, download `301dc257-aa97-4ee6-8f3d-89b04da1c4f4`. No import was claimed or observed.
The worker exited at 03:11:59Z on a truthful refusal; the original Fix remains pending and E7/E8 are empty.

The janitor's failed-download search subsequently grabbed a different download. Physical subtitle and scene checks
proved that source contains Mickey's Monstrous Truck and Minnie's Vacation Home, the old Season 3 stories, despite
its E7/E8 file label. It must not be imported as the correct replacement. Original E13 to E16 and completed-prefix
files remain unchanged. A normal Release Pick with no offers did not establish absence: the proper replacing-mode
classifier found fresh named alternatives, including a distinct iVy encoding with English.

DESIGN-055 P4 decision 39 and PLAN-077 were written before implementation. Recovery must reuse this original Fix
and Carry, preserve the already carried marks, and bind an actual new grab and whole-slot import. It may abandon
only the exact proved wrong queue item, with blocklist on, client removal off, redownload skipped and no search.
An uncertain removal or grab is observed or refused, never repeated. The janitor must defer another failed-download
search owned by this active verified repair without spending its loop budget. This recovery waits for final review,
a signed deployment and a fresh exact live plan. No borrowed member identity, second delete or new Carry is allowed.

Pokemon E8 and E31 retain their wrong files. Two bounded NZB reads found only obfuscated split archives and parity
subjects. Correct story, release group and English remain unproved; that does not establish that no release exists.
Never use Saon. Mickey E13 to E16 remain held until new E7/E8 content is proved and a fresh same-content mapping is
reviewed. Every next slot needs the exact approved release, fresh source/destination identity, verified Carry,
English and story proof, actual whole import, protected-file read-back and relevant per-account Plex proof.

English is available in every checked Pokemon context. Owners select English; one affected context selects Hindi.
The show preferences remain unset. A 549-only audit read found zero original-behind-other files, so the existing
ADR-115 scanner does not flag the show. A household preview offering a set does not authorize expanding that scope.
No household preference write was made; the member guide can teach selection of the available English track.

## Dated holds and owed checks

OC-056 remains held until 2026-10-15T20:10Z and closed blocking Fixes. Paw Patrol's tvdbAiring ordering switch must
finish in a verified Watch Carry before its season plan is regenerated. Preserve the only Runaway Stargazer copy.
The later archive-week and first-member-use observations remain pending; staff repairs and the removed bridge
fixture do not satisfy member-use checks. The final step-6 evidence belongs here after the current repairs.

Root activity `act-034019-464174` covers the scoped rollout and media work until 2026-10-14T09:40:19Z. Root must end
it after verification or renew it before expiry while actual work continues. Only owned Jobs/processes may be stopped.
