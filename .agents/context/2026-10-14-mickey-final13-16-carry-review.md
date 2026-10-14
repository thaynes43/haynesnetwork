# Mickey final S01E13–16 carry review

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
|---|---|---|
| `33d04f8818a5d4d4` | `Mickey.Mouse..MixedUp.Adventures.S01E13E14.Ye.Olde.Royal.Heist..Tea.Time.Trouble.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor` | S01E13 · Ye Olde Royal Heist, S01E14 · Tea Time Trouble! | override; renumbered only |
| `510923351a39d052` | `Mickey.Mouse..MixedUp.Adventures.S01E15E16.AbrakaGoof..Happy.Birthday.Helpers.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor` | S01E15 · Abra-ka-Goof!, S01E16 · Happy Birthday Helpers! | override; renumbered only |

Each release covers two of the original four episodes; neither is individually a whole-slot replacement. Their joint union covers all four exactly once. Both actual completed files must separately prove English and both intended stories before any import. Normal completion must require every stored original slot episode across both actual download GUIDs, with bounded real native-history settlement and no synthetic events. If either correct release or the new destination cannot be proved, retain original 65359 and hold.

## Evidence identity

- Read-only mapping proof SHA-256: `c6b20a027bfdef809b8a16dbf93acdf43227b151b3e3bff1a0ef1253104498a6`.
- Final read-only plan proof SHA-256: `721fa17839627b68138b10bd2842fb4674ea694960097af02ed97faa5eaf145d`.
- Root-ratified destination physical proof SHA-256: `d7f42ca1a8f0ab0871d34181a061e8bcac758e8ee17c6349aa5f3d0aa085c1a6`.
- Raw private evidence persists on the shared PVC under `selfserve-plan077/mickey/continuation-r2-1253-20261014T0810Z/slot7-completed`; this Markdown carries the concrete identities and scope needed for a cold start.
