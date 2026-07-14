-- ADR-056 (PLAN-046 — Kapowarr comics acquisition). ADDITIVE only — extends book_requests with the COMIC
-- routing leg (comics are Kapowarr's domain, never LazyLibrarian's). A comic-classified request now gets a
-- real path: resolve/add the volume in Kapowarr (monitored Wanted) and reconcile Kapowarr's per-volume state
-- back into a third per-format status. ADR-055 STANDS (books_items pure mirror; request/Missing state lives
-- in book_requests). ADR-046 STANDS.
--   • book_requests.comic_status — the COMIC format lifecycle (the ebook/audio precedent): requested → wanted
--     (monitored in Kapowarr) → grabbed (issues downloading) → landed (all issues on disk) → missing. NULL ⇒
--     the request is NOT a comic (a book/audiobook want — the existing ebook/audio path). Non-null ⇒ a comic:
--     `comic_status` IS the actionable state; ebook/audio stay 'missing' (N/A for a comic). CHECK admits the
--     five BOOK_REQUEST_STATUSES or NULL — kept in lockstep with the BOOK_REQUEST_STATUSES const source.
--   • book_requests.kapowarr_volume_id — the LOCAL Kapowarr volume id the routing added (the ll_book_id
--     analog: the reconcile + force-search key). NULL until routed (Kapowarr unreachable / no ComicVine match
--     leaves the comic parked, unroutable_reason='comic').
--   • book_requests.comicvine_id — the resolved ComicVine volume id (audit/debug + dedupe against a search
--     result's already_added). NULL until resolved.
-- The goodreads-sync mode routes comics through Kapowarr instead of parking (parking remains the fallback when
-- Kapowarr is unreachable/blocked). The USER-initiated force-search (request_book_search audit) now dispatches
-- comics to Kapowarr's auto_search task (books/audio still to LazyLibrarian's searchBook). No new table, no new
-- permission_audit action, no enum CHECK relaxations beyond the additive comic_status CHECK below.
-- A down-migration drops the three columns.
ALTER TABLE "book_requests" ADD COLUMN "comic_status" text;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "kapowarr_volume_id" text;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "comicvine_id" text;--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_comic_status_enum" CHECK ("book_requests"."comic_status" IS NULL OR "book_requests"."comic_status" = ANY (ARRAY['requested','wanted','grabbed','landed','missing']));
