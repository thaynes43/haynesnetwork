# 2026-10-03 — LazyLibrarian bundle audit (the omnibus resolve bug)

The Google Books title resolve mapped single-volume wants to box sets and omnibus editions (DESIGN-028's omnibus
amendment; fixed by haynesnetwork #658 and Libretto #17, live as v0.105.2 and `sha-3309ff2`). Earlier the same day
the Odd Interlude #1/#2 wants were repaired by hand. This note covers the rest of LazyLibrarian.

## Method

- Scan: LL `getAllBooks` (1,016 rows) for bundle patterns in the title or subtitle (box set, collection, omnibus,
  starter pack, N-book, books N-M, trilogy, duology, quartet, a `;` contents list), keeping rows with a format
  `Wanted`. Then every `book_requests` row whose `ll_book_id` points at one, with its anchor (pairing), collection
  member ref (collection) or shelf item (goodreads). For Kavita anchors, the file the series actually holds
  (`GET /api/Series/volumes?seriesId=`), because a Kavita anchor's title is its series name.
- Rule: a want whose own title names a single work (or a different work) and that resolved to a bundle is the bug.
  It is repointed to the single-volume LL row when one exists, otherwise parked (`unroutable_reason='wrong_volume'`,
  `ll_book_id` cleared). A want whose own title names the bundle is left alone, except a recipe member that only
  duplicates single volumes the same recipe lists (parked, see below).
- Writes: a one-off node script in a haynesnetwork-main pod. One transaction per want with the precondition
  `ll_book_id = <old> AND unroutable_reason IS NULL`. Then LL `unqueueBook&type=<eBook|AudioBook>` per bundle format,
  only when its status still read the recorded old value and no unparked want still pointed at it. Dry-run first,
  then apply, then a fresh `getAllBooks` read-back. No addBook, queueBook or searchBook was sent.
- Pairing wants were written only after v0.105.2 (#660) was live. Before #660 the pairing mint re-resolved a cleared
  id and the Skipped sweep re-queued and re-searched the Skipped bundle, so a park did nothing for a pairing want.

## Repointed

| Want | Origin | Title | Old `ll_book_id` | New `ll_book_id` |
|---|---|---|---|---|
| 2fbe7042 | collection (skyward-audiobooks) | ReDawn | wnVOEAAAQBAJ (Skyward Flight. The Collection) | yo5CEAAAQBAJ (ReDawn, Skyward Flight Novella 2) |
| 82f3f5ee | pairing (Kavita file: Queen Song) | Red Queen Novella #1 | SqeBzwEACAAJ (Red Queen Book Box Set) | wV7VBgAAQBAJ (Queen Song) |

Queen Song's audiobook reads `Skipped` in LL, so the next pairing run's Skipped sweep queues and searches it. That
is the pairing want doing its job on the right book (no Queen Song audiobook is in the library).

The ReDawn collection want no longer exists: the 23:27Z collection pass found its new id already held by the
pairing want 46120a3e ("ReDawn (Skyward Flight", audio `wanted`, LL audio `Wanted`) and dropped the duplicate, as
`syncCollectionWants` does by design. ReDawn's audiobook is still wanted, once.

## Parked (`wrong_volume`, `ll_book_id` cleared)

| Want | Origin | Title (file held, for Kavita) | Old `ll_book_id` |
|---|---|---|---|
| 53585ac0 | collection (silo) | Silo Stories | txDiDwAAQBAJ (The Silo Series Collection) |
| 378b62d6 | collection (shatter-me) | Shatter Me Series: 1-5 | IxyOAwAAQBAJ (Shatter Me Starter Pack, Books 1-3 and Novellas 1 & 2) |
| 159547b2 | collection (the-dark-artifices) | The Dark Artifices, the Complete Collection | ihnjDwAAQBAJ (the same boxed set) |
| 83cfec28 | collection (the-dark-artifices-audiobooks) | The Dark Artifices, the Complete Collection | NULL (re-minted 00:28Z 2026-10-04) |
| 75393440 | pairing | The Dark Artifices (Queen of Air and Darkness, two copies) | ihnjDwAAQBAJ (the boxed set) |
| 697b279d | pairing | Red Queen Novella #2 (Red Queen.epub) | SqeBzwEACAAJ (Red Queen Book Box Set) |
| f9b63bbe | pairing | The Obelisk Gate | muR1swEACAAJ (The Broken Earth Trilogy) |
| 11f624e1 | pairing | Realm Breaker | PgIMzwEACAAJ (Realm Breaker 2-Book Hardcover Box Set) |
| 4c3d07f2 | pairing | Hogwarts Library Books (Beedle the Bard) | Xtr3yQEACAAJ (The Hogwarts Library Box Set) |
| 60b7b5ae | pairing | A Song of Ice and Fire (Fire & Blood) | PcyOEAAAQBAJ (GRRM Song of Ice and Fire Audiobook Bundle) |
| 9413a6a7 | pairing | Jack Ryan (Without Remorse, Red Rabbit) | HvWkjsRHnD4C (Jack Ryan Books 7-12) |
| a6f209b8 | pairing | Tom Clancy NF (SSN) | HvWkjsRHnD4C (Jack Ryan Books 7-12) |
| 20c30076 | pairing (ABS audiobook) | Outlander | 1t0Q0QEACAAJ (Outlander Series 8 Book Set) |
| 6fdc0809 | pairing | Percy Jackson (no files in Kavita) | BMgQ0QEACAAJ (Percy Jackson Series Set Book 1-5) |
| af5c72b3 | pairing | Glitch: A Short Story (file is Shift) | pk_VsgEACAAJ (Hugh Howey Twinpack Vol. 3) |
| 5633e9e1 | pairing | Cormac McCarthy - All the Pretty Horses, No Country for Old Men, The Road | m5wG0QEACAAJ (McCarthy 6 Books Set) |
| 328548eb | pairing | The Inheritance Cycle (Murtagh) | CyAJMAEACAAJ (The Inheritance Cycle box set) |
| 24e155f8 | pairing | The History of Middle-Earth (The Lays of Beleriand) | 2MFMAAAACAAJ (The Complete History of Middle-Earth Part 2) |
| 2fb4cec9 | pairing | Code to Zero | K3wuAAAACAAJ (Code to Zero [and] The Man from St Petersburg) |
| 4bc39f8b | pairing | Kiss Kiss | lrQBGwAACAAJ (Kiss, Kiss ; Over to You ; ... 6-in-1) |

The Shatter Me and Dark Artifices members are not resolver mistakes: the recipe lists the compilation as a member
(Shatter Me Series: 1-5 carries ISBN 9780062372703, which is the Starter Pack itself; the Complete Collection carries
its own ISBN). They are parked because each recipe also lists the single volumes: shatter-me holds 10 and lists
Shatter Me on its own, and the-dark-artifices-audiobooks already holds all three novels, so the boxed set would only
duplicate held books. This reverses the earlier same-day repair, which had repointed the Dark Artifices wants to the
boxed set's canonical row without weighing whether to want it. Libretto issue #18 asks recipes to stop listing
compilations next to their members.

Every pairing want above had its missing format `wanted` (328548eb: audio `grabbed`; 20c30076: ebook `wanted`, the
anchor is an audiobook) and keeps those statuses.

## LazyLibrarian formats set Skipped (old → new)

| BookID | Title | Format | Old | Now |
|---|---|---|---|---|
| wnVOEAAAQBAJ | Skyward Flight. The Collection | AudioBook | Wanted | Skipped (eBook stays Open) |
| txDiDwAAQBAJ | The Silo Series Collection | eBook | Wanted | Skipped |
| IxyOAwAAQBAJ | Shatter Me Starter Pack | eBook | Wanted | Skipped |
| u3AnzwEACAAJ | Red Queen 4-Book Paperback Box Set | eBook | Wanted | Skipped |
| y984LgEACAAJ | The Infernal Devices (Boxed Set) | AudioBook | Wanted | Skipped (eBook stays Open) |
| SqeBzwEACAAJ | Red Queen Book Box Set | AudioBook | Wanted | Skipped |
| muR1swEACAAJ | The Broken Earth Trilogy | AudioBook | Wanted | Skipped |
| PgIMzwEACAAJ | Realm Breaker 2-Book Hardcover Box Set | AudioBook | Wanted | Skipped (eBook stays Open) |
| Xtr3yQEACAAJ | The Hogwarts Library Box Set | AudioBook | Wanted | Skipped |
| PcyOEAAAQBAJ | GRRM Song of Ice and Fire Audiobook Bundle | AudioBook | Wanted | Skipped |
| HvWkjsRHnD4C | Tom Clancy's Jack Ryan Books 7-12 | AudioBook | Wanted | Skipped |
| BMgQ0QEACAAJ | Percy Jackson Series Set Book 1-5 | AudioBook | Wanted | Skipped |
| pk_VsgEACAAJ | Hugh Howey Twinpack Vol. 3 | AudioBook | Wanted | Skipped |
| m5wG0QEACAAJ | Cormac McCarthy 6 Books Set | AudioBook | Wanted | Skipped |
| CyAJMAEACAAJ | The Inheritance Cycle | AudioBook | Wanted | Skipped |
| 2MFMAAAACAAJ | The Complete History of Middle-Earth | AudioBook | Wanted | Skipped |
| K3wuAAAACAAJ | Code to Zero [and] The Man from St Petersburg | AudioBook | Wanted | Skipped (eBook stays Open) |
| lrQBGwAACAAJ | Kiss, Kiss ; Over to You ; ... | AudioBook | Wanted | Skipped |
| 1t0Q0QEACAAJ | Outlander Series 8 Book Set | eBook | Wanted | Skipped |
| ihnjDwAAQBAJ | The Dark Artifices, the Complete Collection | eBook + AudioBook | Wanted / Wanted | Skipped / Skipped |

The two orphans had no want pointing at them. u3AnzwEACAAJ came from a since-deleted collection want titled
"Red Queen" (the find-missing cron searched it twice a day from 2026-07-23; the want was reconciled away once Red
Queen landed). y984LgEACAAJ has no audit trail; the Infernal Devices audiobook is already held under -fHTJV9mAnEC.

## Left as is (the want's own title names the bundle)

- goodreads ce76868b "Foundation / Foundation and Empire / ... / I, Robot" → fruTHQAACAAJ The Foundation Trilogy: the
  shelf item itself is an omnibus.
- pairing anchors titled as the bundle: Dreamsongs 2-Book Bundle, His Dark Materials Omnibus, Dancers in the Dark &
  Layla Steps Up, Smythe-Smith Quartet, Dreamblood (holds both duology books), Bartleby and Benito Cereno, Revolting
  Rhymes and Dirty Beasts (two ABS items), The Pandora Sequence, The Wicked Years Complete Collection, and the ABS item
  "Red Queen 4-Book Hardcover Box Set" (14e4c4c4, ebook Wanted on Uhk6swEACAAJ).
- Not bundles despite the pattern: Moods, Four Weddings and a Sixpence, That Hideous Strength (Space Trilogy, Book 3),
  Pierre & Israel Potter → The Works of Herman Melville. Israel Potter.

Three of the left-alone anchors look mislabeled in the library itself, which a person should look at: the ABS item
"Red Queen 4-Book Hardcover Box Set" is one 6.4-hour file (not four novels); the Kavita series "The Wicked Years
Complete Collection" holds only Wicked; "The Pandora Sequence" holds a Charterhouse Dune epub. The pairing defect
behind most of the parked rows (a Kavita anchor pairs on its series name) is issue #661.
