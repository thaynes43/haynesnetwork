'use client';

// ADR-019 / DESIGN-008 D-11 — a fixed 2:3 poster box shared by the grid cards and the detail
// head. The box RESERVES its space (aspect-ratio), so a late image load or a failure never
// reflows neighbors (ADR-015 no-reorientation). The poster streams through the authed proxy
// route (`posterUrl` = /api/posters/{id}); a null poster or a load error falls back to the
// centered KindIcon — never a broken <img>.
//
// ADR-041 / DESIGN-017 D-07 — progressive reveal: the image starts transparent and fades in on
// load over the tinted skeleton box (opacity only — no geometry change, ADR-015-safe; the global
// reduced-motion rule kills the transition). A loading wall reads as "tiles filling in", never a
// broken grid.
//
// DESIGN-017 D-09 — `shape="still"` renders the drill-in's reserved 16:9 episode still
// (`.epi-still`) instead of the 2:3 box; its no-image fallback is the bare tinted box (no icon —
// denser than the KindIcon tile at row size). One reveal implementation for every poster surface.
import { useEffect, useRef, useState } from 'react';
import { KindIcon } from './kind-icon';

export function MediaPoster({
  posterUrl,
  kind,
  alt,
  shape = 'poster',
}: {
  posterUrl: string | null;
  kind: string;
  alt: string;
  /** 'poster' = the 2:3 `.poster-box` (KindIcon fallback); 'still' = the 16:9 `.epi-still`. */
  shape?: 'poster' | 'still';
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // A URL swap (placeholderData refresh, healed art) resets BOTH states during render (the React
  // "adjusting state when a prop changes" pattern) so a previously-failed tile retries the new URL
  // instead of sticking on the fallback, and the new image fades in from transparent again.
  const [lastUrl, setLastUrl] = useState(posterUrl);
  if (lastUrl !== posterUrl) {
    setLastUrl(posterUrl);
    setFailed(false);
    setLoaded(false);
  }
  const showImage = posterUrl !== null && !failed;

  // Belt-and-braces for an instant cache hit: if the image completed before React attached the
  // onLoad listener, mark it loaded so a cached poster never sits transparent.
  useEffect(() => {
    if (imgRef.current?.complete === true) setLoaded(true);
  }, [posterUrl]);

  return (
    <div className={shape === 'poster' ? 'poster-box' : 'epi-still'}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- authed proxy route, not a static asset
        <img
          ref={imgRef}
          className={`poster-img${loaded ? ' is-loaded' : ''}`}
          src={posterUrl}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : shape === 'poster' ? (
        <span className="poster-fallback" aria-hidden="true">
          <KindIcon kind={kind} className="poster-fallback-icon" />
        </span>
      ) : null}
    </div>
  );
}
