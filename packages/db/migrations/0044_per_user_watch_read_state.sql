-- ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user watch/read-state attribution). Three ADDITIVE tables;
-- the household aggregates on media_metadata (play_count/last_viewed_at/last_watched_*) are UNTOUCHED
-- (ADR-053 C-03 — per-user is additive, never a replacement):
--   • user_account_map — the app-user ↔ media-account MAPPING seam (one row per app user): plex_user_id
--     (the Tautulli history join key, auto-filled from the OIDC claim / friend matchers), abs_user_id
--     (the ABS mediaProgress admin-read key), kavita_username (carried; Kavita read-state DEFERRED —
--     ADR-053 C-05). Mirrors the users.plex_email/plex_username override pattern. The Feed-attribution
--     backlog reuses this seam verbatim (ADR-053 C-01). UNIQUE on plex_user_id / abs_user_id (NULLs
--     exempt — many users unmapped).
--   • user_media_watch — the per-user VIDEO watch read-model, one row per (media_item, app_user):
--     watched / in_progress + this user's play_count / last_viewed_at, re-keyed from the Tautulli
--     history user_id through the map. The ADR-051 per-user facets read it (populated-value-gated).
--   • user_book_progress — the per-user ABS book read-state, one row per (books_item, app_user):
--     is_finished / progress (0..1) / in_progress from the ABS admin mediaProgress[] read. Audiobooks
--     only (Kavita DEFERRED).
-- All three are guarded single-writer tables (no audit — synced/descriptive, the media_metadata class).
-- Down: DROP the three tables (they carry no dependents; cascade FKs clean up on user/item delete).
CREATE TABLE "user_account_map" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plex_user_id" text,
	"abs_user_id" text,
	"kavita_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_account_map_plex_user_unique" UNIQUE("plex_user_id"),
	CONSTRAINT "user_account_map_abs_user_unique" UNIQUE("abs_user_id")
);
--> statement-breakpoint
CREATE TABLE "user_media_watch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_item_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"play_count" integer,
	"last_viewed_at" timestamp with time zone,
	"watched" boolean DEFAULT false NOT NULL,
	"in_progress" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_media_watch_item_user_unique" UNIQUE("media_item_id","app_user_id")
);
--> statement-breakpoint
CREATE TABLE "user_book_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"books_item_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"is_finished" boolean DEFAULT false NOT NULL,
	"progress" double precision,
	"in_progress" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_book_progress_item_user_unique" UNIQUE("books_item_id","app_user_id")
);
--> statement-breakpoint
ALTER TABLE "user_account_map" ADD CONSTRAINT "user_account_map_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_media_watch" ADD CONSTRAINT "user_media_watch_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_media_watch" ADD CONSTRAINT "user_media_watch_app_user_id_users_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_book_progress" ADD CONSTRAINT "user_book_progress_books_item_id_books_items_id_fk" FOREIGN KEY ("books_item_id") REFERENCES "public"."books_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_book_progress" ADD CONSTRAINT "user_book_progress_app_user_id_users_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_media_watch_user_idx" ON "user_media_watch" USING btree ("app_user_id");--> statement-breakpoint
CREATE INDEX "user_book_progress_user_idx" ON "user_book_progress" USING btree ("app_user_id");
