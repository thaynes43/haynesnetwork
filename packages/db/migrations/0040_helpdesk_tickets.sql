-- ADR-050 / DESIGN-012 D-10..D-13 (PLAN-034 Helpdesk) — the Bulletin Messages board becomes a
-- media-issue TICKET system:
--   • tickets — a household media-issue report: required title + intake category, optional linked
--     Media Item, a state machine (open → in_progress → complete | rejected; the matrix lives in
--     @hnet/domain TICKET_TRANSITIONS), and last_activity_at (the wall's sort key, bumped by every
--     reply/transition in the same tx). Written only by the @hnet/domain ticket single-writers.
--   • ticket_events — the APPEND-ONLY event history: creation (from_status NULL → open) + every
--     transition, each with an optional household-visible note (requirement 5 — full history).
--     actor_user_id SET NULL on account deletion so the history outlives the account.
--   • ticket_replies — the flat reply thread (any member with the Bulletin `messages` sub-view
--     grant may reply — owner ruling Q-02). Immutable v1.
--   • notification_outbox event-type CHECK rebuilt to admit 'ticket_created' — createTicket
--     enqueues the admins' Pushover ping in the SAME tx as the ticket insert (ADR-034 C-01, Q-04).
--   • DROP TABLE messages — the ADR-026 board rows are TEST DATA, not household history (owner
--     ruling Q-03); the board surface is replaced wholesale by tickets. The Feed (`notifications`)
--     and the grant tables (role_message_action_grants / role_bulletin_view_grants) are UNTOUCHED —
--     the stored grant values keep gating the Helpdesk (create = post, transitions = moderate).
-- A down-migration drops the three ticket tables, reverts the outbox CHECK, and recreates the
-- (empty) messages table per 0018.

--> statement-breakpoint
-- tickets: the household media-issue reports (the Helpdesk wall).
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text NOT NULL,
	"media_item_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_status_enum" CHECK ("tickets"."status" = ANY (ARRAY['open','in_progress','complete','rejected'])),
	CONSTRAINT "tickets_category_enum" CHECK ("tickets"."category" = ANY (ARRAY['playback','audio','subtitles','quality','missing','other']))
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_activity_idx" ON "tickets" USING btree ("last_activity_at" DESC);--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tickets_author_idx" ON "tickets" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "tickets_media_item_idx" ON "tickets" USING btree ("media_item_id");--> statement-breakpoint

-- ticket_events: the append-only creation + transition history (the detail page's timeline).
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_events_to_status_enum" CHECK ("ticket_events"."to_status" = ANY (ARRAY['open','in_progress','complete','rejected'])),
	CONSTRAINT "ticket_events_from_status_enum" CHECK ("ticket_events"."from_status" IS NULL OR "ticket_events"."from_status" = ANY (ARRAY['open','in_progress','complete','rejected']))
);
--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","created_at");--> statement-breakpoint

-- ticket_replies: the flat reply thread (oldest-first under the ticket detail).
CREATE TABLE "ticket_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_replies" ADD CONSTRAINT "ticket_replies_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_replies" ADD CONSTRAINT "ticket_replies_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_replies_ticket_idx" ON "ticket_replies" USING btree ("ticket_id","created_at");--> statement-breakpoint

-- notification_outbox event-type CHECK rebuild: admit 'ticket_created' (preserving every prior value).
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_event_type_enum";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_event_type_enum" CHECK ("notification_outbox"."event_type" = ANY (ARRAY['batch_created','batch_leaving_soon','batch_leaving_soon_reminder','batch_final_warning','batch_swept','smart_degraded','smart_recovered','ticket_created']));--> statement-breakpoint

-- The old Messages board goes with its surface: the rows are owner-ruled TEST DATA (Q-03) and the
-- tickets aggregate replaces the board wholesale. (Post-deploy, a few realistic example tickets are
-- filed through the app's own writers and LEFT in prod as onboarding examples — Q-03.)
DROP TABLE "messages";
