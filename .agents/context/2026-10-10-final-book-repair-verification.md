# #825 final repair verification — current record

Last accepted restoration: **2026-10-10 23:01:46Z**, Ransom V5 Normal `628e26d4`.
The owner requested safe closure and no further repair attempts.
Root accepted the retained 22:16:40–41 Native observations and the remaining
22:26:35–37 absence checks; these are distinct observation times.
This record is being updated through the remaining authorized repairs. Preparation,
process exit status and source merges do not establish a production repair.

## Completed original work

- Five adversarial-review fixes are deployed in haynesnetwork v0.110.5.
- Kometa's verified run improved from 77m47s to 91s after the bulk IMDb fix.
- The earlier backfill completed 290 EPUB metadata-edit operations; 289 paths
  remained current after one LazyLibrarian edition replacement.
- Reading lists received 116 missing entries across 39 lists. Original entries
  and 75 recipes were preserved; 31 new recipes have acquisition disabled.
- `KubePersistentVolumeFillingUp` for `downloads/slskd` resolved after expansion
  of the same claim from 2 GiB to 4 GiB. Books already use `gasha01` NFS.

These operations must not be repeated. The book work concerns EPUB/Kavita
metadata, not MP3/M4B audiobook tags.

## V23 evidence-file permissions correction

V23 moved zero files because three Kavita exporters created mode `0644` reports
where the existing verifier requires private `0600` files. The reports were
below the 32 MiB limit. Ops #3784 fixes creation at the three exporter sites
without changing their SQL, CLI or JSON, or chmod/reusing rejected evidence.
The four focused private-creation/golden/refusal controls passed. V24 adopted
the merged exporters; its recorded refusal was a different timing condition.

## Ransom V2: refused before book writes

The owner has approved the exact seven-field catalog repair, stale EPUB series
tag removal and guarded scans, preserving IDs and progress. Q-01 is answered;
there is no pending owner decision for that exact repair.

Consumed phase `b6e6917765bf456caa211ebdd6e1624d` stopped before activation on
an actual cross-module inventory call missing its `api` argument. Neither its
Lidarr helper nor Ransom writer acquired a Job UID; no catalog/tag write or
target scan occurred. Its accepted final Normal audit is `ff3cdf39` at 20:35Z.
Ops #3786 fixes that single argument; its real cross-module positive and
wrong-API/namespace controls passed. The consumed phase must never be replayed.

## Pathfinder V24: deadline refusal, zero moves, safe Normal

Phase `fdf5f96266cd4f2a902573c22c623960` used Stop #3787 and inverse #3788.
Fresh read-only LIVE capture passed in 131.255144s. The primary writer Job UID
remained null, and no primary journal, ACK or selected move occurred.

The original actuation origin was 21:03:07.034970Z, giving the unchanged 170s
cutoff at 21:05:57.034970Z. The first full publisher capture finished at
21:04:50.276Z. Native LazyLibrarian/Kavita readers retired at 21:05:25.613Z;
the second full publisher capture then began with only 30.64s left and did not
finish before the original cutoff. The exact supervisor refusal was
`maintenance abort deadline reached`, not another evidence-file mode failure.
The watcher's generic `cached_source_or_hold_proof_lost` catch does not prove
external custody loss; that caught exception was not retained.

Recovery completed in 68.880771s within the original 130s reserve. Root's
accepted audit at 21:08:11Z (`0f21bc21`) proves Normal `3b9b43e9`, all seven
controllers Ready/unheld/owner-free, all four Deployment identities with exact
Normal specs, six current healthy service Pods, the complete five-Job/Pod union
and both primary PostgreSQL leases absent, and the original watcher/group retired.
Historical cache/activation files remain; their presence is not current authority.
Activity `act-205236-1999665` ended.

Exact private diagnosis: V24 `actual-copy-abort-deadline-diagnosis.json`,
SHA-256 `9cd10c381bf603314c554c785b352de808ec222c522f504526350f37df2afb80`.
Do not replay V24, reset its clocks, increase the limits or remove either proof.

## Ransom V3: native inventory request refused before activation

Stop #3789 and inverse #3790 were reviewed and merged. The inverse restored
the entire Normal tree at `23226eb3`. The fresh prewatch and acknowledged cache
readiness passed. An earlier read-only readiness call arrived before the watcher
acknowledged the sealed receipt; it produced no readiness output or activation.
A fresh check after that acknowledgement passed without resetting any clock.

The one automatic production command ran from 21:34:15.609Z to 21:34:21.287Z
and refused before activation. The corrected cross-module call now supplies
`api="v1"`, but its `kubectl get ... -o json` request returns a generic `List`.
The unchanged validator requires the native `PodList` representation. This is
an actual request-boundary defect; the earlier fake-`PodList` control did not
exercise the command that produces the data.

