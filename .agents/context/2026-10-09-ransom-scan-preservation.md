# Ransom: prepared catalog identity option, no production authorization

## Owner ruling received, 2026-10-10

Q-01 is answered: the owner selected “Apply the verified Ransom repair
(Recommended)” after the current read-only premise `e6e88737` established
75 days without all-user reading activity, the exact IDs/seven cells, no alias
and unchanged target reading state. Authorized scope is the seven catalog fields,
stale EPUB series-tag removal and guarded scans, preserving IDs and reading
progress. This supersedes pending-owner statements below.

No production catalog/tag write or scan is claimed. The saved seven-cell
maintenance component is preparation. A separately admitted finite maintenance
Job, current full typed-state/fence checks, private original retention, actual
scan completion and qualified preservation/inverse remain required. Keep the
whole-folder hold until the accepted operation completes; hourly strip stays off.


Current production status, 2026-10-10 15:52Z: the whole-folder hold remains.
A separate authorized read-only production capture now confirms **75 days of
all-user reading idleness**, with all five files older than 30 days and no active
matching session. The current activity source still records the July 27 reading
end; this is a fresh verification of that historical date, not reuse of an old
eligibility assertion. Current Library/Series/Volume/Chapter/File IDs remain
1/1650/1800/3358/3570, all seven before-cells match, and no competing same-library
alias exists. No production catalog, EPUB tag or scan write has occurred.

Aggregate SHA-256:
`e6e88737ddf50f93c8e233e2acb9dd6ac86843dd6636576d7c3a6ac4764f8937`.
Applicability SHA-256:
`572f884f14426ae94fa780803f232726ca40073688e558fe463610171a9cc2a2`.
The current target reading state in five tables matches the earlier production
capture; the immutable app image and all six folder-stat rows also match. This
does not claim all 82 current global tables are unchanged or replay the native
scanner test. The successful isolated v13 forward/inverse proof below remains
historical.

**Q-01 — owner ruling pending.** After physically checking the fresh premise and
exact seven proposed cells, Root asked through the phone question tool whether
to approve the seven-field catalog repair, existing series-tag removal and
guarded scans while preserving IDs and saved state. PLAN-074 explicitly requires
this ruling because the catalog writer extends strip-only authority. Keep the
whole-folder hold until the answer and exact current execution contract are
bound; general completion authorization and an isolated fixture are not this
ruling. The hourly strip stays off. This work does not rewrite MP3/M4B tags.

## Verified blocker and native source

The stable native Kavita database copy captured at 2026-10-09T16:34:07.903866Z maps the
one Ransom EPUB to series 1650 (`Gabriel Allon`), volume 1800 (`26`), chapter 3358
(`-100000`) and file 3570. Its progress 19, session 11 and activity 22 still exist;
progress retains its exact nonempty BookScrollId/XPath in private evidence. ReadingHistory 9 also
embeds this series/chapter/activity identity and resolves through the same current
file. Actual reading ended July 27 and the
owner's 30-day rule has been satisfied since August 26. Eligibility does not prove
scanner preservation.

Kavita v0.9.0.2 BookService falls back to EPUB title `Ransom` and loose-leaf volume
`-100000` after grouping/index removal. ProcessSeries looks up series by normalized
name/localized name/original name, then volumes by LookupName. A missing match creates
a new entity. Existing unmatched volumes/series are removed. The native foreign keys
can cascade removal into progress, bookmark, annotation and session-activity rows.
Neither an ordinary scan nor merely retaining EPUB contents proves saved state survives.
The exact native path is `/data/cephfs-hdd/data/media/books/EBooks/Daniel Silva/Ransom/Ransom - Daniel Silva.epub`.
The deployed Pod UID is `565e49a9-405c-4d0f-acb7-3c18daa3dd2b`, image
`jvmilazz0/kavita:0.9.0.2`, imageID digest
`ca6af7a18d7124d014702983c2364e485294f808c1552e9555f2595b7cda7982`, restart count 0.

