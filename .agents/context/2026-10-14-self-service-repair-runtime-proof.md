# PLAN-077 live repair proof, 2026-10-14

This records actual work in the Codex takeover. PLAN-077 stays active. The owner judges readiness under ADR-112.
Staff work each new report through the member tools first, teach the tool that succeeds, and record a missing
capability when a hand repair is needed. There is no readiness counter or default-policy ruling here.

## Frozen checkpoint at 2026-10-14T11:59:39.296664418Z

This checkpoint supersedes pending-state statements in the earlier timestamped snapshots below. Signed v0.125.4
is verified live; only the two independently authorized immutable initial media workers intentionally remain on
signed v0.125.3. Pokemon has **27 of 32 approved slots complete** and Mickey has **16 of 23 initial slots complete**.
Pokemon E32 and Mickey E39 are not completed by this snapshot. Final Mickey E13 to E16 remains PREPARED and held,
reviewed offline only. PLAN-077 is Active, Step 5's formal hold remains, and Step 6/P8 evidence is still pending.

### Actual v0.125.4 rollout and verification

[haynes-ops 3925](https://github.com/thaynes43/haynes-ops/pull/3925) merged at 11:38:18Z as
`ef7936cfe41024f05aed8c145b66ad51a0947346`, after both required checks and advisory review without findings.
The actual report and credential-free proof merged in [3926](https://github.com/thaynes43/haynes-ops/pull/3926)
at 11:58:03Z as `254966b069715f77f8bc69c550fe61f70b24b74a`. See its
[report](https://github.com/thaynes43/haynes-ops/blob/254966b069715f77f8bc69c550fe61f70b24b74a/.agents/reports/haynesnetwork-v0.125.4-deploy-2026-10-14.md)
and [native proof](https://github.com/thaynes43/haynes-ops/blob/254966b069715f77f8bc69c550fe61f70b24b74a/.agents/evidence/haynesnetwork-v0.125.4-deployment-20261014.json).

The live verification completed at 11:51:25.643441Z. The source and all three affected Kustomizations applied
the deployment commit; the HelmRelease was Ready at observed generation 283. All three serving replicas and
successful migrators used exact signed digest
`sha256:5522d758426a317b42fec609fbe02f8f27cdc042f03b133833002f8ccb2f881f`. All 24 frontend and two downloads
CronJob templates pin v0.125.4. Every replica's local health and public ingress returned 200/ok. The journal has
107 rows; baked 0105 to 0107 and their applied hashes agree, with all four expected schema features present.
Four deployed domain sources and the private CLI match release `ab8181c36b00d389dbdb05db534b0a10845b6178`:

| Deployed source | SHA-256 |
| --- | --- |
| `wrong-content-parts.ts` | `6edb2b9ded0ef44ad4339163c3f323207eb175ac235fd04927dbdb8b762d751a` |
| `owned-sonarr-import.ts` | `98fff1fc757d20e120fcee12edd6bc512aa87c8cc386524ccef8ecd55d241c0f` |
| `wrong-content-retry.ts` | `a044c89f43b18f1ebf33422e1db7aee29cc386871fd5fe777366e55190bb20ed` |
| `queue-cleanup.ts` | `acce8e62dd3ea21af7b8aa2c6feaa9962400b7436c63eea216dfcea8d8540d88` |
| `repair-guide.ts` | `5ff0d6f51f6ae56b50b18e59f3cce1f051705d1957302d567f1ff696df4eaa4c` |

Exactly two new bounded verification Jobs ran sequentially on talosw03 with nice 19, CPU limit 500m, deadline
300s, backoff 0, restartPolicy Never, TTL 86400 and no service-account token. Both used the exact signed digest,
reported native Complete=True/succeeded=1, exited 0 and had zero restarts. Books completed before owed was created.

| Job | Actual Job UID / Pod UID | Created / native Complete |
| --- | --- | --- |
| `verify-books-v1254-20261014-114755` | `9e96ed9b-763d-47b7-8b43-2865fd355415` / `ec8d9918-0e73-4450-8774-8deb2cd60109` | 11:47:55Z / 11:49:08Z |
| `verify-owed-v1254-20261014-115020` | `d155e9c8-bdc1-43be-bf36-4be11390157a` / `cfdf450c-8825-439b-bfd9-d83d462221a5` | 11:50:20Z / 11:50:29Z |

Books observed 1606 books, 1258 ebook files, 753 audio files, zero unreadable/missing, sixteen wrong files and
nine holds. Owed observed 56 rows, 28 pending, nine overdue and 22 evaluated: eleven pass, seven wait, 28 closed,
two manual, four fail and four not_yet. Existing failures OC-015/034/035/038 and manual OC-009/046 remain, with
all dated/member-use waits retained. These are runner observations, with no library repair, owed-YAML update,
row closure, Step 6 execution or readiness judgment. All 52 historical terminal Pods were retained.

### Immutable media workers and new accepted finishes

The 11:51:25.643410Z running inventory found exactly the following two intentional older executions; every other
running haynesnetwork Pod was a verified v0.125.4 serving replica. Their original code, identities, captures and
bounds remain unchanged. This checkpoint performs no cluster or media write.

| Worker | Frozen worker SHA-256 | Actual Job UID / Pod UID | Original write cutoff / expiry |
| --- | --- | --- | --- |
| `frontend/pokemon-owned-cont-v1253-20261014-0830` | `419610f806c90f44c3d706055f3cce62539205d6a6edde0856cfc3001a50f446` | `998d39b1-cf59-42bb-bec1-9f32126635a3` / `c3b0b685-8ee9-4d95-86bc-292935d6c654` | 13:25:21.983024Z / 13:40:21.983024Z |
| `frontend/p077-mickey-resume-v1253-r2` | `3259b55c62daa4fd0e229b372403622370bffa38bb3232f52278853bd1f20127` | `5c04bbf3-135e-4330-a52a-cb6fce15a56e` / `610f5a36-6f21-4a3a-a4cd-8e3137db7b2c` | 13:55:35.213261Z / 14:10:35.213261Z |

Both retain signed v0.125.3 digest
`sha256:463eb1c92e375f2d52d22c345b42e4f05a0fdf06c19a89e7ae50681f704c0f16`. Actual declaration
`act-073758-527071` covers frontend, media, downloads, Plex, PlexOps, Sonarr, SABnzbd and HaynesTower until
2026-10-14T14:37:58Z; record SHA is `7e4a5046caa6fb82d67ea6c3c755773d2b4124c69e4d2b55e45f42dd2e4a6dfb`.
Root owns its renewal/end. Final post-terminal all-image inventory is still owed: observe both native terminal
outcomes and exact identities, repeat the inventory, and merge that proof. Do not patch, replace, stop or extend
these original workers on the strength of the rollout.

Pokemon E30's one IMPORT47 was delivered at 11:32:29.608Z. Actual file 80059/1501485589, native import 67031,
whole episode 49228 and download `0714123b-0fb4-4e20-8d0f-c326aab31e19` bind original Fix
`5e9a3884-5493-4b34-a011-d0975ba9b1d1` and verified Carry `9dd8d976-3eda-4510-90f1-727f9d971619`.
Normal event `4b85eeed-54c9-485a-ba35-ea475a135f56` was recorded at 11:45:03.611Z; first completed observation
was 11:45:04.789Z. Measured source/library are 1920 by 1080 with English AAC4. Root's viewed 150s Wobbuffet/
maroon-shirted-boy and 300s Professor Oak/green-mug/video-call scenes support the
[official Tricks of the Trade](https://www.pokemon.com/us/animation/seasons/3/episode-30-tricks-of-the-trade)
identity, corroborated by [EP146](https://bulbapedia.bulbagarden.net/wiki/EP146); this is story inference, without a
literal-card or unseen-action claim. Four complete nonempty Plex contexts passed current-zero/correct-copy marks,
distinct S20E30 coverage and unset preferences. Protected raw E41 34640/178856668 is unchanged. Finish 49 passed
at 11:46:41.601Z; checkpoint SHA `99149422e2b6ba06269a87cb9eb1f8a31b7bb2b7b217dc841173ca741b446361` preserves
27 completions. E32/E33/E34/E36/E38 remain, plus retained held E8/E31. Full rows are in the
[completed table](2026-10-14-pokemon-completed-slot-proof.md).

Mickey E37/E38 imported natively as 80058/1463747016, whole episodes 37217/37218, import rows 67029/67030 and
download `f8696055-485d-4ec8-aa43-227cb3dd27fe`. Root viewed literal Garage Alone at 62s and Camp Happy Helpers
at 693.63s. Source/library measured 1920 by 1080 with English AAC7 and equal SHA
`8c5cd2560e8fb4eb9205a1a039403d2da6a943f50215d4c465617e42055d27bd`. Native adoption 94 was read-only, with no
ManualImport, owned-import intent or queue cleanup. Original normal event `e8b199e0-b05a-4e75-97f5-5311382c1c60`
completed on Fix `7cbb67e7-8447-4727-b1f4-399521f3a83c`/verified Carry `07a4042f-a001-42eb-916b-c6f32e88a9d6`.
Strict actual Plex items 58513/556295 at index 37 covered the whole pair; owners/every captured account passed
current-zero/correct-copy marks, with protected final 65359/1377201632 unchanged. Finish 95 passed at
11:31:55.517Z. Sixteen initial slots are complete; E39/E41/E43/E45/E47/E49/E51 remain. E39 native adoption 99 is
delivered but full finish pending, so it is excluded. The completed row is appended to the Mickey table below.

### Final proposal and continuing holds

The final E13 to E16 packet is PREPARED, suspended and held. Its offline review covered late-observe handling,
live mutating-GET deadline guards and v0.125.4 native-adoption code. The exact five current artifact hashes are in
the [final proposal record](2026-10-14-mickey-final13-16-carry-review.md); recomputation matched its private
artifact manifest. Future capture, expiry, identity and prefix-proof fields remain blank. Before any execution,
require all 23 actual initial finishes, actual predecessor termination, a fresh complete actual prefix and physical
same-content mapping, signed deployed `5522d758...` source, actual finite activity and a new root review of the
sealed concrete envelope. Offline review is not execution authorization; never load this into a running worker.

P7 remains on/on as user 19, fixture 5 deleted, protected historical issues 1 to 4 unchanged. Q-12 remains asked
and unanswered, with email/web push off. Step 5 still holds OC-056 until 2026-10-15T20:10Z and closed blocking
Fixes. Paw Patrol's tvdbAiring change must complete inside its verified Carry before a regenerated season plan;
preserve Runaway Stargazer. Step 6 and P8 follow the repairs and formal hold in the original order. There is no
readiness/default-policy ruling or metric gate; ADR-112 keeps readiness with the owner.

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
- [978](https://github.com/thaynes43/haynesnetwork/pull/978) merged as
  `7deef24087a56585de137a8cb0c6214424182a9d` at 06:53:08Z after all four required checks and a renewed review
  without findings. It adds the documented same-Fix failed-download recovery and the janitor's scoped ownership
  hold. Recovery retains the original verified Carry, binds each actual grab attempt and whole-file import, and
  observes uncertain commands without replay. Unrelated janitor searches retain their existing policy and budget.
- [Release 980](https://github.com/thaynes43/haynesnetwork/pull/980), v0.125.3, merged as
  `61f83a55eca470d41f9d27941699b8abf29fd6cb` at 07:12:07Z after all four required checks. Publisher
  [38526806143](https://github.com/thaynes43/haynesnetwork/actions/runs/38526806143) explicitly verified the exact
  cosign workflow identity on its first attempt at 07:15:54Z. Root independently confirmed the matching registry
  body digests at 07:21:29Z and the actual successful verification step. The image is
  `sha256:463eb1c92e375f2d52d22c345b42e4f05a0fdf06c19a89e7ae50681f704c0f16`; its signature manifest is
  `sha256:33c81b2479780344cc2ae91801221e6d25156c4a7d6e74e59379fbfd22053d15`. Both returned HTTP 200.
  Deployment is in progress. These artifact checks do not establish live deployment or authorize the prepared
  Mickey continuation.
- [haynes-ops 3922](https://github.com/thaynes43/haynes-ops/pull/3922) subsequently merged at 07:30:14Z as
  `9734a9463d8bd5fa03a71c94e16a4c96d0d7fe76` after both required checks. The source and all three Flux
  Kustomizations applied it; the HelmRelease is Ready. All three apps and migrators use the exact signed v0.125.3
  digest, all migrators exited zero, and all twenty-four frontend plus both downloads CronJob templates pin v0.125.3.
  Internal health on all three replicas and the public ingress returned 200/ok. The migration journal remains at
  107 with matching baked 0105 to 0107 hashes; deployed retry, owned-import and queue-cleanup source hashes match
  the reviewed main tree. The actual deployment report merged in
  [haynes-ops 3924](https://github.com/thaynes43/haynes-ops/pull/3924), `d7948aecd113096411d0b20959a0452ed81da916`,
  at 07:45:00Z after both required checks and an advisory review without findings.
- Bounded v0.125.3 Books Census Job `61f9eefe-5ef1-4aef-9798-c5d41118334b` completed at 07:40:43Z;
  owed-checks Job `ca7ecebe-8d32-4c8b-9f0a-ef251870aa9b` completed at 07:41:20Z. Root independently checked
  their native Complete conditions, exact Pod UIDs, signed image IDs and zero exits. Both used nice 19, a 500m CPU
  limit and worker node talosw03. Census still finds sixteen wrong files and nine holds, with zero unreadable or
  missing files. Owed observations retain known failures and future/member waits. These prove the runners executed,
  not that a dated or first-member observation has passed; the final step-6 snapshot still follows the media work.

- Subsequent v0.125.4 artifact proof: publisher [38555912857](https://github.com/thaynes43/haynesnetwork/actions/runs/38555912857),
  exact release commit `ab8181c36b00d389dbdb05db534b0a10845b6178`, job 115824866506, completed successfully.
  Its actual cosign verification step 11 succeeded on attempt 1 at 11:25:00.644Z for digest
  `sha256:5522d758426a317b42fec609fbe02f8f27cdc042f03b133833002f8ccb2f881f`, with the repo-workflow identity
  regexp and GitHub OIDC issuer, verified transparency claims and trusted certificates. Root independently fetched
  v0.125.4 and its digest-pinned signature at 11:26:10.253Z: both HTTP 200, matching returned/body hashes. Signature
  manifest is `sha256:f4faf47c28acaecc3a19be71e0a847678c46a2e19c7faf62e1b8ad953d91cba2`. This authorizes the
  three manifest-pin change; it does not claim live deployment. Immutable initial workers remain on v0.125.3.

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
old-content correct-copy marks, new current-zero state and protected E20/E21 files passed. At that checkpoint, E11 was next.

The first finite worker was stopped only at an idle, verified prefix. Its exact UID and successful deletion are bound
to the saved checkpoint; a fresh read-only revalidation at 04:09Z checked the completed parents, full Carries, files,
protected identities, Plex copies and marks. Continuation `frontend/pokemon-owned-cont-v1251-20261014-0415`, UID
`ba9e6537-1546-47e5-bcfc-3488270913b7`, started at 04:14:16Z on a worker node with a 500m CPU limit. It verified
the sealed seed and worker hashes and adopted E1 to E7 before its first new control. It resumed at E9; E8 stays held.
That continuation used the verified v0.125.1 helper, with a finite deadline of 09:14:16Z. Its older running image
was recorded during the v0.125.2 rollout. The later E12 checkpoint and corrected successor are recorded below.

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

E15, Fighting Flyer with Fire, passed: file 80029/1496452289, actual 1920 by 1080 video and English track 4,
import 66872, both Plex copies, S20E104 correct-copy marks and protected E26 file 33958/1110340701. The observed
Falkner/Hoothoot and Charizard/Pidgeot gym battle corroborate the story; no title card or unseen victory was claimed.
Its original Fix completed normally from actual event `0777617d-45bb-462a-8340-9dd44f50ac4d` with the ledger cursor
unchanged.

E16, For Cryin' Out Loud!, used the approved SRS fallback: file 80030/856208430, actual 640 by 480 video and one
English AAC track 1. Native GRAB 66874 and import 66875 share download `4efb7294-f99e-4522-8ba1-6e3d71b70cd4`
and episode 49214. The corrected observer's one bounded 200-row page proved the exact import and full file scope.
It adopted that existing import without ManualImport, re-grab, invented import intent or queue removal. Fix
`fe7c0be2-feda-4096-a49c-b35b3039c67e` was already completed normally, confirmed read-only at 06:21:35Z against
actual event `b6bb88d5-8c37-4542-a35a-b75fce5cdd1f`. Marill, its parasol-carrying owner and carriage scenes
corroborate the story; no title card or unseen crying was claimed. Both Plex copies, S20E105 marks and the source/
copy identities passed. No quality upgrade or household preference write occurred.

E16's empty per-slot protected-file list is expected for this native import. The approved SRS release names E16,
and actual GRAB 66874 and import 66875 target only episode 49214. There is no separate unselected raw neighbor.
The full thirty-four source/copy preflight ran first, and the native observer refused extra grabbed episodes or
extra current-file coverage. Its two observations recorded unchanged protected state at 06:13:20Z and 06:18:58Z.
Later explicitly approved replacements can change their own source identities; this is a historical per-slot check.

E17, Tanks a Lot!, passed: file 80031/1516961341, actual 1920 by 1080 video, English track 4 and import 66878.
The purple tracked tank, Sentret family and vehicle wedged on the cliff corroborate the canonical story; no title
card or unseen controls were claimed. Both Plex copies and S20E106 marks passed; protected E28 file
34091/918877254 stayed unchanged. Normal Fix completion used actual event `03e11c68-a043-4472-b884-494aff45a535`
with the cursor unchanged. Finish serial 24 was accepted before E18 began. Full immutable slot identities are retained
in the packet and will be folded into the final same-session per-slot record.

E18, Charizard's Burning Ambitions, passed: file 80032/1605039096, actual 1920 by 1080 video, English AAC track 4
and import 66881. The valley caretaker and Charizard community corroborate the canonical story; no unseen training
or title card was claimed. Fix `317c0492-2e89-4ae4-abc9-ae391ef2f451`, verified Carry
`4210af9e-04d0-4690-81e4-5b7ced9e240f`, completed normally from event
`a6ac85c5-6363-4fda-b688-6d749ab9b351`. Both Plex copies, S20E107 marks and protected E29 file
34129/921776375 passed. Finish serial 29 was accepted at 06:51:27Z.

E19, Grin to Win!, passed: file 80033/1576515027, actual 1920 by 1080 video, English AAC track 4 and import 66884.
Root viewed the group with Sunflora and the trainer holding a Sunflora-topped trophy against the canonical annual
contest story. This is scene-based inference, without an observed title card or unseen contest action. Original Fix
`f3f2a2ce-8235-426e-a567-6faec2cf68e2`, verified Carry `0ef04fda-b579-4214-9595-45671f5c4f99`, completed normally
at 07:15:03Z from real event `85014d66-5471-43f1-8a76-b63973929f60`. Its old source maps only to the proved S20E108
copy, file 35671/763997137. Both Plex copies, correct-copy marks and protected raw E30 file 34168/920793882 passed.
Finish serial 34 was accepted at 07:20:54Z; E20 then began.

A fresh strict read-only audit at 07:19:54Z revalidated all eighteen accepted files through E19 on both Plex servers,
including the owner and every captured affected account. All required leaf listings were complete and nonempty;
each current and correct-copy physical part matched uniquely, current marks were zero, and carried marks matched.
The host verifier now checks every Media.Part and refuses empty proof arrays. Its three positive and twelve
missing-account, empty-leaf, wrong-part and duplicate guard cases passed with one process under nice 19. The frozen
worker was not patched.

Review also found a timing gap in the finite worker: its command admission and outer loop check the deadline, but
the actual Arr/Plex transports do not recheck the reserve immediately before each write. Finish the current E20,
then hold at its verified idle checkpoint before any E21 replacement. A corrected cold successor needs actual
predecessor Job/Pod absence, fresh full post-deletion read-only proof, signed v0.125.3 verified live, complete account
and physical coverage, bounded underlying history, and a real activity declaration covering its finite lifetime.
Do not hotpatch the worker, replay a completed replacement or relabel a prepared envelope as live evidence.

E20, Chikorita's Big Upset, then passed: file 80035/1582434735, actual 1920 by 1080 video, English AAC track 4 and
import 66889. Root viewed Raticate biting Chikorita and the later standoff while its trainer holds a Poké Ball;
these corroborate the canonical overview without claiming an episode card or unseen motive. Original Fix
`f6499f83-2abc-42d2-b81f-17ad0c11ac10`, verified Carry `2ecf1f07-78e6-49e4-9781-89ccda770756`, completed normally
from actual event `0d6cc7af-e0c3-4bdf-9bae-e0d5fa2df2e6`. The old story maps only to proved S20E109, file
35675/761401091. Both servers and every captured account passed strict physical coverage, current-zero and
correct-copy mark checks. Held raw E31 file 34210/920982569 stayed unchanged. Finish serial 39 was accepted at
07:30:49Z; actual idle proof at 07:31:24Z found nineteen verified slots, no pending parent/download or next control.
The immutable checkpoint SHA is `34ffb14696bef28fdeaed3bc44995398572ba36f62fab1ed33c5c2a165606ad2`.
No E21 replacement was admitted. The [completed-slot proof](2026-10-14-pokemon-completed-slot-proof.md) records
full Fix, Carry and normal-completion event UUIDs, exact files/imports, correct-copy destinations and content evidence.

The held v0.125.2 predecessor was then stopped with its exact Job UID precondition. Native deletion was accepted
at 07:38:07Z; actual Job and Pod GETs returned NotFound at 07:38:26Z. Root independently confirmed both absent at
07:40:24Z. Gone-proof SHA `21ad720eb5ca8754bcdfd1fd2a269c435205ad9f057b78ca138a6ef91f987bc2` retains the original
after-E20 checkpoint hash and accepted finish time, plus actual request/response/server timestamps. An earlier
timeout-flag attempt never reached the API and was not counted as an accepted delete. Only this owned Job stopped;
Mickey's terminal predecessor remains preserved. Fresh full post-deletion proof precedes any cold successor.

Native adoption is also being narrowed to the original audited grab window, full-slot scope and unique GUID.
Parent creation time alone cannot attribute a later foreign same-title download. Read-only retrospective proof
confirms E16's real GRAB 66874 at 06:11:32Z lies between its exact `grab_intent` at 06:11:31.851Z and successful
`release_grab` receipt at 06:12:17.374Z, with target 49214 and the already recorded native import 66875. No new claim,
mark change or import replay was used. The corrected cold worker must retain its actual current-zero predicate.

The corrected cold worker, SHA `419610f806c90f44c3d706055f3cce62539205d6a6edde0856cfc3001a50f446`, and its
seed, generator and UID-bound control contract passed independent review. All actual component times must match
their hashed source files, aggregate sections must match those files, and every complete read-only component must
be fresh. Partial proof and timestamp-only refresh cases refuse. Eighty-nine focused isolated guards, the real
generated preview's refusal before evaluation, and affected types passed under nice 19 with one process.

An attempted launch at 08:35Z refused because the genuine proof had aged out; no Kubernetes mutation or media
command occurred. A complete real refresh then reread all four components, nineteen parents/Carries/normal import
anchors, thirty-four mappings, sixty-nine distinct physical files and both Plex servers with every captured account.
Original checkpoint, state and capture time stayed unchanged. Final complete proof SHA
`93a69fa898bf8bd5076c68dc5c15ceef2a945d49f5ab86229e4137b75c27c6e5` completed at 08:37:13Z. Root reviewed the
concrete Job and seed and created it directly while all four actual components remained fresh. Native creation
was accepted at 08:42:01Z; no creation request was replayed.

Current continuation `frontend/pokemon-owned-cont-v1253-20261014-0830`, Job UID
`998d39b1-cf59-42bb-bec1-9f32126635a3`, Pod UID `c3b0b685-8ee9-4d95-86bc-292935d6c654`, runs Ready on talosw02
with the exact signed v0.125.3 digest and a 500m CPU limit. Root independently checked its native identity and
image. Actual startup proof at 08:45:01Z confirms all four runtime hashes, adoption of only the nineteen completed
slots, index 19, no pending parent/download and next E21. Its control namespace starts at 1; historical accepted
serial 39 remains preserved. Job manifest SHA is `dc14c194a0288178da8bf7f97d261f4f36afb92efbb8dca2388454f19e9b00c8`;
seed SHA is `de1f6ec9cdcd5215d30461c10ed08e226efc0d29c90d5e2d1f245ba1b4d01b06`. Absolute expiry is 13:40:21Z;
every actual write checks the 13:25:21Z cutoff. The declaration covers its expiry and shutdown margin. E8/E31 stay held.

Mickey's initial slots E1/E2, E3/E4 and E5/E6 are physically verified and normally completed, with literal cards,
English, full paired imports, actual queue cleanup and strict per-account Plex proof. The next slot, E7/E8, is held.
This is an interim verified checkpoint. Merge each additional repair's full per-slot proof into this record before
ending the same session; a grab or prepared script does not establish completion.

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

The fresh deployed v0.125.3 plan was ready: exact original Fix and Carry, failed download and native grab/failure
anchors, whole targets 37187/37188 and 179 protected files. Root reviewed the distinct iVy English/Romanian offer,
key `de801bbbf5384ede`, size 682447000, with digest
`1b07bfb991bba22f07a29a4450931ec79ea838021ab0d3fbf209231a2e70b34c`. Only the previously allowed low-score and
renumbering reasons were overridden. The exact foreign source retained size 1560855497 and prior physical
wrong-story proof SHA `95eabf559fec223253c48c8b0c8cb1c8a3574deb208fce0ef5f92119c9176313`.

The first reviewed cold Job, UID `8ad2f439-73af-41b9-b304-b76be1dc5cba`, started at 07:52:05Z on signed
v0.125.3, then refused startup at 07:52:19Z. Pod UID `78516472-dccc-47b7-88ce-d4eb203225a1` exited one before any
control was accepted. No retry, library, queue or Plex write occurred; the terminal Job/Pod remain preserved.
Its completed-prefix guard incorrectly expected `fileId` in a normal ledger event. Production intentionally
stores the native source-event ID, episode and download there, not file ID. Fresh read-only checks prove all three
completed pairs retain the correct normal events, current files and verified Carries, and pending E7/E8 still has
zero retry/import claims. The cold guard fix must join that real ledger identity to bounded native import history
and immutable audited whole-slot file IDs/bytes, keeping all current-file, English, physical/account and mark checks.
Never invent a payload field or force completion. A new reviewed cold successor needs both predecessors actually
terminal, fresh evidence and actual declaration coverage; the failed worker is not patched or replayed.

The corrected prefix guard binds the real normal ledger source-event/episode/download identity to bounded native
imports and the latest immutable audited whole-slot file read-back. Three real production cases with no ledger
file ID and twelve meaningful refusal cases passed, along with affected types. Independent review approved frozen
worker SHA `3259b55c62daa4fd0e229b372403622370bffa38bb3232f52278853bd1f20127`; full affected read-only validation
on production passed at 08:07:29Z. Both terminal predecessor Job/Pod pairs remained preserved and were freshly
checked before the new launch.

Job `frontend/p077-mickey-resume-v1253-r2`, UID `5c04bbf3-135e-4330-a52a-cb6fce15a56e`, started at 08:14:03Z.
Pod UID `610f5a36-6f21-4a3a-a4cd-8e3137db7b2c` is Ready on talosw02 with signed v0.125.3 and a 500m CPU limit.
Actual startup adopted only completed slots 1/3/5 before recovery. Root reviewed manifest SHA
`bc69a85f747c58c7e66f684ccdba610d3ad440d75ccae2356b2243e3a8fb5b61` and envelope SHA
`8372c5dd98344f9d9975e84eedceff7538c7276e925a0f98760bbb3c30de1ff7`. Expiry is 14:10:35Z, with a write cutoff
of 13:55:35Z, inside the actual declaration. Original terminal-worker serial 5, later reconciled serial 20 and the
failed first cold startup remain distinct provenance.

The audited retry ran once under the original Fix and Carry. Attempt `70005338-2d1c-40aa-9f53-7d5c29f60bcb`
abandoned only the exact proved wrong foreign queue item, read back its absence, retained the download client and
skipped redownload/search. The actual new grab call at 08:17:06.094Z to 08:17:06.794Z binds download
`04f547da-7099-42e8-b396-aff4ac1aa00c` and native GRABs 66897/66898 to precisely episodes 37187/37188.
The existing Fix, verified Carry, all 181 episode identities, completed prefix and old final file remained unchanged.

Root viewed both literal replacement title cards: Agent Double-O-Goof at 60s and Egg-xasperating! at 691.54s.
Actual source is 599908341 bytes, 1351.072s, with English EAC3 stream 1 and Romanian stream 2. File SHA is
`72d69a36b932843e9452f5ecae607676bcefa5bb9de558333592d4f8a2cdca9a`. Physical metadata was checked; no speech
recognition or unseen story action was claimed. The native queue reparsed this correct source as E13 to E16, so it
remained held for target re-evaluation. The protected existing E13 to E16 file was not overwritten.

One audited owned import passed genuine target re-evaluation for E7/E8 and imported only that pair. Actual file
80038/599908341 covers exactly episodes 37187/37188; native imports 66899/66900 occurred at 08:29:38Z on the new
download. Verified read-back preceded the audited neutral owned-queue cleanup. A measured library-file hash matches
the approved source byte for byte, retaining both viewed cards and the physical English track.

Original Fix `d26e411f-7b47-42e4-a363-2633de493d64` completed normally from real event
`dcb744aa-22af-4f4d-a635-14fe337e1e83`; no settlement write or borrowed requester was used. Both Plex servers expose
one actual index-7 item covering the pair, keys 109432/556273. Strict owner/every-captured-account physical and
English checks passed with zero current plays/resume; the correct S3E7 copy retains the affected account's five
plays. Old final E13 to E16 file 65359/1377201632 stayed unchanged. Finish control 26 was accepted at 08:42:17Z only
after all checks. The next initial slot is E9/E10. Final E13 to E16 execution still waits for every initial slot and
fresh root-reviewed physical same-content mapping.

At 09:03Z, root ratified Pokemon E21's fresh replacement source. Fix
`34e35777-d724-4a28-a34c-706953558413` retains verified Carry `f2c2b02c-6e83-4339-800d-c6e557d26dbe`.
The actual grab completed at 08:48:38.037Z; source download `0be8b42d-2d16-4181-923e-c5aad351e3b7` measures
1469914845 bytes, 1920 by 1080, with English AAC stream 4. Root viewed source frames at 300s and 750s: the
caretaker beside a wire-net enclosure, then the same caretaker and group facing a collapsed house under cloudy
skies. These support the [Foul Weather Friends](https://www.pokemon.com/us/animation/seasons/3/episode-21-foul-weather-friends)
story inference, corroborated by the [episode synopsis](https://bulbapedia.bulbagarden.net/wiki/Foul_Weather_Friends).
No literal card, unseen species or weather cause was claimed. Root authorized one owned import only after fresh
source, whole target 49219, plan and protected raw E32 file 34245/1104231692 checks. Fresh PLAN3 completed at
09:03:46.412Z with unchanged digest `9e1cb185d126697990c86e08`, source bytes and whole target. Actual source and
protected-file stats passed at 09:04:35Z. Guarded IMPORT4 was delivered once at **09:05:01.977177Z**, under the
exact Job/Pod UID, source-hash and write-cutoff checks. Do not resubmit that import. Observe the original claim and
actual result; normal completion, imported library identity and strict account/Plex proof remain pending in this
snapshot. Source ratification and control delivery are not completion evidence.

The scheduled pipeline then completed E21 normally at 09:15:03.843Z, from actual ledger event
`703630ce-80f2-4af8-85b1-abf1e0a28155`, native import 66911 at 09:05:05Z and the same download. No task ingestion
or status write was used. Imported file 80039/1469914845 covers precisely episode 49219. Its measured resolution
and English AAC stream match the source; the actual imported 300s frame has the same PNG hash as the viewed source.
Fresh strict proof at 09:24Z covers both servers, owners and every captured affected account, four nonempty
physical contexts: current plays/resume are zero, correct-copy marks are preserved and preferences remain unset.
Protected raw E32 file 34245/1104231692 stayed unchanged. Finish 6 was accepted at 09:25:50.193Z. The actual
accepted checkpoint SHA is `fc894427474ce6969f718a67ddf15c39a353e7b6a2661d016f5f2aa5054102e0`; twenty approved
slots are complete, with twelve approved replacements still to run and E8/E31 held. The current next slot is E22.

Mickey E9/E10's one owned import 30 was accepted at 09:11:49Z after root viewed both literal cards at 60s and
691.58s. Its actual source/library file is 80040/1463744854, with English AAC stream 7, 1920 by 1080 and SHA
`faaf59120ec0365a55d43498b5feaced169de1c2e5f2e0a85a0f76f3e0c2a1cf`. Whole episodes 37189/37190 imported as
native events 66912/66913 on download `2205c47d-0158-48be-bfb4-ee8171f1421c`. Fix
`607fe1c2-aed2-4bdb-9976-f794722c9595` completed naturally via event `246d23c8-c916-4845-849c-8eb05437f12c`;
Carry `5cd1086c-d8c3-4c96-b94c-66e0e33fd6a1` remains verified. Both servers expose actual index-9 items,
keys 58497/556275, covering the whole physical pair. Owner/every-captured-account current-zero and correct S3-copy
marks passed, and all protected files including final 65359 stayed unchanged. Finish 32 passed at 09:17:21.448Z.

Mickey E11/E12's approved 720p fallback has correct literal cards but one physically untagged AAC stream 0.
Root viewed It's Wiki Wiki Time! at 60s and Happy Hula Helpers! at 691.8s. Actual source is 579915208 bytes,
1280 by 720, 1351.595s, SHA `5fbacf1eaa3d7a23fa9315dab8f65dd7cab6f556531e6215afdbe585b8ea3c11`.
Two actual 12s dialogue samples at 120s and 800s were processed serially by the already loaded internal speech
service. Both detected English without a forced language or silence; no model installation, external upload or
root listening was claimed. Proof SHA is `1fe66bc2e66f372345e557fdf5c782d279dcf069daa691951e2b7c77ad0b32b2`.
The physical language tag remains null. One owned import 36 was accepted at 09:29:49Z under original Fix
`e3d6aa5f-6fd9-477a-9300-b020c6472132`, verified Carry `7e1132fc-4588-44c2-a9e7-53ae31ef6e94`, exact download
`17559d59-24db-459b-979f-8f4a221e005c` and whole targets 37191/37192. Do not resubmit it. Actual library identity,
normal completion and every Plex context's sole/selected audio still need verification. An absent English metadata
label must not be forged into a positive metadata check or bypassed by editing the running worker.

Actual checks at 09:34Z then proved library file 80041/579915208 covers exactly 37191/37192, with the same measured
SHA as the speech-checked source. Native imports 66924/66925 both occurred at 09:29:49Z on the original download.
The physical AAC stream's tag stayed null. Every required actual Plex context naturally returned one default
English track, position 1, without any language or preference write. Both servers' actual index-11 items,
keys 58498/556276, cover the physical pair. Strict owner/captured-account current-zero and correct S3-copy marks
passed, with protected final file 65359 unchanged. Fix completion event is `21f75679-60c3-40d6-ac2c-c3d4cb50b5f0`,
from native source 66924. Finish 38 passed at 09:34:58.909Z under the unchanged frozen guards. No successor Job or
proof-guard change was needed. Six initial slots are complete; the next initial slot is E17/E18.

Final Mickey E13 to E16 remains held until every initial slot finishes and its complete plan/mapping is refreshed.
The [proposed final review](2026-10-14-mickey-final13-16-carry-review.md) binds original whole file 65359 to actual
new same-content pair 80038, with marks going to the existing correct copy and zero old state on new replacements.
The existing API supports two selected releases whose disjoint union covers all four original episodes, under one
Fix, Carry and deletion. A concrete recovery gap remains if one part fails: the current writer fails the parent,
while D-39 accepts only a whole-slot failed grab. A docs-first prospective recovery change is being prepared before
the final run; root approved its concrete decision-40 architecture for implementation at 09:36Z. The proposed
release choices are not an execution approval, and the new recovery still needs tests, required PR checks, a signed
release and live verification.

At 09:50:57.775Z Pokemon E22 passed finish 12. Actual file 80043/1576411922, native import 66940 and whole episode
49220 bind original Fix `05f08c49-cfa2-4021-95ab-2f2bb1f777f8`, verified Carry
`0fc8844c-cbd5-4621-861a-4ab5196cbe8f` and download `69ee26d0-33d2-4d04-a344-9a07fb6be3cf`. The scheduled
pipeline completed it at 09:45:04.300Z through ledger event `8020af10-7829-430b-aa05-34b683fd16e9`, without task
ingestion or status writes. Source/library both measure 1920 by 1080, with English AAC stream 4; the imported
300s frame matches the root-viewed source PNG hash. Strict both-server proof at 09:49:54Z covers owners and every
captured account, four complete nonempty contexts, current-zero, preserved correct-copy marks and unset preferences.
Protected raw E33 file 34277/1083194684 stayed unchanged. Checkpoint SHA is
`889a5119d4498ff880a8e109fe5c109e518f5cfe17b895a9e1d9e4b7fb2ef4fb`; twenty-one approved slots are complete.

Pokemon E23's actual source measures 1624337947 bytes, 1920 by 1080, English AAC stream 4. Root viewed 300s and
600s frames: a girl in pink/red with the group in the mountains, then ribboned Mareep facing Pikachu at sunset.
Those support the [Mild 'n Wooly](https://bulbapedia.bulbagarden.net/wiki/EP139) inference; no literal card or
unseen battle action was claimed. Guarded fresh plan 15 and source/protected checks passed before **one IMPORT16
delivery at 09:59:58.646Z**. Original Fix `776f8333-9f18-4f61-87e2-9876b51c52a7`, verified Carry
`25fd4405-d042-4460-ae12-95e5af859334`, download `7ae657f1-36e2-477a-a5a0-99bc04fcaf9c`, whole target 49221
and digest `7dee987be266b15b44532869` remain bound to that command. Never resubmit it. Actual import, normal
completion and strict final proof remained pending at delivery; protected raw E34 is 34308/1093478129.

E23 then imported as file 80045/1624337947, native event 66953, whole episode 49221 on the original download.
Normal event `21693071-b2a8-4d7f-868d-e7b78b82d972` was recorded at 10:00:04.395Z; the original parent was
first observed completed at 10:00:22.881Z. Its later updatedAt reflects factual owned observation, not a new
completion time. Source/library both measure 1920 by 1080 with English AAC stream 4; the imported 600s PNG
matches the root-viewed source hash. Both-server owner/every-captured-account proof passed at 10:02:17Z: four
complete nonempty contexts, current-zero, correct-copy marks and unset preferences, with protected raw E34
unchanged. Finish 18 was accepted at 10:04:12.068Z; checkpoint SHA
`42fcedf6d54ea93865a342f6fa92c5bc79f29ab79a009e84e62746a58b0570f8` preserves twenty-two completed slots.
E24 is next; ten approved replacements remain, with E8/E31 still held.

Mickey E17/E18 passed finish 44 at 09:46:47Z. Actual file 80042/1387613620 covers 37197/37198, measured
1920 by 1080 with English AAC stream 7 and equal source/library SHA
`16b22bec2766c58904f19f1692b26cab6789a853a4daecffcdf31038bf6a9465`. Root viewed both literal cards at 62s and
691.65s. Native imports 66934/66935 bind original Fix `9cc5295d-255e-47b4-a4f2-9f76372c4b57`, verified Carry
`507dadd3-1bf0-417c-82f8-257145f32adf` and download `fe91241b-91ff-485c-adba-554f09df2107`. Normal event is
`5c8b4fe4-0555-479f-939d-d07f16f04ba5`; the scoped settle was a no-op after natural completion. Both actual
index-17 Plex items, keys 58501/556277, cover the pair. Owner/captured current-zero and correct-copy marks passed;
protected raw E33 to E36 and final file 65359 remained unchanged.

Mickey E19/E20 passed finish 50 at 10:00:02Z. Actual file 80044/1489695593 covers 37199/37200, measured
1920 by 1080 with English AAC stream 7 and equal source/library SHA
`3203b502dbea21eacf14afc8f450a7ac81a4c34e80355cb99c4470efd9025870`. Root viewed the actual Going Upppppppppp!
and Gone Fishin'! cards at 61s/691.65s. Native imports 66947/66948 bind Fix
`00e5ca72-a5ed-4d82-9e24-8d48e8192d19`, verified Carry `2596c737-709d-4fd3-bd29-fb1a47852c16` and download
`e14e2b3c-1f34-4cc6-ac3d-df816f61f56f`. Authorized scoped ingestion recorded those two real imports from one
bounded 200-row page and normal matching completed that original Fix only, with the cursor unchanged. Actual
completion event is `1c9cff9d-60bc-4612-9c51-af937e8c0a79`. Both actual index-19 Plex items, keys 58502/556279,
cover the pair; strict owner/captured current-zero, correct-copy marks and all protected files, including 65359,
passed. Eight initial slots are complete; E21/E22 is next. Final E13 to E16 remains held last.

Pokemon E24 passed finish 23 at 10:16:44.838Z. Actual file 80047/1571149461, native import 66966 and whole
49222 bind Fix `cab8005d-9e78-46b3-9f4d-1edcab83bec4`, verified Carry
`aa2d614b-2b62-4fd8-8963-799178231212` and download `70bacf20-6730-4596-99d3-cafa6d7f095b`. One IMPORT22
was accepted at 10:12:36.012Z, after genuine intended-target reevaluation, without a rejection override. Normal
ledger event `373a6932-026b-4562-baa5-f4eb3106d365` was recorded at 10:15:04.135Z; first completed observation
was 10:15:32.863Z. Root-viewed tatami and dojo-trainer scenes support the
[Wired for Battle](https://bulbapedia.bulbagarden.net/wiki/EP140) inference, with no unseen card or action claimed.
Source/library measure 1920 by 1080 with English AAC4 and equal sampled 480s PNG. Four complete nonempty Plex
contexts passed current-zero/correct-copy marks with preferences unset; protected raw E35 file 34366/174244980
remained unchanged. Checkpoint SHA is `0bd29057e6d21ec2cf40a68a43ad773ed23572e4b23efffcd8c954d16ca170a2`.

Pokemon E26 passed finish 29 at 10:31:13.393Z. Actual file 80049/1576134020, native import 66984 and whole
49224 bind Fix `07f3b58b-dbca-43dd-b4db-3fd4a850cbab`, verified Carry
`856b1aab-cf2f-4d16-8ea1-f1f2f48cfb18` and download `a8396803-134e-4ef0-afee-aabb0aeffd71`. One IMPORT27
was accepted at 10:24:35.128Z after genuine intended-target reevaluation; observation 28 verified it without replay.
Normal event `5bd1d0d3-48d8-4c8c-aa9f-c9ed57486cd4` was recorded at 10:30:04.107Z; first completed observation
was 10:30:25.573Z. Root-viewed cave-water and costume scenes support the
[A Shadow of a Drought](https://bulbapedia.bulbagarden.net/wiki/EP142) inference, with no unseen cause or action
claimed. Source/library measure 1920 by 1080 with English AAC4 and equal sampled 750s PNG. Four complete nonempty
Plex contexts passed current-zero/correct-copy marks, preferences unset and protected raw E37 file 34433/186411294.
Checkpoint SHA `6e243d11a20e1818c19a59e0260179da371707e1868b6ffcdffad12b73c2a06b` preserves twenty-four slots.
E28 replacement 30 was delivered once at 10:31:57.533Z under Fix `ddd28c27-f20e-4f12-8039-9753c70783e9`,
verified Carry `09ea4310-7b5e-4530-b060-49438d76d2e2` and download `680b60b7-777f-42a9-ae9b-91daf20daaea`.
Root viewed its forest-arena trainer and Metapod/judge scenes and ratified the
[Gettin' the Bugs Out](https://bulbapedia.bulbagarden.net/wiki/EP144) inference and measured English AAC4.
IMPORT34 was delivered once at 10:42:20.823Z after fresh PLAN33/source/protected checks. Observe it without replay;
actual import read-back, normal completion and final proof are pending at this snapshot. Its
S03E28 to S20E28 mapping refers to distinct seasons/files and never a self-copy. Protected raw E39 is 34503/150918956.

Mickey E21/E22, E23/E24 and E25/E26 passed finishes 56/62/68 at 10:10:48.365Z, 10:21:59.940Z and
10:33:22.606Z. Root viewed both actual cards for each pair; every file measures 1920 by 1080 with English AAC7.

| Slot | File / bytes / source-library SHA | Full native imports / original download | Original Fix / verified Carry / normal completed event | Actual Plex keys |
| --- | --- | --- | --- | --- |
| E21/E22 | 80046/1439091186<br>`9354b2aa136049d11f06aa24500a897277d667350ba512841c370eb6a69d417d` | 66960/66961<br>`e002da33-d3e6-4767-9182-902a3009f935` | Fix `af02ae2b-7dc0-4712-8ab3-57cc291ecba3`<br>Carry `754c6ee1-53bd-4450-bf9f-4e04d41fcb52`<br>event `4efa3a24-7f6a-4f7c-a520-022a29889b78` | 58503/556281 |
| E23/E24 | 80048/1496949994<br>`0eea9fb50fe7f4e6769fd52ec897df88338a3c3738dc3ddc5f43cadbecca7c43` | 66972/66973<br>`e1bee361-6cbb-48a7-a81a-6c266950a69c` | Fix `c56c1a9d-b652-4f29-8286-c0cb6f7cef55`<br>Carry `094505b8-abe0-491c-b82c-154ff9d01f97`<br>event `6dab6d78-7e92-4a06-ba5c-0cc52b581381` | 58504/556283 |
| E25/E26 | 80050/1359342126<br>`bf35018019836d451b7a70e5af0cfc770b8f126a7ab057077b074022f427eca7` | 66985/66986<br>`7e8c69ef-2ae9-477f-ab07-324067cd676b` | Fix `8ed6b6ad-ee48-42d9-a162-16fca60b776f`<br>Carry `ca7697cc-b4e4-415c-8e71-25544cb00cea`<br>event `cdc9314b-0418-4017-bd0f-20b5e3c1d0e4` | 58505/556285 |

Each actual single Plex item covers its independently proved Sonarr pair. Strict owner/every captured context
passed new current-zero and correct-copy marks, with all protected files including final 65359 unchanged. E21/E22
and E23/E24 used authorized ingestion of two real native imports from one 200-row page and normal settlement of
only the original Fix, leaving the cursor unchanged. E25/E26 completed naturally and its settlement was read-only.
Eleven initial slots are complete. E29/E30 natively imported at 10:37:00Z as 80052/1451468663, full 37209/37210,
native events 66999/67000, original download `b193b63e-bb92-48ae-b48b-197fdf3a7e01`. Physical ratification and
strict finish are pending; do not issue ManualImport or invent an owned import intent for this native result.

[PR 987](https://github.com/thaynes43/haynesnetwork/pull/987) implements the reviewed decision-40 architecture.
Focused local checks passed. Review found that queue enforcement must conservatively hold an unresolved selected
GRAB on its exact native series/dispatched title without inventing GUID ownership; private parser messages also
need their actual flag/command names. These findings are being corrected before renewed review and required
checks. Final multipart E13 to E16 remains held until that signed fix is deployed and all initial slots finish.

Pokemon E28's single IMPORT34 then verified full native event 67001 and file 80053/1478614008 for 49226 on its
original download. Normal event `ee636b7c-492f-4499-a930-75f1666ef898` was recorded at 10:45:03.544Z; first
completed observation was 10:46:41.781Z. Source/library measure 1920 by 1080 with English AAC4 and equal viewed
300s PNG. Both Plex servers' four complete nonempty owner/captured contexts passed current-zero/correct-copy
marks, owners selecting English and preferences unset. Distinct S20E28 copy 34113/209560051 and protected raw
E39 34503/150918956 remained unchanged. Finish 36 passed at 10:50:12.051Z; checkpoint SHA
`3beb91643d2d4556bc4ffc48f9d608e1eb7a732f76618fc23ccf0e7507fc583c` preserves twenty-five approved completions.
The earlier E28 source-helper completions do not prove serial starts; that limitation was recorded, and all later
E29 samples waited for actual completion before the next started.

Pokemon E29's single IMPORT41 was delivered at 11:05:10.883Z after fresh plan 40 and exact source/protected checks.
Actual file 80056/1477524293, native import 67016 and whole 49227 bind Fix
`0ff7cb78-cf1c-4c33-baa0-9bc32d3c2b94`, verified Carry `1a4781b0-de89-4339-b145-4189ec85727e` and original
download `f751078a-727c-43f1-a998-81cc72acb022`. Observation 42 verified that command without replay. Root viewed
300s forest/trainer and 900s black-haired blue-collared guest/gray straps/wooden-slat scenes. These support the
[A Farfetch'd Tale](https://bulbapedia.bulbagarden.net/wiki/EP145) inference with its
[one-episode guest](https://bulbapedia.bulbagarden.net/wiki/Sylvester_(EP145)); no Farfetch'd, literal episode card,
unseen action or wooden-object purpose was claimed. Source/library measure 1920 by 1080 with English AAC4 and
matching 900s PNG. Normal event `11b96cd0-9314-4890-bda9-e72862ac03aa` was recorded at 11:15:03.215Z; first
completed observation was 11:15:27.277Z. Four complete nonempty Plex contexts passed current-zero/correct-copy
marks, English for owners and unset preferences. Distinct S20E29 copy 34143/187676829 and protected raw E40
34579/184582512 remained unchanged. Finish 43 passed at 11:17:10.644Z; checkpoint SHA
`60b35d5532273d3f52192da3867d75180d9921c012f51007468e3b817a61174e` preserves twenty-six completions. E30
replacement 44 was delivered once at 11:18:05.361Z; source ratification/import/normal/final proof are pending at
this snapshot. Preserve its distinct S20E30 mapping and never replay an already submitted command.

At the earlier 11:21Z snapshot, Mickey's next four pairs had imported natively. The table also appends the later
accepted E37/E38 row. Explicit native adoption controls 73/79/84/89 recorded actual observed
results, with no ManualImport, regrab, owned-import intent or queue cleanup. Root viewed both literal cards for each
pair; actual measured files are 1920 by 1080 with English AAC7, and source/library SHA agrees.

| Slot | Accepted full finish | File / bytes / SHA | Whole native imports / original download | Original Fix / verified Carry / normal completed event | Actual Plex keys |
| --- | --- | --- | --- | --- | --- |
| 29 | 2026-10-14T10:47:48.611Z | 80052/1451468663<br>`6978863fd47ff93b94e4214e0af2b431e6e76d7378af9b60d17f35a17f6cf68e` | 66999/67000<br>`b193b63e-bb92-48ae-b48b-197fdf3a7e01` | Fix `1f81619d-8939-4285-8971-b67a2b9c7b31`<br>Carry `e83431fe-5754-4656-b4bc-50a2d4264752`<br>event `846437b4-38f1-4178-89b9-65bdf8f848c1` | 58507/556287 |
| 31 | 2026-10-14T10:56:26.824Z | 80054/1449008566<br>`98cdbb75baff438de88d4f56a460e6728b9d525f21f4c0560598bfe8eaeb2f6a` | 67006/67007<br>`3672b4c6-95b2-494c-accf-0f5621c11cc5` | Fix `f42ca203-e7ff-4e43-9e5a-7d157dced5a7`<br>Carry `56c69636-5d17-4e37-baea-336b836ec90e`<br>event `49fbb173-16a9-4bd0-9936-2a7c360cc3bb` | 58508/556291 |
| 33+34 | 2026-10-14T11:04:48.204Z | 80055/1422068449<br>`e0ac549866841ad4be505f581452ea0774befa7faa3a9ffd8b7e18a555b5214d` | 67014/67015<br>`140af96f-0a43-40e9-90b7-5e7f0f28dc71` | Fix `2b5f8c56-6ded-419b-a226-cca91bdda123`<br>Carry `cac066b7-c68d-4502-9c64-3e8f3da6fd0b`<br>event `e707018c-a64f-4f68-b70b-82d236c8977e` | 58509/556292 |
| 35+36 | 2026-10-14T11:16:55.598Z | 80057/1537356210<br>`3a03fffa2e23883e5c305623d867b9f2f6c8ac1afd226ec9eefe1b73cab2bf46` | 67021/67022<br>`b9f965e6-ac61-4bb4-aacb-4c5924f94c03` | Fix `78b7a280-c49b-4f03-83f7-1285a2d3a56c`<br>Carry `bc1dd372-5a96-4922-aea3-12267289c67b`<br>event `565cebfa-e549-4c1c-9bb2-80fe1cc9c287` | 58511/556294 |
| 37 | 2026-10-14T11:31:55.517Z | 80058/1463747016<br>`8c5cd2560e8fb4eb9205a1a039403d2da6a943f50215d4c465617e42055d27bd` | 67029/67030<br>`f8696055-485d-4ec8-aa43-227cb3dd27fe` | Fix `7cbb67e7-8447-4727-b1f4-399521f3a83c`<br>Carry `07a4042f-a001-42eb-916b-c6f32e88a9d6`<br>event `e8b199e0-b05a-4e75-97f5-5311382c1c60` | 58513/556295 |

Each actual single Plex item covers its independently proved pair. All owners/every captured account passed strict
new current-zero, correct-copy marks and protected identities, including final 65359. E29/E30 and E33/E34 completed
naturally; settlement was read-only. E31/E32 and E35/E36 used only two real native rows from one 200-row page and
the original normal matcher, with the cursor unchanged. E33/E34's two original files cover only one Sonarr episode
each, not a four-episode original; exact distinct mappings 33 to S3E65/E66 and 34 to S3E67/E68 were preserved.
E35/E36 likewise retained source prefixes 35 to S3E69/E70 and 36 to S3E71/E72. No original scope was reduced to
fit the single-key worker. At the earlier 11:21Z snapshot, fifteen initial slots were complete and E37 was next;
the appended E37/E38 row now brings the frozen 11:59:39Z count to sixteen. Earlier missing/failed card samples are
retained as misses; the physical observation 'Mouse vs. Machine' has no exclamation, stored separately from the
canonical Sonarr label.

[987](https://github.com/thaynes43/haynesnetwork/pull/987) merged at 11:08:27Z as
`6f431991d1e2dc167166a253203236b5e1255d8e` after all four required checks on `0117ef55` and renewed reviews
without findings. It fixes the actual unsupported both-native-parts adoption interlock in addition to the two
advisory findings. Read-only adoption may protect another fresh positively bound whole native part before its
audit exists; existing audited names/bytes and unsettled imports still refuse. All media-writing recovery retains
its audit boundary. The final multipart suite passed 34 focused cases, including natural completion and adoption
on open/completed parents with zero HTTP/Plex writes. Legacy regression, private CLI, types/lint and CI passed.
[Release 988](https://github.com/thaynes43/haynesnetwork/pull/988) merged at 11:20:44Z as
`ab8181c36b00d389dbdb05db534b0a10845b6178` after all four required checks. Actual publisher
[38555912857](https://github.com/thaynes43/haynesnetwork/actions/runs/38555912857) subsequently completed its actual cosign verification on attempt 1, and root fetched both matching registry
artifacts at 11:26Z (details above). Manifest deployment remains pending. Signed v0.125.3 remains live. The final-only cold proposal
is disabled with no future proof/timestamps filled. It must not load into the current worker or bypass the initial
completion, fresh mapping, exact reviewed hash and signed live-source checks. Final E13 to E16 remains last.

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

Root activity `act-051827-491938` covered the scoped rollout and media work, with an original expiry of
2026-10-14T11:18:27Z. Its preceding declaration ended at 05:18Z after that successor was active.

At 07:37:58Z root declared `act-073758-527071`, covering frontend, media, downloads, Plex, PlexOps, Sonarr, SABnzbd
and HaynesTower until 2026-10-14T14:37:58Z. The old declaration ended at 07:40Z after its successor was active and
the old Pokemon Job/Pod were confirmed gone. Fresh six-hour Mickey and five-hour Pokemon envelopes must fit this
actual coverage, including their shutdown margin. Root ends the current declaration after work completes.
