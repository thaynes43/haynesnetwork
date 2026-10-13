# Ben 10 and Mickey wrong-content copies: durable evidence

Recorded 2026-10-13T23:17:40.374332+00:00. PLAN-077 step 4. This records read-only evidence and proposed release choices; no replacement has run and the driver must approve the choices before any media write.

Current Sonarr fingerprints were read at 2026-10-13T23:15:51.758Z with the typed read client: both Ben 10 source files, all 25 Mickey source files and all 25 Mickey destination references match the retained IDs, relative names and byte sizes. Source and destination episode links also match. The source and destination sizes differ in every Mickey pair. These are API fingerprints, not freshly computed whole-file hashes. Content proof below comes from the earlier independent frame/title-card or subtitle evidence; an unchanged filename alone is not content proof.

The fresh v0.125.0 read-only Jobs were `p077-ben10-replace-plan-10132312` (23:11:36–23:12:07Z) and `p077-mickey-replace-plan-10132312` (23:12:23–23:13:08Z). Both succeeded, with CPU limit 500m, nice 19, backoff 0, deadline 7200 seconds and TTL 86400 seconds. They only planned; every source still exists. Plans must be rechecked by the domain writer immediately before a mutation.

## Ben 10 (2016), TVDB 318145, Sonarr series 99

Fresh absence verification 2026-10-13T23:16:20.956Z to 2026-10-13T23:16:22.957Z: Sonarr listed 1070 series and none had TVDB 79567. All TV-type Plex sections were paged to completion with includeGuids=1, checking both external TVDB GUIDs and the legacy TVDB agent GUID. No original-show match appeared:

| Server | TV section | Shows read | Listing complete | Original TVDB 79567 |
|---|---|---|---|---|
| haynestower | 2 — HNet TV Shows | 972 | yes | absent |
| haynesops | 2 — HOps TV Shows | 973 | yes | absent |
| hayneskube | 4 — HOps Peloton | 12 | yes | absent |
| hayneskube | 3 — HOps YT | 72 | yes | absent |

The only Ben 10 titles were the 2016 reboot, TVDB 318145, on HaynesTower (rating key 547444) and HaynesOps (100817); neither HaynesKube TV section listed a Ben 10 title. Thus no existing 2005-show destination is available in this fresh inventory. The mandatory Watch Carry still takes each account’s fresh state snapshot and audits any dropped mark. Repeat the absence check if this step is delayed or the inventory changes; an unexpected original copy holds the step for the driver.

Both source files conclusively show the classic 2005 show rather than the 2016 target story. The historical original-story identification is weaker than the wrong-show finding: the E10 scene was described as likely Lucky Girl; the E12 Ghostfreak scene matches Side Effects in the prepared mapping. Do not infer correctness merely because Sonarr approves a release or its year/episode number matches. Reject the wrong-show playWEB Lucky Girl and Side Effects releases.

### S01E10 — Animo Farm

- Sonarr episode 8507; wrong file 65865; 878290127 bytes.
- Relative name: `Season 1/Ben 10 (2016) - S01E10 - Animo Farm [WEBDL-1080p][AAC 2.0][h264].mp4`.
- Independent frame proof: Classic 2005 art and intro; Hex in a museum, Gwen with a charm (original evidence: likely Lucky Girl).
- Prepared original content identity: Ben 10 (2005), Lucky Girl.
- No sameAs destination is proposed. Before any replacement, freshly verify TVDB 79567 is absent from Sonarr and all configured Plex TV libraries. If a correct copy appears, hold this replacement for the driver; do not silently drop its marks.
- If absence is confirmed, the mandatory fresh Watch Carry snapshot determines any audited drop. A mark on this wrong content never credits the newly downloaded 2016 slot.

### S01E12 — Adventures in Babysitting

