// DESIGN-004 D-20 — link-preview (Open Graph / Twitter) branding for haynesnetwork.
// Discord and other chat clients scrape the pasted URL UNAUTHENTICATED; the app redirects
// them to /login, so this metadata is exported from the ROOT layout (app/layout.tsx) where it
// applies to every route the crawler can reach — the sign-in page included. The browser-tab
// <title> stays page-specific (login overrides it to "Sign in — haynesnetwork"); the EMBED
// title comes from `og:title` here and is always the wordmark.
import type { Metadata, Viewport } from 'next';
import { BRAND_ACCENT } from './brand';

/**
 * The ONE owner-editable link-preview description. Plain register by request — do not
 * dress it up. Shared by `og:description` and `twitter:description`. Edit this single
 * constant to change the embed copy everywhere.
 */
export const SITE_DESCRIPTION =
  "Front door to the haynes-ops self hosted apps. Closed site — members only; access isn't given out.";

/** The embed title / site name (`og:title`, `og:site_name`) — the wordmark, not a page title. */
export const SITE_NAME = 'haynesnetwork';

/** The dynamic OG banner route (app/og/route.tsx); resolved absolute via `metadataBase`. */
export const OG_IMAGE_PATH = '/og';
export const OG_IMAGE_ALT = 'haynesnetwork — the hub-and-spoke network mark on a black field';
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/**
 * The app's public origin, matching how the web app already derives it for the tRPC client
 * (apps/web/lib/trpc-provider.tsx). In the cluster `NEXT_PUBLIC_BASE_URL` is the bare apex
 * (`https://haynesnetwork.com`); locally it falls back to the dev origin. `metadataBase` uses
 * this to turn the relative `/og` image URL into the absolute URL crawlers require.
 */
export function resolvePublicOrigin(): string {
  return process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
}

export const siteMetadata: Metadata = {
  metadataBase: new URL(resolvePublicOrigin()),
  // Browser-tab default (humans); pages may override. NOT the embed title — that is og:title.
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: 'website',
    url: '/',
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: OG_IMAGE_PATH,
        width: OG_IMAGE_WIDTH,
        height: OG_IMAGE_HEIGHT,
        alt: OG_IMAGE_ALT,
      },
    ],
  },
  twitter: {
    // summary_large_image tells Discord/X to render the 1200x630 banner big, not a thumbnail.
    card: 'summary_large_image',
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: [{ url: OG_IMAGE_PATH, alt: OG_IMAGE_ALT }],
  },
};

/** Embed accent / mobile browser chrome color — the brand primary (`--color-accent`). */
export const siteViewport: Viewport = {
  themeColor: BRAND_ACCENT,
};
