// Pure full-work identity checks shared by format pairing and cross-origin collection coverage.
// DESIGN-036 / DESIGN-038: subtitles and contributor boundaries remain load-bearing.

/** Complete credited names: partial surnames cannot turn lost CSV boundaries into author proof. */
export function pairingAuthorsAgree(a: string | null, b: string | null): boolean {
  const normalize = (name: string): string =>
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const credits = (value: string | null): string[] => {
    const parts = (value ?? '').split(/\s*,\s*/);
    // Explicit complete coauthor credits retain their boundaries. Surname-first or fragmented
    // credits are not split into guessed aliases.
    return parts.length > 1 && parts.every((part) => normalize(part).split(' ').length >= 2)
      ? parts
      : [value ?? ''];
  };
  const tokens = (name: string, other: string): string[] =>
    normalize(
      name.replace(/\b[A-Z]{2,3}\b/g, (compact) => {
        const explicit = [...other.matchAll(/\b(?:[A-Z][.\s]+){2,3}/g)].some(
          ([run]) => run.replace(/[.\s]/g, '') === compact,
        );
        return explicit ? compact.split('').join(' ') : compact;
      }),
    ).split(' ');
  const givenAgrees = (x: string, y: string): boolean =>
    x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y));
  const leftCredits = credits(a),
    rightCredits = credits(b);
  if (leftCredits.length !== rightCredits.length) return false;
  const agrees = (left: string, right: string): boolean => {
    const l = normalize(left),
      r = normalize(right);
    if (!l || !r) return false;
    if (l === r) return l.length >= 2;
    const lt = tokens(left, right),
      rt = tokens(right, left);
    if (
      lt.length < 2 ||
      rt.length < 2 ||
      lt.at(-1)!.length < 2 ||
      rt.at(-1)!.length < 2 ||
      lt.at(-1) !== rt.at(-1) ||
      !givenAgrees(lt[0]!, rt[0]!)
    )
      return false;
    const lm = lt.slice(1, -1),
      rm = rt.slice(1, -1);
    const [shorter, longer] = lm.length <= rm.length ? [lm, rm] : [rm, lm];
    let index = 0;
    return shorter.every((part) => {
      while (index < longer.length) if (givenAgrees(part, longer[index++]!)) return true;
      return false;
    });
  };
  const taken = new Set<number>();
  return leftCredits.every((left) => {
    const index = rightCredits.findIndex((right, i) => !taken.has(i) && agrees(left, right));
    if (index < 0) return false;
    taken.add(index);
    return true;
  });
}

/**
 * ADR-065 C-01 (review-hardened 2026-07-16) — the EDITION-NOISE tokens the pairing key drops.
 * Exactly these: the articles plus the packaging words the two ecosystems decorate the SAME work
 * with ("… : A Novel", "… (Unabridged)"). Nothing else — subtitles stay load-bearing.
 */
const PAIRING_NOISE_TOKENS = new Set([
  'a',
  'an',
  'the',
  'novel',
  'unabridged',
  'abridged',
  'edition',
]);

/**
 * The PAIRING title key — deliberately NOT the goodreads-match `normTitle` (which cuts at the first
 * ':'/'(' and would collapse DISTINCT franchise works: "Star Wars: Heir to the Empire" and
 * "Star Wars: Thrawn" share an author, and a subtitle-cutting key would mispair them). This key
 * keeps the FULL title: lowercase, collapse non-alphanumerics to single spaces, drop ONLY the
 * PAIRING_NOISE_TOKENS, and the matcher requires FULL EQUALITY of the remaining token sequence.
 * "Project Hail Mary: A Novel" ⇄ "Project Hail Mary (Unabridged)" both reduce to
 * "project hail mary"; "star wars heir to empire" ≠ "star wars thrawn". A bare stem vs a subtitled
 * edition ("Dune" vs "Dune: Book One of the Dune Chronicles") does NOT pair — the conservative
 * miss is correct (DESIGN-036 Q-02 is the upgrade path).
 */
export function pairingTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0 && !PAIRING_NOISE_TOKENS.has(w))
    .join(' ');
}

export type PairingCredit = { author: string | null; authors?: readonly string[] };

/** Explicit arrays are authoritative. A legacy display credit never expands into guessed people. */
export function declaredCredits(value: PairingCredit): string[] {
  const raw = value.authors ?? (value.author ? [value.author] : []);
  if (raw.some((a) => !a.trim() || a.split(',').length > 2)) return [];
  return [...new Set(raw.map((a) => a.trim()))];
}

export function pairingCreditsAgree(a: PairingCredit, b: PairingCredit): boolean {
  const left = declaredCredits(a), right = declaredCredits(b);
  if (!left.length || left.length !== right.length) return false;
  const taken = new Set<number>();
  return left.every((credit) => {
    const index = right.findIndex((other, i) => !taken.has(i) && pairingAuthorsAgree(credit, other));
    if (index < 0) return false;
    taken.add(index);
    return true;
  });
}

