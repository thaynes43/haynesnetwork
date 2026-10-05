// Issue #700 (DESIGN-036 amendment 2026-10-05) — the language of a library item or a LazyLibrarian book, as the
// English-only rule (F10, `.agents/context/2026-07-13-f10-english-audit.md`) reads it. Pure.
//
// Three classes, from the live values of `books_items.attrs.language` (Kavita: `en`, `en-US`, `en-GB`, `nl`, `de`,
// `es`; Audiobookshelf: `English`, `en`, blank, `XXX`) and LazyLibrarian's `BookLang`:
//   • english — `en`, `eng` (ISO 639-2; LazyLibrarian's own default list is `en, eng, en-US, en-GB`), `en-*`,
//     `English` (case-insensitive);
//   • unknown — blank, null, `XXX` (the ISO 639-2 "no language" code) or LazyLibrarian's own `Unknown`. Pairing is
//     allowed: the 199 blank Audiobookshelf items are overwhelmingly English, so blocking them would break pairing
//     broadly;
//   • foreign — anything else (`nl`, `de`, `es`, `German`, ...).
// The library field is not fully reliable (an Audiobookshelf item that reads `English` held the German vols 4-6 of
// Chroniken der Unterwelt), so the push also checks LazyLibrarian's own `BookLang` (the push-time guard in
// `mintPairingWants`).

export type BookLanguageClass = 'english' | 'unknown' | 'foreign';

/** `unroutable_reason` of a pairing want parked because its book is not English (issue #700). */
export const FOREIGN_LANGUAGE_REASON = 'foreign_language';

export function classifyBookLanguage(value: string | null | undefined): BookLanguageClass {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'xxx' || v === 'unknown' || v === 'und') return 'unknown';
  if (v === 'en' || v === 'eng' || v === 'english' || v.startsWith('en-') || v.startsWith('en_')) return 'english';
  return 'foreign';
}

/** Is this item/book explicitly non-English? Blank, null and `XXX` are unknown, not foreign. */
export const isForeignLanguage = (value: string | null | undefined): boolean =>
  classifyBookLanguage(value) === 'foreign';

/** The language a `books_items.attrs` blob mirrors (`attrs.language`), or null when absent or not a string. */
export function readItemLanguage(attrs: unknown): string | null {
  const language = (attrs as { language?: unknown } | null | undefined)?.language;
  return typeof language === 'string' ? language : null;
}
