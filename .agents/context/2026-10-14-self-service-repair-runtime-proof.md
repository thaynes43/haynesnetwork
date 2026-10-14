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
  [haynes-ops 3919](https://github.com/thaynes43/haynes-ops/pull/3919) merged at 04:34:44Z as
  `9d2556a46a09e50468a0526b07a47ac02ef26f47` after both required checks and a review without findings.
  Live verification at 04:45:35Z confirmed three Ready apps and three successful migrators on that exact signed
  digest, all 24 frontend and both downloads CronJob templates, both health endpoints and migration 107 with all
  baked SQL hashes. The deliberately pinned Pokemon continuation was the sole older running execution; no pending
  app pods remained. Retained finished Job pods were preserved.
- The bounded v0.125.2 Books Census Job, UID `1977f6a6-fcd8-4d30-82ee-e027367f7fb1`, completed at 04:42:32Z;
  owed-checks, UID `ad4a66a9-f243-4bd9-bf89-7f79c16848ab`, completed at 04:43:30Z. Both exited zero with the exact
  signed digest. Root independently read their native completion and identities. This records successful runner
  execution; real member observations and dated holds remain owed.
- The live paired-file check passed after the rollout: E1 and E2 previews agree with all 24 audio tracks on the
  independently matched physical file on both Plex servers, including names, ordering, language and default flags.
  Both previews are `already_set`/`present`, with specific audio guidance. It used 21 reads and zero media writes.
- [977](https://github.com/thaynes43/haynesnetwork/pull/977) merged as
  `1c7a44245ceb132d94d9f97103a8e7a34830f902` at 04:45:38Z after all four required checks. The test fixture owns its
  direct Node sync process, cancels on timeout and waits for actual closure before cleanup. Nine deterministic
  ownership tests and both focused browser cases passed; both advisory findings were addressed and the renewed
  review had no findings. This changes test lifetime only; the original stalled UI action remains unknown.

## P7 and notifications

P7 comment and resolve remain on as user 19. Owned Ghost fixture 5 received one invitation and one outcome/resolve,
then was deleted on 2026-10-13 at 23:09Z. It made no library writes and is excluded from real-report/member evidence.
Read-only follow-up at 01:34Z preserved issues 1 to 4 exactly: resolved, comment counts 1/3/3/2, unchanged full
comment hashes and zero bridge-write rows. A final bounded read-only audit on v0.125.2 at 04:42Z again matched the
original full text/ID/author hashes and statuses of issues 1 to 4, with zero domain bridge-write rows and zero closed
historical eligibility. Comment and resolve remain on for the expected bridge user; email and web push remain off.
Q-12 was asked with web push recommended; answer pending. The audit used five Seerr GETs and a read-only database
transaction, without touching the removed fixture, other reports or member accounts.

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

The continuation also verified E9, The Little Big Horn (80023/1554931427), and E10, The Chikorita Rescue
(80024/1583822286), with English track 4 and normal full completion. Root spot-checked E9's bandaged Stantler fawn
and its later capture in a net, and E10's visibly injured Chikorita and later snowy-forest scene. Both Plex copies,
old-content correct-copy marks, new current-zero state and protected E20/E21 files passed. Next is E11.

The first finite worker was stopped only at an idle, verified prefix. Its exact UID and successful deletion are bound
to the saved checkpoint; a fresh read-only revalidation at 04:09Z checked the completed parents, full Carries, files,
protected identities, Plex copies and marks. Continuation `frontend/pokemon-owned-cont-v1251-20261014-0415`, UID
`ba9e6537-1546-47e5-bcfc-3488270913b7`, started at 04:14:16Z on a worker node with a 500m CPU limit. It verified
the sealed seed and worker hashes and adopted E1 to E7 before its first new control. It resumed at E9; E8 stays held.
The continuation intentionally uses the verified v0.125.1 helper, with a finite deadline of 09:14:16Z. Its running
image must be reported honestly during the v0.125.2 rollout. It is not restarted to make an inventory look uniform.

E11 exposed a temporary verification-reader bug: slicing the last two digits read S20E100 as E0. The external
reader and cold continuation collector now parse the full anchored season/episode coordinate; seven actual positive
and six malformed/cross-season cases passed. The serving domain writer already used full coordinates, and the running
worker's embedded collector is used only at startup. E11's file 80025/1592293332, English track 4, both Plex copies,
correct-copy S20E100 marks and protected E22 file passed before finish at 05:05:52Z. No Plex change or import replay
was used to overcome the false refusal.

E12, Whistle Stop, also passed: file 80026/1491996742, English track 4, real import 66863, both Plex copies, strict
S20E101 correct-copy state and protected E23 file 33682/1158933679. Observed Ledyba, orchard and silver-whistle scenes
corroborate the canonical story; no unseen title card was claimed. Its Fix completed normally at 05:14:43Z, and
finish serial 20 reached the idle eleven-slot prefix before any E13 replacement.

The worker's native-import observer needed a bounded history page. Root deleted only that idle predecessor
Job, UID `ba9e6537-1546-47e5-bcfc-3488270913b7`, with a UID precondition at 05:26:38Z. Both its Job and Pod were
confirmed gone at 05:28:06Z. The captured state SHA was
`e3df4700a1dcdc943c4702aaa951c1cb1db96efb99952b3946286a727a7c5e00`. Full read-only revalidation at 05:29:46Z
checked all eleven completed parents and Carries, actual files, both Plex servers, captured contexts, English and
protected identities; proof SHA `9e7b34618894e51c78b9eecf0c637c601c49e4f6b6400f0483456ba045b4bf4b`.

The corrected worker SHA is `454567817d5ecaf737bf4d7c75d138daf03dc866539fc0b352ef0638eb8bf35d`. It reads one
descending native-history page of at most 200 rows with exact download/import anchors, refusing incomplete proof;
it also parses full positive season/episode coordinates. The reviewed generator requires actual predecessor absence
and completed post-deletion revalidation even for a fresh captured state. Positive and refusal cases passed, with
zero cluster calls in guard tests. No running function was patched, captured state relabeled or library command replayed.

Successor `frontend/pokemon-owned-cont-v1252-20261014-0530`, Job UID `adcad698-99a1-4b2d-9092-50c8f6e1ba29`,
Pod UID `54f03285-c0d4-488e-b68a-e6de13a18264`, started natively at 05:36:31Z on talosw01, Ready on the exact signed
v0.125.2 image. Startup adopted only the freshly revalidated eleven-slot prefix, with no pending parent, download or
control, and next selected E13. Its deadline is 10:36:31Z; no new replacement starts after 10:21:31Z. The predecessor
image exception during the earlier rollout is historical, not a current running workload.

E13, Ignorance Is Blissey, then passed: file 80027/1573820910, actual import 66866, English AAC track 4,
both Plex copies and captured contexts, S20E102 correct-copy marks and protected E24 file 33843/1171596257.
Root checked the young-character flashback and Team Rocket with the Center food pile against the canonical food-supply
story. This is scene-based inference, without an observed title card. Fix `a5d2c26b-fc5c-4de3-9113-da316964932b`
completed normally; read-only event proof was already completed at 05:46:06Z. Finish serial 5 was accepted at
05:46:41Z only after all read-backs, then E14 began. Private account IDs stay in the runtime audit packet.

E14, A Bout With Sprout, passed: file 80028/1500200216, import 66869, English AAC track 4, both Plex copies,
captured contexts and S20E103 correct-copy marks. The already correct E25 file 79757/1464300940 stayed unchanged.
Root checked the classroom lesson/pointer and teacher with children against the canonical academy story; no title
card or unseen catch was claimed. Fix `141185f2-8f09-45dc-9815-a80090a1ae4a` completed from actual event
`62a20d41-db99-4717-979c-54694227b91a` at 05:56:43Z. Finish serial 10 was accepted at 05:57:19Z; E15 began next.

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

Root activity `act-051827-491938` covers the scoped rollout and media work until 2026-10-14T11:18:27Z. The preceding declaration ended at 05:18Z after its successor was active. Root must end
it after verification or renew it before expiry while actual work continues. Only owned Jobs/processes may be stopped.
