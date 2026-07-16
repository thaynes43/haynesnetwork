// DESIGN-034 D-04 — one collapsible help section: a native <details>/<summary> (the repo's
// blessed ADR-015 in-place expansion idiom — .season__head / .metrics-host precedents).
// Collapsed by default; the summary row (glyph + title + chevron) is a ≥44px tap target and
// opening only rotates the chevron + reveals the body below — nothing outside the expansion
// re-orients. The stable `id` is the deep-link anchor HashOpener targets (D-05 section list).
import type { ReactElement, ReactNode } from 'react';

export function AboutSection({
  id,
  title,
  glyph,
  children,
}: {
  id: string;
  title: string;
  glyph: ReactElement;
  children: ReactNode;
}) {
  return (
    <details className="about-sec" id={id}>
      <summary className="about-sec__head">
        <span className="about-sec__glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="about-sec__title">{title}</span>
        <span className="about-sec__chevron" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width={16}
            height={16}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      </summary>
      <div className="about-sec__body">{children}</div>
    </details>
  );
}