- Sonarr episode 8509; wrong file 65707; 821140777 bytes.
- Relative name: `Season 1/Ben 10 (2016) - S01E12 - Adventures in Babysitting [WEBDL-1080p][AAC 2.0][h264].mp4`.
- Independent frame proof: Classic 2005 art and intro; Ghostfreak in a hooded coat at a construction site (prepared mapping: Side Effects).
- Prepared original content identity: Ben 10 (2005), Side Effects.
- No sameAs destination is proposed. Before any replacement, freshly verify TVDB 79567 is absent from Sonarr and all configured Plex TV libraries. If a correct copy appears, hold this replacement for the driver; do not silently drop its marks.
- If absence is confirmed, the mandatory fresh Watch Carry snapshot determines any audited drop. A mark on this wrong content never credits the newly downloaded 2016 slot.

## Mickey Mouse: Mixed-Up Adventures, TVDB 320725, Sonarr series 439

The first pass has 23 slots and 25 physical files: 1, 3, 5, 7, 9, 11, 17, 19, 21, 23, 25, 29, 31, 33+34, 35+36, 37, 39, 41, 43, 45, 47, 49 and 51. Each source below contains season 3 stories whose existing destination was independently identified. Carry watch state to those existing correct copies through the audited domain writer; never credit the new season 1 replacement. Every mapping is prefixed by its original source episode so a multi-file slot cannot cross-credit accounts or source marks.

Special exact mappings:

- Slot 33+34: `33:S03E65,33:S03E66,34:S03E67,34:S03E68`.
- Slot 35+36: `35:S03E69,35:S03E70,36:S03E71,36:S03E72`.

### Source S01E01-02 → S3E01-02

