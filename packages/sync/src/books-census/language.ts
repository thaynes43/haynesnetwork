// DESIGN-028 amendment 2026-10-06 (the Books Census, issue #744) — which language a held file is in, from what it
// says (its declared language) and from what it is (a sample of its text). The English-only rule (F10) found library
// language tags wrong in both directions, so the declared language is one signal and the text another. Pure.
import { classifyBookLanguage, type BookLanguageClass } from '@hnet/domain';

/**
 * Function words, one list per language: frequent in running text, rare in another language's. Words that are also
 * common English words are left out of the foreign lists ("die", "in", "a", "is", "on", "an", "or", "son", "me"), so an
 * English book never scores foreign on them.
 */
const FUNCTION_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: 'the and of to that was he she it for with his her you they this have from had not but were said what which their would there been when who will could them than then into'.split(
    ' ',
  ),
  de: 'der das und ist nicht ich sie er es ein eine zu den mit sich auf dem auch als wie aber noch nach wenn nur aus bei oder schon sein wird hatte'.split(
    ' ',
  ),
  fr: 'le la les et est une des du que qui dans pas je il elle au pour sur avec mais ce sont nous vous leur plus tout comme fait était'.split(
    ' ',
  ),
  es: 'el los las y que en un una es por con para se lo como pero su más del al está fue sus todo esta muy había porque'.split(
    ' ',
  ),
  it: 'il che di non un una per con si mi sono ma gli ho era della alla questo anche più del nel sua suo lei lui'.split(
    ' ',
  ),
  nl: 'het een en van dat niet ik je hij ze op te met voor maar zijn er naar ook nog wat kan bij als heeft werd hem'.split(
    ' ',
  ),
  sv: 'och att det som är jag inte på med för den har till av var om han hon ett sig'.split(' '),
  da: 'og at det er ikke jeg på med som til den har af var han hun et sig'.split(' '),
};

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length > 0);

export interface TextLanguageGuess {
  /** The language the text reads as, or null when the sample is too short to say. */
  language: string | null;
  /** Function-word hits per language (English included), for the finding's evidence. */
  hits: Record<string, number>;
  /** Words in the sample. */
  words: number;
}

/** The fewest function-word hits a language needs before a sample counts as that language. */
const MIN_HITS = 30;
/** The share of letters that must be in a non-Latin script for the sample to read as foreign by script alone. */
const SCRIPT_SHARE = 0.5;

/**
 * Guess a text sample's language from its function words: foreign when the best foreign language has at least MIN_HITS
 * hits and three times English's; English when English has at least MIN_HITS and three times the best foreign
 * language's; else null (too short, or mixed). Hebrew, Cyrillic, Greek, Arabic or CJK letters as the majority read as
 * foreign (`script`). Foreign lists may overlap each other: only English against the rest decides.
 */
export function guessTextLanguage(text: string | null | undefined): TextLanguageGuess {
  const sample = text ?? '';
  const letters = sample.match(/\p{L}/gu) ?? [];
  const nonLatin =
    sample.match(
      /[\p{Script=Hebrew}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    ) ?? [];
  const words = tokens(sample);
  const hits: Record<string, number> = {};
  const sets = Object.entries(FUNCTION_WORDS).map(([lang, list]) => [lang, new Set(list)] as const);
  for (const [lang] of sets) hits[lang] = 0;
  for (const w of words) for (const [lang, set] of sets) if (set.has(w)) hits[lang]! += 1;
  if (letters.length >= 200 && nonLatin.length / letters.length >= SCRIPT_SHARE) {
    return { language: 'script', hits, words: words.length };
  }
  const english = hits.en ?? 0;
  const [foreign, foreignHits] = Object.entries(hits)
    .filter(([lang]) => lang !== 'en')
    .sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  if (foreignHits >= MIN_HITS && foreignHits >= 3 * english)
    return { language: foreign, hits, words: words.length };
  if (english >= MIN_HITS && english >= 3 * foreignHits)
    return { language: 'en', hits, words: words.length };
  return { language: null, hits, words: words.length };
}

/** A declared language (`dc:language`, EXTH 524, ID3 TLAN) classed like the library's tags (DESIGN-036 #700 table). */
export function classifyDeclaredLanguage(value: string | null | undefined): BookLanguageClass {
  const v = (value ?? '').trim().toLowerCase();
  // ISO 639-2 codes for "English" beyond `eng`, and the multiple-languages / not-applicable codes.
  if (v === 'enm' || v === 'en_us' || v === 'en_gb') return 'english';
  if (v === 'mul' || v === 'zxx' || v === 'mis') return 'unknown';
  return classifyBookLanguage(value);
}
