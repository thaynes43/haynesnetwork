-- ADR-060 / DESIGN-031 (PLAN-035 — ticket email notifications). ADDITIVE changes:
--   • notification_preferences — a user's own notification opt-ins (first field:
--     email_ticket_updates, default false — R-196). One row per user, cascade on user delete.
--     Written ONLY by @hnet/domain setNotificationPreference; NO audit row (descriptive per-user
--     state — the library_preferences precedent, ADR-052 C-04 / hard rule 6 exempt).
--   • NOTIFY_OUTBOX_CHANNELS grows 'email' (ADR-060 C-01 — the first second channel; email rows
--     carry payload.to resolved at enqueue time, same-tx) and NOTIFY_OUTBOX_EVENT_TYPES grows
--     'ticket_replied' / 'ticket_status_changed' (DESIGN-031 D-02) — parity CHECK rebuilds only
--     (the 0024/0030/0033/0040/0041/0048 relax pattern).
-- A down-migration drops the table and reverts the two CHECKs (delete any email-channel /
-- ticket_replied / ticket_status_changed outbox rows first).
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email_ticket_updates" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_unique" UNIQUE("user_id")
);--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_channel_enum";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_channel_enum" CHECK ("notification_outbox"."channel" = ANY (ARRAY['pushover','email']));--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_event_type_enum";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_event_type_enum" CHECK ("notification_outbox"."event_type" = ANY (ARRAY['batch_created','batch_leaving_soon','batch_leaving_soon_reminder','batch_final_warning','batch_swept','smart_degraded','smart_recovered','ticket_created','mam_gate_paused','mam_gate_resumed','mam_gate_stuck','activity_import_failed','ticket_replied','ticket_status_changed']));
