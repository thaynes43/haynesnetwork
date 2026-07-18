-- DESIGN-038 D-13 (2026-07-18) — Books/Audiobooks collection WANTED tiles. A books OR audiobooks
-- collection that is not full must render its MISSING members as Wanted tiles beside the held ones
-- (the owner's Stormlight "3 held + 15 wanted" view). The movies leg shipped this via
-- plex_collection_members held/wanted rows (migration 0065); the wanted-row model is medium-neutral,
-- but books have no *arr ledger for the not-held members — so a collection's missing members are minted
-- as `book_requests` rows with a NEW origin `'collection'` (the DESIGN-038 D-16 deferred slot), sourced
-- from Libretto's member-level missing endpoint (`read.listMissingMembers(recipeId)`).
--
-- This migration adds the storage:
--   1. `books_collections.libretto_recipe_id` — the recipeId Libretto embedded in its `[libretto:<id>]`
--      description marker (already parsed for provenance, DESIGN-038 D-11). Captured on the mirror so
--      the wanted pass can call `listMissingMembers(recipeId)` with an EXACT id-join (the movies-leg
--      "capture the id" hardening lever, applied here rather than deferred). NULLABLE + OPEN — null for
--      a hand-made (non-Libretto) collection, which has no recipe and therefore no wanted members.
--   2. `book_requests` grows the COLLECTION-WANT seat, disjoint from goodreads/pairing:
--        • `collection_id`  uuid FK → books_collections ON DELETE CASCADE (the want belongs to a
--          collection; a vanished mirror collection cascade-drops its wants — no orphans).
--        • `collection_member_ref` text — the stable per-member key within the collection
--          (ISBN-13 → identifier → normalized title), the idempotency key so a re-run never dupes a want.
--        • origin CHECK rebuilt to admit 'collection'; the origin↔keys coherence CHECK gains the
--          collection branch (collection_id + collection_member_ref NOT NULL) — no half-keyed row.
--        • a PARTIAL unique (collection_id, collection_member_ref) WHERE origin='collection' keys the
--          collection wants; goodreads/pairing rows (collection_id NULL) never collide on it.
--        • an index on collection_id for the drill's collection-scoped wanted read.
--
-- The collection wants are a REBUILDABLE derived cache of Libretto's current missing set (the
-- plex_collection_members wanted-row class): the wanted pass upserts the present-missing members and
-- reconcile-DELETES the ones no longer missing (a member that became held drops out of Libretto's list
-- and its want resolves). Single-writer (@hnet/domain book-requests.ts, guard-listed), no audit rows.
-- A down-migration deletes origin='collection' rows first, then drops the partial unique, the index, the
-- two book_requests columns and the books_collections column, and reverts the two CHECKs.
ALTER TABLE "books_collections" ADD COLUMN "libretto_recipe_id" text;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "collection_id" uuid;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "collection_member_ref" text;--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_collection_id_books_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."books_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_requests" DROP CONSTRAINT "book_requests_origin_enum";--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_origin_enum" CHECK ("book_requests"."origin" = ANY (ARRAY['goodreads','pairing','collection']));--> statement-breakpoint
ALTER TABLE "book_requests" DROP CONSTRAINT "book_requests_origin_keys";--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_origin_keys" CHECK (("book_requests"."origin" = 'goodreads' AND "book_requests"."shelf_item_id" IS NOT NULL AND "book_requests"."integration_id" IS NOT NULL) OR ("book_requests"."origin" = 'pairing' AND "book_requests"."pairing_books_item_id" IS NOT NULL) OR ("book_requests"."origin" = 'collection' AND "book_requests"."collection_id" IS NOT NULL AND "book_requests"."collection_member_ref" IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "book_requests_collection_member_unique" ON "book_requests" USING btree ("collection_id","collection_member_ref") WHERE "book_requests"."origin" = 'collection';--> statement-breakpoint
CREATE INDEX "book_requests_collection_idx" ON "book_requests" USING btree ("collection_id");
