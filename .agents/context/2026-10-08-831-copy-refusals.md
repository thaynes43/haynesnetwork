# #831 copy windows through 2026-10-09 00:24Z

Production is live. All five requested CronJobs plus the LazyLibrarian daily scan are unsuspended;
LazyLibrarian, Kavita and Libretto are Ready, Libretto acquisition is normal, and four Flux scopes are
unsuspended and Ready at haynes-ops `d24a429fd4569e414cd04729abaa5ed6d6b3a6cf`. Actual kubectl/native capture:
`/home/dev/work/hn-825b-runtime-copy-cont04-restored-root.json`, completed October 9 00:24:22Z.
All owned copy Jobs, Pods and PostgreSQL sessions are absent. Hourly stripping remains off; Ransom is held.

The first two copy windows restored first on refusal. Haynes-ops #3608/#3609 created no Job and restored
in 89 seconds. Its startup parser/rollout fence was corrected and independently reviewed. Haynes-ops
#3611/#3612 created one read-only Lidarr helper and restored in 146 seconds. The second window captured all
eight publishers in 32.283 seconds, with the exact reviewed path set, then refused imported validation before
SOURCE/MAIN creation, PostgreSQL leases, proof delivery or archive moves. Both pause/inverse pairs merged
after current required checks and Claude findings were read and handled. Their worktrees were removed.

Actual second outcome: `/home/dev/work/hn-831-copy-cont02-runtime-evidence/actual-observed-outcome.json`,
SHA-256 `08d5f56d5376a72bbfd1d0fc08e1f4919dea5a148fa0b0e6993cf792eaa2ee36`.
The exact first runtime refusal is unknown because its transient full inventories and imported exception
message were not retained. Offline reproduction found a concrete mismatch: the final mount sweep rejected
two SAB local XFS mounts whose physical proofs the same guard had already verified. Live read-only inventory
also shows storage/system mounts need explicit normal-write/source classification. Do not exempt a namespace,
every hostPath or every CSI volume. The guard concerns configured publishing into EBooks; it cannot prove
privileged storage infrastructure incapable of arbitrary writes. Do not pause again merely to discover the
next rejection. Complete prospective classification and review while live first.

No copy move or recipe/list write is claimed. Preserve actual receipts and never invent missing SOURCE/MAIN
inputs for a zero before their creation. Any later attempt needs a fresh phase, checkpoint, reviewed current
inverse PR, independent recovery watcher, exact ownership and cleanup before every Flux resume. Restore on
success, refusal, errors or uncertainty before further diagnosis. Retained extras are never deleted.

Core #825 verification remains valid: 290 metadata operations, 289 current verified paths, ten collision peers,
the fully observed 19:47Z Force scan, preserved reading progress/locks/curation, and deployed v0.110.4.
#830 is closed. Remaining work: guarded #831 consolidation/protected-copy review, staged library-only lists,
hourly flag/runbook-only draft haynes-ops #3571, and final PLAN/DESIGN/HANDOFF updates. OC-045 still awaits
the October 9 04:00Z scan and 04:32Z pairing run; OC-046 records Ransom's separate 30-day idle rule.

## Third window and exact admission default, 2026-10-09 00:01Z

Haynes-ops #3613/#3614 restored the third refusal completely. First service stop was
23:54:58.440580Z, recovery was requested at 23:56:03.640561Z, and the watcher completed at
23:57:34.006997Z, 155.566417 seconds after the first stop. The one inverse was reviewed at its
current head `e9497f42`; all ten checks passed and the normal Claude review had no findings.
Both merged worktrees were removed. All five owned Jobs and their Pods were absent, and the
primary PostgreSQL 16 reported zero owned sessions before the final runtime verification.

The explicit normal-write profiles and all eight native publisher checks passed. The read-only
Lidarr helper was bound. Kubernetes then created the read-only SOURCE Job, but its observation
refused with `created Job differs from exact recorded ready manifest`. SOURCE's actual Job UID
and transient PostgreSQL timeline were not retained; neither a SOURCE census nor a MAIN receipt
exists. MAIN was never created, so no archive moved. The intended ready manifest is not an actual
server object. Preserve that distinction rather than fabricating missing proof.

