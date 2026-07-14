// DESIGN-026 D-04 amendment (group-card art) — the GENRE glyph set for abstract-dimension group
// cards. The owner ruling: an abstract slice (genre / decade / format / length) gets a DESIGNED
// glyph tile, never fake imagery. All inline SVG on the 24-grid, stroked in currentColor
// (token-inherited — never a hex, never an asset), following the TicketCategoryIcon precedent
// (ADR-050 / DESIGN-012 D-12: "the icon renders large where a poster would be").
//
// `genreGlyphKind` maps a RAW genre tag (the live vocabulary is messy — mixed case, compounds
// like "Mystery, Thriller & Suspense") onto the glyph family by keyword, first match wins; an
// unmatched tag gets the open-book default. Same glyph for every tag of a family keeps the wall
// one visual grammar.

export type GenreGlyphKind =
  | 'scifi'
  | 'fantasy'
  | 'mystery'
  | 'thriller'
  | 'horror'
  | 'romance'
  | 'biography'
  | 'history'
  | 'kids'
  | 'business'
  | 'spirit'
  | 'poetry'
  | 'comedy'
  | 'science'
  | 'adventure'
  | 'music'
  | 'classics'
  | 'book';

/** Keyword → family, ordered (sci-fi before science; classics last so "Classic Thrillers" keeps
 *  its stronger family). Case-folded substring/regex match over the raw tag. */
const GLYPH_RULES: ReadonlyArray<[GenreGlyphKind, RegExp]> = [
  ['scifi', /sci[\s-]?fi|science fiction/],
  ['fantasy', /fantas|romantasy|dragon|magic|myth/],
  ['mystery', /myster|detective|sleuth/],
  ['thriller', /thriller|suspense|crime/],
  ['horror', /horror|ghost|frankenstein/],
  ['romance', /roman[tc]|love stor|erotic/],
  ['biography', /biograph|memoir/],
  ['history', /histor/],
  ['kids', /child|juvenile|kid|young adult|\bya\b|youth|bildungsroman/],
  ['business', /business|money|financ|invest|career|management|leadership|workplace|econom/],
  ['spirit', /spirit|religio|christian|faith|\bgod\b|mind & spirit/],
  ['poetry', /poetr|poem|verse/],
  ['comedy', /comed|humor|humour|funny/],
  ['science', /science|nature|computer|technolog/],
  ['adventure', /adventur/],
  ['music', /music|blues|jazz|song/],
  ['classics', /classic/],
];

export function genreGlyphKind(genre: string): GenreGlyphKind {
  const folded = genre.trim().toLowerCase();
  for (const [kind, pattern] of GLYPH_RULES) {
    if (pattern.test(folded)) return kind;
  }
  return 'book';
}

