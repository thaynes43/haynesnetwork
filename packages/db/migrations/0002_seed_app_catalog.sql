-- Seed the app catalog on first deploy only. Admin edits/deletions win forever after
-- (R-11); later catalog changes go through the admin UI, audited via permission_audit.
INSERT INTO app_catalog (slug, name, description, url, icon, default_visible, sort_order)
SELECT * FROM (VALUES
  -- R-12: default-visible tiles
  ('seerr',      'Seerr',      'Request movies & TV shows',            'https://overseerr.haynesnetwork.com', 'seerr',      true,  10),
  ('plex',       'Plex',       'Watch — legacy haynestower server',    'https://plex.haynesnetwork.com',      'plex',       true,  20),
  ('k8plex',     'K8Plex',     'Watch — k8s Plex server',              'https://k8plex.haynesnetwork.com',    'plex',       true,  30),
  -- R-13: admin-grantable tiles, seeded hidden
  ('plexops',    'PlexOps',    'Watch — ops Plex server',              'https://plexops.haynesnetwork.com',   'plex',       false, 40),
  ('immich',     'Immich',     'Photo & video library',                'https://immich.haynesnetwork.com',    'immich',     false, 50),
  ('open-webui', 'Open WebUI', 'Self-hosted AI chat',                  'https://ai.haynesnetwork.com',        'open-webui', false, 60),
  ('paperless',  'Paperless',  'Document management',                  'https://paperless.haynesnetwork.com', 'paperless',  false, 70),
  ('tautulli',   'Tautulli',   'Plex activity & stats',                'https://tautulli.haynesnetwork.com',  'tautulli',   false, 80)
) AS seed(slug, name, description, url, icon, default_visible, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM app_catalog);
