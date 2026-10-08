-- DESIGN-036 / T-294 (issue #825): preserve unread counterpart reservations when strict pairs drop.
-- Additive derived read-model, never a Format Pair or held-file assertion. Sole writer: syncFormatPairs.
CREATE TABLE "books_pairing_reservations" (
  "book_item_id" uuid NOT NULL REFERENCES "books_items"("id") ON DELETE CASCADE,
  "audio_item_id" uuid NOT NULL REFERENCES "books_items"("id") ON DELETE CASCADE,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("book_item_id", "audio_item_id")
);
--> statement-breakpoint
CREATE INDEX "books_pairing_reservations_audio_idx" ON "books_pairing_reservations" ("audio_item_id");
