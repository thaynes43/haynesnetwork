-- ADR-101 / DESIGN-028 amendment 2026-10-06 (issue #741): the Request Event. Every book_requests mint, change and
-- delete a single writer makes records one append-only row here, in the same transaction, with the decision that made
-- it (`reason`), the writer, the job (`site`), who (`actor`: sync, repair or user) and the changed fields' values
-- before and after. Until now the sync-driven writes left only log lines. `request_id` has no foreign key, so a dropped
-- collection want keeps its history. `reason` is typed in code and deliberately has no CHECK (a new writer adds its
-- reason without a migration); `kind` and `actor` are CHECK-enforced from their enums.ts arrays. Journal idx 95.
-- ADDITIVE: a new table the previous image never reads or writes, so it runs unchanged against this schema. A
-- down-migration drops the table.
CREATE TABLE "book_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"writer" text NOT NULL,
	"site" text,
	"actor" text NOT NULL,
	"actor_user_id" uuid,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_request_events_kind_enum" CHECK ("book_request_events"."kind" = ANY (ARRAY['mint','update','delete'])),
	CONSTRAINT "book_request_events_actor_enum" CHECK ("book_request_events"."actor" = ANY (ARRAY['sync','repair','user']))
);
--> statement-breakpoint
ALTER TABLE "book_request_events" ADD CONSTRAINT "book_request_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_request_events_request_created_idx" ON "book_request_events" ("request_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "book_request_events_reason_created_idx" ON "book_request_events" ("reason","created_at" DESC);
