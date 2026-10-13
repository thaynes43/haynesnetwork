# ADR-115: The household audio default for staff

- **Status:** Accepted (owner ruling on issue #955, 2026-10-13: "English if present")
- **Date:** 2026-10-13
- **Deciders:** Tom Haynes. Drafted by Opus 5.5.
- **Amends:** [ADR-109](109-self-service-media-repair.md) C-07 (the Plex audio-language write only for the title's
  original language) and C-02 (the write-back list), for writes staff make themselves. A person's own Wrong language
  report keeps C-07 unchanged. ADR-109's other consequences stand.
- **Design:** [DESIGN-055](../designs/055-self-service-media-repair.md) D-08, P6 decisions 11 and 14, and the Q-03 row's
  amendment. Plan: PLAN-077 P6.

## Context and problem statement

ADR-109 C-07, from the owner's Q-03 ruling, lets the app set a show's preferred audio language in Plex for everyone,
but only to the show's original language, and only when a person's file already has it.

PLAN-077 P6's staff audit (`repair-guide.ts audio-scan`, 2026-10-13) read every Sonarr series and found 181 shows whose
files carry the original language behind another one.

- 144 of them are English originals. Staff set them to English, which is also their original language, so C-07
  covers them.
- 13 have another original language, and their files start in a third language or in an English dub. For an account
  with no language preference, Dragon Ball plays German, JUJUTSU KAISEN S2 plays Portuguese, and Alpha Males plays
  French.

Under C-07 alone, the only staff fix for these 13 would be the original language. That would also switch the English
dubs that an English-speaking household may want (Boruto, One Piece).

## Decision drivers

- Fix what the audit flags: a default track that is neither the original language nor the household's language.
- Keep English dubs working for an English-speaking household.
- Leave a person's own report as the owner ruled for Q-03.

## Considered options

The options are the ones listed on issue #955.

- **A.** Leave the 13 shows as they are.
- **B.** Set the original language on all 13.
- **C.** Set the original language only where the default is neither the original nor English.
- **D.** English wherever a file has an English track, else the original language.

## Decision outcome

Chosen option: **D**, the owner's ruling on #955 (2026-10-13): **"English if present."**

The ruling covers the shows the staff audit flags, the ones whose files start in a language other than their original
one. A show whose files already start in its original language is not flagged, and staff leave it as it is.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **The household default.** For a show the staff audit flags, staff set its preferred audio language as follows. English goes where the show's files carry an English track, dubs included. The original language goes where no file carries English. The setting applies on every Plex server that carries the show, and every server is read back. |
| C-02 | **No-op.** A show is left alone when every file carrying the chosen language already starts in it, and no server stores a different language. Boruto is the example: all 291 of its files start in English. |
| C-03 | **Staff only.** The single writer takes the rule as `rule: 'household'` and refuses it for any request with a requester. A person's Wrong language report keeps ADR-109 C-07: the original language only. The Repair Request records the rule. |
| C-04 | **The tools.** `repair-guide.ts audio-scan --apply-household` works through the audit's findings. `audio-preference --household` previews or sets one show. Both go through the same audited writer and `@hnet/plex/write` from `packages/domain`. |
| C-05 | **Hard rule 4** names the household default beside the Q-03 write. |
| C-06 | Good: every flagged show starts in a language the household speaks, or in its original, and English dubs keep working. |
| C-07 | Bad: an account that prefers the original language gets English on these shows, unless that person picks a track. Accepted: Plex remembers a track a person picks, and the account's own audio setting still applies on every show staff did not flag. |

## More information

- Builds on ADR-109 C-07 (the Q-03 write), ADR-017 (the confined Plex write surface) and DESIGN-055 P6 decision 11 (the
  staff scan).
- Glossary T-323 (Audio Preference), T-326 (Household Default).
