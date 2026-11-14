-- ADR-121 / DESIGN-052 D-32. Additive; preserves every 0111 keep reason.
CREATE TABLE "trash_restore_keeps" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "arr_kind" text NOT NULL CONSTRAINT "trash_restore_keep_kind" CHECK ("arr_kind" IN ('radarr', 'sonarr')),
 "external_id" integer NOT NULL CONSTRAINT "trash_restore_keep_external" CHECK ("external_id" > 0),
 "title" text NOT NULL,
 "media_item_id" uuid REFERENCES "media_items"("id") ON DELETE SET NULL,
 "restore_run_id" uuid NOT NULL REFERENCES "restore_runs"("id"),
 "restored_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
 "created_at" timestamptz NOT NULL DEFAULT now(),
 "revoked_at" timestamptz,
 "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
 CONSTRAINT "trash_restore_keep_identity" UNIQUE ("arr_kind", "external_id")
);--> statement-breakpoint
ALTER TABLE "trash_batch_items" DROP CONSTRAINT "trash_batch_items_keep_reason_enum";--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD CONSTRAINT "trash_batch_items_keep_reason_enum" CHECK ("trash_batch_items"."keep_reason" IS NULL OR "trash_batch_items"."keep_reason" = ANY (ARRAY['tag','recently_watched','watchlisted','unevaluable','not_in_pool','live_excluded','release_unrecorded','recently_added','saved','release_unverified','release_block_full','media_request','admin_restored']));

--> statement-breakpoint
CREATE TABLE "trash_title_delete_claims" (
 "arr_kind" text NOT NULL CONSTRAINT "trash_delete_claim_kind" CHECK ("arr_kind" IN ('radarr', 'sonarr')),
 "external_id" integer NOT NULL CONSTRAINT "trash_delete_claim_external" CHECK ("external_id" > 0),
 "claim_id" uuid NOT NULL DEFAULT gen_random_uuid(),
 "claimed_at" timestamptz NOT NULL DEFAULT now(),
 "completed_at" timestamptz,
 PRIMARY KEY ("arr_kind", "external_id")
);