export function GenreGlyph({ genre, className }: { genre: string; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  };
  switch (genreGlyphKind(genre)) {
    case 'scifi':
      // A ringed planet.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="5.2" />
          <ellipse cx="12" cy="12" rx="9.5" ry="3.1" transform="rotate(-18 12 12)" />
        </svg>
      );
    case 'fantasy':
      // A four-point spark with a companion star.
      return (
        <svg {...common}>
          <path d="M11 5.5l1.6 4.6 4.6 1.6-4.6 1.6L11 17.9l-1.6-4.6-4.6-1.6 4.6-1.6z" />
          <path d="M18 4.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
        </svg>
      );
    case 'mystery':
      // The magnifier.
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="5.7" />
          <path d="M14.8 14.8 20 20" />
        </svg>
      );
    case 'thriller':
      // A lightning bolt.
      return (
        <svg {...common}>
          <path d="M13.2 3 6.5 13.5h4.3L10.8 21l6.7-10.5h-4.3z" />
        </svg>
      );
    case 'horror':
      // A ghost with a wavy hem.
      return (
        <svg {...common}>
          <path d="M6 20v-8.8a6 6 0 0 1 12 0V20l-2.4-1.7-2.4 1.7-1.2-1.4-1.2 1.4-2.4-1.7z" />
          <circle cx="10" cy="10.7" r="0.5" fill="currentColor" stroke="none" />
          <circle cx="14" cy="10.7" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'romance':
      // The heart.
      return (
        <svg {...common}>
          <path d="M12 19.3c-4.4-3.1-7.3-5.9-7.3-9.1 0-2.7 1.9-4.6 4.2-4.6 1.3 0 2.4.6 3.1 1.6.7-1 1.8-1.6 3.1-1.6 2.3 0 4.2 1.9 4.2 4.6 0 3.2-2.9 6-7.3 9.1z" />
        </svg>
      );
    case 'biography':
      // A portrait bust.
      return (
        <svg {...common}>
          <circle cx="12" cy="8.3" r="3.3" />
          <path d="M5.5 19.5c.8-3.9 3.4-6.2 6.5-6.2s5.7 2.3 6.5 6.2" />
        </svg>
      );
    case 'history':
      // A columned temple.
      return (
        <svg {...common}>
          <path d="M4.5 9 12 4.5 19.5 9" />
          <path d="M6 9v8.5M10 9v8.5M14 9v8.5M18 9v8.5" />
          <path d="M4.5 19.5h15" />
        </svg>
      );
    case 'kids':
      // A balloon on a string.
      return (
        <svg {...common}>
          <ellipse cx="12" cy="8.8" rx="4.6" ry="5.3" />
          <path d="M11.2 14.3h1.6" />
          <path d="M12 14.3c-.9 1.6.9 2.4 0 4-.6 1-1.6 1.4-2.5 1.4" />
        </svg>
      );
    case 'business':
      // The briefcase.
      return (
        <svg {...common}>
          <rect x="4" y="8" width="16" height="11" rx="2" />
          <path d="M9.5 8V6.5A1.5 1.5 0 0 1 11 5h2a1.5 1.5 0 0 1 1.5 1.5V8" />
          <path d="M4 13h16" />
        </svg>
      );
    case 'spirit':
      // A flame.
      return (
        <svg {...common}>
          <path d="M12 4c3 3.2 5 5.6 5 8.6a5 5 0 0 1-10 0C7 9.6 9 7.2 12 4z" />
          <path d="M12 12.3c1 1 1.6 1.9 1.6 3a1.6 1.6 0 0 1-3.2 0c0-1.1.6-2 1.6-3z" />
        </svg>
      );
    case 'poetry':
      // The quill.
      return (
        <svg {...common}>
          <path d="M18.7 5.3c-4.4-.4-8.6 1.7-10.8 5.8-1.1 2.1-1.5 4.5-1.4 7.1 2.6.1 5-.3 7.1-1.4 4.1-2.2 6.2-6.4 5.8-10.8z" />
          <path d="M6.5 18.5c3.3-5.2 6.7-8.7 11-12" />
        </svg>
      );
    case 'comedy':
      // A grinning face.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.3" />
          <path d="M8.2 13.6c1 1.8 2.2 2.7 3.8 2.7s2.8-.9 3.8-2.7" />
          <circle cx="9.2" cy="9.6" r="0.5" fill="currentColor" stroke="none" />
          <circle cx="14.8" cy="9.6" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'science':
      // The atom.
      return (
        <svg {...common}>
          <ellipse cx="12" cy="12" rx="9" ry="3.4" />
          <ellipse cx="12" cy="12" rx="9" ry="3.4" transform="rotate(60 12 12)" />
          <ellipse cx="12" cy="12" rx="9" ry="3.4" transform="rotate(-60 12 12)" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'adventure':
      // A compass.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.3" />
          <path d="M15.2 8.8l-1.9 4.5-4.5 1.9 1.9-4.5z" />
        </svg>
      );
    case 'music':
      // A beamed note.
      return (
        <svg {...common}>
          <path d="M9 16.8V6.8l9-2v9.7" />
          <circle cx="7" cy="17" r="2" />
          <circle cx="16" cy="14.7" r="2" />
        </svg>
      );
    case 'classics':
      // A single classical column.
      return (
        <svg {...common}>
          <path d="M8.5 4.5h7M9.5 7h5M10 7v10.5M14 7v10.5M8.5 19.5h7" />
          <circle cx="9" cy="5.8" r="0.9" />
          <circle cx="15" cy="5.8" r="0.9" />
        </svg>
      );
    case 'book':
      // The open book (default).
      return (
        <svg {...common}>
          <path d="M4 6.2c2.5-1.2 5.1-1.1 8 .6 2.9-1.7 5.5-1.8 8-.6v11.9c-2.5-1.2-5.1-1.1-8 .6-2.9-1.7-5.5-1.8-8-.6z" />
          <path d="M12 6.8v11.9" />
        </svg>
      );
  }
}
