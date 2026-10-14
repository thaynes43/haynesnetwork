# Mickey final S01E13–16 carry review

**Current status, frozen 2026-10-14T11:59:39.296664418Z: PREPARED and held.** Signed v0.125.4 is verified live
through [haynes-ops 3925](https://github.com/thaynes43/haynes-ops/pull/3925) and merged actual proof
[3926](https://github.com/thaynes43/haynes-ops/pull/3926), with exact image
`sha256:5522d758426a317b42fec609fbe02f8f27cdc042f03b133833002f8ccb2f881f`. Sixteen of 23 initial slots are fully
proved through E37/E38. E39/E41/E43/E45/E47/E49/E51 remain; adoption 99 for E39 is delivered but its full finish
is pending. The original finite initial worker is unchanged. The final-only proposal is reviewed offline,
suspended and disabled for execution. Future capture/expiry/identity/prefix-proof fields remain blank.

Require all 23 actual initial finishes, actual predecessor termination, fresh complete prefix and physical
same-content mapping, exact deployed signed sources, actual finite activity and a new root review of the sealed
concrete envelope before execution. The older mapping snapshot below is evidence for preparation; it does not
replace those fresh reads. The latest offline review covers late-observe handling, actual mutating-GET deadline
guards and v0.125.4 native-adoption code. It authorizes no media or cluster command.

**Subsequent offline contract review, 2026-10-14T12:11:38Z:** the frozen initial worker exits naturally immediately after its accepted E51/E52
finish. Capture its actual live pre-final state, full earlier completed prefix and verified parts before that finish,
explicitly marked pre-final and nonterminal. After the finish, require the exact same Job/Pod UIDs, native
Complete/succeeded=1/active=0 and every main/init container's actual exit 0/finishedAt, together with the actual
`slot_fully_verified` 51 event and following `next_slot_gate` done/null/`final13to16Held=true` event. Combine those
actual records with all 23 completed rows and current normal/file/account proofs. Do not claim a post-terminal
Pod-exec state or finished-Plex-file capture, or reconstruct a terminal checkpoint. The controller and runtime
consume native termination facts and completed rows; neither requires those unavailable terminal files.
This clarifies the recipe's evidence provenance without changing worker/control code or weakening termination,
all-23, fresh-prefix, root-mapping or sealing requirements. Future captures/expiry/identity remain blank.

The approved host lifecycle helper is SHA `dc39136f3b5e5d54d739a903e210b81cb3d1391fd4416a4500692419fb72f575`;
its contract proof is SHA `3b6c52a9060023b848494e61b8393f3ee84fc2d9543d08e1f0a3e9c53e491acd`. That read-only
contract proof explicitly separates observed live E37 state from the not-yet-actual final-event shape; it is not
the predecessor's terminal proof. The recipe-only provenance correction follows this docs-first clarification.

The following hashes remain the original frozen **11:59:39Z** artifact snapshot, including the then-current recipe:

| Prepared artifact | SHA-256 |
| --- | --- |
| `final-worker.ts` | `5c603b3768ee6a61158eafc5fe3924aafc6d4183ddf4fc4a3f00d60306d3878c` |
| `final-control.py` | `fa8c30bdf1dd93a074ef42642cd454ee9fe05b67481e936033696ad755770f87` |
| `job.suspended-proposal.json` | `c8dba3e9e0b528d079124feeef12170417ecf0a2eccdacd9befa1feed9c1b960` |
| `envelope.prepared.json` | `3c3ea879061036a3ca4ff12c84232309fb0e9dbdc4f0bd393907f6d69567e94f` |
| `execution-recipe.json` | `535b16267a1437ef8f85dde6d74aed06b22f61672befb7ac42a2b9ee07ab3932` |

After the subsequent offline contract review above, only `execution-recipe.json` and its private manifest entry
changed. The current recipe is **11155 bytes**, SHA
`cf73b2ed7e5e4bb0aa0410aaf9cf52a9ca01a7379fcfb007fd033290c5d20e91`. Worker, controller, prepared envelope
and suspended Job hashes remain exactly those in the frozen table. Preparation is still `preparedOnly=true`,
the proposal is suspended, completed rows remain unsealed and future capture/expiry/identity fields are blank.
No live prefix/mapping capture, sealing, command delivery or Job creation occurred during this offline review.

See the [runtime checkpoint](2026-10-14-self-service-repair-runtime-proof.md) for actual rollout, immutable worker
identities/bounds and the completed E37/E38 row. PLAN-077 remains Active; formal Step 5, Step 6 and P8 remain in
the original order, with no readiness/default-policy ruling.

**Earlier update, 2026-10-14 11:21Z:** D40's original-part/failed-part recovery and both-native factual adoption are merged
in [987](https://github.com/thaynes43/haynesnetwork/pull/987), with all four checks and renewed review passed.
[Release 988](https://github.com/thaynes43/haynesnetwork/pull/988), v0.125.4, is merged; cosign and both registry artifacts were subsequently verified at 11:25/11:26Z.
Deployment verification remains pending. Fifteen initial slots are fully proved. The separate final-only
proposal is prepared disabled, with future captures/digest/expiry blank. This does not authorize execution. Preserve
the proposed mapping below and refresh it after every initial finishes on the signed deployed source.


Read-only snapshot: 2026-10-14T09:03:37.285Z. Execution remains held until all 23 initial packet slots finish and the driver approves a fresh final plan and mapping.

## Original file and proven destination

- Original file **65359**, **1377201632 bytes**, full Sonarr episode IDs **37193, 37194, 37195, 37196** (S01E13–16).
  Relative name: `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E13-14-15-16 - Ye Olde Royal Heist and Tea Time Trouble! and Abra-ka-Goof! and Happy Birthday Helpers! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Correct story destination **80038**, **599908341 bytes**, full Sonarr episode IDs **37187, 37188** (S01E07–08).
  Relative name: `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E07-08 - Agent Double-O-Goof and Egg-xasperating! [WEBRip-1080p][EAC3 2.0][x265]-iVy.mkv`.

The independently recorded original subtitle/story evidence identifies Agent Double-O-Goof (the Queen visit and Commander Heist royal briefcase story) and Egg-xasperating. The older evidence is preserved in [the original copy mapping record](2026-10-13-ben-mickey-wrong-content-copy-mappings.md#final-s01e1316-wait-for-corrected-e0708-imports). This preview does not infer content from the original four-title basename.

The new destination was physically measured after actual whole-pair import. Its literal cards were viewed at 60 seconds (Agent Double-O-Goof) and 691.54 seconds (Egg-xasperating!). Physical English EAC3 stream 1 is available, with Romanian stream 2; no spoken ASR claim is made. Actual duration is 1351.072 seconds. Measured completed-source and library SHA-256 both equal `72d69a36b932843e9452f5ecae607676bcefa5bb9de558333592d4f8a2cdca9a`. Original protected file 65359 remained unchanged.

The same-parent recovery completed normally: Fix `d26e411f-7b47-42e4-a363-2633de493d64`, Carry `76419c02-7b27-41e7-afba-baac49a21d24`, actual download `04f547da-7099-42e8-b396-aff4ac1aa00c`, native import events 66899/66900, completed ledger event `dcb744aa-22af-4f4d-a635-14fe337e1e83`. Both Plex servers passed owner/every captured affected account strict current zero and preserved correct-copy mark checks before slot 7 finish was accepted at 08:42:17Z.

## Actual Plex representation

| Server | Original item / actual index | Destination item / actual index | Physical identity |
|---|---|---|---|
| haynesops | 58499 / S01E13 | 109432 / S01E07 | Original 1377201632 bytes; destination 599908341 bytes; exact basenames match |
| haynestower | 46426 / S01E13 | 556273 / S01E07 | Original 1377201632 bytes; destination 599908341 bytes; exact basenames match |

Each actual Plex item covers its independently confirmed whole Sonarr file. The record does not invent Plex leaves for indices 14–16 or 8. Fresh final Watch Carry must capture the original actual item and bind both correct story destinations to the actual paired destination item.

## Proposed mapping and two-part replacement

`--same-as 13:S01E07,13:S01E08` binds the one original physical file 65359 to correct destination file 80038. Source prefix 13 resolves the original file; adding prefix 15 would refer to the same original file and is unnecessary. Marks go to the existing proved E07–08 copy, while newly filled E13–16 receives no old wrong-content state.

The read-only preview digest is `89c905f48a84e5ed0bdaedd817766907`; it is evidence of available choices, not an executable approval. Ongoing initial repairs change protected fingerprints, so final execution must freshly plan the complete four-episode slot, verify full original/destination identity, and obtain driver approval.

| Key | Exact release | Landing coverage | Refusals / state |
|---|---|---|---|
| `33d04f8818a5d4d4` | `Mickey.Mouse..MixedUp.Adventures.S01E13E14.Ye.Olde.Royal.Heist..Tea.Time.Trouble.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor` | S01E13 · Ye Olde Royal Heist, S01E14 · Tea Time Trouble! | override; renumbered only |
| `510923351a39d052` | `Mickey.Mouse..MixedUp.Adventures.S01E15E16.AbrakaGoof..Happy.Birthday.Helpers.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor` | S01E15 · Abra-ka-Goof!, S01E16 · Happy Birthday Helpers! | override; renumbered only |

Each release covers two of the original four episodes; neither is individually a whole-slot replacement. Their joint union covers all four exactly once. Each actual file must separately prove English and both intended stories before an owned import or adoption of a native import. Sonarr's own import is observed and verified, never replayed. Normal completion must require every stored original slot episode across both actual download GUIDs, with bounded real native-history settlement and no synthetic events. If either correct release or the new destination cannot be proved before the original deletion, retain original 65359 and hold. After a claimed grab, observe its actual result and use only the audited same-parent recovery; never delete another file to restart.

## Evidence identity

- Read-only mapping proof SHA-256: `c6b20a027bfdef809b8a16dbf93acdf43227b151b3e3bff1a0ef1253104498a6`.
- Final read-only plan proof SHA-256: `721fa17839627b68138b10bd2842fb4674ea694960097af02ed97faa5eaf145d`.
- Root-ratified destination physical proof SHA-256: `d7f42ca1a8f0ab0871d34181a061e8bcac758e8ee17c6349aa5f3d0aa085c1a6`.
- Raw private evidence persists on the shared PVC under `selfserve-plan077/mickey/continuation-r2-1253-20261014T0810Z/slot7-completed`; this Markdown carries the concrete identities and scope needed for a cold start.
