-- Issue #740 / DESIGN-036 amendment 2026-10-06: the Mint Backoff. format-pairing re-tried the same unresolvable wants
-- every hour (attempted 100, unmintable about 95 per run on 2026-10-05) and spent its whole daily Google Books slice on
-- them. A pairing want whose Google Books lookup finds no usable book now waits 1, 3, 7, then 30 days before the next
-- lookup (`mint_backoff_until`), counted in `mint_backoff_count` for the identity it was tried under
-- (`mint_backoff_key`: title key, author, ISBN); a changed identity is tried at once. Journal idx 93. ADDITIVE: the count
-- defaults to 0 and the others are nullable, so the previous image, which never names them, runs unchanged. A
-- down-migration drops the three columns.
ALTER TABLE "book_requests" ADD COLUMN "mint_backoff_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "mint_backoff_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "mint_backoff_key" text;
