-- ADR-052 / DESIGN-026 D-06 (PLAN-029 — server-side per-user Library preferences). The FIRST per-user
-- store in the schema (live-verified none existed): one row per (user_id, wall) carrying the last `view`
-- shape, `group_by` dimension (grouped views only), and last-used `sort_field` + `sort_dir` the wall
-- reopens with. Read on wall load (bare URL fills from here; an explicit URL param WINS and is never
-- written back — the D-10 precedence); written (upsert) on change. Written ONLY by the @hnet/domain
-- `setLibraryPreference` single-writer (guard-listed). NO audit row — descriptive UI state, not a
-- role/permission/ledger mutation (ADR-052 C-04). `wall`/`view`/`sort_dir` are CHECK-constrained to the
-- enum const arrays; `sort_field` is free text (the three engines advertise DIFFERENT sort keys). Cascade
-- on user delete; ≤ one row per (user, wall). Down: DROP TABLE (no dependents).
CREATE TABLE "library_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wall" text NOT NULL,
	"view" text NOT NULL,
	"group_by" text,
	"sort_field" text NOT NULL,
	"sort_dir" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_preferences_user_wall_unique" UNIQUE("user_id","wall"),
	CONSTRAINT "library_preferences_wall_enum" CHECK ("library_preferences"."wall" = ANY (ARRAY['movies','tv','music','peloton','youtube','books','audiobooks','comics'])),
	CONSTRAINT "library_preferences_view_enum" CHECK ("library_preferences"."view" = ANY (ARRAY['flat','grouped','hierarchy'])),
	CONSTRAINT "library_preferences_sort_dir_enum" CHECK ("library_preferences"."sort_dir" = ANY (ARRAY['asc','desc']))
);
--> statement-breakpoint
ALTER TABLE "library_preferences" ADD CONSTRAINT "library_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
