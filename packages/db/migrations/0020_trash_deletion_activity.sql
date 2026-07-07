-- Trash deletion-audit fix — app-initiated deletions must surface in the Activity tab.
--
-- ROOT CAUSE: an Expedite (or batch sweep) deletes PER ITEM via Maintainerr's
-- `/collections/media/handle`, which Maintainerr does NOT webhook back to us — so the Activity tab
-- (which reads the notifications store) never saw app-triggered deletions. The fix has the APP write
-- its own Activity notification in the SAME transaction as the deletion, under a new source 'trash'.
--
-- The ONLY schema change is a CHECK relax: notifications.source is CHECK-constrained to
-- NOTIFICATION_SOURCES (built from the const array), so admitting 'trash' rebuilds that constraint —
-- drop + re-add with the full ARRAY incl. the new value, mirroring the 0018/0019 CHECK rebuilds.
-- Additive: existing rows keep validating; no new table, column, or FK. A down-migration reverts to
-- the prior four-value CHECK (drop any stored source='trash' rows first if reverting).
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_source_enum";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_enum" CHECK ("notifications"."source" = ANY (ARRAY['maintainerr','seerr','tautulli','trash']));
