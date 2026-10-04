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

## Repair

Planned: after the deploy and the first books-sync backfill, clear `unroutable_reason` on the five one-book
wants and on Jack Ryan (one transaction per want, precondition `unroutable_reason = 'wrong_volume' AND
ll_book_id IS NULL`). The next `format-pairing` pass re-resolves the five by their held book (the lifted-park
reset pushes them) and re-parks Jack Ryan as `multi_book`. The Dark Artifices want stays parked: its anchor
pairs, so it is never a candidate.
