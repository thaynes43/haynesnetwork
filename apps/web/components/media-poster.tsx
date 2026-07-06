'use client';

// ADR-019 / DESIGN-008 D-11 — a fixed 2:3 poster box shared by the grid cards and the detail
// head. The box RESERVES its space (aspect-ratio), so a late image load or a failure never
// reflows neighbors (ADR-015 no-reorientation). The poster streams through the authed proxy
// route (`posterUrl` = /api/posters/{id}); a null poster or a load error falls back to the
// centered KindIcon — never a broken <img>.
import { useState } from 'react';
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
  const showImage = posterUrl !== null && !failed;
  return (
    <div className="poster-box">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- authed proxy route, not a static asset
        <img
          className="poster-img"
          src={posterUrl}
          alt={alt}
          loading="lazy"
          decoding="async"
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