Relevant upstream source at tagged commit `6bcd5689385d0e96824982d843c54f15ce784ddc`:
`BookService.cs:1420`, `ProcessSeries.cs:95,590,639`,
`SeriesRepository.cs:1244,1398`, `ScannerService.cs:580`, `Volume.cs:GetNumberTitle`,
`VolumeBuilder.cs`, and `ParserConstants.cs`. The official tagged source is pinned in
the private evidence; source-path analysis is not an executed scanner integration test.
Primary source links: [native EPUB parser](https://github.com/Kareadita/Kavita/blob/6bcd5689385d0e96824982d843c54f15ce784ddc/Kavita.Services/BookService.cs#L1420),
[series and volume update](https://github.com/Kareadita/Kavita/blob/6bcd5689385d0e96824982d843c54f15ce784ddc/Kavita.Services/Scanner/ProcessSeries.cs#L590),
[series lookup and cleanup](https://github.com/Kareadita/Kavita/blob/6bcd5689385d0e96824982d843c54f15ce784ddc/Kavita.Database/Repositories/SeriesRepository.cs#L1244).

## Exact candidate and intended proof

Subject to fresh complete alias/conflict/state audit, retain all four primary IDs and
all foreign keys. The proposed catalog delta is:

| Table / ID | Field | Before | Candidate |
| --- | --- | --- | --- |
| Series / 1650 | Name | Gabriel Allon | Ransom |
| Series / 1650 | NormalizedName | gabrielallon | ransom |
| Series / 1650 | OriginalName | Gabriel Allon | Ransom |
| Volume / 1800 | LookupName | 26 | -100000 |
| Volume / 1800 | Name | 26 | -100000 |
| Volume / 1800 | MinNumber | 26 | -100000 |
| Volume / 1800 | MaxNumber | 26 | -100000 |

OriginalName changes with the work key so a later Gabriel Allon grouping cannot alias
this standalone Ransom work. Volume numeric fields change together because native
GetNumberTitle derives Name from MinNumber/MaxNumber, and loose-leaf behavior tests
MinNumber. The already-default chapter key and the exact file path need no edit.
No title, contributor, identifier, EPUB content, saved-state, curation, lock or
timestamp update is included in this catalog candidate.

An offline clone of the stable private native copy may validate this exact transaction
and inverse only. It must reject any additional lookup alias in the same format/library,
changed cardinality/file relationship, unexpected trigger or schema/foreign-key drift.
Full canonical table rows before/after must differ only in the seven fields above;
all saved IDs/XPath, locks, metadata and every other row must remain exact. The inverse
restores those seven old values with the same exact-state preconditions, without an
overwrite or replacement of the live database.

## Completed bounded offline evidence

The private stable source copy has SHA-256
`ac33b02757a8f08e9296720049dce85afdfe3def9e50768e80ac561bd462f267`.
Its full native schema contains 82 tables and 34,433 rows. Complete alias inspection
found only series 1650 for Ransom/Gabriel Allon across name, original name, normalized
name, localized name and sort name; the exact prospective native Ransom lookup matches
no current series. Library 1 / format 3 contains no alternative matching alias. The
series has one volume, one chapter and one file. Native schema has no triggers or
unique indexes on the four catalog tables. Current target series/volume/chapter lock
flags are all zero.

The sanctioned complete dependency resolver passed all 21 saved-state tables and
metadata-lock relationships with zero errors and zero target lock protections. The
target's actual protections are progress 19, session 11, activity 22 and ReadingHistory
9; no target curated-list, bookmark, annotation or profile reference was found. One
disconnected historical activity elsewhere retains the resolver's explicit legacy
classification; it is not target evidence or a reason to discard any saved row.

One serial `nice -n 19` fixture mutated only a separate offline clone. It committed
the exact seven-field delta, compared every full canonical row across all 82 tables,
then committed the guarded inverse and compared the entire database's logical rows
with the original. Forward differences were exactly the declared Series/Volume fields;
all saved-state, curation, lock and unrelated rows stayed exact; the inverse restored
every canonical row. Native foreign-key checks passed before/after. The source copy's
SHA stayed unchanged. Five finite negative controls refused competing aliases,
unexpected triggers, changed volume key, changed saved XPath and changed file binding.
For each control, a second check supplied the hypothetical changed clone's own complete
snapshot, so the refusal independently exercised its semantic guard rather than only
the old approved table digest. These are fixture inputs, not approvals of changed
production state.

Private evidence is under `/tmp/hn-ransom-live-readonly-1009-1640/`: copy proof,
full source/schema/alias/dependency evidence and `ransom-catalog-offline-proof.json`.
The fixture is `/tmp/hn-ransom-catalog-offline-1009.py`, SHA-256
`9195612db3a11e9a0d62a1cff655bd09317e81a2dcd4a092410a79356b301a2b`.
Raw database, user payloads and authentication state remain private and are excluded
from git. These artifacts are diagnostic evidence, not a fresh runtime approval.

## Required execution gates and limits

This would add a native catalog writer outside the prior strip-only authorization.
Root must first review concrete source, offline proof and an independent review, then
ask the owner about that exact additional writer. No production SQL has been prepared
for execution or run. Supported series/volume metadata APIs do not expose these lookup
keys, so calling them is not an equivalent sanctioned rename.

Before any future production stage: fresh full corpus/identity/LL/app state on v0.110.5;
exact original/candidate ZIP-member and hash proof; complete all-user dependencies and
all catalog aliases; native image/source/schema pins; admitted bounded stop of every
Kavita/database/EPUB writer; no open native handles or background scan; an independently
armed restoration watcher; immutable before/intent/readback and inverse; and root's
fresh concrete runtime ratification. Keep the whole-folder hold and global strip gate
off until preservation is actually proved. Do not combine this with Pathfinder COPY.

An offline SQL-shape/row-equivalence check cannot establish actual scanner behavior.
The current dev pod has no .NET SDK. A bounded fixture executing the exact native
parser/scanner against a throwaway isolated database and EPUB is the proposed next
proof. The tagged ProcessSeriesTests currently has only TODO scaffolding, so invoking
that vendor test file would not exercise the preservation path. A real fixture must
use the pinned native assemblies and dependency-injection graph (or an exact-source
build), execute `ScannerService.ScanSeries(1650, true)` against the isolated exact-folder
EPUB and clone, then compare every saved-state/curation/lock row and all four IDs.
It must also exercise the actual parsed series/volume/chapter keys and the native
cleanup predicate against the **complete retained parsed-name set**. Never invoke a
full library scan with only Ransom mounted; that would treat unrelated works as missing.
A Python recreation of those methods cannot count as execution proof. The deployed
runtime is self-contained .NET Core/ASP.NET 10.0.1; a generic source-only harness can
reflect the native private CreateHostBuilder and Build its graph, but must never call
Program.Main, host.Start/Run, startup migrations or hosted/Hangfire workers.
The fixture must have no production database/media mount, ingress, external service
bearers/secrets mounted, acquisition path or live scheduled writer. The private clone
itself contains authentication fields; keep the whole clone private, do not claim it
contains no credentials, and do not publish it or its user payloads in git/CI artifacts.
Its environment and invocation require
separate preparation/review, with no
production scan, rename, progress write or new Job implied by this note. Any actual
scan must preserve every saved-state row and lock verbatim; otherwise stop and retain
Ransom's hold. Metadata rollback alone cannot recreate deleted IDs or saved state.

## Historical native preservation PASS, 2026-10-10 03:24Z

One separately approved isolated v13 Job executed the actual pinned Kavita 0.9.0.2
scanner against the unchanged historical private database/EPUB pair. It used signed
fixture image `ghcr.io/thaynes43/book-native-scan-fixture@sha256:c5e8aa8f2b059ef95e1c5f43502f9ca3baaa37d961e69fc8c269a5956209d861`,
published by ops #3708 (`0d51f288`) and literally pinned by #3709 (`7f522742`).
The 13 admitted fixture/native modules matched their reviewed physical publication
closure. The sole independent packet review is `c391dbe322c3f37fa9cf04eac9c084ccf53df33462563de342bbbbe1f927d1d7`.

The native scan ran from `2026-10-10T03:24:22.898578Z` to
`2026-10-10T03:24:25.9549517Z`. All existing target IDs and saved-state, curation and
lock rows stayed exact. Across 82 tables and 34,433 rows, the seven proposed catalog
cells and 25 explicitly bounded native effects occupied 32 distinct cells with no
overlap. The native readback and complete typed compare-and-swap inverse passed;
every table then exactly matched the original historical database. The native
cleanup predicate removed zero retained works using the complete 1,931 parsed keys.
The application was built without starting its hosted workers.

The actual encoded cover check also passed. In the physically admitted harness,
`Program.cs:162` calls `NativeProjection.RequireAfterCover` before publishing PASS
or performing the inverse. `NativeProjection.cs:164–166` verifies the retained
Volume/Chapter cover binding; line 175 hashes the actual native cover bytes against
the independently encoded candidate. This guard was unchanged by the two Series
color allowance corrections. Earlier v12 remains UNKNOWN; the successor supplies
the previously missing cover and inverse proof.

The actual receipt is `2c5a990c1e8b9b4c6998421e46fd8d4ccdd025c0d8b326756c761dc6a9fdffad`.
The aggregate is `/home/dev/work/hn-ransom-native-fixture-actual-c5e8-v13-1010/aggregate-actual-v13-proof-final.json`,
SHA-256 `44df8c85d981c00486f86a2ac4b76bed8d7ef17ad41ad21183bda03eab16b18c`.
It binds CLOSED packet `10a8339d`, authorized one-run copy `ac62117f`, exact Job/Pod
UIDs, durable proof/ACK, and complete final typed Job/Pod inventories. Owned cleanup
finished at `03:24:46.559607Z`; the independent watchdog confirmed it at
`03:24:46.721154Z`. Both preceded the original 180-second execution and 200-second
cleanup caps. The fresh full fixture union was empty, and the production Kavita Pod
UID stayed unchanged. Production writes were zero.

This is a historical scanner preservation PASS. Fresh target-only all-user reading
activity, saved location, file/catalog identity and idle eligibility remain pending
from the existing authorized export. The historical July 27 reading timestamp and
August 26 eligibility date are not a fresh current assessment; metadata scan clocks
must not restart that 30-day rule. OC-046 remains pending and the whole-folder hold
and global hourly strip gate remain in place.

The production proposal still comprises only `Series.Name`, `Series.NormalizedName`,
`Series.OriginalName`, `Volume.LookupName`, `Volume.Name`, `Volume.MinNumber` and
`Volume.MaxNumber`, plus removal of this EPUB's grouping/index metadata under the
existing strip-only boundary. It would present the existing ebook as a standalone
work while preserving its exact reading place and identities. The added catalog
writer still requires the owner's exact ruling and fresh runtime admission under
PLAN-074. This proof neither validates the EPUB title/author nor changes audiobook
metadata; no production catalog edit, EPUB strip, scan or hold release has occurred.

The concrete production design remains non-executable. Fresh current target/file,
all-user reading and saved-state, alias, lock, native version and writer-fence
bindings are still empty. A forward transaction would update exactly two existing
rows through typed full-row compare-and-swap, then verify that only the seven
declared cells differ before commit. The accepted post-scan inverse would restore
the seven catalog and 25 bounded native keys across five rows, requiring all original
logical tables to match before commit. Missing or changed protected rows refuse;
this inverse cannot recreate deleted saved state.

Supported metadata APIs do not expose these lookup keys, and the offline/native
fixture is not an admitted production writer. The minimum new admission after the
owner's ruling is a narrow production catalog adapter with current-state binding,
plus the separately reviewed exact-folder hold release/inverse, native single-series
scan and owned retirement/Normal restoration. Existing EPUB strip and backup-restore
helpers both reject the configured hold, so it must not be bypassed incidentally.
The retained-original manifest and candidate-only atomic restore remain required.
No production adapter, source/image PR, Job or hold change accompanies this design;
it is separate from Pathfinder's two-extra COPY phase.
