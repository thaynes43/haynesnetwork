-- ADR-088 / ADR-089 / DESIGN-049 D-07 (PLAN-068 S2 — the Watch Companion). Journal idx 76. ADDITIVE changes:
--   • watch_accounts — the tracked Plex accounts, keyed by the plex.tv numeric id (= Tautulli user_id). v1 tracks
--     one row: the Server Owner (ADR-029), written by the `watch` sync from getOwnerAccount(). The partial unique
--     index `watch_accounts_one_owner` makes "exactly one principal" a SCHEMA invariant — the MCP surface resolves
--     its principal as THE owner row (DESIGN-049 D-03), so a second owner row must be impossible, not merely unwritten.
--   • watch_events — the APPEND-ONLY Watch Event log (T-243): every Tautulli history row of a tracked account on all
--     three instances, insert-or-ignore on (instance, tautulli_row_id). `tautulli_row_id` is the history row's
--     `row_id` — verified live 2026-09-23 as the stable per-row id under grouping=0 (`id` mirrors it; `reference_id`
--     is the GROUP's first row and repeats across rows). Never capped, never re-read (ADR-088 C-02).
--   • watch_titles — the Title State snapshot (T-244): one row per (account, title_key) — a show or a movie, the
--     per-server Plex progress united, event facts and ledger links attached. Upserted, never deleted.
--   • watch_marks — Watch Marks (T-248): the owner's explicit statements (`watched` / `not_interested` /
--     `not_mine`), each row carrying the exact Plex keys it flipped (`flipped`) so undo reverses precisely that.
--     The rows ARE the audit trail (no permission_audit coupling — the poster_guard_applications class).
--   • watch_reco_signals — the recommendation input cache (ADR-089): the owner's plex.tv watchlist and the daily
--     TMDB recommendation seeds; each run replaces one source's rows for the account in one transaction.
--   • sync_runs.run_kind admits 'watch' (the 0024/0030/0048/0056/0075 relax pattern: drop + re-add the full ARRAY
--     from SYNC_RUN_KINDS, now with the new key). Parity only — the mode writes no sync_runs row.
-- Every enumerated column is text + CHECK built from its enums.ts const array (DESIGN-001 D-02); the nullable ones
-- admit NULL. `users.id` and `media_items.id` are uuid, so the three FKs to them are uuid (DESIGN-049 D-07 said
-- "users.id is text" — it is not; recorded in the design). All five tables are written ONLY by @hnet/domain
-- single-writers (the no-direct-state-writes guard lists them).
-- A down-migration drops the five tables (children first) and reverts the run_kind CHECK.
CREATE TABLE "watch_accounts" (
	"plex_account_id" bigint PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"role" text NOT NULL,
	"app_user_id" uuid,
	"tracked" boolean DEFAULT true NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_accounts_role_enum" CHECK ("watch_accounts"."role" = ANY (ARRAY['owner','household']))
);
--> statement-breakpoint
ALTER TABLE "watch_accounts" ADD CONSTRAINT "watch_accounts_app_user_id_users_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_accounts_one_owner" ON "watch_accounts" USING btree ("role") WHERE role = 'owner';--> statement-breakpoint
CREATE TABLE "watch_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plex_account_id" bigint NOT NULL,
	"instance" text NOT NULL,
	"tautulli_row_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"item_guid" text,
	"show_guid" text,
	"title" text NOT NULL,
	"show_title" text,
	"season" integer,
	"episode" integer,
	"year" integer,
	"rating_key" text,
	"grandparent_rating_key" text,
	"started_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"percent_complete" smallint,
	"watched" boolean NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_events_instance_row_unique" UNIQUE("instance","tautulli_row_id"),
	CONSTRAINT "watch_events_instance_enum" CHECK ("watch_events"."instance" = ANY (ARRAY['haynestower','haynesops','hayneskube'])),
	CONSTRAINT "watch_events_kind_enum" CHECK ("watch_events"."kind" = ANY (ARRAY['movie','episode']))
);
--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_plex_account_id_watch_accounts_plex_account_id_fk" FOREIGN KEY ("plex_account_id") REFERENCES "public"."watch_accounts"("plex_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_events_account_started_idx" ON "watch_events" USING btree ("plex_account_id","started_at" DESC);--> statement-breakpoint
CREATE INDEX "watch_events_account_show_idx" ON "watch_events" USING btree ("plex_account_id","show_guid");--> statement-breakpoint
CREATE TABLE "watch_titles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plex_account_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"title_key" text NOT NULL,
	"plex_guid" text,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"imdb_id" text,
	"media_item_id" uuid,
	"title" text NOT NULL,
	"year" integer,
	"genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_rating" text,
	"is_kids" boolean DEFAULT false NOT NULL,
	"on_plex" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plex_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"episode_map" jsonb,
	"episodes_total" integer,
	"episodes_watched" integer,
	"furthest_season" integer,
	"furthest_episode" integer,
	"next_season" integer,
	"next_episode" integer,
	"next_title" text,
	"next_server" text,
	"next_rating_key" text,
	"next_resume" boolean DEFAULT false NOT NULL,
	"resume_percent" smallint,
	"plex_watched" boolean DEFAULT false NOT NULL,
	"plex_last_viewed_at" timestamp with time zone,
	"event_plays" integer DEFAULT 0 NOT NULL,
	"event_watched_episodes" integer DEFAULT 0 NOT NULL,
	"first_watched_at" timestamp with time zone,
	"last_watched_at" timestamp with time zone,
	"rewatch" boolean DEFAULT false NOT NULL,
	"show_status" text,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_titles_account_title_key_unique" UNIQUE("plex_account_id","title_key"),
	CONSTRAINT "watch_titles_kind_enum" CHECK ("watch_titles"."kind" = ANY (ARRAY['show','movie'])),
	CONSTRAINT "watch_titles_next_server_enum" CHECK ("watch_titles"."next_server" IS NULL OR "watch_titles"."next_server" = ANY (ARRAY['haynestower','haynesops','hayneskube'])),
	CONSTRAINT "watch_titles_show_status_enum" CHECK ("watch_titles"."show_status" IS NULL OR "watch_titles"."show_status" = ANY (ARRAY['continuing','ended']))
);
--> statement-breakpoint
ALTER TABLE "watch_titles" ADD CONSTRAINT "watch_titles_plex_account_id_watch_accounts_plex_account_id_fk" FOREIGN KEY ("plex_account_id") REFERENCES "public"."watch_accounts"("plex_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_titles" ADD CONSTRAINT "watch_titles_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "watch_marks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plex_account_id" bigint NOT NULL,
	"action" text NOT NULL,
	"scope" text NOT NULL,
	"title_key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"year" integer,
	"plex_guid" text,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"imdb_id" text,
	"season" integer,
	"episode" integer,
	"query" text NOT NULL,
	"consumer" text NOT NULL,
	"actor_user_id" uuid,
	"flipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plex_result" text NOT NULL,
	"plex_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone,
	"revert_result" text,
	CONSTRAINT "watch_marks_action_enum" CHECK ("watch_marks"."action" = ANY (ARRAY['watched','not_interested','not_mine'])),
	CONSTRAINT "watch_marks_scope_enum" CHECK ("watch_marks"."scope" = ANY (ARRAY['movie','show','season','episode','through'])),
	CONSTRAINT "watch_marks_kind_enum" CHECK ("watch_marks"."kind" = ANY (ARRAY['show','movie'])),
	CONSTRAINT "watch_marks_plex_result_enum" CHECK ("watch_marks"."plex_result" = ANY (ARRAY['pending','written','partial','not_on_plex','failed','none'])),
	CONSTRAINT "watch_marks_revert_result_enum" CHECK ("watch_marks"."revert_result" IS NULL OR "watch_marks"."revert_result" = ANY (ARRAY['written','partial','failed','none']))
);
--> statement-breakpoint
ALTER TABLE "watch_marks" ADD CONSTRAINT "watch_marks_plex_account_id_watch_accounts_plex_account_id_fk" FOREIGN KEY ("plex_account_id") REFERENCES "public"."watch_accounts"("plex_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_marks" ADD CONSTRAINT "watch_marks_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_marks_account_created_idx" ON "watch_marks" USING btree ("plex_account_id","created_at" DESC);--> statement-breakpoint
CREATE TABLE "watch_reco_signals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plex_account_id" bigint NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"year" integer,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"imdb_id" text,
	"plex_guid" text,
	"seed_title_key" text,
	"seed_title" text,
	"rank" smallint NOT NULL,
	"added_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_reco_signals_source_enum" CHECK ("watch_reco_signals"."source" = ANY (ARRAY['watchlist','tmdb_seed'])),
	CONSTRAINT "watch_reco_signals_kind_enum" CHECK ("watch_reco_signals"."kind" = ANY (ARRAY['show','movie']))
);
--> statement-breakpoint
ALTER TABLE "watch_reco_signals" ADD CONSTRAINT "watch_reco_signals_plex_account_id_watch_accounts_plex_account_id_fk" FOREIGN KEY ("plex_account_id") REFERENCES "public"."watch_accounts"("plex_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- sync_runs.run_kind admits 'watch' (parity only — the mode writes no sync_runs row).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan','failure-digest','collections-sync','format-pairing','books-collections-sync','queue-cleanup','watch']));
