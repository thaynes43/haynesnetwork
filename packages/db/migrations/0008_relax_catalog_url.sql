-- ADR-013 — relax the app_catalog URL CHECK (BRANCH-A, no host restrictions). The catalog
-- now accepts arbitrary hosts (`*.haynesops.com` included); the app normalizes every value
-- to a canonical http(s) URL before it lands here, so the DB keeps only a scheme backstop.
ALTER TABLE "app_catalog" DROP CONSTRAINT "app_catalog_url_haynesnetwork_only";--> statement-breakpoint
ALTER TABLE "app_catalog" ADD CONSTRAINT "app_catalog_url_scheme" CHECK ("app_catalog"."url" ~ '^https?://');
