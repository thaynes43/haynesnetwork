-- Issue #771 / DESIGN-028 amendment 2026-10-06 (latest): the Author Check. A collection want whose LazyLibrarian book
-- is credited to another author than the member's ("Gray Dawn", Walter Mosley, on Stewart Edward White's "The Gray
-- Dawn") gives that book up and is resolved again with its author. `wrong_author_ll_book_id` remembers the book it gave
-- up: a resolve that names the same book again vouches for it (the author is written another way), so the check stops
-- there instead of looping. Journal idx 94. ADDITIVE and nullable, so the previous image, which never names it, runs
-- unchanged. A down-migration drops the column.
ALTER TABLE "book_requests" ADD COLUMN "wrong_author_ll_book_id" text;