Both actual Job UIDs remained null. No helper, catalog write, EPUB write or scan
ran, and no Stop actuation or service outage was observed. Root's final audit
at 21:36:47Z (`cc95fdab`) verifies all seven resources Ready/unheld/owner-free
on `23226eb3`, four unchanged Deployment identities/specs, six unchanged healthy
service Pods, complete maintenance Job/Pod and DB-lease absence, no activation,
and the retired original watcher/group. The 130s cold restoration limit was
not exercised. Activity `act-212646-2041826` ended. V3 is consumed and must not
be replayed.

Ops #3791 merged the Pathfinder overlap correction at `dddf92ab`. It starts
the first complete publisher capture after both owned Native readers exist,
overlapping their read-only payload collection. The second complete proof
remains after reader retirement. Its child inherits the producer's host group
and is reaped; producer retirement is separate from watcher retirement. Three
focused ordering, refusal and child-containment controls passed. No actual
production timing improvement is claimed yet.

Ops #3792 merged at `28fe314e`. The Ransom inventory requests now use the native
Kubernetes core API endpoints with the unchanged typed validator. The focused
route/invalid-shape controls and one actual read-only `PodList` request passed.
Root's targeted current check proves all seven controllers Ready, current on
`28fe314e`, unheld, owner-free and with unchanged full specs/UIDs. The final V3
audit `cc95fdab` remains historical on `23226eb3`; it was not relabeled.

## Ransom V4: stale pre-Stop token check, zero book writes, Normal restored

Consumed phase `e3d68425a13c4bbeb361d82556912061` used Stop #3793 and
inverse #3794. The sole producer ran from 22:13:30Z to 22:14:34Z. Actual Stop
completed at 22:14:32Z, then the host guard rejected a legitimate new app rehold
token against the immutable pre-Stop token. Both maintenance Job UIDs remained
null. No helper, catalog/EPUB write or scan ran. This was a caller composition
defect, not proven foreign custody loss.

The original watcher verified Normal `f447906a` at 22:16:15Z. Restoration took
93.603707s from authority revocation, within the unchanged 130s reserve;
original actuation origin to Normal was 159.384796s within 300s. Root accepted
`final-audit.corrected-actuation.json`, SHA-256
`9d3fa57562b6bf6849a58a502e34e33d1ae7949aef5d9d638cd693172e23d0e0`.
It preserves all 14 original Native observations: seven controllers Ready on
that Normal commit, unheld/owner-free, four original Deployment UIDs/exact Normal
specs, and six healthy replacement service Pods. The unfinished read-only tail
verified the full two-Job/Pod union, primary PG lease and converter lock absent,
and both separate producer/watcher host groups empty and retired. Activity
`act-220434-2064261` ended. Cache and activation files are historical evidence.

The first local final audit incorrectly inferred no Stop from phase-only fields
and required unchanged Pod identities. Its correction uses the actual watcher
Stop receipts and reuses the original Native captures. A subsequent local log
writer rejected empty stderr; its completed first read-only response was retained
and reused without repeating that API call. Failed sources and evidence remain
unchanged; no rejected artifact was chmodded or overwritten.

Ops #3795 merged as `dc1f82af` at 22:29Z and corrects only the two post-Stop
`check_live` calls to use `holds=False`
after the existing fresh four-app hold validator. Live Source/controller and
both parent hold checks remain strict, as do original app identity continuity,
new request/drain ownership, Stop readiness and clocks. The cleanup sibling is
prospective: V4 never reached it. One focused both-caller control passed valid
new tokens and refused old tokens, foreign ownership, undrained holds, and changed
Source/parent ownership. Actual repair remains separate from that source fix.

## Ransom V5: publisher binding refusal, no writer, accepted Normal

Fresh Normal `dc1f82af` prewatch `a191f907` verified all-seven readiness, full
service identities/specs and maintenance absence. The original watch armed at
22:45:10Z with unchanged expiry 23:15:10Z. Parents (`0848b2eb`) then apps
(`09ef21e3`) were held on Normal. Stop #3796 merged as `8c789693` at 22:50:26Z.
The owning watch retargeted inverse #3797 once to `6894bc98`; its actual replay
plus empty validation footer and whole Normal tree passed current required checks
and distinct peer `227e13fc`. Root read the authentic terminal failed advisory
(352ms, no model/assistant/source output; underlying cause unknown), then executed
the literal qualified metadata ratifier (`3bd1a178`, approved `fe319bf5`, private
loader/predicate `6ae0b1bb`). Exact inverse merged as `628e26d4` at 22:57:47Z.

Sealed cache `4abc4d7e` was acknowledged by that same watch before the one fresh
readiness check (`5b3edd2b`, 3.774622s). Root granted conditional runtime GO and
launched the original producer in its own group: PID=PGID 2113033, birth
242434680, separate from recovery watcher 2097090. Actual activation origin was
22:58:59.524868Z; cached Stop started at 22:59:08.344556Z and completed at
22:59:57.213632Z.

