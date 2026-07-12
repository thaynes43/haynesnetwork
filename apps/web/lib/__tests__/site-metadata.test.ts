// DESIGN-004 D-20 — the link-preview (Open Graph / Twitter) branding contract. The crawler that
// scrapes a pasted haynesnetwork.com link is unauthenticated and gets redirected to /login, which
// inherits this ROOT-layout metadata — so asserting the exported object here is a cheap proxy for
// "the tags are in the HTML the crawler receives" (the rendered HTML + /og 200 are also curl-checked
// against the live dev stack during verification).
import { afterEach, describe, expect, it } from 'vitest';
import { BRAND_ACCENT } from '../brand';
import {
  OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  resolvePublicOrigin,
  SITE_DESCRIPTION,
  SITE_NAME,
  siteMetadata,
  siteViewport,
} from '../site-metadata';

// The openGraph/twitter image field is a union; in this app it is always our single-object array.
type OgImage = { url: string; width?: number; height?: number; alt?: string };
const ogImages = siteMetadata.openGraph?.images as OgImage[];
const twImages = siteMetadata.twitter?.images as OgImage[];

describe('link-preview metadata (DESIGN-004 D-20)', () => {
  it('ships the exact owner-directed description, plain and unchanged', () => {
    expect(SITE_DESCRIPTION).toBe(
      "Front door to the haynes-ops self hosted apps. Closed site — members only; access isn't given out.",
    );
    // The one constant feeds both the general description and both card descriptions.
    expect(siteMetadata.description).toBe(SITE_DESCRIPTION);
    expect(siteMetadata.openGraph?.description).toBe(SITE_DESCRIPTION);
    expect(siteMetadata.twitter?.description).toBe(SITE_DESCRIPTION);
  });

  it('og:title / og:site_name are the wordmark (NOT a page <title>)', () => {
    expect(SITE_NAME).toBe('haynesnetwork');
    expect(siteMetadata.openGraph?.title).toBe('haynesnetwork');
    expect(siteMetadata.openGraph?.siteName).toBe('haynesnetwork');
    // `type` lives on the OpenGraphWebsite member of the union — read it loosely.
    expect((siteMetadata.openGraph as { type?: string }).type).toBe('website');
  });

  it('advertises the 1200x630 banner + large-image card so Discord renders it big', () => {
    expect(ogImages[0]?.url).toBe(OG_IMAGE_PATH);
    expect(ogImages[0]?.url).toBe('/og');
    expect(ogImages[0]?.width).toBe(OG_IMAGE_WIDTH);
    expect(ogImages[0]?.height).toBe(OG_IMAGE_HEIGHT);
    expect(OG_IMAGE_WIDTH).toBe(1200);
    expect(OG_IMAGE_HEIGHT).toBe(630);
    expect(ogImages[0]?.alt).toBe(OG_IMAGE_ALT);
    expect(twImages[0]?.url).toBe('/og');
    // `card` lives on the summary-image member of the Twitter union — read it loosely.
    expect((siteMetadata.twitter as { card?: string }).card).toBe('summary_large_image');
  });

  it('theme-color is the brand accent token, sourced from lib/brand', () => {
    expect(siteViewport.themeColor).toBe(BRAND_ACCENT);
    expect(siteViewport.themeColor).toBe('#78be20');
  });

  it('metadataBase resolves the relative /og image to an absolute origin URL', () => {
    const base = siteMetadata.metadataBase as URL;
    expect(base).toBeInstanceOf(URL);
    // Whatever the origin, /og becomes an absolute URL a crawler can fetch.
    expect(new URL(OG_IMAGE_PATH, base).toString()).toMatch(/^https?:\/\/[^/]+\/og$/);
  });
});

describe('resolvePublicOrigin — env-aware public origin (matches the tRPC client)', () => {
  const original = process.env.NEXT_PUBLIC_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = original;
  });

  it('uses NEXT_PUBLIC_BASE_URL (the bare apex in prod) when set', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://haynesnetwork.com';
    expect(resolvePublicOrigin()).toBe('https://haynesnetwork.com');
    // metadataBase built from it turns /og into the production absolute URL.
    expect(new URL('/og', resolvePublicOrigin()).toString()).toBe('https://haynesnetwork.com/og');
  });

  it('falls back to the local dev origin when unset', () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    expect(resolvePublicOrigin()).toBe('http://localhost:3000');
  });
});
