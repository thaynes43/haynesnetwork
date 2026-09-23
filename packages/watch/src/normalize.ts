// Title normalization (DESIGN-049 D-13), shared by the resolver and the `name:` identity key (D-08).

export interface NormalizedTitle {
  /** Lower-case, diacritics and punctuation dropped, `&` → `and`, no leading article, single spaces. */
  norm: string;
  /** A year hint: a parenthesized year anywhere, else a bare trailing year (1900–2099). */
  year: number | null;
}

const PAREN_YEAR = /\(\s*((?:19|20)\d{2})\s*\)/g;
const TRAILING_YEAR = / ((?:19|20)\d{2})$/;
const BARE_YEAR = /^(?:19|20)\d{2}$/;

/**
 * Trailing country tags that disambiguate same-name shows ("The Office (US)"). Two-letter codes that
 * are also common English words at the end of a title ("it", "in", "no", "be") are deliberately absent.
 */
const COUNTRY_TAGS = new Set([
  'us',
  'usa',
  'uk',
  'gb',
  'au',
  'nz',
  'ca',
  'ie',
  'de',
  'fr',
  'jp',
  'kr',
  'es',
  'se',
  'dk',
  'nl',
  'mx',
  'br',
  'za',
]);

/**
 * Normalize a title or a spoken query (D-13): NFKD, strip diacritics, lower-case, `&` → `and`, drop
 * punctuation (apostrophes and periods join, so "S.H.I.E.L.D." is "shield"; everything else becomes a
 * space), drop one leading "the", "a" or "an", collapse spaces.
 *
 * Years: a parenthesized year ("Dune (2021)") is a tag — it becomes the hint and leaves the title. A
 * bare trailing year ("dune 2021", "Blade Runner 2049") also becomes the hint but STAYS in `norm`,
 * because it is often part of the title; the resolver's 0.95 rule matches the year-less form. A title
 * that is only a year ("1917") keeps it and has no hint.
 */
export function normalizeTitle(input: string): NormalizedTitle {
  let year: number | null = null;
  let s = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  s = s.replace(PAREN_YEAR, (_match: string, y: string) => {
    year ??= Number(y);
    return ' ';
  });
  s = s
    .replace(/&/g, ' and ')
    .replace(/['`.\u2018\u2019\u02bc]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/ {2,}/g, ' ');
  const withoutArticle = s.replace(/^(?:the|a|an) /, '');
  if (withoutArticle.length > 0) s = withoutArticle;
  if (year === null) {
    const m = TRAILING_YEAR.exec(s);
    if (m?.[1] !== undefined) year = Number(m[1]);
  }
  return { norm: s, year };
}

/**
 * Drop ONE trailing country tag or bare year from a normalized title ("office us" → "office",
 * "dune 2021" → "dune"); returns the input when there is none or nothing would remain.
 */
export function stripTrailingTag(norm: string): string {
  const i = norm.lastIndexOf(' ');
  if (i <= 0) return norm;
  const last = norm.slice(i + 1);
  return COUNTRY_TAGS.has(last) || BARE_YEAR.test(last) ? norm.slice(0, i) : norm;
}
