-- Issue #668 (owner ruling 2026-10-04, "Add them all back now"): a want settled `missing` because LazyLibrarian lost
-- its book (issue #665, DESIGN-028 amendment 2026-10-04) is handed back to LazyLibrarian ONCE. Journal idx 88.
-- ADDITIVE, three book_requests columns:
--   ll_rerequested_at      when that one re-request ended: LazyLibrarian took the book, or it refused it on three
--                          separate days. NULL = not yet. Never cleared, so a want lost again stays `missing`.
--   ll_rerequest_failures  how many hand-offs LazyLibrarian refused (addBook answered false or the book never
--                          appeared), e.g. its Google Books lookup out of quota.
--   ll_rerequest_failed_at the last refusal; a refused want is tried again only a day later.
-- The previous image never names the columns. A down-migration drops all three.
ALTER TABLE "book_requests" ADD COLUMN "ll_rerequested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "ll_rerequest_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "ll_rerequest_failed_at" timestamp with time zone;
