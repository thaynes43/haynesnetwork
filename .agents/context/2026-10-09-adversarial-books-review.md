# 2026-10-09 — Adversarial review of the books repair wave after #746

## Verdict and scope

The repair wave closes several concrete risks recorded by the October 6 review, but five current failure cases still
survived on `51c90a6` (v0.110.4). This change fixes those cases and their confirmed siblings. It does not certify the
whole app or the physical library as defect-free. All counterexamples ran locally against PostgreSQL 16, pure
functions or controlled service stubs; this review made no production data repairs or library mutations.

Scope began after the prior review, docs PR #746 / issue #731. The substantive earlier wave reviewed was #748, #751,
#760, #762, #765, #769/#773, #780, #791/#793, #798 and #805/#806. The later wave reviewed was #819 (collection resolve
coverage), #824 (production e2e server/Goodreads loading), #827 (Google Books pacing), #826 (admin Request Events),
#833 (series splits), #837 (verified identities/in-flight formats), #843 (physically held conflicts) and #851
(complete contributors). Git history, HANDOFF, the previous review and issue #825 bounded the scope. Older shared
helpers were followed where current code still called them; the Goodreads matcher dates to #253. Related #825
operator proof-window docs and haynes-ops #3615/#3620 were provenance, not permission for another live repair.

## Five proved failures and fixes

| ID | Severity | Reproducible baseline failure | Provenance | Current fix location |
| --- | --- | --- | --- | --- |
| A-01 | P1 | An active *Mistborn: The Final Empire* pairing want covers *Mistborn: Secret History*, even with a different known LL edition id. `syncCollectionWants` deletes the real Secret History request. `Brandon Sanderson Jr` also matches Brandon Sanderson. | Coverage helper extracted by #819 (`71ac0c1`), retained through #833/#837/#843/#851. Baseline `book-requests.ts:1721` and `:1728`. | `packages/domain/src/book-requests.ts`, `loadPairingCoverage`; `collection-wants-sync.ts`, `resolveMissingMembers`. |
| A-02 | P1 | Goodreads' library matcher reports the Final Empire library id for Secret History; a known Walter Mosley credit also falls back to the Brandon Sanderson title bucket. This false held proof can satisfy/suppress acquisition of a distinct request. | Shared matcher #253 (`96ead3f`); baseline `book-requests.ts:484` and `:490`. | `packages/domain/src/book-requests.ts`, `loadLibraryMatcher`. |
| A-03 | P1 | The verified Kavita source changes Alpha→Beta during the Google Books await. The minter still records Alpha's held format `landed` and queues/searches Alpha's other format. | Existing minter, surviving the verified-identity boundaries in #833/#837/#843/#851. | `packages/domain/src/format-pairing.ts`, `pairingMintAnchorCurrent`, `upsertPairingWant` and mint push boundaries. |
| A-04 | P2 | For the record *Code to Zero*, content title *Code to Zero [and] The Man from St Petersburg* passes. Census reports `findings=[]`, `wrongFile=0`, `judgedContent=1`. | Whole-title prefix shortcut #791 (`d26ddec`), baseline `ll-book-check.ts:787`; #805/#806 repaired the reverse shape only. | `packages/domain/src/ll-book-check.ts`, `namesNothingElse`; sync census regression. |
| A-05 | P2 | A new active owner minted during the final LL snapshot read does not stop either release draining or orphan repair from changing its Wanted ebook to Skipped. Acquisition is interrupted; file bytes are untouched. | Owner snapshots #751 (`494c42d`), retained through #833's transition protection. | `packages/domain/src/ll-release.ts`, `currentLlFormatProtection` and both final unqueue boundaries. |

A-01/A-02 now require the complete pairing title key and strict contributor comparison. Subtitles, parenthetical
work labels and volume numbers remain identity; only documented edition noise disappears. Known author mismatch
and missing authors cannot fall back to a title bucket. Source/Libretto contributor arrays retain their boundaries
and cardinality. The independent review proved why joining them back to CSV was insufficient: `[Homer, Robert
Fagles]` could otherwise match the invented single person `Homer Fagles`. Tests cover that false match and a positive
complete roster. Known Kavita chapters supply their own full titles and rosters: an Odyssey container holding
The Iliad cannot satisfy Odyssey; a proven chapter in a multi-book series may satisfy its own work. Incomplete
chapters cannot supply contributor proof. Current source credits must also agree with the request snapshot; a newly changed Emily Wilson
roster cannot rename an already queued Robert Fagles request. The exact shared-LL-id shortcut, active status rules,
park/completion exclusions and genuine same-work edition/initial matches remain.

