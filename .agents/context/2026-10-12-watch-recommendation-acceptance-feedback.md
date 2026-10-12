# Watch recommendation acceptance feedback — 2026-10-12

The v0.111.0 agent acceptance test passed the broad-discovery, external-candidate, explicit-scope,
ambiguity and read-only workflows. Its partial-pass findings led to ADR-108, DESIGN-054 D-04..D-07
and PLAN-076. The owner's book-repair stop remains binding.

## Resulting contracts

| Finding | Resolution |
| --- | --- |
| Commercial provider absence used to reject a suitable released title | Released media beyond theatrical-only is eligible through the owner's acquisition setup, regardless of Plex/watchlist/commercial listings. Commercial listings are optional convenience, never a default filter or ranking boost. Upcoming/theatrical-only media needs an explicit request. |
| Recorded watched with zero direct completed plays lacked a clear source | `viewingBasis` names the source supporting the selected classification from full records. Explicit statements, Plex flags/episode state, direct watched verdicts and retained history stay distinct. Replay progress and episode scope are preserved; no liking or 100% viewing is inferred. |
| Exact-title year mismatch returned no recovery identities | At most five deduplicated canonical identity-only alternatives retain strict name/kind/all-ID checks and unresolved identity/null personal evidence. Provider failure remains unavailable; a partial local cache is not a complete catalog. |
| Cached reasons suggested personal affinity | Neutral similarity copy identifies titles in viewing records. No scorer weights, acquisition logic or discovery service were added. |
| Numeric titles could acquire an invented year when catalog dates were missing | Catalog search, direct identity reads, external-ID bridges and hydration preserve unknown years as null. Numeric literal titles still resolve by name. |

## Feature validation

