-- DESIGN-010 D-12 amendment (2026-07-09, owner-directed) — cross-server watch VISIBILITY on the
-- trash walls (info, not protection). Two additive, nullable columns on media_metadata so existing
-- rows are unaffected (no backfill — the next 6h metadata-refresh harvest populates them):
--
--   last_watched_at      — the MAX last-watch instant across ALL THREE Tautulli histories
--                          (HaynesTower / HaynesOps / HaynesKube; full history, not the 30-day
--                          window), TV rolled up to the show. The SAME source instant as the
--                          pre-existing last_viewed_at (0012) — but stored as an explicit,
--                          server-attributed pair (with last_watched_server) that the trash walls +
--                          the item detail card read for the "Last watched on <server> · <Mon YYYY>"
--                          indicator. It does NOT change any protection semantics: recentlyWatched
--                          (≤30d) and the guardian keep still derive from last_viewed_at, unchanged.
--   last_watched_server  — the estate slug (haynesops | hayneskube | haynestower) whose contribution
--                          produced that max — the attribution the walls surface. NULL when never
--                          watched on any server (like last_watched_at).
ALTER TABLE "media_metadata" ADD COLUMN "last_watched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_metadata" ADD COLUMN "last_watched_server" text;
