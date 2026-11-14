-- ADR-118 / DESIGN-052 D-30: the sweep may record keep_reason `media_request` when a pending
-- batch row's title carries the mediarequests tag. Journal idx 109, after 0110. ADDITIVE: the
-- CHECK keeps every value 0110 allows, including `release_unverified` and `release_block_full`,
-- and adds `media_request`.
-- The previous image never writes the new reason, so it runs unchanged against this schema.
ALTER TABLE "trash_batch_items" DROP CONSTRAINT "trash_batch_items_keep_reason_enum";--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD CONSTRAINT "trash_batch_items_keep_reason_enum" CHECK ("trash_batch_items"."keep_reason" IS NULL OR "trash_batch_items"."keep_reason" = ANY (ARRAY['tag','recently_watched','watchlisted','unevaluable','not_in_pool','live_excluded','release_unrecorded','recently_added','saved','release_unverified','release_block_full','media_request']));
