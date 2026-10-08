# Issue 825: preserved coverage gaps, 2026-10-08

Read-only full inventory verified 1,956 EPUBs and 4,730 other file fingerprints. The post-force Kavita mapping
covers 1,949 EPUBs. These seven paths were absent in the original pre-full snapshot at 04:44Z, the pre-collision
snapshot at 15:11Z, the pre-force snapshot at 16:28Z and the post-force snapshot at 16:38Z. They are preserved
engineering gaps, not evidence that the series strip removed files. All 13 nonunique mappings also predate
the collision stage and force. Never report complete unique coverage or acquire replacements from that gap.

The actual force request was accepted at 16:32:57Z and the server committed at 16:36:01Z. All 48 reading rows,
eight saved-lock tables and 27 curated tables survived unchanged. Its final notification reader failed, so a
future conclusive notification check must preserve that limitation. Normal scanning removed two wrong-author
items from owned Libretto list 26; a physical Cassandra Clare correction remains pending.

All paths below are relative to EBooks. The whole-file SHA binds each existing file. Creator/title text is
reported only when present in the raw OPF; names in a filename do not supply missing metadata.

- Path: `C.S. Lewis/The Great Divorce/The Great Divorce - C.S. Lewis.epub`
  SHA-256: `c7338d93a686d3c3c1b0a9c6bc68e1a6014c67cf8936ac647e219f248635b39e`.
  Raw OPF title: The Great Divorce. Raw creator: C. S. Lewis.

- Path: `J.R.R. Tolkien/The Adventures of Tom Bombadil/J.R.R. Tolkien - The Adventures of Tom Bombadil.epub`
  SHA-256: `4abdac36ddfbf8d9a584f3f4b85fd1cd5415f371509090b8a95698668b7f602b`.
  Raw OPF title: The Adventures of Tom Bombadil. Raw creator: J. R. R. Tolkien.

- Path: `Jane Mayer/Dark Money/Jane Mayer - Dark Money.epub`
  SHA-256: `7e42dc252acd5ae5d5802987be08b0cae20ad4eb5f8eedae3b844a451e2d85f8`.
  Raw OPF title: Dark Money. Raw creator: Jane Mayer.

- Path: `Martha Wells/Exit Strategy/Martha Wells - Exit Strategy.epub`
  SHA-256: `449fb3031979d8c03d4561644f32ab4f69dac47bf6c964d066df92067b97da15`.
  Raw OPF title: Exit Strategy. Raw creator: Martha Wells.

- Path: `Orson Scott Card/The Call of Earth/The Call of Earth - Orson Scott Card.epub`
  SHA-256: `9060135f0482aba92d877c866bde7d8b4c393c79fd880c4c0783eee57488fe25`.
  Raw OPF title: The Call of Earth. Raw creator: Orson Scott Card.

- Path: `Philip Pullman/Lyra's Oxford/Philip Pullman - Lyra's Oxford.epub`
  SHA-256: `c0ceb2e1cbc8c979a103c0300b20bb16b7d2665ad8c635c90470fcc6d52a177c`.
  Raw OPF title: Lyra's Oxford. Raw creator: Philip Pullman.

- Path: `Ursula K. Le Guin/Buffalo Gals and Other Animal Presences/Ursula K. Le Guin - Buffalo Gals and Other Animal Presences.epub`
  SHA-256: `75f5056b1b4217d85038c6fb71874196b59a4c71447dd909bcbf40f060b6dd84`.
  Raw OPF title: absent. Raw creator: absent.

No matching current MediaError row establishes the parser cause. Investigation should reread these exact
ZIP/OPF records and fresh Kavita mappings, then use bounded read-only parser/log evidence. Do not infer a
work from filenames, change non-series EPUB metadata, supply recipe membership or use acquisition to
bridge the gap. Duplicate-copy consolidation must retain every dependency and reading protection.

Retained evidence: `/home/dev/work/hn-825b-seven-unmapped-cold-context.json`, the four timestamped database
snapshots, and `/home/dev/work/hn-825b-current16-retention-readonly-1703.jsonl` with SHA-256
`f597a48912b39cd51664214f61bd7498be93b462e1a5b7de9a63299d317bd078`. Recompute current file and
reading-state proofs before any later action. This record supplies cold-start context if pod artifacts disappear.

The 13 preserved nonunique path mappings are:

- `Brandon Sanderson/Alcatraz Vs. the Evil Librarians/Alcatraz Vs. the Evil Librarians - Brandon Sanderson.epub`
- `Brandon Sanderson/Wind and Truth/Wind and Truth - Brandon Sanderson.epub`
- `Cassandra Clare/Tales from the Shadowhunter Academy/Tales from the Shadowhunter Academy - Cassandra Clare.epub`
- `Christopher Paolini/Inheritance/Inheritance - Christopher Paolini.epub`
- `Dean Koontz/Dead and Alive (Dean Koontzs Frankenstein Book 3)/Dead and Alive (Dean Koontzs Frankenstein Book 3) - Dean Koontz.epub`
- `George R.R. Martin/Wild Cards I/Wild Cards I - George R.R. Martin.epub`
- `Homer/The Odyssey/The Odyssey - Homer.epub`
- `Sarah J. Maas/A Court of Thorns and Roses/A Court of Thorns and Roses - Sarah J. Maas.epub`
- `Sarah J. Maas/Throne of Glass/Throne of Glass - Sarah J. Maas.epub`
- `Stephenie Meyer/Twilight/Twilight - Stephenie Meyer.epub`
- `Tahereh Mafi/This Woven Kingdom/This Woven Kingdom - Tahereh Mafi.epub`
- `Terry Pratchett/The Witchs Vacuum Cleaner And Other Stories/The Witchs Vacuum Cleaner And Other Stories - Terry Pratchett.epub`
- `Walter Mosley/The Tempest Tales/The Tempest Tales - Walter Mosley.epub`
