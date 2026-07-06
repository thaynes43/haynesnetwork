-- ADR-016 / DESIGN-005 D-19 — Subtitle Fix via Bazarr. The missing_subtitles Fix routes
-- to Bazarr's subtitle search (no blocklist, no delete, no *arr re-grab; the media file is
-- untouched), recording a new FixPath value 'bazarr_subtitle'. The fix_requests path CHECK
-- must be relaxed to admit it. Replaces (drops + re-adds) the constraint in place, keeping
-- the `IS NULL OR` guard (path_taken is null until actioned); existing rows are unaffected
-- (additive — no bazarr_subtitle rows exist unless subtitle fixes ran).
ALTER TABLE "fix_requests" DROP CONSTRAINT "fix_requests_path_enum";--> statement-breakpoint
ALTER TABLE "fix_requests" ADD CONSTRAINT "fix_requests_path_enum" CHECK ("fix_requests"."path_taken" IS NULL OR "fix_requests"."path_taken" = ANY (ARRAY['blocklist_search','delete_search','bazarr_subtitle']));
