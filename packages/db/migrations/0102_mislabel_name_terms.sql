-- ADR-113 / DESIGN-055 Q-10 ruling (owner, 2026-10-13). Journal idx 101. The Mislabel Block's second term kind, the
-- MISLABELLED NAME, on mislabel_block_terms (single writer packages/domain/src/mislabel-block.ts):
-- (1) `kind` (`group` | `pair` | `double` | `alias`, default `group`, so every existing row is a group term) and
--     `name_token` (a name's display text, e.g. `S01E11 Secret Menu`); `release_group` becomes nullable. A group term
--     names its group and no name; a name term its name and no group (`mislabel_block_terms_kind_fields`).
-- (2) origin admits `staff` (a name term staff add with the in-cluster tool). A group term comes from a re-map or the
--     adoption, a name term from staff or the adoption (`mislabel_block_terms_kind_origin`).
-- (3) The active unique index covers (instance, series, kind, lower(group or name token)).
-- The previous image inserts group rows only (kind defaults to `group`, release_group set), so it runs unchanged against
-- this schema while no name term exists. Once one does, the previous image's writer refuses every profile write
-- (`validate`: its grammar check does not know a name term), which leaves the profile as it is; roll back by removing the
-- name terms first. A down-migration deletes the name rows, restores the 0101 index, CHECKs and NOT NULL, and drops the
-- two columns.
ALTER TABLE "mislabel_block_terms" ADD COLUMN "kind" text DEFAULT 'group' NOT NULL;--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" ADD COLUMN "name_token" text;--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" ALTER COLUMN "release_group" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" ADD CONSTRAINT "mislabel_block_terms_kind_enum" CHECK ("mislabel_block_terms"."kind" = ANY (ARRAY['group','pair','double','alias']));--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" ADD CONSTRAINT "mislabel_block_terms_kind_fields" CHECK (("mislabel_block_terms"."kind" = 'group' AND "mislabel_block_terms"."release_group" IS NOT NULL AND "mislabel_block_terms"."name_token" IS NULL) OR ("mislabel_block_terms"."kind" <> 'group' AND "mislabel_block_terms"."release_group" IS NULL AND "mislabel_block_terms"."name_token" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" DROP CONSTRAINT "mislabel_block_terms_origin_enum";--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" ADD CONSTRAINT "mislabel_block_terms_origin_enum" CHECK ("mislabel_block_terms"."origin" = ANY (ARRAY['remap','adoption','staff']));--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" ADD CONSTRAINT "mislabel_block_terms_kind_origin" CHECK (("mislabel_block_terms"."kind" = 'group' AND "mislabel_block_terms"."origin" IN ('remap','adoption')) OR ("mislabel_block_terms"."kind" <> 'group' AND "mislabel_block_terms"."origin" IN ('staff','adoption')));--> statement-breakpoint
DROP INDEX "mislabel_block_terms_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "mislabel_block_terms_active_uq" ON "mislabel_block_terms" ("instance","series_id","kind",lower(coalesce("release_group", "name_token"))) WHERE "mislabel_block_terms"."state" = 'active';
