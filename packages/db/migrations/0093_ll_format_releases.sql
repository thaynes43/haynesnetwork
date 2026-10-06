-- Issue #735 / DESIGN-028 amendment 2026-10-06: the LazyLibrarian Release. When the app abandons, parks or re-points a
-- want, the LazyLibrarian book format it had queued for that want is recorded here (in the same transaction), and each
-- goodreads-sync and format-pairing run unqueues it (back to `Skipped`) once a fresh read shows it `Wanted`, nothing
-- holds it and no live request still asks for it. Journal idx 92. ADDITIVE: a new table the previous image never reads
-- or writes, so it runs unchanged against this schema. A down-migration drops the table.
CREATE TABLE "ll_format_releases" (
	"ll_book_id" text NOT NULL,
	"format" text NOT NULL,
	"reason" text NOT NULL,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ll_format_releases_ll_book_id_format_pk" PRIMARY KEY("ll_book_id","format"),
	CONSTRAINT "ll_format_releases_format_enum" CHECK ("ll_format_releases"."format" = ANY (ARRAY['ebook','audiobook']))
);
