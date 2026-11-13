# ADR-117: The Release Block records every verified posted name, not only the file on disk

- **Status:** Proposed (2026-11-13; story 838, saga 813. Drafted for the coordinator and the owner to accept.)
- **Date:** 2026-11-13
- **Deciders:** the owner, by the 2026-11-13 ruling on story 818 (comment 8011): a release the app already grabbed is never fetched again, and a person must still be able to request the title. Drafted in the same change as DESIGN-052 D-29.
- **Supersedes:** the part of [ADR-093](093-release-block-and-watchlist-enrollment.md) C-07, and of DESIGN-052 D-11 and D-25bd, that records only the release on disk (or, for a title already gone, only the latest import). ADR-093 is otherwise unchanged, including the renamed-file term (C-22), the 365-day life (C-07), the 3,000-term cap, and the rule that a failed write deletes nothing.

## Context and problem statement

Before Trash deletes a title it writes one "must not contain" term into the Release Block, so a later request does not fetch that release again. Since 2026-10-04 the term has been built from the file Radarr renamed, not from the name the indexer posted. An independent review (`.agents/context/2026-11-13-trash-readd-audit-review.md`, findings F4, F5 and F8) measured that kind of term to miss about 8 percent of real names, and found that the block keeps only the last file: a grab that failed, or one an upgrade replaced, is forgotten, and a later request can fetch it again.

The owner restated the rule the same day: a release already grabbed is never fetched again, and the block is on the release, never on the title's return. A separate story owns whether a term still expires after 365 days. This decision does not change that life, who is eligible, or how fast Trash moves.

## Decision drivers

- Every release the app can show was grabbed counts, including one that failed or was replaced.
- A person can still request the title in Seerr. Nothing here excludes the title.
- Where the evidence is unsure, delete nothing and block more.
- The writers stay the ones that already exist: a term is grammar-checked, written, and read back before any delete. A failed write or read-back deletes nothing.
- The 3,000-term cap and the 365-day life stay as they are.

## Considered options

- **A. Keep recording only the file on disk.** Rejected: it is the behaviour the review measured, and it leaves earlier grabs unblocked.
- **B. Record every verified posted name, and the renamed file only when that file has no verified name of its own.** Chosen.
- **C. Stop deleting any title that has no verified name.** Not chosen here. That is the owner's decision (DESIGN-052 Q-21). Until it is answered, a file with no verified name keeps today's renamed-file term and is still deleted.
- **D. Drop the renamed-file term whenever any grab of the title has a verified name.** Rejected for this story: the file on disk may be a different release from the grabs we can name, and dropping its term would block less. DESIGN-052 Q-18 records the choice.

## Decision

Before a delete, the app writes a Deleted-Release Record and a term for every posted release name it can verify for the title, through the existing writers `recordAndBlockReleases` and `reconcileReleaseBlock`.

A name is verified when it is a non-empty posted title that contains no `://`, from one of these:

1. Every Radarr or Sonarr history event of type grabbed or download-failed for that item.
2. Every ledger event of type grabbed or download-failed for that item, at or before the delete. A read that fills its page is treated as incomplete and the title is kept.
3. For a movie, a download-history job whose name, completion time and size match the file being deleted (the same size rule the 2026-09-28 backfill used). A series has no file size to match, so this source is movies only.
4. The file's own scene name or original path, when that name looks like a release. That was already part of the file's identity.

Names that are only a URL are skipped and never stored or logged. The download client's failure message, duplicate key and job id are not names and are not read for this purpose.

The renamed file is still recorded, as a low-confidence term, when that file has no verified name of its own. It is recorded even when some other grab of the title has a verified name. A delete whose every term is that fallback is counted on the sweep result, the sweep summary log, and the batch-close event. No page shows the count in this story.

A name that looks like a release but cannot be made into a term keeps the title: nothing is deleted. A name that does not look like a release is skipped.

The one-off backfill `packages/sync/src/scripts/release-block-backfill.ts` adds verified records beside existing low-confidence rows, and for deleted movies and shows that have no term yet, wherever a posted name is in the ledger or in a legacy download-history file passed on the command line. It does not read the live download client, and it does not ask Radarr or Sonarr for history: a deleted id can be reused. Dry-run is the default path and writes nothing. Applying it is a later, separate run. It does not lengthen a term past 365 days from the delete.

## Consequences

- A failed grab and a grab an upgrade replaced are blocked when the app can still show their posted names.
- The renamed-file term remains for a file with no verified name, and still misses the share measured in ADR-093 C-22 until Q-21 is answered.
- More terms are written per title. On 2026-11-13 the live Radarr profile held 619 distinct terms against a cap of 3,000 (DESIGN-052 D-29). The measured additions are far under that cap. The cap's behaviour is unchanged: the newest terms are kept.
- A ledger read that fills its page keeps that title, so a grabbed name past the page cannot be dropped. A download-history read that fills its last page is logged and the jobs already read are still used: refusing every movie delete would stop Trash, and this decision does not change the pace. The bound is 40 pages; the history measured the same day was 21 and was not truncated. A missing key or a failed read omits that source and does not stop the sweep.
- The six deleted shows the review names have no posted name in the ledger, and the size match does not apply to a series (Q-19). They stay without a term until a per-episode source exists.
- Term life, eligibility, pace, restore, and request protection are untouched.
