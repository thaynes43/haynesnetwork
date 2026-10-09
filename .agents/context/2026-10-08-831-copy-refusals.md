# #831 copy windows through 2026-10-08 23:57Z

Production is live. All five requested CronJobs plus the LazyLibrarian daily scan are unsuspended;
LazyLibrarian, Kavita and Libretto are Ready, Libretto acquisition is normal, and four Flux scopes are
unsuspended and Ready at haynes-ops `1ed0d32de06981fedb89dcc9188a050105f7a2a4`. Actual kubectl/native capture:
`/home/dev/work/hn-825b-runtime-copy-cont03-restored-root.json`, completed 23:57:28Z.
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
