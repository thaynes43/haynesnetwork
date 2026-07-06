-- ADR-017 / DESIGN-007 D-12 — fix the haynestower registry base_url (live defect, 2026-07-06).
-- The 0010 seed pinned haynestower's base_url to an in-cluster Service DNS
-- (`http://haynestower.media.svc.cluster.local:32400`) that DOES NOT EXIST: haynestower is the
-- EXTERNAL Unraid box, not an in-cluster PMS. The registry refresh therefore failed DNS for
-- that server. It IS reachable from cluster pods via its public ingress
-- (`https://plex.haynesnetwork.com`, verified with the owner token 2026-07-06). Registry
-- metadata must stay truthful (DESIGN-007 D-12), so correct the seeded row. The other two
-- servers ARE genuine in-cluster Services and are left untouched. `updated_at` is bumped so the
-- change is visible in the audit/ops view. Idempotent (slug-scoped UPDATE; the row always exists).
UPDATE "plex_servers"
   SET "base_url" = 'https://plex.haynesnetwork.com',
       "updated_at" = now()
 WHERE "slug" = 'haynestower';