A-03 reads only the current anchor by id. It checks undeleted/kind/language/held-source certainty, full work title,
complete credits and normalized ISBN before resolve, inside the mint transaction, and before add/queue/search.
The transaction locks the request first, then the anchor `FOR SHARE`, matching the existing repair writer's lock
order; no lock spans an external await. Changed/unread source proof defers the attempt without inventing a
permanent hold. If queue succeeds before a source change is observed, the writer still records truthful Wanted
ownership while skipping the stale search, so the next stable identity pass releases the abandoned format.

A-04 checks an explicit additional-work suffix before either the whole-title prefix or split-part fallback. `and`,
`[and]`, `&`, `/` and `+`, including connectors behind part punctuation/parentheses, cannot hide another work.
Declared BookSub/series/packaging, `and Other Stories`, implicit subtitles and ordinary colon subtitles retain
their accepted behavior. The reproduced two-work title now yields one `wrong_file` census finding.

A-05 rereads current protections after the last LL read and immediately before unqueue. The current owner read is
scoped to the LL id; a separate cheap id/format probe conservatively protects a queued pairing predecessor with a
removed anchor until `settleRemovedPairingWants` resolves or clears it. Initial derived transition protection is
retained. It does not rerun full-library matching for every candidate, which would turn the fix into a performance
regression. The drain leaves protected transitions pending and settles new owners as owned; orphan repair skips.

## Other reviewed fixes and prior risks

- **#827 pacing: no additional confirmed defect.** The process-local rolling-minute pacer serializes physical
  Google Books calls, including resolver retries, and the one-minute breaker recovery is bounded. Fake-timer tests
  cover its accounting and waiting. This is the documented per-process policy, not a global guarantee for all
  consumers of a shared Google Books key. OC-042 already tracks the live pacing result.
- **#826 admin Request Events: no additional confirmed defect.** The router enforces admin-only access, bounds
  pages and uses a `(created_at,id)` cursor with PostgreSQL timestamp precision. Tests exercise anonymous/requester/
  reader denial, real writer events, cursor paging, bad input and deleted wants. PLAN-073 still owns the existing
  authenticated admin/non-admin UI verification; the local API test is not that live UI check.
- **#824: no additional confirmed defect.** The harness guard restricts its production-build bypass to a declared
  local e2e harness; the existing guard tests passed. Full browser e2e remains the required CI gate for this PR.
- **The #746 latent risks were followed through fixes.** Grabbed/gone status repairs, release cleanup, the broader
  Volume/Author checks, mint backoff, English-only guards, Request Events and the required e2e gate are materially
  stronger than that review's baseline. Those changes did not make all downstream identity/state assumptions safe:
  coverage/matcher siblings retained a broader identity key, the minter retained source proof across awaits, the
  census accepted an unexplained prefix suffix, and release cleanup retained owners across an external read.
  Successive fixes guarded different pipeline stages; a correct pairing matcher alone cannot protect its callers.

## Verification and limits

Every local test run used `nice -n 19`, one Vitest worker and serial files; there were no load burners, stress tools,
wide/looped tests or destructive live experiments. Embedded PostgreSQL was version 16.

- Initial coverage/credit/pacer/harness selection: 63/63 tests, four files.
- Expanded pairing/Goodreads/collection/complete-credit/held-coverage selection: 317/317 tests, five files, before the
  final structured-credit extraction and omnibus guard.
- Final affected pairing, Goodreads, collection, complete-credit and Held File Check selection: 251 tests across
  five files passed (four files in the combined run, then the corrected isolated collection fixture passed 32/32).
  The final source-roster/snapshot regression also passed in the focused collection rerun. The additional nested
  Kavita inventory case passed with the final Goodreads suite (47/47).
- Release drain/orphan repair: 37/37 tests, including six deterministic final-read ownership/transition races.
- Books Census: 22/22, including the extra-work content finding.
- Request Event writers and pacer: 13/13. Admin history API: 7/7.
- Changed domain and sync test/source files passed scoped ESLint; domain TypeScript checking and `git diff --check`
  passed. Required lint/test/build/e2e and advisory Claude review run on the PR before merge.

PostgreSQL proofs and unconditional vendor API writes cannot be made atomic by these small guards. Source mutation
after a last read can still race an external add/queue/search; a new owner after the last protection read can still
race unqueue. The guards remove the reproduced stale-snapshot intervals, bound rechecks to relevant rows, and keep
actual successful queue ownership truthful. They do not claim a shared vendor/app lock or transaction.

Remaining identity/source design work already has durable owners: #835 canonical reading-list/held-title gaps,
#838 eight creator identities, #839 structured EPUB creators through Kavita Writer parsing, #842 incomplete/conflicting
credits, and DESIGN-036 Q-02 identifier-backed cross-edition matching. The operational #825/#831 work is separate:
duplicate retention (Pathfinder #864), reading lists, signed census image, hourly strip (still off), OC-046 Ransom
30-day idle rule and OC-047 file-to-series coverage. PLAN-073 owns the live authenticated History UI check.
Existing owed-check records remain the source of truth; this review does not mark those obligations passed.
