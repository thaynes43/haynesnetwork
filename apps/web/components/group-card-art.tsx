'use client';

// DESIGN-026 D-04 amendment (group-card art) — ONE art slot for every aggregate group card,
// rendering the ruled ladder per dimension:
//
//   • art='covers' (a concrete dimension — Author): the dimension's OWN portrait when the source
//     holds one (ABS author photo through /api/books/author-image — populated-value-gated
//     server-side, so the URL exists only where the photo does) → else the stacked member-cover
//     fan → else the KindIcon tile.
//   • art='glyph' (an abstract dimension — Genre; decade/format/length reuse this when they ship):
//     the designed token-themed glyph emblem (genre-glyphs.tsx). NEVER fake imagery.
//
// ADR-015: everything renders inside the SAME reserved 2:3 `.poster-box`, so a portrait that
// loads late, errors (→ the fan swaps in, in place), or a missing cover never moves a neighbor.
// The portrait fades in exactly like MediaPoster (the shared `.poster-img` opacity-only reveal;
// the global reduced-motion rule kills it).
import { useEffect, useRef, useState } from 'react';
import { KindIcon } from './kind-icon';
import { GenreGlyph } from './genre-glyphs';
import type { WallGroupingArt } from '@/lib/library-view-registry';

export function GroupCardArt({
  art,
  label,
  imageUrl,
  coverUrls,
  kind,
}: {
  art: WallGroupingArt;
  /** The group's label (drives the glyph family for abstract dimensions). */
  label: string;
  /** The dimension's own portrait URL (null = none — server-gated), 'covers' art only. */
  imageUrl: string | null;
  /** The bounded member-cover sample (the fan fallback). */
  coverUrls: string[];
  /** KindIcon kind for the empty-group fallback tile. */
  kind: string;
}) {
  if (art === 'glyph') {
    return (
      <span className="poster-box glyph-tile">
        <span className="glyph-tile__ring">
          <GenreGlyph genre={label} className="glyph-tile__icon" />
        </span>
      </span>
    );
  }
  return <GroupCovers imageUrl={imageUrl} coverUrls={coverUrls} kind={kind} />;
}

function GroupCovers({
  imageUrl,
  coverUrls,
  kind,
}: {
  imageUrl: string | null;
  coverUrls: string[];
  kind: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // A URL swap (refetch, re-matched photo) resets BOTH states during render (the MediaPoster
  // pattern) so a previously-failed portrait retries the new URL instead of sticking on the fan.
  const [lastUrl, setLastUrl] = useState(imageUrl);
  if (lastUrl !== imageUrl) {
    setLastUrl(imageUrl);
    setFailed(false);
    setLoaded(false);
  }
  const showPortrait = imageUrl !== null && !failed;

  // Belt-and-braces for an instant cache hit (see MediaPoster).
  useEffect(() => {
    if (imgRef.current?.complete === true) setLoaded(true);
  }, [imageUrl]);

  if (showPortrait) {
    return (
      <span className="poster-box group-card__portrait">
        {/* eslint-disable-next-line @next/next/no-img-element -- authed proxy route, not a static asset */}
        <img
          ref={imgRef}
          className={`poster-img${loaded ? ' is-loaded' : ''}`}
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className="poster-box group-card__stack">
      {coverUrls.length === 0 ? (
        <span className="poster-fallback">
          <KindIcon kind={kind} className="poster-fallback-icon" />
        </span>
      ) : (
        coverUrls.map((url, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- authed proxy route, not a static asset
          <img
            key={url}
            src={url}
            alt=""
            loading="lazy"
            className={`group-card__cover group-card__cover--${i}`}
            onError={(e) => {
              (e.target as HTMLImageElement).style.visibility = 'hidden';
            }}
          />
        ))
      )}
    </span>
  );
}
