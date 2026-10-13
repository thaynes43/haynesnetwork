# ADR-113: Mislabelled-name terms in the Mislabel Block

- **Status:** Accepted (owner ruling on DESIGN-055 Q-10, 2026-10-13: option A)
- **Date:** 2026-10-13
- **Deciders:** Tom Haynes. Drafted by Opus 5.5.
- **Amends:** [ADR-110](110-episode-title-evidence-guards-grabs-and-imports.md) C-04 (the Mislabel Block holds
  series-and-group terms only, written only from a confirmed re-map) and C-05 (the adoption of Case A's hand-made
  profile); hard rule 4's write-back list (C-07 here). ADR-110's other consequences stand.
- **Design:** [DESIGN-055](../designs/055-self-service-media-repair.md) D-05, P4 decision 14, Q-10 and its "Q-10 ruling
  decisions". Plan: PLAN-077 P4.

## Context and problem statement

ADR-110 C-04 made the Mislabel Block one app-owned Sonarr release profile whose terms each pair one series title with
one release group. Case A's hand-made profile (Sonarr release profile 3, "Regular Show: The Lost Tapes: block
off-by-one numbered postings", tag 31 `lost-tapes-release-block`, used only by series 1061) holds six terms. One is a
group term (`DUAL BiOMA`), adopted in PLAN-077 P4 as the Mislabel Block's first term. The other five block release
NAMES that file the series wrong whoever posts them:

- the German title, `verlorenen Videos` (Sonarr lists "Regular Show Die verlorenen Videos" as an alternate title of the
  series; a live grab was `Regular.Show.Die.verlorenen.Videos.S01E11.GERMAN.DL.1080P.WEB.H264-WAYNE`);
- a double-episode token, `S01E13E14`;
- three number-and-title pairs, `S01E11 Secret Menu`, `S01E13 Smoke Alarm` and `S01E24 All You Can Fit`, each a number
  with another episode's title.

A group term cannot hold them, so the hand profile could not be retired. The hand terms are also tag-scoped and carry
no series anchor; the Mislabel Block's profile has no tags, so a term there must name the series by its own text.

## Decision drivers

- Retire the hand-made profile and its tag without dropping the five blocks.
- One managed profile, one single writer, one grammar check before every write: a term .NET cannot compile stops
  every grab on that Sonarr (ADR-093 C-19).
- A term must never block the right release of its series, or another series.
- Nothing automatic: the evidence for a mislabelled name is a person's judgment.

## Considered options

1. **A second term kind, the mislabelled name**, series-anchored, written by staff and the adoption through the same
   single writer; then the hand profile is deleted.
2. **Keep the hand profile** as a hand-kept exception beside the Mislabel Block.
3. **Drop the five blocks** (the season is complete) and delete the hand profile.

## Decision outcome

Chosen option: **1**, the owner's ruling on DESIGN-055 Q-10 (2026-10-13), because it keeps the five blocks under the
same checks, lifetime and audit as every other Mislabel term, and it leaves no hand-kept profile beside the managed one.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Three mislabelled-name kinds** join the group term, each built only from the DESIGN-052 D-12 whitelist grammar (the exact form's words with their apostrophes, accented letters and `&`; separators `[^a-z0-9]`; boundaries `(?<![a-z0-9])` and `(?![a-z0-9])`) and checked by a strict template validator that also compiles the term. **Pair** (`S01E11 Secret Menu`): `/^(?=.*(?<![a-z0-9]){series words}(?![a-z0-9]))(?=.*(?<![a-z0-9])s0*{S}e0*{E}[^a-z0-9]*{title words}(?![a-z0-9]))/i`. **Double** (`S01E13E14`): the series lookahead, then `(?=.*(?<![a-z0-9])s0*{S}e0*{E}[^a-z0-9]*e0*{F}(?![a-z0-9]))` with F after E. **Alias** (an alternate title): `/^(?=.*(?<![a-z0-9]){alias words}(?![a-z0-9]))/i`, allowed only for a title Sonarr lists in the series' `alternateTitles` that differs, folded, from the series' own title. |
| C-02 | **A term must not block what it should not.** Before any write it must match the mislabelled name in a release title of the series, raw and dotted; match no ordinary release name of the series (a pair's words under a neighbouring episode or season, an ordinary tag in place of its words, a double's two episodes alone or the doubles beside it, and for an alias any release under the series' own title); for a pair, match no release that gives its number the title Sonarr has for it; and match no release of another library series. |
| C-03 | **Writers.** Staff, with the in-cluster tool (`mislabel-block.ts add-name`, origin `staff`), and the adoption of a hand-made block (`mislabel-block.ts adopt` with a name, origin `adoption`). No person is offered a name term; a confirmed re-map still offers only its group (ADR-110 C-04, D-04 rule 10). The database ties each kind to its origins: a group term comes from a re-map or the adoption, a name term from staff or the adoption. |
| C-04 | **Same profile, same rules.** Name terms live in the one "haynesnetwork: mislabelled releases (managed, do not edit)" profile, through the same single writer and lock, with ADR-110 C-04's 365-day life and 500-term cap (one count across both kinds), the write and read-back before the answer, a `removed` row for a write that was sent but not confirmed, the hourly upkeep (expiry, drift repair), and ADR-110 C-08's audited staff removal. |
| C-05 | **Storage.** `mislabel_block_terms` gains `kind` (`group`, `pair`, `double`, `alias`) and `name_token` (the display text); `release_group` is set for a group term only. One live term per (series, kind, group or name), case-insensitive. |
| C-06 | **The hand profile is retired by hand** (ADR-110 C-05's pattern): the five names are adopted with the tool and the managed profile read back, then staff delete profile 3, remove tag 31 from series 1061, delete tag 31, and read back each step. The app builds no writer that deletes a Sonarr profile or tag. |
| C-07 | **Hard rule 4** gains one sentence: the Mislabel Block also holds ADR-113 mislabelled-name terms, written only by staff and the adoption through the same single writer. |
| C-08 | Good: one managed profile holds every Mislabel block, all under one grammar check, one lifetime and one audit trail, and the hand profile's tag scoping is no longer needed. |
| C-09 | Bad: an alias blocks every release posted under that title, including correct ones, and a pair blocks its title words under that number from every group. Accepted: staff choose each name from evidence, the checks in C-02 refuse names that ordinary releases carry, a term ends after a year, and staff can remove one at any time. |

## More information

- Builds on ADR-110 (the Mislabel Block), ADR-093 C-19 and DESIGN-052 D-12 (the term grammar and compile check),
  ADR-094 (the janitor's whole-name term, a separate grammar).
- Glossary T-310 (Mislabel Block), T-318 (Mislabelled-Name Term).
