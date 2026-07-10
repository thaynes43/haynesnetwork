// DESIGN-003 D-10 — the code-shipped icon registry's KEY LIST. Admins never upload
// markup: app_catalog.icon must be one of these keys (or null → generic tile glyph),
// validated by @hnet/api's CatalogEntryInput. The inline-SVG components that render
// these keys arrive with the UI shell task (DESIGN-004 D-09); the keys live in
// @hnet/ui (not apps/web) so @hnet/api can import them without depending on the
// Next app — and this file stays React-free so @hnet/api pulls no React types.
// Adding an icon is a code change: extend this tuple AND ship the matching SVG.
export const ICON_KEYS = [
  'seerr',
  'plex',
  'immich',
  'open-webui',
  'paperless',
  'tautulli',
  // ADR-046 / DESIGN-024 (PLAN-023) — the two book-server catalog cards.
  'kavita',
  'audiobookshelf',
] as const;

export type IconKey = (typeof ICON_KEYS)[number];

export function isIconKey(value: unknown): value is IconKey {
  return typeof value === 'string' && (ICON_KEYS as readonly string[]).includes(value);
}
