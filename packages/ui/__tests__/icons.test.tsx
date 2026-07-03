// DESIGN-004 D-09 / DESIGN-003 D-10 — every ICON_KEY must render a self-contained
// currentColor SVG (no hex, no external refs), and null/unknown keys must fall back
// to the generic glyph. Rendered with react-dom/server — no DOM package needed.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppIcon, GenericAppIcon, ICON_COMPONENTS } from '../src/icons/components';
import { ICON_KEYS } from '../src/icons/registry';

describe('icon registry components', () => {
  it('ships a component for every ICON_KEY', () => {
    expect(Object.keys(ICON_COMPONENTS).sort()).toEqual([...ICON_KEYS].sort());
  });

  it.each(ICON_KEYS.map((k) => [k] as const))(
    '%s renders an aria-hidden currentColor svg with no hex literals',
    (key) => {
      const html = renderToStaticMarkup(<AppIcon icon={key} />);
      expect(html).toMatch(/^<svg/);
      expect(html).toContain('currentColor');
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // theme-token rule (hard rule 2)
      expect(html).not.toMatch(/href=|url\(/); // self-contained — no external refs
    },
  );

  it('falls back to the generic glyph for null and unknown keys', () => {
    const generic = renderToStaticMarkup(<GenericAppIcon />);
    expect(renderToStaticMarkup(<AppIcon icon={null} />)).toBe(generic);
    expect(renderToStaticMarkup(<AppIcon icon="not-a-key" />)).toBe(generic);
    expect(renderToStaticMarkup(<AppIcon icon="plex" />)).not.toBe(generic);
  });
});