The actual outcome audit is `/home/dev/work/hn-831-copy-cont03-outcome-audit/actual-outcome-review-v1.json`,
SHA-256 `7b0e50662388f9d86c6fb41136dc23b580bd5bf7104fc88505d63f1d703da0a3`.
One authorized server dry-run of the exact SOURCE manifest reproduced a sole canonical difference:
Kubernetes omits the explicit `readOnly: false` on its `/tmp` volume mount. The source image and
all other normalized fields matched. This proves the current validator defect, without recovering
the deleted Job's identity. A narrow false/default normalization and independent review precede
another runtime attempt. No mount, source, image or ownership check may be relaxed.

An offline hourly audit also reproduced cleanup preceding the full identity preflight. Correct
that order before enabling hourly stripping. Production stays live during both fixes. No automatic
retry, new metadata replay, scan or acquisition was performed by this checkpoint.

## Fourth window and clock refusal, 2026-10-09 00:24Z

Haynes-ops #3616/#3617 restored the fourth refusal. First stop was 00:20:35.034788Z,
recovery was requested at 00:22:05.114196Z, and the watcher completed at 00:23:42.941947Z,
187.907159 seconds after the first stop. All current checks and normal Claude findings were
read before merge. Both extra worktrees were removed. The fresh native capture at 00:24:22Z
verifies all six schedules, four Flux scopes, services and acquisition restored, with no owned
Jobs, Pods or PostgreSQL sessions. No MAIN Job was created and no archive moved.

Three read-only Jobs were bound. SOURCE's actual Job UID is `383973ba-1473-4549-836f-9c1722b7140e`,
Pod UID `9076dbc4-3339-443a-88f2-c144b965bff3`, primary PostgreSQL 16 backend `769826`.
Its healthy lease and complete app snapshot, 2440 requests and 3545 items, are retained.
Its whole-library census never produced a retained completion receipt. The LL reader emitted
`capture-refused / ERR_ASSERTION` before Kavita or MAIN creation. The immutable actual outcome
is `/home/dev/work/hn-831-copy-cont04-outcome-audit/actual-outcome-review-v1.json`, SHA-256
`25e3d97fcab72a558a9c04c25048e0a64164928994c2c76462ee19032b1c7f3f`.

A narrow historical Loki query recovered the LL Pod UID
`7cf7bae4-89bb-4613-bc79-a5d23d772913` and its refusal at 00:22:00.701829380Z.
The separate recovered-evidence addendum is
`/home/dev/work/hn-831-copy-cont04-outcome-audit/recovered-LL-clock-evidence-addendum-v1.json`,
SHA-256 `afe96950b69b98d7d2a04d67cae3953f2e57a2b6d5856f1619701555318c105c`.
The event does not name the assertion. A separate offline reproduction identifies
`capture_fence_abort_clock`: JavaScript truncates the start timestamp to milliseconds,
so the fractional Python deadline exceeds its bound by 0.788 milliseconds. Floor the reader
deadline earlier rather than extending it. Offline inspection also finds Kavita's hardcoded
node stale; bind the actual reader node through the downward API and retain all native
service, PVC, Job and Pod checks. Review both corrections and safe refusal retention while live.

Another identical timing sequence is not yet justified: the actual live corpus reader took
32.588 seconds in one capture and 132.216 seconds in another, with the cause of that difference
unknown. Check a bounded design before another pause; do not assume the faster duration or
extend a pause through diagnosis. No new scan, metadata replay or acquisition is authorized
merely by those failed attempts.

Haynes-ops #3615 merged at 00:31:11Z as `9b65f666`, with all current checks green and the
clean normal Claude review read. Its two valid findings were corrected and answered.
Hourly identity preflight now precedes cleanup, and only an exact interrupted publication
pair escalates ambiguous identity to a whole-run refusal. The strip flag remains off.
