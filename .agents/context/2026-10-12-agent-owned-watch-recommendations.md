# PLAN-075 delivery: agent-owned watch recommendations

The owner wants agents to choose for his current request using viewing evidence and broad research,
without treating Plex ownership, watchlist membership or population ratings as the recommendation.
ADR-107 and DESIGN-054 record that contract. Missing records remain unknown; a play alone proves
neither completion nor liking. Reads do not mark titles watched, edit watchlists or acquire media.

## Shipped application

- [haynesnetwork #882](https://github.com/thaynes43/haynesnetwork/pull/882), squash
  `b6c38232804d33d0d5a4c72bcdf02c3e7d0da357`: adds factual `viewing_context` and ordered batch
  `check_titles` for external candidates. `recommend` remains compatible, discloses its limited
  cache and supports explicit catalog/Plex/watchlist scope. Membership boosts and Plex-first
  pagination are removed. The agent owns discovery, current research, availability checks and ranking.
- [release #881](https://github.com/thaynes43/haynesnetwork/pull/881), squash
  `e991164523b26c4ea1ac843dd3fb165fd32beb38`: **v0.111.0**. Publication run `38203520204` succeeded.
  Image `ghcr.io/thaynes43/haynesnetwork:v0.111.0`, index
  `sha256:483f144efd51f59c341b81ddeed969b13b092d30cfba79040e600c6c430ebb93`.
  OCI source/version/revision, SLSA provenance and the Cosign GitHub OIDC signature were verified
  against the exact release commit and workflow identity, including transparency inclusion.
- [haynes-ops #3828](https://github.com/thaynes43/haynes-ops/pull/3828), squash
  `dd2dbe1c9b4eaf1a60195b653d08169c3a8b1f51`: updates the app and all 24 consumer CronJobs through
  GitOps. Flux and HelmRelease are Ready; `haynesnetwork-main` has 3/3 ready updated replicas at
  the verified digest, zero restarts and successful migration init containers. Health is HTTP 200.
  Existing CronJob suspend flags were preserved.

## Validation

Feature and release required checks (`lint-and-typecheck`, `test`, `build`, `e2e-gate`) passed,
including the full end-to-end gate. Focused coverage includes account isolation, canonical-ID
conflicts and ambiguity, external/marks-only identities, partial viewing and unavailable sources,
membership-neutral scoring and pagination, static single-writer guards, public routes and voice
budgets. Tests ran serially under `nice -n 19`; no load loops or stress tools were used.

The deployed hop passed read-only smoke checks for all eleven schemas and personal evidence:
an ordered five-candidate batch resolved four, including three outside Plex, and retained one
unresolved result. Cached catalog/Plex/watchlist scopes and pagination disclose their coverage.
No viewing or watchlist records were changed. Live tools/list was 5,142 payload bytes (5,176 bytes
with JSON-RPC envelope), instructions 537 characters; observed new-tool text was at most 388
characters and structured output at most 4,031 bytes, within the 1,200-character/64-KiB limits.

Claude advisory jobs were unavailable and returned no findings. The skip was recorded on each
app/release/deploy PR under the repository's optional-review rule; required checks remained green.

## Voice-agent rollout and closure

[hass-sandbox #241](https://github.com/thaynes43/hass-sandbox/pull/241), squash
`f06dc6670a36a5829f456703eebecfefe1ff2247`, updates shared guidance and the guarded prompt helper.
The new block was applied to Movie Room, Rumpus Room, Phone's OpenAI standby and Jarvis, retaining
explicit-action warnings. Phone's active Assist-only pipeline is unchanged. The live Watch history
coordinator loaded all eleven tools after the app rollout.

The official OpenAI reconfigure flow recalculated the three enabled web-search agents' cities
while changing prompts. [haynes-ops #3829](https://github.com/thaynes43/haynes-ops/pull/3829), squash
`7f71b8b1ecd0de230ed71c990cbdf38112ccf637`, temporarily mounts a narrow admin integration using
Core's native subentry writer, a complete-data hash guard and a protected original-city snapshot.
Nine focused tests passed against the installed HA framework. The rollout is Ready, and all three
original cities were restored. Complete four-subentry data and metadata match the original
snapshots apart from the exact intended Watch history block; API lists and model settings match.

[hass-sandbox #242](https://github.com/thaynes43/hass-sandbox/pull/242), squash
`79b8e7bb412787fff8b459a7ad331be8f4fef201`, makes the helper prefer the native atomic prompt/Watch
attachment update, reject stale hashes and verify the complete readback. Absent that integration,
it refuses the unsafe OpenAI flow before mutation; safe OpenAI and Jarvis fallback remains guarded.
Fifteen focused tests, all functional CI checks and post-merge helper CI passed. The helper is
invoked from checked-out source and needs no separate runtime image or docs-site deployment.
The installed source confirms both
omitted flags default false and guarded submissions refuse unknown default fields. Unsafe UI undo
advice was removed. The advisory was unavailable, with no findings; its skip was recorded.

The voice comparison used one unchanged synthetic audio fixture, three serial fresh conversations
per condition, the same Movie Room prompt/model/settings and no device or playback. Only the fixed
Watch history API attachment differed. All six accepted turns had zero streamed tool calls/results
and zero calls/results in their fresh chat logs. Median intent duration was 1.776 seconds without
Watch history and 1.507 seconds with the eleven tools (difference -0.269 seconds). Median
end-of-speech-to-first-fetched-audio was 2.996 and 2.771 seconds respectively (-0.225 seconds).
This small comparison observed no added overhead against the 0.5-second target; it does not establish
a speed improvement or cover tool-using turns. An earlier attempt was rejected because STT inserted
one word into the harmless fixed instruction; no timing was accepted, no tool calls were observed
and the complete configuration was restored. The accepted run used only the original and that
verified exact transcription variant. No further timing trials ran.

Exact Movie Room data/API order and all four intended subentries were verified after the comparison.
The temporary maintenance entry was unloaded and removed through the official API, unregistering
its commands. [haynes-ops #3830](https://github.com/thaynes43/haynes-ops/pull/3830), squash
`999d7e17d0c73cf38ea4548642df8d8e4025d59a`, removes only the active ConfigMap and app mount;
audited source/tests/runbook remain inactive. Required Flux/diff aggregates passed and the unavailable
advisory had no findings, with its skip recorded. Final Flux revision is `999d7e17`; HA is 1/1 Ready,
the maintenance entry/commands/ConfigMap/mount are absent, full four-agent data/metadata preservation
passes, and the Watch coordinator refreshed all eleven tools. Root independently confirmed the
cleanup revision/Ready state/absent mount and ConfigMap, and haynesnetwork remains 3/3 at v0.111.0.
Authenticated HA API/Core health passed, both containers are ready and restarts are zero. Startup
logs included one LG ThinQ error, five offline webOS errors and five dashboard/WebSocket queue-overflow
messages. A bounded settled 60-second window contained two Chromecast connection errors and one
Xbox coordinator error. Both windows had zero Watch history/OpenAI/Jarvis/maintenance errors;
no hardware actions were taken. Protected city/full snapshots and task-private working files were
removed after the final preservation audit. Activity `act-050619-2632990` ended; none remains declared.

The prior owner stop on book repair in HANDOFF remains binding. This recommendation task does
not authorize resuming those repairs or advancing unrelated book work.