- Feature [haynesnetwork #884](https://github.com/thaynes43/haynesnetwork/pull/884) merged
  `df7bb2b2096ed3285bcd00eafdcf49106aee4136` at 16:13:31Z.
- Exact reviewed head `08db679c3df5201e61a819365d4aff95cae006d4` passed required
  `lint-and-typecheck`, `test`, `build` and `e2e-gate`. Pipeline Playwright passed in 7m42s;
  fresh Claude advisory completed with no findings.
- 171 focused serial tests passed: 142 watch, 25 MCP contract/formatter, two Postgres MCP
  integration and two sibling watchlist integration cases. Watch/MCP typechecks and lint passed.
- CI initially found two stale sibling text assertions; their corrections strengthen canonical
  year confirmation/no-watched-conclusion/no-write checks. No runtime change was needed.
- Independent review identified the missing-date numeric-title issue and verified its correction.
  Existing classification precedence, account boundaries, counts/progress and lookup budgets remain.

## Connected-agent guidance

Connected-app metadata did not carry initialize instructions, so the viewing-context description
also exposes broad discovery, contextual judgment, dated research and the released-media policy.
This closes a client-visible guidance gap without adding tools, inputs or a discovery service.
[haynesnetwork #888](https://github.com/thaynes43/haynesnetwork/pull/888) merged
`688e7d475529ac27d6301f52fd6e0b047f9d3639` at 16:30:49Z. Exact head
`1073c574bc55f20d5b12c6776382a10ef04ca81c` passed all four required checks; Claude advisory was clean.
The optional Playwright advisory also passed in 7m18s.
Thirteen focused tool-contract tests and the actual transport/schema budget test passed serially.
The eleven-tool JSON-RPC `tools/list` body is 5,526 UTF-8 bytes, below 6,144; instructions are
596 characters, below 600, and the viewing-context description is 484 characters. These repeated
contract checks are not added to the distinct 171-case feature total.

## Voice delivery and cleanup

- Source [hass-sandbox #243](https://github.com/thaynes43/hass-sandbox/pull/243) merged
  `618425aa9910b1f63cc10afba5be8d1f181a698f`. Documented/helper blocks match byte for byte;
  the previous block remains verbatim in update history. Current block SHA-256:
  `93f43ecb70dbfc5a38bcd069dbf3b5c80b642d6e2fc32202d7540fb6b0af96be`.
- Temporary native maintenance [haynes-ops #3831](https://github.com/thaynes43/haynes-ops/pull/3831)
  merged `75542fb068ed3599d5c570ec8e4a16d50675b35f`; cleanup
  [#3832](https://github.com/thaynes43/haynes-ops/pull/3832) merged
  `cb89ca38b03a8070fbdd1b961ca1c01bedc1693d`. All required checks/advisories passed with no findings.
- Fifteen helper guard tests and nine native-writer tests passed serially. Four source dry runs
  passed; complete resulting prompts are 5,371–5,599 characters, within the 8,000 bound.
- Fresh full snapshots were saved privately on the dev-env PVC before rollout. Each serial native
  write checked the complete-data hash and changed only the prompt with attachment `keep`.
  Independent post-cleanup readback verified all four complete data objects and metadata,
  original cities/models/API order, every other original subentry and complete Assist pipelines.
  The active Phone agent remains local Assist-only. Rollback was not needed.
- Native entry and four maintenance commands are absent; ConfigMap/mount/runtime source removed.
  HA is 1/1 Ready, both containers Ready with zero restarts; authenticated health and loaded Watch
  MCP verified. No Watch/OpenAI/Jarvis/maintenance startup errors. Private snapshots/transfers
  removed and activity `act-155349-2763206` ended.
- No physical, audio, playback, history, watchlist or acquisition writes. The wording-only rollout
  did not repeat the prior limited voice latency benchmark and makes no new performance claim.

### Post-deploy Home Assistant metadata refresh

The final factual audit caught that the earlier HA receipt preceded the app deployment. OPS-015
§8 requires an entry reload after description changes: HA loads tools at setup and discards MCP
initialize instructions. A supported Watch-only entry reload succeeded at 17:25:40Z. Native
coordinator readback confirms all eleven loaded names, input schemas and descriptions exactly
match v0.111.1, including the 484-character viewing-context description (SHA-256
`d478910301cc3f9da7b42ac09dcfd4fb1d4904d2ce2fdf9615f2527e9b123135`). The Watch API is registered
and entry loaded. Temporary coordinator logging was restored in finally to inherited INFO with
unchanged `core.logger` bytes. Complete `core.config_entries` and Assist pipelines are byte-identical
before/after; the refresh adds no prompt/settings writes or HA pod restart.

Final 17:29:12Z readback also verifies all four full holder/parent entries and relevant registry
metadata, active Phone entity/entry/subentry/pipeline and Assist-only APIs. HA kept the same Pod UID,
both containers Ready with zero restarts. All integration effective log levels remain INFO;
persisted logger bytes are identical. Full identical-file hashes:

- `core.config_entries`: `34a3ca3fa3376dae166625a0095fa71e5c6072cdfc0a9eba7b633d920834ce6d`.
- Assist pipelines: `4480a53392da2d0dc289683ed60a64ea5b95c89e6eae03dcdbf20006cac3fe31`.
- `core.logger`: `361023c7e3df8ce81cc649ade435ba821f90608482c02113b9d2c3efcb7ba7a0`.

Private snapshots/native capture were removed and activity `act-172447-3215500` ended. Sanitized
final HA receipt SHA-256: `e6854c664c9e284b87cee4cdd66142a0663421bee421d6dd4945de2adf5edc65`;
app receipt SHA-256: `f166efa279047634045333594e88fd8cf3f071edf7cf7b340113a49c2a8ea6f7`.
These include the direct loaded-description/schema hashes and distinguish server initialize
instructions from the tool descriptions HA consumes.

## Release and deployed verification

- Release [haynesnetwork #886](https://github.com/thaynes43/haynesnetwork/pull/886) merged
  `7141f3aeaf582297a13c97bf02749c916ebbb57d` at 16:56:15Z for v0.111.1. Final head
  `fae264c6563b368d8bf7aa5d9d68c93d38f10304` passed all four required gates; full release
  Playwright passed in 7m08s, run `38279863394`. Generated release advisory was skipped by design
  with no findings. Both feature ancestry checks and actual main/base equality passed before merge.
- Two concurrent peer merges required refreshed release checks; evidence above refers to the
  final head, not the earlier successful run.
- Publication run `38280853231` passed in 3m52s. Tag v0.111.1 points to release commit
  `7141f3aeaf582297a13c97bf02749c916ebbb57d`; its tree is identical to the tested release head
  (`b5c8bbfaf32bd0191ffa04d7a1aa3f83a93c2295`) and contains both feature merges.
- Signed OCI index: `sha256:bf1a8c80926799db986dc1f35d3f5695c4dc4d87890c1fce576267eaa4b3c1d9`.
  Linux/amd64: `sha256:085113c59b83e0850a50b703f7963dea88f53e9f36b00b66a542bd169f677e88`.
  OCI source/version/revision and SLSA subject/VCS revision match the release. Keyless Cosign
  certificate chain and transparency proof verify against GitHub's OIDC issuer and
  `https://github.com/thaynes43/haynesnetwork/.github/workflows/release-please.yml@refs/heads/main`.
- Three-anchor image update [haynes-ops #3837](https://github.com/thaynes43/haynes-ops/pull/3837)
  merged `018417229ef6f3497ca47c747729be04166a1701` at 17:06:16Z after both aggregate gates passed.
  Two clean advisory reviews were read. Root reviewed the exact three image tag changes before
  merge; Flux fetched the same revision. Independent root readback at 17:07:58Z confirmed
  `haynesnetwork-main` uses v0.111.1 with three updated, ready and available replicas.

- Deployment audit: 3/3 ready replicas, zero restarts and successful migration init containers.
  Three linux/amd64 nodes report the signed index containing the verified platform manifest. All
  24 CronJob templates use v0.111.1; image-stripped specs and suspension flags are unchanged.
  All three Flux applications are Ready at the image-bump revision; Helm is Ready/Released and
  documented ingress health returns HTTP 200.
- Live MCP initialization and viewing-context description match the reviewed source byte for
  byte: 596 and 484 characters. Eleven schemas occupy 5,492 result bytes / 5,526 including
  JSON-RPC, within 6,144. Largest tested structured response is 5,007 bytes; largest spoken
  response is 523 characters, within 64 KiB and 1,200 respectively.
- The reported watched/zero-direct-completed-play case now exposes `plex_watched_state`.
  Strong-ID wrong-year input remains unresolved with null identity/evidence and a canonical
  2021 identity-only option. Correct-year, numeric-title and external outside-Plex cases resolve.
  Snapshot coverage remains incomplete and personal ratings unavailable. No media writes or
  commercial-availability lookups were performed by the live audit.
- App activity `act-170601-3204662` ended after healthy rollout and read-only verification.
  Final safe receipt captured at 17:11:33Z verifies temporary task helpers/signature transfers
  and all prior private HA snapshots/transfers are absent. No raw personal responses were saved.
  PLAN-076 is completed; its record includes feature, guidance, voice, release and deployed proof.

CPU constraint: no burners, stress tools or wide parallel/looped tests. Bounded tests ran serially
under `nice -n 19`; required CI supplied broad validation.
