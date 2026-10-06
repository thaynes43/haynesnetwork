-- Issue #719 follow-up: the first English-edition run (2026-10-06 07:41Z) looked each want up with the structured
-- `intitle:`/`inauthor:` query only, which Google Books answers with nothing for some works (Azazel), and parked nine wants
-- `no_english_edition` that had an English edition (Azazel). The lookup now also tries the plain words. Clear the lookup
-- stamp on each such park of a person's want (goodreads) or a collection's, so it is looked at once more on the next
-- goodreads-sync run. The eight pairing parks of that run are left: their titles are the foreign library titles ("De
-- Silmarillion"), which no English lookup answers, and a park now waits a week before its next lookup. Data only: no
-- column changes, the previous image reads the same shape. Journal idx 91.
UPDATE "book_requests" SET "english_edition_tried_at" = NULL WHERE "unroutable_reason" = 'no_english_edition' AND "origin" <> 'pairing';