- Source episodes: S01E01 (episode 37181), S01E02 (episode 37182).
- Wrong source file 24797; 1561495093 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E01-02 - Mickeys Wild Tire! and Sittin Kitty [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: CHIP AND DALE "Mickey's Mixed-Up Motor Lab."; MINNIE "Wishy Washy Helpers."
- Destination episodes: S03E01 (episode 37283), S03E02 (episode 37284).
- Existing correct destination file 65370; 1510896273 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E01-02 - Mickeys Mixed-Up Motor Lab and Wishy Washy Helpers [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles spoken
- Exact sameAs arguments: `1:S03E01,1:S03E02`.

### Source S01E03-04 → S3E03-04

- Source episodes: S01E03 (episode 37183), S01E04 (episode 37184).
- Wrong source file 24800; 1565636010 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E03-04 - Goofy Gas! and Little Big Ape [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: "One Unicorny Day."; "The Happy Horse Helpers."
- Destination episodes: S03E03 (episode 37285), S03E04 (episode 37286).
- Existing correct destination file 65371; 1451586910 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E03-04 - One Unicorny Day! and The Happy Horse Helpers! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `3:S03E03,3:S03E04`.

### Source S01E05-06 → S3E05-06

- Source episodes: S01E05 (episode 37185), S01E06 (episode 37186).
- Wrong source file 24803; 1565650412 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E05-06 - Race for the Rigatoni Ribbon! and Roaming Around Rome [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: "Animal Antics."; "Here, Kitty, Kitty, Kitty."
- Destination episodes: S03E05 (episode 37287), S03E06 (episode 37288).
- Existing correct destination file 65381; 1516728809 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E05-06 - Animal Antics and Here Kitty Kitty Kitty! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `5:S03E05,5:S03E06`.

### Source S01E07-08 → S3E07-08

- Source episodes: S01E07 (episode 37187), S01E08 (episode 37188).
- Wrong source file 24806; 1560855497 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E07-08 - Agent Double-O-Goof and Egg-xasperating! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: "Mickey's Monstrous Truck."; "Minnie's Vacation Home."
- Destination episodes: S03E07 (episode 37289), S03E08 (episode 37290).
- Existing correct destination file 65380; 1561109038 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E07-08 - Mickeys Monstrous Truck and Minnies Vacation Home! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `7:S03E07,7:S03E08`.

### Source S01E09-10 → S3E09-10

- Source episodes: S01E09 (episode 37189), S01E10 (episode 37190).
- Wrong source file 24809; 1567982759 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E09-10 - Mickeys Perfecto Day! and Running of the Roadsters! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: "Mixed Up For a Day"; "Princess Clarabelle."
- Destination episodes: S03E09 (episode 37291), S03E10 (episode 37292).
- Existing correct destination file 65382; 1507866492 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E09-10 - Mixed-Up for a Day! and Princess Clarabelle! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `9:S03E09,9:S03E10`.

### Source S01E11-12 → S3E11-12

- Source episodes: S01E11 (episode 37191), S01E12 (episode 37192).
- Wrong source file 24812; 1561194085 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E11-12 - Its Wiki Wiki Time! and Happy Hula Helpers! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: "A Gollywood Wedding."; "No Dilly Dally in New Delhi."
- Destination episodes: S03E11 (episode 37293), S03E12 (episode 37294).
- Existing correct destination file 65383; 1627022303 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E11-12 - A Gollywood Wedding! and No Dilly Dally in New Delhi! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `11:S03E11,11:S03E12`.

### Source S01E17-18 → S3E17-18

- Source episodes: S01E17 (episode 37197), S01E18 (episode 37198).
- Wrong source file 24821; 1557618695 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E17-18 - Guru Goofy and Bed Breakfast and Bungled! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: "Where's Mickey?"; "Cuckoo in Hot Dog Hills."
- Destination episodes: S03E17 (episode 37299), S03E18 (episode 37300).
- Existing correct destination file 65389; 1437619449 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E17-18 - Wheres Mickey and Cuckoo in Hot Dog Hills! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `17:S03E17,17:S03E18`.

### Source S01E19-20 → S3E19-20

- Source episodes: S01E19 (episode 37199), S01E20 (episode 37200).
- Wrong source file 24824; 1562857990 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E19-20 - Going Upppppppppp! and Gone Fishin'! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Minnie] "Campy Camper Day!"; [Clarabelle] "Founder's Day Flounder!"
- Destination episodes: S03E19 (episode 37301), S03E20 (episode 37302).
- Existing correct destination file 65388; 1530034612 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E19-20 - Campy Camper Day! and Founders Day Flounder! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `19:S03E19,19:S03E20`.

### Source S01E21-22 → S3E21-22

- Source episodes: S01E21 (episode 37201), S01E22 (episode 37202).
- Wrong source file 24827; 1562115388 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E21-22 - Goof Luck Charm and Teed Off! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: "Goofasaur."; "Teahouse Helpers."
- Destination episodes: S03E21 (episode 37303), S03E22 (episode 37304).
- Existing correct destination file 65390; 1503086169 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E21-22 - Goofasaur! and Teahouse Helpers [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `21:S03E21,21:S03E22`.

### Source S01E23-24 → S3E23-24

- Source episodes: S01E23 (episode 37203), S01E24 (episode 37204).
- Wrong source file 24830; 1561636030 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E23-24 - The Impossible Race and The Happiest Helpers Cruise! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Minnie] "Papa Pluto."; [Minnie] "Happy Valentine Helpers."
- Destination episodes: S03E23 (episode 37305), S03E24 (episode 37306).
- Existing correct destination file 65391; 1505299061 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E23-24 - Papa Pluto and Happy Valentine Helpers [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `23:S03E23,23:S03E24`.

### Source S01E25-26 → S3E25-26

- Source episodes: S01E25 (episode 37205), S01E26 (episode 37206).
- Wrong source file 24833; 1567232163 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E25-26 - Smarty Goof and Adventures in Buddysitting! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: "Petey O'Pete." (St. Patrick's Day); [Daisy] "Daisy Does It."
- Destination episodes: S03E25 (episode 37307), S03E26 (episode 37308).
- Existing correct destination file 65392; 1582627683 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E25-26 - Petey O'Pete and Daisy Does It! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `25:S03E25,25:S03E26`.

### Source S01E29-30 → S3E29-30

- Source episodes: S01E29 (episode 37209), S01E30 (episode 37210).
- Wrong source file 24839; 1558530741 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E29-30 - Stop That Heist! and Lights! Camera! Help! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: story 1 title not spoken; opens with Goofy singing "Old McMickey had a farm", "I'm opening a community farm", ends "This farm is a hit!" (S3E29 overview: renovate a rundown farm); [Minnie] "Happy Lab Helpers."
- Destination episodes: S03E29 (episode 37311), S03E30 (episode 37312).
- Existing correct destination file 65397; 1429177655 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E29-30 - Old McMickey Had a Farm and Happy Lab Helpers [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: "Happy Lab Helpers." spoken; same farm opening lines
- Exact sameAs arguments: `29:S03E29,29:S03E30`.

### Source S01E31-32 → S3E31-32

- Source episodes: S01E31 (episode 37211), S01E32 (episode 37212).
- Wrong source file 24842; 1557496741 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E31-32 - Mouse Vs. Machine! and Grandpa Beagles Day Out [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Mickey] "Hard Hat Diggity Dog."; [Daisy] "Hair-Raising Helpers."
- Destination episodes: S03E31 (episode 37313), S03E32 (episode 37314).
- Existing correct destination file 65396; 1477035114 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E31-32 - Hard Hat Diggity Dog! and Hair-Raising Helpers! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `31:S03E31,31:S03E32`.

### Source S01E33 → S3E65-66 (two stories on a one-slot file)

- Source episodes: S01E33 (episode 37213).
- Wrong source file 24845; 1200179824 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E33 - Donalds Garage [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Goofy] "It's a Hap-Hap-Happy Hot Dog Hills!"; [Minnie & Daisy] "Happy Friend-iversary!"
- Destination episodes: S03E65 (episode 37347), S03E66 (episode 37348).
- Existing correct destination file 65418; 1386559074 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E65-66 - Its a Hap-Hap-Happy Hot Dog Hills! and Happy Friend-iversary! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `33:S03E65,33:S03E66`.

### Source S01E34 → S3E67-68

- Source episodes: S01E34 (episode 37214).
- Wrong source file 24848; 719888906 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E34 - Artful Helpers [WEBDL-720p][AAC 2.0][h264]-DKiDS.mkv`.
- Source story evidence: [Minnie] "Crooner Mickey."; [Minnie] "Once Upon A Lemonade Stand."
- Destination episodes: S03E67 (episode 37349), S03E68 (episode 37350).
- Existing correct destination file 65425; 1463147488 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E67-68 - Crooner Mickey and Once Upon a Lemonade Stand [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `34:S03E67,34:S03E68`.

### Source S01E35 → S3E69-70

- Source episodes: S01E35 (episode 37215).
- Wrong source file 24849; 793923405 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E35 - Ready Get Pet. Go Pluto! [WEBDL-720p][AAC 2.0][h264]-DKiDS.mkv`.
- Source story evidence: [Goofy] "Holi, By Golly."; [Minnie] "The Pink City."
- Destination episodes: S03E69 (episode 37351), S03E70 (episode 37352).
- Existing correct destination file 65423; 1508896227 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E69-70 - Holi By Golly and The Pink City [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `35:S03E69,35:S03E70`.

### Source S01E36 → S3E71-72

- Source episodes: S01E36 (episode 37216).
- Wrong source file 24852; 1221471882 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E36 - Figaros New Friend! [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Daisy] "The Spooky Spook House!"; [Mickey] "Clarabelle's Banana Splitz."
- Destination episodes: S03E71 (episode 37353), S03E72 (episode 37354).
- Existing correct destination file 65424; 1405332891 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E71-72 - The Spooky Spook House! and Clarabelles Banana Splitz! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `36:S03E71,36:S03E72`.

### Source S01E37-38 → S3E37-38

- Source episodes: S01E37 (episode 37217), S01E38 (episode 37218).
- Wrong source file 24853; 1555333115 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E37-38 - Garage Alone and Camp Happy Helpers [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Pete] "Mickey's Roommate."; [Cuckoo Loca] "Minnie's Bow-tel!"
- Destination episodes: S03E37 (episode 37319), S03E38 (episode 37320).
- Existing correct destination file 65398; 1439936713 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E37-38 - Mickeys Roommate and Minnies Bow-tel! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `37:S03E37,37:S03E38`.

### Source S01E39-40 → S3E39-40

- Source episodes: S01E39 (episode 37219), S01E40 (episode 37220).
- Wrong source file 24856; 1563045630 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E39-40 - The Haunted Hot Rod and Petes Ghostly Gala [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Mickey] "Mickey's Sporty Day."; [Daisy] "Go, Chili Dogs!"
- Destination episodes: S03E39 (episode 37321), S03E40 (episode 37322).
- Existing correct destination file 65406; 1535161123 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E39-40 - Mickeys Sporty Day and Go Chili Dogs! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `39:S03E39,39:S03E40`.

### Source S01E41-42 → S3E41-42

- Source episodes: S01E41 (episode 37221), S01E42 (episode 37222).
- Wrong source file 24859; 1561997320 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E41-42 - Billy Beagles Tip-Top Garage and Diner Dog Rescue [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Mickey] "Goofy's Hot Dog Harvest."; [Minnie] "Puppy Birthday to You."
- Destination episodes: S03E41 (episode 37323), S03E42 (episode 37324).
- Existing correct destination file 65403; 1499370372 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E41-42 - Goofys Hot Dog Harvest and Puppy Birthday to You! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `41:S03E41,41:S03E42`.

### Source S01E43-44 → S3E43-44

- Source episodes: S01E43 (episode 37223), S01E44 (episode 37224).
- Wrong source file 24862; 1563572363 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E43-44 - Pit Stop and Go and Alarm on the Farm [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Mickey] "Holiday in Hot Dog Hills."; [Daisy] "Happy Kitty Helpers."
- Destination episodes: S03E43 (episode 37325), S03E44 (episode 37326).
- Existing correct destination file 65405; 1458323467 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E43-44 - Holiday in Hot Dog Hills and Happy Kitty Helpers [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `43:S03E43,43:S03E44`.

### Source S01E45-46 → S3E45-46

- Source episodes: S01E45 (episode 37225), S01E46 (episode 37226).
- Wrong source file 24865; 1557287518 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E45-46 - Happy Hot Diggity Dog Holiday and Happy Holiday Helpers [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Minnie] "Enough Stuff."; [Minnie] "The Hippity Hop Horse Show."
- Destination episodes: S03E45 (episode 37327), S03E46 (episode 37328).
- Existing correct destination file 65404; 1462476307 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E45-46 - Enough Stuff and The Hippity Hop Horse Show! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `45:S03E45,45:S03E46`.

### Source S01E47-48 → S3E47-48

- Source episodes: S01E47 (episode 37227), S01E48 (episode 37228).
- Wrong source file 24868; 1560718120 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E47-48 - Hot Dog Daze Afternoon and Super Sweet Helpers [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Mickey] "The Mystery of Hot Dog Lake."; [Minnie] "Phantom Wing."
- Destination episodes: S03E47 (episode 37329), S03E48 (episode 37330).
- Existing correct destination file 65402; 1533485959 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E47-48 - The Mystery of Hot Dog Lake! and Phantom Wing [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `47:S03E47,47:S03E48`.

### Source S01E49-50 → S3E49-50

- Source episodes: S01E49 (episode 37229), S01E50 (episode 37230).
- Wrong source file 24871; 1126264783 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E49-50 - The Grand Food Truck Rally and Cuckoo La-La [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: [Goofy] "Magic Tricked." (The Great Goofini); [Minnie] "Art From the Heart!"
- Destination episodes: S03E49 (episode 37331), S03E50 (episode 37332).
- Existing correct destination file 65409; 1375582913 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E49-50 - Magic Tricked! and Art From the Heart! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: same two titles
- Exact sameAs arguments: `49:S03E49,49:S03E50`.

### Source S01E51-52 → S3E51-52

- Source episodes: S01E51 (episode 37231), S01E52 (episode 37232).
- Wrong source file 24874; 1565774209 bytes; `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E51-52 - Rockin Roadsters! and Safari So Goody [WEBDL-1080p][AAC 2.0][h264]-CRFW.mkv`.
- Source story evidence: no spoken titles; story 1 opens "Duck, duck... geese." and Goofy's homemade "birdy call" (S3E51 overview: Goofy's bird call draws dozens of geese); story 2 opens "[shushes]" then "You're always right, Billy. And loud too." (S3E52 overview: Billy Beagle learns inside vs outside voices)
- Destination episodes: S03E51 (episode 37333), S03E52 (episode 37334).
- Existing correct destination file 65408; 1475927711 bytes; `Season 3/Mickey Mouse - Mixed-Up Adventures (2017) - S03E51-52 - Duck Duck Geese! and Shhhhh! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`.
- Destination story evidence: identical opening lines in both stories
- Exact sameAs arguments: `51:S03E51,51:S03E52`.

## Final S01E13–16: wait for corrected E07–08 imports

The retained file 65359 is 1377201632 bytes; relative name `Season 1/Mickey Mouse - Mixed-Up Adventures (2017) - S01E13-14-15-16 - Ye Olde Royal Heist and Tea Time Trouble! and Abra-ka-Goof! and Happy Birthday Helpers! [DSNP WEBDL-1080p][AAC 2.0][x264]-AndreMor.mkv`. It is linked to S01E13 (episode 37193), S01E14 (episode 37194), S01E15 (episode 37195), S01E16 (episode 37196).

Independent subtitle/story proof: Mickey says “Agent Double-O-Goof” while the Queen visits and Commander Heist steals the royal briefcase; Daisy says “Egg-xasperating”. This file holds the real season 1 E07–08 stories, rather than the E13–16 titles in its library filename.

Current E07–08 (Sonarr episodes 37187 and 37188) still point at wrong file 24806, 1560855497 bytes, whose season 3 content is documented above. Therefore they are not valid destinations yet. The final E13–16 replacement is excluded from the current plan and batch.

After the first pass imports corrected E07–08, independently prove both new stories and record their new file IDs, relative names and byte sizes. Only then freshly plan E13–16 and carry its marks to those confirmed copies. Refill E13–16 with exact correct releases for S01E13E14 (Ye Olde Royal Heist / Tea Time Trouble!) and S01E15E16 (Abra-ka-Goof! / Happy Birthday Helpers!). If the destination or a correct replacement cannot be proved, keep this file and hold the step.

## Proposed release choices for driver review

All selections below fill their entire slot exactly once. Early Mickey choices need an explicit override as reported by the plan; that status does not weaken the independent source/destination content proof. Slot 11 has no AndreMor candidate in the fresh plan: the proposed fallback is the correctly titled GoApe 720p pair, rather than an iVy upscale. No choice is approved for mutation by this record alone.

| Show / slot | State | Fresh digest | Selected key | Correct release title | Exact landing labels |
|---|---|---|---|---|---|
| Ben 10 10 | grab | ca2916c6ef0ef6409c2d8067ac903f71 | ef72d24eb68ec213 | Ben.10.2016.S01E10.Animo.Farm.1080p.SHAHID.WEB-DL.AAC2.0.H.264-MZABI | S01E10 · Animo Farm |
| Ben 10 12 | grab | 501df9978a46e462d18a0bedbf694f54 | dc3540b1bf3a4335 | Ben.10.2016.S01E12.Adventures.in.Babysitting.1080p.HMAX.WEB-DL.DD2.0.H.264-LAZY | S01E12 · Adventures in Babysitting |
| Mickey 1 | override | 6d1fefaa0141ea389cf9bdc87dcbea19 | 6219a10435f1b588 | Mickey.Mouse..MixedUp.Adventures.S01E01E02.Mickeys.Wild.Tire..Sittin.Kitty.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E01 · Mickey's Wild Tire!, S01E02 · Sittin' Kitty |
| Mickey 3 | override | 7b9185b8d972e917a9ed9526cae1e473 | f5448ad343ad9223 | Mickey.Mouse..MixedUp.Adventures.S01E03E04.Goofy.Gas..Little.Big.Ape.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E03 · Goofy Gas!, S01E04 · Little Big Ape |
| Mickey 5 | override | 34d5c19e6c042dc1a08eee57eebb8693 | 5106705fb08e1870 | Mickey.Mouse..MixedUp.Adventures.S01E05E06.Race.for.the.Rigatoni.Ribbon..Roaming.Around.Rome.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E05 · Race for the Rigatoni Ribbon!, S01E06 · Roaming Around Rome |
| Mickey 7 | override | 3a60bc6bae2fd33b24d6c001faecea07 | 27c3492d722fc668 | Mickey.Mouse..MixedUp.Adventures.S01E07E08.Agent.DoubleOGoof..Eggxasperating.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E07 · Agent Double-O-Goof, S01E08 · Egg-xasperating! |
| Mickey 9 | override | a4e91815ea669056c5bf6174054549a3 | 055fa983b925bf87 | Mickey.Mouse..MixedUp.Adventures.S01E09E10.Mickeys.Perfecto.Day..Running.of.the.Roadsters.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E09 · Mickey's Perfecto Day!, S01E10 · Running of the Roadsters! |
| Mickey 11 | override | b9796b7b2f4bdf7c593f427ae1bed59c | 83e908d7d7892082 | Mickey.and.the.Roadster.Racers.S01E11E12.Its.Wiki.Wiki.Time.Happy.Hula.Helpers.720p.DSNY.WEBRip.AAC2.0.x264-GoApe | S01E11 · It's Wiki Wiki Time!, S01E12 · Happy Hula Helpers! |
| Mickey 17 | override | 239e4d186f2bc01707bda24c0987a21c | bed04ed69d5285c2 | Mickey.Mouse..MixedUp.Adventures.S01E17E18.Guru.Goofy..Bed.Breakfast.and.Bungled.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E17 · Guru Goofy, S01E18 · Bed, Breakfast and Bungled! |
| Mickey 19 | override | e346c1481e6c550df7d8e0f4bb52ca00 | 52eff3f400de12e8 | Mickey.Mouse..MixedUp.Adventures.S01E19E20.Going.Upppppppppp..Gone.Fishin.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E19 · Going Upppppppppp!, S01E20 · Gone Fishin'! |
| Mickey 21 | override | 97acb5f2f06299f799c5a6f6daf6c668 | af7c9edf45268295 | Mickey.Mouse..MixedUp.Adventures.S01E21E22.Goof.Luck.Charm..Teed.Off.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E21 · Goof Luck Charm, S01E22 · Teed Off! |
| Mickey 23 | override | 833c822f0b8afab0e5d95253bd8215c5 | 71f910b50e456b25 | Mickey.Mouse..MixedUp.Adventures.S01E23E24.The.Impossible.Race..The.Happiest.Helpers.Cruise.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E23 · The Impossible Race, S01E24 · The Happiest Helpers Cruise! |
| Mickey 25 | override | dbb76b394c52b4afe9e8d86d20405a66 | e2d61dd4607f9e8d | Mickey.Mouse..MixedUp.Adventures.S01E25E26.Smarty.Goof..Adventures.in.Buddysitting.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E25 · Smarty Goof, S01E26 · Adventures in Buddysitting! |
| Mickey 29 | grab | 9aa3c622601b07371686e2b56e832f3c | 274327e2abf832c2 | Mickey.Mouse..MixedUp.Adventures.S01E29E30.Stop.That.Heist..Lights.Camera.Help.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E29 · Stop That Heist!, S01E30 · Lights! Camera! Help! |
| Mickey 31 | grab | 2519a2eb11ebcf0355dfd479bb4c98d5 | 60ef71e1b32c18ae | Mickey.Mouse..MixedUp.Adventures.S01E31E32.Mouse.Vs.Machine..Grandpa.Beagles.Day.Out.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E31 · Mouse Vs. Machine!, S01E32 · Grandpa Beagle's Day Out |
| Mickey 33+34 | grab | ea453c1c4738bf6280df8a8ba0c015f3 | 1cb3f8236986d1a9 | Mickey.Mouse..MixedUp.Adventures.S01E33E34.Donalds.Garage..Artful.Helpers.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E33 · Donald's Garage, S01E34 · Artful Helpers |
| Mickey 35+36 | grab | 4511a12386d484c4ce565e6a7154d0ba | 5ff64b5b9938241b | Mickey.Mouse..MixedUp.Adventures.S01E35E36.Ready.Get.Pet.Go.Pluto..Figaros.New.Friend.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E35 · Ready, Get Pet... Go Pluto!, S01E36 · Figaro's New Friend! |
| Mickey 37 | grab | cb026646ebf2e3b55ce8284cec6e0d5b | d33c825ab7d77c0b | Mickey.Mouse..MixedUp.Adventures.S01E37E38.Garage.Alone..Camp.Happy.Helpers.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E37 · Garage Alone, S01E38 · Camp Happy Helpers |
| Mickey 39 | grab | fc1090260370c1e8a7f25e5185651988 | fcdc6fd5ac5599dd | Mickey.Mouse..MixedUp.Adventures.S01E39E40.The.Haunted.Hot.Rod..Petes.Ghostly.Gala.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E39 · The Haunted Hot Rod, S01E40 · Pete's Ghostly Gala |
| Mickey 41 | grab | 54724204b42173e1388be038a1812ef5 | 3d00146d7619a211 | Mickey.Mouse..MixedUp.Adventures.S01E41E42.Billy.Beagles.TipTop.Garage..Diner.Dog.Rescue.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E41 · Billy Beagle's Tip-Top Garage, S01E42 · Diner Dog Rescue |
| Mickey 43 | grab | b4395228077d00adbf40d7d42914b1e9 | e2a52e35b5d040a4 | Mickey.Mouse..MixedUp.Adventures.S01E43E44.Pit.Stop.and.Go..Alarm.on.the.Farm.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E43 · Pit Stop and Go, S01E44 · Alarm on the Farm |
| Mickey 45 | grab | 7b2678def70bf742b6598598d3162c11 | 63dffbef6cf3fe0a | Mickey.Mouse..MixedUp.Adventures.S01E45E46.Happy.Hot.Diggity.Dog.Holiday..Happy.Holiday.Helpers.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E45 · Happy Hot Diggity Dog Holiday, S01E46 · Happy Holiday Helpers |
| Mickey 47 | grab | b5ba6fd0442d9ac6da1fc02cf139dcf4 | 4b74ec341d1b2a01 | Mickey.Mouse..MixedUp.Adventures.S01E47E48.Hot.Dog.Daze.Afternoon..Super.Sweet.Helpers.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E47 · Hot Dog Daze Afternoon, S01E48 · Super Sweet Helpers |
| Mickey 49 | grab | fc0fc9756ca0e342b85cacd630c81893 | 7cf176c17d25a228 | Mickey.Mouse..MixedUp.Adventures.S01E49E50.The.Grand.Food.Truck.Rally..Cuckoo.LaLa.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E49 · The Grand Food Truck Rally, S01E50 · Cuckoo La-La |
| Mickey 51 | grab | 3e53750eff421d6da747eb5e9d9fbe5f | 1779f9a7e192250f | Mickey.Mouse..MixedUp.Adventures.S01E51E52.Rockin.Roadsters..Safari.So.Goody.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor | S01E51 · Rockin' Roadsters!, S01E52 · Safari, So Goody |

The no-fake-activity OC-050/051 audit is separate. This content record changes no settings, enforcement mode, Seerr issue or media state. Every future arr/Plex write must go through the existing domain writers and its audit trail.