The actual host execution `9a483a46` exited 1 at 23:00:24.064731Z during the
read-only publisher prelude. `lidarr-native-source-bridge.py:123` refused
“native helper source binding or gate changed”: the expected publisher profile
config SHA was **null**, while the actual READY manifest contained
`24a82aa7f24b1790f5e671d4cda1ed16692bf541d71bac08a7201aa2fcaf3e4c`.
The initial diagnosis blaming missing env UID/hash was corrected from the same
retained evidence: READY has both values; the dynamic env file intentionally
contains only READY/deadline overrides.

A read-only helper Job acquired UID `7ad07474-ceed-4482-8390-67dd34298a5c`.
The Ransom writer UID, Pod UID and PostgreSQL ownership stayed null. The failure
was before `HostAdmission.create` (run lines 959–960); bound operation, before
snapshot, lock custody, writer execution and catalog/EPUB mutation paths were
unreached. Distinct peer `1ad91f30` verifies this actual no-writer boundary; it
does not claim a new physical before/after catalog or EPUB capture.

Authority was revoked at 23:00:28.676635Z. Normal `628e26d4` was reverified at
23:01:46.305317Z: **77.628682s** after revoke within 130s, and 166.780449s after
original activation within 300s. The original producer was separately waited
and reaped with its actual group empty (`c8b9c8ce`). The recovery watcher completed
and retired. One final audit `b56d7a91` at 23:02:04.813182Z proves all seven
controllers Ready/current/unheld/owner-free, four original Deployment UIDs with
exact full Normal specs, six healthy current service Pods, both owned Job/Pod
unions and PostgreSQL leases absent. Root acceptance is `29acccde`. Root's first
generic ref walker counted zero because this audit uses filename-to-SHA maps;
the same original 14 Native captures were then physically verified without
recapture (`8863a5eb`). Activity `act-224440-2097018` ended. Historical cache and
activation receipts remain immutable evidence, not live repair authority.

## Final schedules and filesystem-lock closure

One bounded read-only closure (`26134303`) reused the retained CronJob lists and
ran the existing Sonarr `sonarr_lock(..., release=False)` route once. All five
book CronJobs plus the LazyLibrarian library scan are unsuspended on their Normal
schedules; the converter's actual `STRIP_SERIES_METADATA` is `0`. The configured
converter lock is absent and state inode `1099529573026` matches admission.
Acquisition is covered by the accepted actual `runtime_still_normal`, source/app
convergence and exact Normal Deployment audit. No release/write/scan/Job occurred.
Local schema assertions were corrected from retained captures; one unnecessary
read-only frontend Cron repeat was disclosed and preserved, with no overwrite.
All native subagents completed. None waits for an overnight check.

## Owner-requested wrap and durable follow-ups

The owner changed the plan: wrap safely now, start no further Ransom/Pathfinder
or optional attempt, retain useful merged fixes, keep automatic stripping off,
and end this run without waiting overnight. No new repair, scan, Job or clock
was started after that instruction. Pathfinder V25 and the Ransom post-Normal
scan remain unbound/unexecuted; their future inputs are not authority to proceed.

- [Ops #3798](https://github.com/thaynes43/haynes-ops/issues/3798): bind the actual
  helper config digest before the publisher prelude; preserve mismatched-source
  refusal rather than bypassing it.
- [Ops #3799](https://github.com/thaynes43/haynes-ops/issues/3799), P1: the worker
  commits catalog cells before publishing the EPUB. A failure between catalog
  commit (`ransom_catalog_maintenance.py:245`) and later guard/publication
  (`ransom_maintenance_job.py:561–562`) can leave a partial repair. The publication
  guard does not compensate that commit, and the inverse has the same ordering.
  Future execution needs a verified recovery/acceptance boundary. **V5 never
  reached it**; healthy services alone is not the no-write proof.

## Remaining gates at this boundary

This run is safely closed; these unapplied repairs and checks remain follow-ups.
Do not automatically retry from this record.

The two selected Pathfinder extras remain in place. Their repair, fresh guarded
force/ordinary mapping checks and one reading-list addition are incomplete.
Ransom's approved production repair and preservation checks are incomplete.
Q-01 is answered; no owner catalog ruling remains pending.
Broader #831 requires fresh complete ownership accounting; the historical
21-move selection is stale and is not authority for further moves.

Production acquisition is enabled and `STRIP_SERIES_METADATA=0`. The next
derived real nightly is October 11 at 04:00Z, followed by hourly validation.
Manual scans cannot satisfy scheduled-origin acceptance. Draft ops #3571 stays
held until those gates. OC-046/OC-047 and the corresponding issues remain open.
No agent from this run is retained to wait for overnight checks.

Current advisory jobs failed before substantive review with empty model usage
and no assistant output. Authentic per-head logs and annotations were read;
distinct reviews and explicit Root dispositions were bound to each actual head.
The underlying advisory failure cause remains unknown. No clean Claude review
or blanket exemption for a future commit is claimed.
