# 2026-10-04 — pairing anchors on the held book (issue #661): measurements and repair

Issue #661: `format-pairing` keyed a Kavita anchor on its `books_items.title`, which is the Kavita SERIES name,
so a one-book series resolved its want to a box set and paired with an audiobook named like the series. Fix:
DESIGN-024 D-03 + DESIGN-036 amendments of this date (the books-sync mirrors each series' held books in
`attrs.heldBooks`; `pairingIdentity` makes the anchor the one book it holds). The same change stops the D-04
re-vanish from resetting every unpaired landed want each run.

## Measured before merge (live mirror, 2026-10-04 ~01:00Z)

- `GET /api/Series/volumes` for all 1,691 live Kavita book series: 1,590 hold one chapter, 101 hold several
  (2 to 8 chapters). With two copies of one book counted once, 1,655 are one book and 36 are several.
- Matcher, old key vs held book: 628 pairs become 659. 36 added (all checked by eye, for example Bobiverse with
  Heaven's River, Heroes of Olympus with The House of Hades, The Dark Artifices with Queen of Air and Darkness),
  5 dropped (Dune holding Heretics of Dune, Twilight holding Breaking Dawn, The Hitchhiker's Guide holding
  Mostly Harmless, Wool holding First Shift - Legacy, Ghosts of the Shadow Market holding the box-set epub),
  2 moved to the right audiobook (Destination: Void to The Jesus Incident, The Pillars of the Earth to The
  Evening and the Morning).
- The 00:32Z `format-pairing` run: `revived 312`, `attempted 100`, `skippedHeld 118`, `pushed 0`, `minted 0`.
  The re-vanish was resetting every unpaired anchor whose want LazyLibrarian already holds, and the mint spent
  its cap re-skipping them.

## The parked wants this defect caused

From the bundle audit's parked list, the Kavita pairing anchors whose series name is not the book they hold:

| Want | Series (anchor title) | Held book (new identity) |
|---|---|---|
| 60b7b5ae | A Song of Ice and Fire | Fire & Blood (ISBN 9781524796280) |
| 4c3d07f2 | Hogwarts Library Books | The Tales of Beedle the Bard |
| 328548eb | The Inheritance Cycle | Murtagh (author from the book: Christopher Paolini) |
| 24e155f8 | The History of Middle-Earth | The Lays of Beleriand (ISBN 9780261102057) |
| a6f209b8 | Tom Clancy NF | SSN (ISBN 9780425173534) |
| 9413a6a7 | Jack Ryan | two books (Without Remorse, Red Rabbit): `multi_book` |
| 75393440 | The Dark Artifices | Queen of Air and Darkness, which ABS already holds: the anchor now pairs |

Not caused by this defect, left parked: the specials whose Kavita title is the book's own (The Obelisk Gate,
Realm Breaker, Code to Zero, Kiss Kiss, Glitch [a Shift file], Red Queen Novella #2 [a Red Queen file], the
Cormac McCarthy compilation), the ABS anchor Outlander, Percy Jackson (no live Kavita row), and the collection
wants (Libretto #18).

## Deploy

v0.105.3 (haynesnetwork #664, release #663) by haynes-ops #3340: 3/3 pods on v0.105.3, `/api/health` ok. A manual
books-sync job right after the roll (`hnet-books-heldbooks-661`, 01:43Z) read all 1,691 Kavita book series in about
12 s with no failure (`kavitaHeldRead 1691`); the 02:22Z scheduled run read none (`kavitaHeldRead 0`, carried
forward, authorless rows included).

First `format-pairing` run on the new code, 02:32Z: `paired 656, added 41, dropped 7, revived 4` (was 312),
`attempted 29, minted 20, pushed 11` (was 0 pushed), `skippedBudget 275` (the pairing GB budget was spent for the
quota day), `skippedUnknownHeld 0, skippedNotOneBook 1, parked 3` (Jack Ryan, Dollenganger, W.A.R.P., all
`multi_book`). The 20 new wants name held books (Mostly harmless, Heretics Of Dune, Whipping Star, Dawn, ...).

## Repair, part 1: the parked wants this defect caused (01:44Z)

`unroutable_reason` cleared on the five one-book wants and Jack Ryan, one transaction per want with the precondition
`unroutable_reason = 'wrong_volume' AND ll_book_id IS NULL` (all six held; `updated_at` left as it was so they sort
ahead in the retry order). No LazyLibrarian write. Result at the 02:32Z pass:

| Want | Now |
|---|---|
| 60b7b5ae | `Fire & Blood`, tiY6EAAAQBAJ (LL: Fire & Blood, GRRM, audiobook Open since 2026-09-22): `landed` |
| a6f209b8 | `SSN`, 6ctWgx2fxXUC (LL: SSN, Tom Clancy, audiobook Open since 2026-09-22): `landed` |
| 9413a6a7 | re-parked `multi_book` by the mint, as designed |
| 4c3d07f2, 328548eb, 24e155f8 | not attempted yet (`skippedBudget`): Beedle the Bard, Murtagh, The Lays of Beleriand need a Google Books resolve |
| 75393440 | left parked: its anchor now pairs with the ABS Queen of Air and Darkness, so it is never a candidate |

Both resolved by reuse (no Google Books call), and LazyLibrarian already held both audiobooks.

## Repair, part 2: pushed wants pointed at an audiobook the anchor does not hold (01:52Z)

A read-only audit of open pushed pairing wants on Kavita anchors found 20 whose LL book differs from their identity
once LL's title is known. Most are cosmetic (the LL book IS the held book, only the title snapshot carries a series
suffix) or already Skipped in LL. Six were wrong and still `Wanted` in LL. Same method as the bundle audit: park
(precondition `ll_book_id = <old> AND unroutable_reason IS NULL`, id cleared), then set the LL audiobook Skipped only
when it still read Wanted and no unparked request pointed at it.

| Want | Anchor (holds) | LL book it wanted | Park | LL audiobook |
|---|---|---|---|---|
| 9c9772ff | Bevelstoke (Miranda Cheever, What Happens in London) | Secretos en Londres (the Spanish edition) | `multi_book` | Wanted → **Skipped** |
| ea891a56 | Discworld (Eric, Science of Discworld III) | The Color of Magic | `multi_book` | kept Wanted: the "Discworld (Rincewind Series)" want uses it |
| 6367e171 | The Discworld (Guards! Guards!, Men at Arms, Shepherd's Crown) | The Color of Magic | `multi_book` | as above |
| f9255a45 | Odd Thomas (two graphic novels) | the short story You Are Destined to Be Together Forever | `multi_book` | kept Wanted: two wants anchored on that story use it |
| fb242aca | The Trials of Apollo (Dark Prophecy, Burning Maze) | Camp Jupiter Classified | `multi_book` | kept Wanted: the Camp Jupiter Classified want uses it |
| fc2e3184 | Heroes of Olympus (The House of Hades) | The Mark of Athena | `wrong_volume` | kept Wanted: The Heroes of Olympus want holds Mark of Athena |

Left alone: multi-book wants whose LL book is one the series holds (The Heroes of Olympus → Mark of Athena,
Underland Chronicles → Gregor and the Prophecy of Bane), the two bundles the bundle audit left (Smythe-Smith
Quartet, The Dreamblood Duology), and Infinity Blade (LL "Infinity Blade" may be the held Awakening).

## Found on the way, filed

Most open requests point at LazyLibrarian ids its `getAllBooks` (1,016 rows) does not return: pairing 748 of 966,
collection 103 of 203, goodreads 51 of 56. Their reconciles skip them, so they never settle. haynesnetwork #665.

## Owed

The three wants waiting on Google Books (4c3d07f2 Beedle the Bard, 328548eb Murtagh, 24e155f8 The Lays of Beleriand)
resolve on the first `format-pairing` pass after the quota day rolls (about 07:00Z, so the 07:32Z run or the next
one with budget). Check each reads its held title and an `ll_book_id` whose LL title is that single book, not a box
set (the Hogwarts Library box set Xtr3yQEACAAJ, The Inheritance Cycle box set CyAJMAEACAAJ, The Complete History of
Middle-Earth 2MFMAAAACAAJ). See HANDOFF (2026-10-04) for the query.
