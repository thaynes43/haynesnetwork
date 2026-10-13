# ADR-110: Episode-title evidence guards imports, and a confirmed mislabel blocks its release group on that series

- **Status:** Accepted (owner, 2026-10-12, with ADR-109 and ADR-111; built in PLAN-077 P2 and P4)
- **Date:** 2026-10-12
- **Deciders:** Tom Haynes (owner goal, 2026-10-12, as in ADR-109). Drafted by Opus 5.5. No owner question is open on
  this ADR: it acts only through a person's confirmed re-map, and anything automatic stays census.
- **Design:** [DESIGN-055](../designs/055-self-service-media-repair.md) D-05, D-07. Plan: PLAN-077 phases P2 and P4.
- **Amends (when its writer lands):** hard rule 4's write-back list gains the Mislabel Block (C-04); DESIGN-046 gains
  the report-only class `title_mismatch` (C-02).
- **Amended by:** [ADR-113](113-mislabelled-name-terms-in-the-mislabel-block.md) (2026-10-13, owner ruling on
  DESIGN-055 Q-10): C-04's block also holds mislabelled-name terms (a number with another episode's title, a
  double-episode token, an alternate title), written only by staff and the adoption through the same single writer;
  C-05's hand profile is retired once its five name blocks are adopted. Every other consequence stands.

## Context and problem statement

Sonarr files an episode by the `SxxEyy` in the release name and trusts it. When a release group numbers a season
differently from TVDB, every file lands on the wrong episode with no warning, because nothing about the import fails:

- **Case A** (Regular Show: The Lost Tapes S01, Seerr issue 4): a BiOMA "DUAL" pack ran one behind TVDB from "Secret
  Menu Item" on, so 8 files were filed one slot too low and the real Spice It Up file was "upgraded" away. A Disney+
  file named for "All You Can Fit" (E23) was filed on E24. The release that finally supplied E11 was posted as
  `S01E10.Spice.It.Up`: its number was wrong and its title was right.
- **Issue #597:** The Penguins of Madagascar grabs (Spanish-titled MULTI posts pairing two segments per file under a
  different numbering; the file for 1x24 is "Cuajito / Estrellas de television", TVDB 1x24 is "Misfortune Cookie"),
  eight "Lioness.2023" grabs for "Lioness (2021)", and the reverse case: T.O.T.S. files that were correct but stuck
  at "matched by ID", which an import guard must not refuse.

Where should a guard live? The *arrs have no pre-import veto: their Connect events fire after an import. A release
profile matches names only, and BiOMA's names carry no episode title at all, so a name rule cannot judge them. The
queue janitor sees only downloads whose import blocked, and Case A's imports did not block.

## Decision drivers

- Catch clean mis-numbered imports (Case A), not only blocked ones.
- Never refuse a correct import on missing evidence: most release names carry no episode title.
- Hard rule 4: any automated *arr write is confined, census-first and audited; a release profile term that does not
  compile in .NET stops every grab on that *arr (ADR-093 C-19).
- The person who watched the episode is the best witness; the engine's job is to suggest and to check.

## Considered options

1. **A janitor class only** (pre-import). Misses every clean import, which is the Case A failure.
2. **An import-time veto.** No hook exists; a script on import runs after the file has moved.
3. **A release profile only.** Cannot judge title-less names; a group-wide global block over-blocks every other show.
4. **One Title Evidence engine used in three places**: the janitor's Import Check and a report-only class before
   import, a census Title Check after import that flags and suggests a re-map, and grab-time prevention through a
   series-scoped Mislabel Block written only from a confirmed re-map.

## Decision outcome

Chosen option: **4**, because it is the only one that sees clean imports, it never blocks on silence, and its one
write (the block) follows a person's confirmation instead of a guess.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Title Evidence** (T-304) is a pure engine in `packages/domain`: it extracts the episode-title text a release, scene or file name carries after its `SxxEyy` token and scores it against the season's TVDB titles (from the *arr's episode list). Verdicts: `agrees`, `disagrees` (naming another episode, with a score), `silent` (no title text) and `ambiguous`. A title that agrees outranks the number: `S01E10.Spice.It.Up` is evidence for E11. Silence is never evidence against. |
| C-02 | **Before import:** the Import Check (ADR-109 C-05) passes only with `agrees` or `silent`; `disagrees` puts the queue item in a new report-only janitor class `title_mismatch` (no enforce cell) and offers the person the "Import this download onto this episode" choice with the evidence shown. |
| C-03 | **After import:** a census Title Check (T-305) on the sync rail reads new `downloadFolderImported` history and records one verdict per imported episode file. A `disagrees` verdict flags the episode on its title page with a suggested Episode Re-map. It never moves a file by itself; automating a re-map would need its own ADR and owner ruling. |
| C-04 | **The Mislabel Block** (T-310): one app-owned Sonarr release profile, "haynesnetwork: mislabelled releases (managed, do not edit)", holding "must not contain" terms only. A term pairs one series title with one release group (series-scoped by its own text, so no tags). Its one writer adds a term only from a person's confirmed re-map whose evidence pins two or more files of that group on that series, writes and reads back before replying, and builds terms from the ADR-093 whitelist grammar with the same compile checks. Terms live 365 days; at most 500 terms. Separate from the Release Block, whose terms come only from Deleted-Release Records by rule. Hard rule 4 is amended in the PR that lands the writer. |
| C-05 | The hand-made per-series profile from Case A (tag `lost-tapes-release-block`) is adopted: its term moves into the Mislabel Block, then the tag profile and tag are removed by hand with a read-back (PLAN-077 P4). |
| C-06 | Good: Case A's failure is visible the hour it happens, and a confirmed bad group cannot refile the same series. |
| C-07 | Bad: title text is fuzzy (translations, two-segment files, renamed specials). Mitigated by never acting on a verdict alone, by `ambiguous`, and by census evidence before any threshold is trusted. |
| C-08 | Bad: a series-scoped group block can hide that group's later correct posts for the series for up to a year. Accepted: the person who confirmed the re-map saw the evidence, and staff can delete a term. |

## More information

- Builds on ADR-083, ADR-094 and DESIGN-046 (the janitor, its classes and release-name block), ADR-093 C-07, C-19 and
  DESIGN-052 D-12, D-13 (term grammar and the single-writer profile pattern), ADR-109 (the Repair Guide, Import Check
  and Episode Re-map).
- PRD R-268; glossary T-304, T-305, T-310.
