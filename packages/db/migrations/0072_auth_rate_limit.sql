-- DESIGN-002 D-14 amend (saga haynesnetwork-ha plan 05:
-- https://github.com/thaynes43/haynes-ops/blob/main/.agents/sagas/haynesnetwork-ha/backlog/05-shared-rate-limit-storage.md).
-- Better Auth's rate limiter kept its buckets in per-replica memory (rateLimit.storage default =
-- 'memory'), so once the app runs >1 replica each pod counts independently and the effective limit
-- multiplies by N (fail-open). Flipping @hnet/auth to `rateLimit.storage: 'database'` points the
-- limiter at this shared table so all replicas enforce ONE combined limit. Shape is better-auth
-- 1.6.23's get-tables default for the `rateLimit` model: `key` (unique bucket key ip|path), `count`
-- (requests in the current window), `last_request` (epoch-ms stamp, bigint). Library-managed
-- operational state — written only by better-auth's own drizzle adapter, NOT a domain single-writer
-- table, so it carries no audit surface and is absent from the no-direct-state-writes guard.
-- Down: DROP TABLE (no dependents; the limiter recreates buckets on demand).
CREATE TABLE IF NOT EXISTS "rate_limit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_last_request_idx" ON "rate_limit" USING btree ("last_request");
