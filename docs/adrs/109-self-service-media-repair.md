# ADR-109: Self-service media repair: Fix and Force Search diagnose first, then repair in place

- **Status:** Proposed
- **Date:** 2026-10-12
- **Deciders:** Tom Haynes (owner goal, 2026-10-12: steer Plex users away from filing Seerr issues for staff and
  toward fixing problems themselves on haynesnetwork.com, once the platform reliably fixes what they report).
  Drafted by Opus 5.5 from three Seerr issues worked by hand the same day. Open owner questions: DESIGN-055 Q-01
  (who may override a profile rejection) and Q-03 (scope of a Plex audio-language write).
- **Design:** [DESIGN-055](../designs/055-self-service-media-repair.md). Plan: PLAN-077. Siblings: ADR-110 (episode-title
  evidence), ADR-111 (Seerr issue bridge and readiness gate).
- **Amends (when the first writer lands):** hard rule 4's write-back list (CLAUDE.md), as ADR-083 C-04, ADR-093 C-08 and
  ADR-098 did; ADR-017's confined Plex write surface gains one call (C-02).

## Context and problem statement

Users report broken media through Seerr issues, and staff fix them by hand. Seerr has had 4 issues since 2026-07-11
(read 2026-10-12); every one was resolved by staff. haynesnetwork's own levers saw almost no use: 2 Fix requests in the
last 90 days, by one person, and 1 Helpdesk ticket ever (a rejected test). Three issues were worked by hand on
2026-10-12, and none of them could have been fixed with the tools a user has today:

- **Case A, Regular Show: The Lost Tapes S01** ("Missing episode 11 and all the episodes after 10 are slid up by 1").
  A BiOMA "DUAL" pack numbered episodes one behind TVDB from "Secret Menu Item" on, and Sonarr, which trusts `SxxEyy` in
  release names, filed 8 files one slot too low. It also "upgraded" the real Spice It Up file away. A Disney+ file for
  E23 was filed on E24. The only releases for two episodes were rejected by the profile (an HMAX x265 at custom-format
  score -9925, and a 720p). The BiOMA files default to Portuguese audio. Fixed by hand with manual imports of the
  existing files (highest episode first) and a rename, two override grabs, an unpack of a `.7z` SABnzbd left behind, a
  per-series release profile, and Plex's show-level preferred audio language. Fix would not have helped: an episode
  Fix blocklists the bad release and then finds nothing acceptable, and a season Fix also blocklists the 10 good ones.
