-- ADR-071 / DESIGN-033 D-09 (media-action UX unification) — the books leg of the unified
-- Fix + Force Search vocabulary. `force_search_book` joins `fix_book` as the SECOND books
-- media-action grant, gating the one-click quick re-search on the books detail page (the exact
-- ADR-023/059/062 idiom: a ROW is the grant; Admin implies all; NO rows ⇒ Admin-only until the
-- owner opens each per role via /admin → roles).
--
-- ADDITIVE + idempotent: rebuild the role_books_action_grants CHECK to admit the new value. No new
-- audit action is needed — Force Search reuses the existing `request_book_search` audit and writes
-- NO durable fix row. A down-migration reverts the CHECK (delete any force_search_book grant rows
-- first).
ALTER TABLE "role_books_action_grants" DROP CONSTRAINT "role_books_action_grants_action_enum";--> statement-breakpoint
ALTER TABLE "role_books_action_grants" ADD CONSTRAINT "role_books_action_grants_action_enum" CHECK ("role_books_action_grants"."action" = ANY (ARRAY['fix_book','force_search_book']));
