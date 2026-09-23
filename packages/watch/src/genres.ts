// Genre vocabulary (DESIGN-049 D-16/D-19). Genres arrive from Sonarr (TVDB names), Radarr (TMDB
// names), Plex and TMDB, and from the spoken `genre` parameter of `recommend`. Everything is folded
// onto one lower-case canonical name so the profile, the candidates and the parameter agree.

/** Spoken and source spellings → canonical genre. Unknown genres pass through normalized. */
export const GENRE_SYNONYMS: Readonly<Record<string, string>> = {
  'sci-fi': 'sci-fi',
  'sci fi': 'sci-fi',
  scifi: 'sci-fi',
  'science fiction': 'sci-fi',
  'science-fiction': 'sci-fi',
  comedy: 'comedy',
  comedies: 'comedy',
  funny: 'comedy',
  horror: 'horror',
  scary: 'horror',
  documentary: 'documentary',
  documentaries: 'documentary',
  docs: 'documentary',
  doc: 'documentary',
  docuseries: 'documentary',
  animation: 'animation',
  animated: 'animation',
  romance: 'romance',
  romantic: 'romance',
  thriller: 'thriller',
  thrillers: 'thriller',
  crime: 'crime',
  drama: 'drama',
  dramas: 'drama',
  action: 'action',
  fantasy: 'fantasy',
  mystery: 'mystery',
  mysteries: 'mystery',
  war: 'war',
  western: 'western',
  westerns: 'western',
  family: 'family',
  kids: 'kids',
  kid: 'kids',
  children: 'kids',
  childrens: 'kids',
};

// Words a speaker wraps around a genre: "a comedy", "sci-fi movies", "some horror films". A known
// genre may shed any of them; an unknown one only a plural ("talk show" stays whole).
const LEADING_FILLER = /^(?:a|an|some|any)\s+/;
const TRAILING_FILLER = /\s+(?:movies?|films?|shows?|series|tv)$/;
const TRAILING_PLURAL = /\s+(?:movies|films|shows)$/;

function clean(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['`\u2018\u2019\u02bc]/g, '')
    .replace(/[_.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function lookup(s: string): string | undefined {
  for (const variant of [s, s.replace(/-/g, ' '), s.replace(/[-\s]/g, '')]) {
    const hit = GENRE_SYNONYMS[variant];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * The canonical genre for one name or spoken phrase ("Science Fiction", "scifi", "sci-fi movies" →
 * `sci-fi`; "funny" → `comedy`; "Children" → `kids`). Unknown genres come back normalized
 * ("Talk Show" → `talk show`); blank input is null.
 */
export function canonicalGenre(input: string): string | null {
  const s = clean(input);
  if (!s) return null;
  const direct = lookup(s);
  if (direct !== undefined) return direct;
  const bare = s.replace(LEADING_FILLER, '');
  const known = lookup(bare) ?? lookup(bare.replace(TRAILING_FILLER, ''));
  if (known !== undefined) return known;
  return bare.replace(TRAILING_PLURAL, '') || bare;
}

/**
 * Canonical genres of a title, de-duplicated in first-seen order. Compound source genres split on
 * `&`, `/` and `,` ("Sci-Fi & Fantasy" → `sci-fi`, `fantasy`; "Action/Adventure" → `action`,
 * `adventure`); "Home and Garden" stays whole.
 */
export function canonicalGenres(genres: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const add = (g: string | null) => {
    if (g !== null && !out.includes(g)) out.push(g);
  };
  for (const raw of genres ?? []) {
    const whole = clean(raw);
    if (!whole) continue;
    const direct = lookup(whole);
    if (direct !== undefined) {
      add(direct);
      continue;
    }
    for (const part of whole.split(/\s*[&/,]\s*/)) {
      if (part) add(lookup(part) ?? part);
    }
  }
  return out;
}
