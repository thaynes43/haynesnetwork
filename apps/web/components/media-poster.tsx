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
import { useEffect, useRef, useState } from 'react';
import { KindIcon } from './kind-icon';

export function MediaPoster({
  posterUrl,
  kind,
  alt,
}: {
  posterUrl: string | null;
  kind: string;
  alt: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const showImage = posterUrl !== null && !failed;

  // Belt-and-braces for an instant cache hit: if the image completed before React attached the
  // onLoad listener, mark it loaded so a cached poster never sits transparent. A URL swap (e.g.
  // placeholderData refresh) resets to transparent until the new image lands.
  useEffect(() => {
    setLoaded(imgRef.current?.complete === true);
  }, [posterUrl]);

  return (
    <div className="poster-box">
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
      ) : (
        <span className="poster-fallback" aria-hidden="true">
          <KindIcon kind={kind} className="poster-fallback-icon" />
        </span>
      )}
    </div>
  );
}
