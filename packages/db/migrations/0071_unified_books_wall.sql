-- ADR-075 (PLAN-060 Stream A) — the unified Books wall. Journal idx 70.
--
-- The Audiobooks Library wall RETIRES: ebooks + audiobooks unify into ONE Books wall with
-- format as a facet (ADR-075 C-01). Per C-06 the per-user `audiobooks` wall preference key
-- retires with it: the orphaned `library_preferences` rows are DROPPED (users re-pick once —
-- honest, cheap; descriptive UI state, no audit rows by ADR-052 C-04), and the wall CHECK is
-- rebuilt without 'audiobooks' so the constraint stays in parity with the schema's
-- LIBRARY_WALLS set (the migration-0037 CHECK-rebuild precedent). Nothing else changes —
-- no mirror-table changes, no permission migration (the `books` section gates Books + Comics
-- exactly as before).
DELETE FROM "library_preferences" WHERE "wall" = 'audiobooks';--> statement-breakpoint
ALTER TABLE "library_preferences" DROP CONSTRAINT "library_preferences_wall_enum";--> statement-breakpoint
ALTER TABLE "library_preferences" ADD CONSTRAINT "library_preferences_wall_enum" CHECK ("library_preferences"."wall" = ANY (ARRAY['movies','tv','music','peloton','youtube','books','comics']));
