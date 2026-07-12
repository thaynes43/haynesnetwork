// DESIGN-004 D-20 — the 1200x630 Open Graph / Twitter banner, generated on the fly with
// next/og (Satori + resvg, bundled Geist font — no external fetch, CSP-safe). Served at the
// PUBLIC, un-gated path /og (there is no global middleware; auth is per-page redirects), so the
// unauthenticated crawler that scrapes a pasted haynesnetwork.com link can fetch it. Built from
// THIS app's identity (DESIGN-006): the hub-and-spoke mark in accent green over the black brand
// field, under the wordmark — nothing borrowed from a sibling app.
import { ImageResponse } from 'next/og';
import { BRAND_ACCENT, BRAND_BG, BRAND_TEXT } from '@/lib/brand';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/lib/site-metadata';

// The DESIGN-006 D-01 hub-and-spoke mark (same geometry as components/brand-mark.tsx and
// app/icon0.svg), inlined as a data-URI SVG so Satori renders it as an <img>.
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><path d="M16 13.9V7.3M20.4 21.5 26 24.8M11.6 21.5 6 24.8" stroke="${BRAND_ACCENT}" stroke-width="2"/><circle cx="16" cy="19" r="3.1" fill="${BRAND_ACCENT}"/><circle cx="16" cy="19" r="5.9" stroke="${BRAND_ACCENT}" stroke-width="1.8"/><circle cx="16" cy="7" r="2.8" fill="${BRAND_ACCENT}"/><circle cx="26.4" cy="25" r="2.8" fill="${BRAND_ACCENT}"/><circle cx="5.6" cy="25" r="2.8" fill="${BRAND_ACCENT}"/></svg>`;
const markDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(markSvg)}`;

export function GET(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 40,
        background: BRAND_BG,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Satori renders <img>, not next/image */}
      <img src={markDataUri} width={260} height={260} alt="" />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 26,
        }}
      >
        <div
          style={{
            fontSize: 108,
            fontWeight: 700,
            letterSpacing: -3,
            color: BRAND_TEXT,
            lineHeight: 1,
          }}
        >
          haynesnetwork
        </div>
        {/* Accent rule — the one deliberate stroke of brand green under the wordmark. */}
        <div
          style={{
            width: 132,
            height: 8,
            borderRadius: 4,
            background: BRAND_ACCENT,
          }}
        />
      </div>
    </div>,
    {
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      headers: {
        // Cheap for repeat scrapes; embeds are cached by the chat client anyway.
        'cache-control': 'public, max-age=3600, s-maxage=86400, immutable',
      },
    },
  );
}
