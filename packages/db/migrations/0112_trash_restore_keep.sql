-- ADR-121 / DESIGN-052 D-32. Additive; preserves every 0111 keep reason.
CREATE TABLE "trash_restore_keeps" (
 "media_item_id" uuid PRIMARY KEY REFERENCES "media_items"("id") ON DELETE CASCADE,
 "restore_run_id" uuid NOT NULL REFERENCES "restore_runs"("id"),
 "restored_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
 "created_at" timestamptz NOT NULL DEFAULT now(),
 "revoked_at" timestamptz,
 "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);--> statement-breakpoint
ALTER TABLE "trash_batch_items" DROP CONSTRAINT "trash_batch_items_keep_reason_enum";--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD CONSTRAINT "trash_batch_items_keep_reason_enum" CHECK ("trash_batch_items"."keep_reason" IS NULL OR "trash_batch_items"."keep_reason" = ANY (ARRAY['tag','recently_watched','watchlisted','unevaluable','not_in_pool','live_excluded','release_unrecorded','recently_added','saved','release_unverified','release_block_full','media_request','admin_restored']));
