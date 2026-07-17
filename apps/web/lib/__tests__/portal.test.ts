// DESIGN-004 D-23 — the Portal display exclusion: the three seeded direct Plex SERVER
// cards never render on /portal, while every other catalog app passes through untouched
// (order preserved). The exclusion is display-only — catalog rows are admin-curated data
// (R-11) — so the set is keyed on the seeded slugs and nothing else.
import { describe, expect, it } from 'vitest';
import { PLEX_WEB_PLAYER_URL, PORTAL_HIDDEN_SLUGS, PORTAL_NAME, portalApps } from '../portal';

const app = (slug: string) => ({ slug, name: slug.toUpperCase() });

describe('portalApps — the D-23 server-card exclusion', () => {
  it('drops exactly the three seeded direct-server slugs', () => {
    expect(PORTAL_HIDDEN_SLUGS).toEqual(new Set(['plex', 'k8plex', 'plexops']));
    const apps = ['seerr', 'plex', 'k8plex', 'plexops', 'immich', 'tautulli'].map(app);
    expect(portalApps(apps).map((a) => a.slug)).toEqual(['seerr', 'immich', 'tautulli']);
  });

  it('passes an admin-added card through even on a Plex-ish slug variant', () => {
    // The exclusion is exact-slug, never fuzzy — an admin re-adding a differently-slugged
    // card (e.g. plex-web) renders normally.
    const apps = ['plex-web', 'k8plex2'].map(app);
    expect(portalApps(apps).map((a) => a.slug)).toEqual(['plex-web', 'k8plex2']);
  });

  it('preserves the incoming sort order of the kept apps', () => {
    const apps = ['tautulli', 'plexops', 'seerr'].map(app);
    expect(portalApps(apps).map((a) => a.slug)).toEqual(['tautulli', 'seerr']);
  });
});

describe('the ratified constants', () => {
  it('nav label + web-player target', () => {
    expect(PORTAL_NAME).toBe('Portal');
    expect(PLEX_WEB_PLAYER_URL).toBe('https://app.plex.tv');
  });
});
