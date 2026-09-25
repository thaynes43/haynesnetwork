-- PRD R-254 / DESIGN-004 D-26 (owner directive 2026-09-25, the Haynes Quest family release) — seed ONE
-- catalog card, Haynes Quest, and grant it to the seeded Family role. Data only: no schema change
-- (ADR-012), an arbitrary http(s) URL (ADR-013), a code-shipped icon key (packages/ui/src/icons).
--   • Per-slug idempotent (the 0037 pattern): the card is inserted only when no row holds the slug, so
--     an admin who already made a `haynes-quest` card keeps it untouched (R-11).
--   • The Family grant rides the insert (one statement, a data-modifying CTE), so it is written only
--     for the row THIS migration created — a pre-existing admin-made card is never granted behind the
--     admin's back. Family is addressed by its fixed 0007 seed id; if that role was deleted, or turned
--     into an all-apps role (which stores no grant rows), the grant selects nothing. Admin sees the card
--     implicitly (is_admin, no row). Default, Friends and every other role get no grant.
--   • Unlike 0037 (ship Admin-only; the owner opens roles after review), the owner has already ruled
--     who sees this card: Family and Admin, the same two audiences the game's own Authentik
--     application admits (`family`, `authentik Admins`).
--   • The card is only a link. The game is gated by its own Authentik application (a haynes-ops
--     blueprint), not by this card; the card carries no Authentik link and is outside ADR-085's derived
--     bindings.
--   • No permission_audit row: a migration is a system-level data operation with no admin actor (the
--     0002/0007 seeds and 0061 wrote none either).
-- A down-migration deletes the `haynes-quest` row; its role_app_grants row cascades away.
WITH seeded AS (
  INSERT INTO app_catalog (slug, name, description, url, icon, sort_order)
  SELECT 'haynes-quest', 'Haynes Quest', 'Play — our family adventure game', 'https://quest.haynesnetwork.com', 'haynes-quest', 110
  WHERE NOT EXISTS (SELECT 1 FROM app_catalog WHERE slug = 'haynes-quest')
  RETURNING id
)
INSERT INTO role_app_grants (role_id, app_id)
SELECT r.id, seeded.id
FROM seeded
JOIN roles r ON r.id = '33333333-3333-4333-8333-333333333333' AND NOT r.is_admin AND NOT r.grants_all;
