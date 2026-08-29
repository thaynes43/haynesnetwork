-- ADR-086 / DESIGN-048 D-01 (PLAN-067 — durable Trash save intent). Journal idx 75. ADDITIVE changes:
--   • trash_save_intents — the DURABLE, REVOCABLE record that the household wants a title kept, keyed on
--     `media_item_id` (the *arr identity) rather than the Plex ratingKey. A Maintainerr exclusion is keyed on
--     `mediaServerId` = the ratingKey, which is NOT stable: a file replacement (upgrade grab → delete → import)
--     re-keys the Plex item and Maintainerr's nightly `removeLeftoverExclusions()` deletes the dangling
--     exclusion, silently erasing the owner's Save (Green Lantern, 2026-08-29). Maintainerr keeps ENFORCEMENT;
--     the app now owns INTENT (ADR-086 D-2, amending ADR-023 narrowly). Written ONLY by the @hnet/domain
--     save-intent single-writer, SAME-TX with the `trash_excluded` ledger row (hard rule 6).
--     `trash_save_intents_one_open_per_item` (partial unique, revoked_at IS NULL) enforces ADR-086 D-1's
--     at-most-one-open-intent invariant in the SCHEMA — the reconciler relies on it and the writer upserts
--     onto it. Revocation is EXPLICIT (`revoked_at`), never inferred from a missing exclusion — that is what
--     stops the reconciler re-protecting something the owner deliberately un-saved (ADR-086 D-3 / C-10).
--   • app_settings.key admits 'trash_relink_enabled' — the reconciler kill switch. Absent key ⇒ the documented
--     default TRUE (ADR-086 D-9: it ships ENFORCING, not census-first, because every action it takes is
--     protective, idempotent and audited). Same CHECK-rebuild pattern as 0074/0075 (drop + re-add the full
--     APP_SETTING_KEYS array, now including the new key).
--   • BACKFILL (one-off, below): seeds one open intent per media item whose LATEST `trash_excluded` event is a
--     save with a USER-ORIGINATED reason. `reason = 'watch_guardian'` is a deliberately time-scoped auto
--     protection and must never become an eternal intent (ADR-086 D-10). Expected on prod-shaped data:
--     108 rows (97 'user' + 11 'batch_save'); 20 items whose latest event is an unsave are correctly skipped.
-- A down-migration drops the table and reverts the CHECK (delete any trash_relink_enabled row first).
CREATE TABLE "trash_save_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_item_id" uuid NOT NULL,
	"media_kind" text NOT NULL,
	"maintainerr_media_id" text NOT NULL,
	"origin" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"relink_count" integer DEFAULT 0 NOT NULL,
	"last_relinked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trash_save_intents_media_kind_enum" CHECK ("trash_save_intents"."media_kind" = ANY (ARRAY['movie','tv'])),
	CONSTRAINT "trash_save_intents_origin_enum" CHECK ("trash_save_intents"."origin" = ANY (ARRAY['user','batch_save','backfill']))
);
--> statement-breakpoint
ALTER TABLE "trash_save_intents" ADD CONSTRAINT "trash_save_intents_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_save_intents" ADD CONSTRAINT "trash_save_intents_saved_by_user_id_users_id_fk" FOREIGN KEY ("saved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_save_intents" ADD CONSTRAINT "trash_save_intents_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trash_save_intents_one_open_per_item" ON "trash_save_intents" USING btree ("media_item_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "trash_save_intents_open_kind_idx" ON "trash_save_intents" USING btree ("media_kind") WHERE revoked_at IS NULL;--> statement-breakpoint
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','trash_relink_enabled','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning','upload_capacity_mbps','download_capacity_mbps','authentik_owned_groups','authentik_group_map','collection_size_cap','mam_governor_config','arr_queue_cleanup_config']));--> statement-breakpoint
-- ADR-086 D-10 — one-off backfill. `DISTINCT ON` takes the LATEST trash_excluded event per media item;
-- the outer filter then keeps only those whose latest event is a USER-ORIGINATED save. Lidarr is
-- impossible here (ADR-023 C-06 — music is never a Trash target) but is excluded explicitly so the
-- media_kind CASE can never silently mint 'tv' for it.
INSERT INTO "trash_save_intents" ("media_item_id", "media_kind", "maintainerr_media_id", "origin", "saved_at", "saved_by_user_id")
SELECT latest."media_item_id",
       CASE WHEN latest."arr_kind" = 'radarr' THEN 'movie' ELSE 'tv' END,
       latest."maintainerr_media_id",
       'backfill',
       latest."occurred_at",
       latest."requested_by_user_id"
FROM (
  SELECT DISTINCT ON (le."media_item_id")
         le."media_item_id",
         mi."arr_kind"                             AS "arr_kind",
         le."payload"->>'maintainerrMediaId'       AS "maintainerr_media_id",
         le."payload"->>'action'                   AS "action",
         COALESCE(le."payload"->>'reason', 'user') AS "reason",
         le."occurred_at",
         le."requested_by_user_id"
  FROM "ledger_events" le
  JOIN "media_items" mi ON mi."id" = le."media_item_id"
  WHERE le."event_type" = 'trash_excluded'
    AND le."media_item_id" IS NOT NULL
    AND mi."arr_kind" IN ('radarr', 'sonarr')
  ORDER BY le."media_item_id", le."occurred_at" DESC
) latest
WHERE latest."action" = 'save'
  AND latest."reason" IN ('user', 'batch_save')
  AND latest."maintainerr_media_id" IS NOT NULL;
