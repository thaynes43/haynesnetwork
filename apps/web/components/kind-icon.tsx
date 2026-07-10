// Inline currentColor glyphs for the three *arr kinds (DESIGN-006 icon convention:
// stroked, 24-grid, themed through the token seam — no per-theme assets).
export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const common = {
    className,
    width: 24,
    height: 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  // ADR-038 (PLAN-022) — ytdl-sub "TV Show by Date" shows fall back to the TV-frame glyph (same as
  // sonarr TV), currentColor only (no new asset, no hex).
  if (kind === 'sonarr' || kind === 'show') {
    return (
      <svg {...common}>
        <rect x="3" y="5" width="18" height="12" rx="2" />
        <path d="M8 21h8" />
      </svg>
    );
  }
  if (kind === 'lidarr') {
    return (
      <svg {...common}>
        <path d="M9 18V6l10-2v11" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="16.5" cy="15" r="2.5" />
      </svg>
    );
  }
  // radarr / fallback: film frame
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  );
}
