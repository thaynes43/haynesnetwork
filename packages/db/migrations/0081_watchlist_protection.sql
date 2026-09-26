-- ADR-093 / DESIGN-052 D-05 (PLAN-072 — watchlists protect titles from Trash; a re-request never re-fetches the
-- deleted release). Journal idx 80. ADDITIVE: eight new tables, three new columns and two CHECK relaxes; nothing is
-- dropped or rewritten, so the previous image runs unchanged against it (the ordered rollback leaves it in place).
--   • watchlist_registry_runs / _accounts / _sources / _items and plex_discover_ids — the Watchlist Registry (T-261)
--     the Registry Gate (T-262) and the Watchlist Keep (T-263) read; per-(account, source) state (D-04).
--   • trash_deleted_releases — the Deleted-Release Record (T-264) the Release Block (T-265) derives its terms from.
--     No URL column exists on purpose: NZB and download URLs carry indexer API keys.
--   • seerr_watchlist_enrollments — Seerr Watchlist Enrollment (T-266), enroll once (D-17).
--   • trash_sweep_status — the one-row record of the scheduled sweep's last outcome (D-14).
--   • trash_batch_items.keep_reason; trash_candidates.plex_guid and .rule_evaluation_failed (D-05, D-06, D-09).
--   • sync_runs.run_kind admits 'watchlist-registry' (parity only — the mode writes no sync_runs row).
--   • app_settings.key admits 'seerr_watchlist_enroll' (absent ⇒ off; DESIGN-052 D-25: D-05's "no DDL" missed that
--     the key CHECK needs this rebuild).
CREATE TABLE "watchlist_registry_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"failure" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "watchlist_registry_runs_trigger_enum" CHECK ("watchlist_registry_runs"."trigger" = ANY (ARRAY['schedule','sweep','manual'])),
	CONSTRAINT "watchlist_registry_runs_status_enum" CHECK ("watchlist_registry_runs"."status" = ANY (ARRAY['running','ok','failed'])),
	CONSTRAINT "watchlist_registry_runs_failure_enum" CHECK ("watchlist_registry_runs"."failure" IS NULL OR "watchlist_registry_runs"."failure" = ANY (ARRAY['roster','owner','owner_truncated','error']))
);
--> statement-breakpoint
CREATE INDEX "watchlist_registry_runs_status_finished_idx" ON "watchlist_registry_runs" USING btree ("status","finished_at" DESC);--> statement-breakpoint
CREATE TABLE "watchlist_registry_accounts" (
	"plex_account_id" text PRIMARY KEY NOT NULL,
	"class" text NOT NULL,
	"plex_uuid" text,
	"seerr_user_id" integer,
	"status" text DEFAULT 'never_read' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"item_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_registry_accounts_class_enum" CHECK ("watchlist_registry_accounts"."class" = ANY (ARRAY['owner','home_full','home_managed','friend','seerr_only'])),
	CONSTRAINT "watchlist_registry_accounts_status_enum" CHECK ("watchlist_registry_accounts"."status" = ANY (ARRAY['never_read','read','carried','unresolvable','unreadable']))
);
--> statement-breakpoint
CREATE TABLE "watchlist_registry_sources" (
	"plex_account_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'never_read' NOT NULL,
	"last_outcome" text NOT NULL,
	"last_error_class" text,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_ok_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"last_ok_count" integer,
	"empty_unverified" boolean DEFAULT false NOT NULL,
	"hidden_logged_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_registry_sources_plex_account_id_source_pk" PRIMARY KEY("plex_account_id","source"),
	CONSTRAINT "watchlist_registry_sources_source_enum" CHECK ("watchlist_registry_sources"."source" = ANY (ARRAY['discover','community','seerr','switch'])),
	CONSTRAINT "watchlist_registry_sources_status_enum" CHECK ("watchlist_registry_sources"."status" = ANY (ARRAY['never_read','read','carried','unreadable','not_applicable'])),
	CONSTRAINT "watchlist_registry_sources_outcome_enum" CHECK ("watchlist_registry_sources"."last_outcome" = ANY (ARRAY['ok','failed','not_applicable']))
);
--> statement-breakpoint
ALTER TABLE "watchlist_registry_sources" ADD CONSTRAINT "watchlist_registry_sources_plex_account_id_watchlist_registry_accounts_plex_account_id_fk" FOREIGN KEY ("plex_account_id") REFERENCES "public"."watchlist_registry_accounts"("plex_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "watchlist_registry_items" (
	"plex_account_id" text NOT NULL,
	"discover_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"imdb_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_registry_items_plex_account_id_discover_id_source_pk" PRIMARY KEY("plex_account_id","discover_id","source"),
	CONSTRAINT "watchlist_registry_items_kind_enum" CHECK ("watchlist_registry_items"."kind" = ANY (ARRAY['movie','show'])),
	CONSTRAINT "watchlist_registry_items_source_enum" CHECK ("watchlist_registry_items"."source" = ANY (ARRAY['discover','community','seerr','switch'])),
	CONSTRAINT "watchlist_registry_items_discover_id_format" CHECK ("watchlist_registry_items"."discover_id" ~ '^[0-9a-f]{24}$')
);
--> statement-breakpoint
ALTER TABLE "watchlist_registry_items" ADD CONSTRAINT "watchlist_registry_items_plex_account_id_watchlist_registry_accounts_plex_account_id_fk" FOREIGN KEY ("plex_account_id") REFERENCES "public"."watchlist_registry_accounts"("plex_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watchlist_registry_items_discover_idx" ON "watchlist_registry_items" USING btree ("discover_id");--> statement-breakpoint
CREATE INDEX "watchlist_registry_items_kind_tmdb_idx" ON "watchlist_registry_items" USING btree ("kind","tmdb_id");--> statement-breakpoint
CREATE INDEX "watchlist_registry_items_kind_tvdb_idx" ON "watchlist_registry_items" USING btree ("kind","tvdb_id");--> statement-breakpoint
CREATE TABLE "plex_discover_ids" (
	"discover_id" text PRIMARY KEY NOT NULL,
	"kind" text,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"imdb_id" text,
	"resolved_at" timestamp with time zone,
	"not_found_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "plex_discover_ids_discover_id_format" CHECK ("plex_discover_ids"."discover_id" ~ '^[0-9a-f]{24}$'),
	CONSTRAINT "plex_discover_ids_kind_enum" CHECK ("plex_discover_ids"."kind" IS NULL OR "plex_discover_ids"."kind" = ANY (ARRAY['movie','show']))
);
--> statement-breakpoint
CREATE TABLE "trash_deleted_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arr_kind" text NOT NULL,
	"arr_item_id" integer,
	"media_item_id" uuid,
	"batch_item_id" uuid,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"imdb_id" text,
	"title" text NOT NULL,
	"year" integer,
	"season" integer,
	"identity_source" text NOT NULL,
	"release_title" text,
	"release_group" text,
	"quality" text,
	"resolution" integer,
	"size_bytes" bigint,
	"file_name" text,
	"indexer" text,
	"years" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"term" text,
	"term_confidence" text,
	"state" text DEFAULT 'in_flight' NOT NULL,
	"origin" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"readd_seen_at" timestamp with time zone,
	"readd_same_release" boolean,
	CONSTRAINT "trash_deleted_releases_arr_kind_enum" CHECK ("trash_deleted_releases"."arr_kind" = ANY (ARRAY['radarr','sonarr'])),
	CONSTRAINT "trash_deleted_releases_identity_source_enum" CHECK ("trash_deleted_releases"."identity_source" = ANY (ARRAY['arr_grab_history','arr_file','ledger_grab','legacy_sab','none'])),
	CONSTRAINT "trash_deleted_releases_term_confidence_enum" CHECK ("trash_deleted_releases"."term_confidence" IS NULL OR "trash_deleted_releases"."term_confidence" = ANY (ARRAY['verified','low_confidence'])),
	CONSTRAINT "trash_deleted_releases_state_enum" CHECK ("trash_deleted_releases"."state" = ANY (ARRAY['in_flight','active','abandoned','expired','pruned'])),
	CONSTRAINT "trash_deleted_releases_origin_enum" CHECK ("trash_deleted_releases"."origin" = ANY (ARRAY['sweep','expedite','backfill','remediation']))
);
--> statement-breakpoint
ALTER TABLE "trash_deleted_releases" ADD CONSTRAINT "trash_deleted_releases_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_deleted_releases" ADD CONSTRAINT "trash_deleted_releases_batch_item_id_trash_batch_items_id_fk" FOREIGN KEY ("batch_item_id") REFERENCES "public"."trash_batch_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trash_deleted_releases_arr_state_idx" ON "trash_deleted_releases" USING btree ("arr_kind","state");--> statement-breakpoint
CREATE INDEX "trash_deleted_releases_media_item_idx" ON "trash_deleted_releases" USING btree ("media_item_id");--> statement-breakpoint
CREATE INDEX "trash_deleted_releases_tmdb_idx" ON "trash_deleted_releases" USING btree ("tmdb_id");--> statement-breakpoint
CREATE INDEX "trash_deleted_releases_tvdb_idx" ON "trash_deleted_releases" USING btree ("tvdb_id");--> statement-breakpoint
CREATE TABLE "seerr_watchlist_enrollments" (
	"seerr_user_id" integer PRIMARY KEY NOT NULL,
	"plex_account_id" text,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"already_on" boolean DEFAULT false NOT NULL,
	"optout_observed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trash_sweep_status" (
	"id" smallint PRIMARY KEY NOT NULL,
	"last_outcome" text NOT NULL,
	"last_reason" text,
	"last_at" timestamp with time zone NOT NULL,
	"paused_since" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	CONSTRAINT "trash_sweep_status_singleton" CHECK ("trash_sweep_status"."id" = 1),
	CONSTRAINT "trash_sweep_status_outcome_enum" CHECK ("trash_sweep_status"."last_outcome" = ANY (ARRAY['ok','paused_gate','paused_release_block','paused_audit_unsafe','aborted_arr']))
);
--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD COLUMN "keep_reason" text;--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD CONSTRAINT "trash_batch_items_keep_reason_enum" CHECK ("trash_batch_items"."keep_reason" IS NULL OR "trash_batch_items"."keep_reason" = ANY (ARRAY['tag','recently_watched','watchlisted','unevaluable','not_in_pool','live_excluded','release_unrecorded']));--> statement-breakpoint
ALTER TABLE "trash_candidates" ADD COLUMN "plex_guid" text;--> statement-breakpoint
ALTER TABLE "trash_candidates" ADD COLUMN "rule_evaluation_failed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- sync_runs.run_kind admits 'watchlist-registry' (parity only — the mode writes no sync_runs row).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan','failure-digest','collections-sync','format-pairing','books-collections-sync','queue-cleanup','watch','watchlist-registry']));--> statement-breakpoint
-- app_settings.key admits 'seerr_watchlist_enroll' (the audited Seerr enrollment switch, D-17; absent ⇒ off).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','trash_relink_enabled','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning','upload_capacity_mbps','download_capacity_mbps','authentik_owned_groups','authentik_group_map','collection_size_cap','mam_governor_config','arr_queue_cleanup_config','seerr_watchlist_enroll']));
