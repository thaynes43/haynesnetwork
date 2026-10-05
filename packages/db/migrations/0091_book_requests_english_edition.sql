-- Issue #719: book_requests gains english_edition_tried_at, stamped whenever the app looks for an English edition of a
-- want whose LazyLibrarian book is not English (F10), so the Google Books lookup runs at most once per request per
-- quota-day whatever it finds. Journal idx 90. ADDITIVE, nullable; the previous image never names it. A down-migration
-- drops it.
ALTER TABLE "book_requests" ADD COLUMN "english_edition_tried_at" timestamp with time zone;
