-- Issue #668 follow-up (PR #676 review): book_requests gains ll_rerequest_added_at, stamped when a re-request's
-- `addBook` went through (LazyLibrarian looked the volume up on the shared Google Books key and kept the book). A
-- queue-only hand-back (LazyLibrarian already held the book) never sets it. Journal idx 89. ADDITIVE, nullable; the
-- previous image never names it. The re-request reads it as proof the key's quota was live this quota-day, so three
-- refusals in a row after it are the quota running out, not the books. A down-migration drops it.
ALTER TABLE "book_requests" ADD COLUMN "ll_rerequest_added_at" timestamp with time zone;
