# #831 copy windows, 2026-10-08 23:12Z

Production is live. All five requested CronJobs plus the LazyLibrarian daily scan are unsuspended;
LazyLibrarian, Kavita and Libretto are Ready, Libretto acquisition is normal, and four Flux scopes are
unsuspended and Ready at haynes-ops `0e6b3c29c45497895a0c9fa8ae8aeb9a823c3d0a`. Actual kubectl/native capture:
`/home/dev/work/hn-825b-runtime-copy-cont02-restored-final.json`, completed 23:12:16Z.
All owned copy Jobs, Pods and PostgreSQL sessions are absent. Hourly stripping remains off; Ransom is held.

Both attempted copy windows restored first on refusal. Haynes-ops #3608/#3609 created no Job and restored
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
