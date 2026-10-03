-- ADR-099 (owner ruling 2026-10-03, "if someone clicks save it's saved forever"): a Trash Save is recorded by the app
-- first and the Maintainerr exclusion follows it. Journal idx 87. ADDITIVE, three parts:
-- (1) trash_save_intents gains the enforcement state of a Save: exclusion_confirmed_at (when Maintainerr was last read
--     back holding the exclusion; NULL = recorded, exclusion still pending), apply_attempts, last_apply_attempt_at,
--     last_apply_error. Every existing intent was opened after its exclusion was written or found (the old
--     Maintainerr-first order), so each is stamped confirmed at its newest known point (last relink, else the save).
-- (2) trash_batch_items.keep_reason admits `saved`: the sweep keeps a pending batch row whose title carries an open
--     save intent (a Save made on another surface).
-- (3) nothing else: the `trash_excluded` ledger reason `reapply` lives in jsonb (no CHECK).
-- The previous image never names the new columns and never writes the new reason, so it runs unchanged against this
-- schema. A down-migration clears `saved` reasons to null, restores the 0086 CHECK and drops the four columns.
ALTER TABLE "trash_save_intents" ADD COLUMN "exclusion_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trash_save_intents" ADD COLUMN "apply_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trash_save_intents" ADD COLUMN "last_apply_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trash_save_intents" ADD COLUMN "last_apply_error" text;--> statement-breakpoint
UPDATE "trash_save_intents" SET "exclusion_confirmed_at" = COALESCE("last_relinked_at", "saved_at");--> statement-breakpoint
ALTER TABLE "trash_batch_items" DROP CONSTRAINT "trash_batch_items_keep_reason_enum";--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD CONSTRAINT "trash_batch_items_keep_reason_enum" CHECK ("trash_batch_items"."keep_reason" IS NULL OR "trash_batch_items"."keep_reason" = ANY (ARRAY['tag','recently_watched','watchlisted','unevaluable','not_in_pool','live_excluded','release_unrecorded','recently_added','saved']));
