-- DESIGN-055 P4 decision 38 (coordinator ruling on issue #928, 2026-10-13: wrong-content files are bugs, replace them
-- when a correct release exists). Journal idx 105. ADDITIVE: watch_carries.kind admits 'wrong_content', the carry of the
-- staff Wrong-Content Replace. The previous image never writes it. A down-migration deletes rows of that kind and
-- restores the 0104 CHECK.
ALTER TABLE "watch_carries" DROP CONSTRAINT "watch_carries_kind_enum";--> statement-breakpoint
ALTER TABLE "watch_carries" ADD CONSTRAINT "watch_carries_kind_enum" CHECK ("watch_carries"."kind" = ANY (ARRAY['season_remap','show_ordering','second_copy','wrong_content']));