- **Case B, The Paper (2025) S02E06** ("Missing episode 6"). Sonarr parsed the inner file name as episodes 6 to 125
  and blocked the import for 18 days. The janitor saw it 423 times as `unknown` and, by design, never acted. Force
  Search found 81 releases and grabbed none, because the stuck download held the episode. Activity's Retry import
  re-runs the same automatic import, and only admins have it. Fixed by an admin manual import (issue #597).
- **Case C, GoodFellas (1990)** ("click play, it says I just watched it"). The file is a healthy 87.6 GB DV remux. The
  play never reached our servers; the reporter most likely pressed Plex's own free-catalogue copy. A "Won't play" Fix
  with no Radarr grab history would have deleted the file and downloaded an essentially identical release.

Sonarr and Radarr run with no recycle bin (`recycleBin: ""`, read 2026-10-12), so a deleted or replaced library file
is gone for good. The problem: give users remedies that fit what they actually report, without breaking the doctrine
that the *arrs are the source of truth and that every write-back is confined and audited, and without adding a
second automatic actor beside the queue janitor.

## Decision drivers

- **Hard rule 4.** The *arrs stay the source of truth; every new write goes through `@hnet/arr/write` from
  `packages/domain` only, with its own ADR line. Library files are never touched outside the *arr's own calls.
- **Destroy last.** No recycle bin exists, so a remedy must never delete or displace a file the person did not name.
- **One action vocabulary (ADR-071).** Fix and Force Search are the only per-item repair buttons, everywhere.
- **Repair is a verb, not a privilege (ADR-080).** Everyone can repair; the per-role hourly budget governs volume.
- **One automatic actor.** The queue janitor (ADR-083, ADR-098) stays the only thing that acts without a person.
  Its census-first ladder is extended, not duplicated (issue #597).
- **Evidence before action.** Each remedy shows what it found and what it will do before any write.

## Considered options

1. **Status quo.** Staff fix reported problems by hand in the *arr UIs.
2. **Give users the *arr UIs** behind SSO. No guard, no audit, needs *arr expertise, and every mistake is permanent.
3. **A guided repair behind the existing Fix and Force Search buttons**, with new confined write-backs: the *arrs'
   own manual import, rename and interactive-search grab (with override fields), queue removal from a person's Force
   Search, and one Plex title-preference write.
4. **An agent per report** (an LLM with *arr access works each issue). Disproportionate for remedies that are mostly
   deterministic; it stays available for the residue no guided remedy fits.

## Decision outcome

Chosen option: **3, a guided repair behind Fix and Force Search**, because it fixes the reported kinds in place, keeps
the vocabulary and the write confinement, and lets every remedy show its evidence and its consequence before it acts.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **The Repair Guide** (T-301). Fix and Force Search open a guide that asks what is wrong, reads the evidence, and offers the remedy that fits: an Episode Re-map, an Import Check on a stuck download, a Release Pick, a language check, playback triage, or the existing Fix and Force Search paths. No new head buttons; any new verb inside the guide goes through the ADR-071 registry and guard. |
| C-02 | **New write-backs** (hard rule 4 amendment, made in the PR that lands the first writer): Sonarr's and Radarr's `ManualImport` command (an existing library file or a finished download's file onto chosen episodes or the movie), `RenameFiles`, the interactive-search grab `POST /release` (with the override fields only under C-06), and queue removal with blocklist (the existing `deleteQueueItem`) from a person's Force Search. Plex: a title-level preferred audio language through `@hnet/plex/write`, only under C-07. All from `packages/domain`, each preceded by its audit row. |
| C-03 | **Destroy last.** No remedy deletes or displaces a library file implicitly. A Re-map refuses any move onto an occupied slot unless that slot's file moves too or the person explicitly discards it. The Fix's no-history delete path shows a Replacement Preview and refuses when the replacement is the same release or nothing acceptable exists. A season Fix blocklists only the downloads behind episodes the person marks bad. Wrong language reads the file's audio tracks before any blocklist or delete. |
| C-04 | **Repair Requests** (T-302): a new aggregate with one single writer, the pending row committed before any mutating call (the Fix pattern), every step appended to its trail, and a ledger event per transition. Each remedy and each interactive release list counts once against the arr pool of the per-role budget (ADR-080). One open repair per series season or movie. |
| C-05 | **Force Search becomes queue-aware** (issue #597 Part 1). It reads the queue for its target first. A finished download that passes the Import Check (T-306) is imported; one that fails it is removed with blocklist and searched again; a healthy one in progress is shown, not searched over. The janitor gets the same Import Check as a new census-first class on its own ladder cell (DESIGN-046 amendment), so automation and the person's button cannot disagree. |
| C-06 | **Who may grab a release the profile rejected is open** (DESIGN-055 Q-01). Until the owner answers, the Release Pick offers approved releases to everyone and shows rejected ones read-only. A hard-refusal list applies whatever the answer: blocklisted, CAM/TS/sample/unknown quality, a Release Block, Mislabel Block or Title Exclusion match, a name that names a different episode, or a size over the profile's limit. |
| C-07 | **The scope of a Plex audio-language write is open** (DESIGN-055 Q-03). Until answered, Wrong language with the wanted audio already in the file explains how to pick the track and writes nothing. |
| C-08 | Good: the three motivating cases become self-serviceable, and the destructive paths that would have harmed Cases A and C refuse instead. |
| C-09 | Bad: a larger *arr write surface. Mitigated by previews, the refusal lists, the budget, one open repair per scope, per-request caps, and an audit row before every call. |
| C-10 | Bad: manual import and override grabs are less stable API surfaces than search commands. Contract tests pin the request bodies against the running versions (Sonarr 4.0.20.3012, Radarr 6.4.4.10685) and the stub *arr. |
| C-11 | Neutral: books keep their own Fix (ADR-062); this ADR covers Sonarr and Radarr. Lidarr keeps today's Fix and Force Search; the Fix-everywhere parity goal (PLAN-041) stands. |

## More information

- Evidence: Seerr issues 2, 3 and 4 (the three cases), issue #597 (stuck downloads, the queue-aware Force Search
  proposal), haynes-ops#3834 (SABnzbd leaves obfuscated `.7z` downloads un-extracted), issue #887 (the janitor
  blocklists them), haynes-ops#3833 (HaynesOps never hardware-transcodes).
- Builds on ADR-007 and ADR-011 (Fix and Force Search write-backs), ADR-016 (subtitle Fix), ADR-028 (live feedback),
  ADR-047 (access-aware Watch-here links), ADR-059 (Activity), ADR-071 (one vocabulary), ADR-080 (budgets), ADR-083,
  ADR-094 and ADR-098 (the janitor), ADR-093 and ADR-097 (Release Block, Title Exclusion).
- PRD R-262..R-267; glossary T-301..T-309.
