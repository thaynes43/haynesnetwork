// Spoken-text primitives (DESIGN-049 D-21): dates, counts, title hygiene and the 1,200-character cap.
// Output is read aloud by the Movie Room voice agent and read by the owner: plain sentences, no
// markdown, bullets, emoji or URLs; digits are fine.

import { DAY_SECONDS } from './types';

/** The Voice Budget's result cap (T-253, R-245). */
export const SPOKEN_MAX_CHARS = 1200;

/** The owner's time zone; "today" and "September 12" are his calendar days, not UTC's. */
export const DEFAULT_TIME_ZONE = 'America/New_York';

export interface DateOptions {
  /** IANA zone for calendar days (default {@link DEFAULT_TIME_ZONE}). */
  timeZone?: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface CivilDate {
  y: number;
  m: number;
  d: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function civilDate(ts: number, timeZone: string): CivilDate {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(ts * 1000));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: part('year'), m: part('month'), d: part('day') };
}

function dayNumber(c: CivilDate): number {
  return Date.UTC(c.y, c.m - 1, c.d) / (DAY_SECONDS * 1000);
}

function monthName(m: number): string {
  return MONTHS[m - 1] ?? 'an unknown month';
}

type DateWords =
  { kind: 'relative'; word: 'today' | 'yesterday' } | { kind: 'day' | 'month'; text: string };

function dateWords(ts: number, now: number, opts: DateOptions): DateWords {
  const tz = opts.timeZone ?? DEFAULT_TIME_ZONE;
  const then = civilDate(ts, tz);
  const today = civilDate(now, tz);
  const diff = dayNumber(today) - dayNumber(then);
  if (diff === 0) return { kind: 'relative', word: 'today' };
  if (diff === 1) return { kind: 'relative', word: 'yesterday' };
  if (then.y === today.y) return { kind: 'day', text: `${monthName(then.m)} ${then.d}` };
  return { kind: 'month', text: `${monthName(then.m)} ${then.y}` };
}

/**
 * A spoken date relative to `now` (both unix seconds), in the owner's calendar: "today",
 * "yesterday", "on September 12" (this year), "in March 2025" (any other year).
 */
export function spokenDate(ts: number, now: number, opts: DateOptions = {}): string {
  const w = dateWords(ts, now, opts);
  if (w.kind === 'relative') return w.word;
  return w.kind === 'day' ? `on ${w.text}` : `in ${w.text}`;
}

/** The same date after "since": "since yesterday", "since September 12", "since March 2025". */
export function spokenSince(ts: number, now: number, opts: DateOptions = {}): string {
  const w = dateWords(ts, now, opts);
  return `since ${w.kind === 'relative' ? w.word : w.text}`;
}

const COUNT_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
] as const;

/** A count as a word up to twenty ("three"), digits above; `capital` for the start of a sentence. */
export function countWord(n: number, capital = false): string {
  const word = Number.isInteger(n) && n >= 0 ? (COUNT_WORDS[n] ?? String(n)) : String(n);
  return capital ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** "1 episode", "5 episodes". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Make a title safe to speak and display: drop URLs, emoji and markdown characters ("M*A*S*H" →
 * "MASH", "[REC]" → "REC"), fold whitespace. Letters, digits and ordinary punctuation stay.
 */
export function spokenTitle(title: string): string {
  return title
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/‍|️/g, '')
    .replace(/[*_`#|~<>[\]{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'vol', 'mt', 'ft']);

/** True when the period at `index` ends an abbreviation or an initial, not a sentence. */
function isAbbreviation(text: string, index: number): boolean {
  if (text[index] !== '.') return false;
  const word = /(\S+)$/.exec(text.slice(0, index))?.[1] ?? '';
  return ABBREVIATIONS.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word) || /\.\p{L}$/u.test(word);
}

/**
 * Cap spoken text at `max` characters, cutting at the last sentence boundary that fits. When no
 * sentence fits, cut at a word boundary and close the sentence. Never returns more than `max`.
 */
export function capSpoken(text: string, max: number = SPOKEN_MAX_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  let cut = -1;
  const boundary = /[.!?]["')\]]?(?=\s|$)/g;
  for (let m = boundary.exec(t); m !== null; m = boundary.exec(t)) {
    const end = m.index + m[0].length;
    if (end > max) break;
    if (!isAbbreviation(t, m.index)) cut = end;
  }
  if (cut > 0) return t.slice(0, cut);
  const slice = t.slice(0, Math.max(0, max - 1));
  const space = slice.lastIndexOf(' ');
  const base = (space > 0 ? slice.slice(0, space) : slice).replace(/[\s,;:.!?-]+$/, '');
  return base ? `${base}.` : '';
}

export interface SpokenListParts {
  /** The opening sentence ("Three unfinished shows."). */
  lead: string;
  /** One full sentence per listed item. */
  items: readonly string[];
  /** Items already left out by the caller's limit. */
  more?: number;
  /** Sentences after the list (e.g. the "Not on Plex yet" picks); dropped first when over budget. */
  tail?: readonly string[];
}

/**
 * Join a spoken list under the cap: lead, items, "And N more." when anything is left out, then the
 * tail. Over budget, tail sentences go first, then items from the end (each one raising N), so the
 * list always ends on a whole sentence and says how many it skipped.
 */
export function capSpokenList(parts: SpokenListParts, max: number = SPOKEN_MAX_CHARS): string {
  const items = [...parts.items];
  const tail = [...(parts.tail ?? [])];
  let more = Math.max(0, parts.more ?? 0);
  const render = () =>
    [parts.lead, ...items, more > 0 ? `And ${more} more.` : '', ...tail]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(' ');
  let text = render();
  while (text.length > max && tail.length > 0) {
    tail.pop();
    text = render();
  }
  while (text.length > max && items.length > 0) {
    items.pop();
    more += 1;
    text = render();
  }
  return capSpoken(text, max);
}
