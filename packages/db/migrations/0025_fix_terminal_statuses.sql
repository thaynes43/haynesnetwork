-- Fix lifecycle timeouts + manual close. Two new TERMINAL fix statuses join the enum
-- (packages/db/src/schema/enums.ts FIX_STATUSES): 'timed_out' (the never-stuck safety net —
-- expireStaleFixRequests auto-closes an OPEN fix, including a fire-and-forget bazarr_subtitle fix,
-- after the 48h horizon so it stops tripping FixAlreadyOpenError) and 'closed_manually' (the
-- admin/requester escape hatch, fix.close). Both are terminal and NOT open, so they release the
-- one-open-fix-per-target block. Relax (drop + re-add) the status CHECK to admit them; existing
-- rows are unaffected (additive — no row carries the new values until the new writers run).
ALTER TABLE "fix_requests" DROP CONSTRAINT "fix_requests_status_enum";--> statement-breakpoint
ALTER TABLE "fix_requests" ADD CONSTRAINT "fix_requests_status_enum" CHECK ("fix_requests"."status" = ANY (ARRAY['pending','actioned','search_triggered','failed','completed','timed_out','closed_manually']));
