// Issue #792 (DESIGN-028 amendment 2026-10-07; owner ruling: admins only) — the words for a want's Request Event
// history (ADR-101, glossary T-292). Pure: the History list (`components/request-event-history.tsx`) renders what these
// return. An event's `before` / `after` are keyed by `book_requests` column name; nothing here shows a raw column name,
// reason code or job id unless it is one this file does not know yet (then it is shown humanized, never hidden).
import type { BookRequestEventReason, BookRequestStatus } from '@hnet/db';
import { formatWhen } from './media';

/** The per-format status in the Wanted detail's own words (the wall's phase vocabulary). */
export const BOOK_REQUEST_STATUS_LABEL: Record<BookRequestStatus, string> = {
  requested: 'Requested',
  wanted: 'Wanted',
  grabbed: 'Grabbed',
  landed: 'Have it',
  missing: 'Missing',
};

/**
 * Why a write happened, in plain words, for every reason a writer records (DESIGN-028's reason table). Typed against
 * the reason union, so a new reason without words fails the typecheck.
 */
export const REQUEST_EVENT_REASON_LABEL: Record<BookRequestEventReason, string> = {
  shelf_want_minted: 'Added from a Goodreads shelf',
  shelf_want_refreshed: 'Updated from the Goodreads shelf',
  ll_pushed: 'Sent to LazyLibrarian',
  ll_reconciled: 'Status updated from LazyLibrarian',
  ll_requeued: 'Queued again in LazyLibrarian',
  comic_routed: 'Sent to Kapowarr',
  comic_reconciled: 'Status updated from Kapowarr',
  landed_reverted: 'Status corrected after a LazyLibrarian check',
  ll_book_gone_repointed: 'LazyLibrarian book replaced, pointed at the new one',
  ll_book_gone_settled: 'LazyLibrarian book gone, marked missing',
  ll_rerequest: 'Re-requested from LazyLibrarian',
  pairing_want_minted: 'Added by format pairing',
  pairing_want_refreshed: 'Updated by format pairing',
  pairing_want_revived: 'Reopened: the paired copy left the library',
  pairing_held_format_landed: 'Held format set to Have it',
  pairing_want_reidentified: 'Cleared to look for the right book',
  pairing_want_retitled: 'Renamed to match the library title',
  collection_want_minted: 'Added as a missing collection member',
  collection_want_refreshed: 'Updated from the collection',
  collection_want_dropped: 'Removed: no longer missing from the collection',
  collection_removed: 'Removed with its collection',
  collection_want_downloaded: 'Downloaded, not in the library yet',
  collection_want_download_reverted: 'Downloaded status taken back',
  force_search_reopened: 'Reopened by a Force Search',
  wrong_author_released: 'Released: the book was by another author',
  parked: 'Parked',
  unparked: 'Unparked',
  english_edition_switched: 'Switched to an English edition',
  wrong_volume_repaired: 'Repaired: it pointed at the wrong volume',
  removed_anchor_settled: 'Settled: its library title was removed',
  parked_want_conformed: 'Statuses corrected on a parked want',
};

/**
 * A readable label per recorded field, by column name. Every field `REQUEST_EVENT_FIELDS` (`@hnet/domain`) records has
 * one; `apps/web/lib/__tests__/request-events.test.ts` fails when a recorded field is added without it. Keyed in the
 * order the history lists changes: the want's state first, then its identity.
 */
export const REQUEST_EVENT_FIELD_LABEL: Record<string, string> = {
  ebook_status: 'Ebook',
  audio_status: 'Audiobook',
  comic_status: 'Comic',
  unroutable_reason: 'Park',
  ll_book_id: 'LazyLibrarian book',
  matched_books_item_id: 'In the library as',
  kapowarr_volume_id: 'Kapowarr volume',
  comicvine_id: 'ComicVine volume',
  ll_rerequested_at: 'Re-request ended',
  ll_rerequest_failures: 'Re-request refusals',
  ll_rerequest_failed_at: 'Last re-request refusal',
  ll_rerequest_added_at: 'Re-request added',
  wrong_author_ll_book_id: 'Other-author book',
  title: 'Title',
  author: 'Author',
  origin: 'Origin',
  pairing_books_item_id: 'Paired with',
  collection_id: 'Collection',
  collection_member_ref: 'Collection member',
  integration_id: 'Goodreads link',
  shelf_item_id: 'Shelf item',
};

const FIELD_ORDER = Object.keys(REQUEST_EVENT_FIELD_LABEL);

const STATUS_FIELDS = new Set(['ebook_status', 'audio_status', 'comic_status']);
const TIME_FIELDS = new Set([
  'll_rerequested_at',
  'll_rerequest_failed_at',
  'll_rerequest_added_at',
]);
/** Ids worth reading in full (they are what an admin searches LazyLibrarian, Kapowarr or ComicVine for). */
const ID_FIELDS = new Set([
  'll_book_id',
  'kapowarr_volume_id',
  'comicvine_id',
  'wrong_author_ll_book_id',
  'collection_member_ref',
]);
/** The app's own row ids: shown short (the full id is the hover title). */
const ROW_ID_FIELDS = new Set(['integration_id', 'shelf_item_id']);
const ITEM_FIELDS = new Set(['matched_books_item_id', 'pairing_books_item_id']);

const ORIGIN_LABEL: Record<string, string> = {
  goodreads: 'Goodreads shelf',
  pairing: 'Format pairing',
  collection: 'Collection',
};

/** `unroutable_reason` values (book-requests.ts schema doc), in words. */
const PARK_LABEL: Record<string, string> = {
  comic: 'Waiting on a ComicVine match',
  wrong_volume: 'Wrong volume',
  multi_book: 'Series holds several books',
  no_book: 'Series holds no book',
  foreign_language: 'Not in English',
  no_english_edition: 'No English edition',
};

const FORMAT_WORD: Record<string, string> = {
  ebook: 'Ebook',
  audiobook: 'Audiobook',
  comic: 'Comic',
};

/** The day Request Events began (migration 0096 shipped in v0.109.0); nothing before it was recorded. */
export const REQUEST_EVENTS_RECORDED_FROM = '2026-10-06';

/** That day as the History says it ("Oct 6, 2026" in the viewer's locale). */
export function recordedFromLabel(): string {
  return new Date(`${REQUEST_EVENTS_RECORDED_FROM}T12:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** `snake_case` / `kebab-case` / `camelCase` → "Words like this" (for a value this file has no words for yet). */
export function humanize(code: string): string {
  const words = code
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : code;
}

export function requestEventReasonLabel(reason: string): string {
  return (REQUEST_EVENT_REASON_LABEL as Record<string, string>)[reason] ?? humanize(reason);
}

export function requestEventFieldLabel(column: string): string {
  return REQUEST_EVENT_FIELD_LABEL[column] ?? humanize(column);
}

// ---------------------------------------------------------------------------
// The shapes the History reads (structural, so this file stays free of the router types).
// ---------------------------------------------------------------------------

export interface RequestEventLike {
  kind: 'mint' | 'update' | 'delete';
  reason: string;
  site: string | null;
  actor: 'sync' | 'repair' | 'user';
  actorName: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  detail: Record<string, unknown> | null;
}

export interface RequestEventRefsLike {
  items: Record<string, { title: string; live: boolean }>;
  collections: Record<string, string>;
}

/** One value as the History shows it. */
export interface EventValue {
  text: string;
  /** In-app link (a library title still in the library). */
  href?: string;
  /** An id: monospace, wraps anywhere. */
  mono?: boolean;
  /** Hover title (the full id behind a short one). */
  title?: string;
  /** An empty value ("None"): muted. */
  none?: boolean;
}

/** One field an event set, changed or cleared. A mint has only `to`, a delete only `from`. */
export interface EventChange {
  column: string;
  label: string;
  from: EventValue | null;
  to: EventValue | null;
}

const NONE: EventValue = { text: 'None', none: true };

function isEmpty(column: string, v: unknown, kind: RequestEventLike['kind']): boolean {
  if (v === null || v === undefined || v === '') return true;
  // A mint or delete lists what the want held; zero refusals is the column default, not something it held.
  return kind !== 'update' && column === 'll_rerequest_failures' && v === 0;
}

/** One recorded field's value in words. */
export function formatEventValue(
  column: string,
  v: unknown,
  refs: RequestEventRefsLike,
): EventValue {
  if (column === 'unroutable_reason') {
    if (v === null || v === undefined || v === '') return { text: 'Not parked', none: true };
    return { text: PARK_LABEL[String(v)] ?? humanize(String(v)) };
  }
  if (v === null || v === undefined || v === '') return NONE;
  const s =
    typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v);
  if (STATUS_FIELDS.has(column)) {
    return { text: (BOOK_REQUEST_STATUS_LABEL as Record<string, string>)[s] ?? humanize(s) };
  }
  if (column === 'origin') return { text: ORIGIN_LABEL[s] ?? humanize(s) };
  if (TIME_FIELDS.has(column)) return { text: formatWhen(s) };
  if (ITEM_FIELDS.has(column)) {
    const item = refs.items[s];
    if (!item) return { text: s.slice(0, 8), mono: true, title: s };
    return item.live
      ? { text: item.title, href: `/library/books/${encodeURIComponent(s)}` }
      : { text: `${item.title} (no longer in the library)` };
  }
  if (column === 'collection_id') {
    const title = refs.collections[s];
    return title !== undefined ? { text: title } : { text: s.slice(0, 8), mono: true, title: s };
  }
  if (ROW_ID_FIELDS.has(column)) return { text: s.slice(0, 8), mono: true, title: s };
  if (ID_FIELDS.has(column)) return { text: s, mono: true };
  return { text: s };
}

/**
 * What an event did to the want, field by field, in the History's order: an update's changed fields before and after,
 * a mint's every field it set, a delete's every field the want held. Empty values are left out of a mint or delete.
 */
export function requestEventChanges(
  e: RequestEventLike,
  refs: RequestEventRefsLike,
): EventChange[] {
  const columns = new Set([...Object.keys(e.before), ...Object.keys(e.after)]);
  const ordered = [
    ...FIELD_ORDER.filter((c) => columns.has(c)),
    ...[...columns].filter((c) => !FIELD_ORDER.includes(c)).sort(),
  ];
  const out: EventChange[] = [];
  for (const column of ordered) {
    const label = requestEventFieldLabel(column);
    if (e.kind === 'mint') {
      if (isEmpty(column, e.after[column], e.kind)) continue;
      out.push({ column, label, from: null, to: formatEventValue(column, e.after[column], refs) });
    } else if (e.kind === 'delete') {
      if (isEmpty(column, e.before[column], e.kind)) continue;
      out.push({ column, label, from: formatEventValue(column, e.before[column], refs), to: null });
    } else {
      out.push({
        column,
        label,
        from: formatEventValue(column, e.before[column], refs),
        to: formatEventValue(column, e.after[column], refs),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The writer's context (`detail`).
// ---------------------------------------------------------------------------

/** Known keys, in the order the line reads them (Postgres `jsonb` keeps its own key order, not the writer's). */
const DETAIL_LABEL: Record<string, string> = {
  outcome: 'Outcome',
  cause: 'Cause',
  formats: 'Formats',
  format: 'Format',
  request: 'Asked for',
  land: 'Set to Have it',
  statusReset: 'Status reset',
  viaAdd: 'Added back to LazyLibrarian',
  llBookId: 'LazyLibrarian book',
  fromLlBookId: 'Previous LazyLibrarian book',
  toLlBookId: 'New LazyLibrarian book',
};
const DETAIL_ORDER = Object.keys(DETAIL_LABEL);

/** The one re-request's outcomes (`recordLlRerequest`, ll-gone.ts). */
const OUTCOME_LABEL: Record<string, string> = {
  landed: 'LazyLibrarian already had it',
  requeued: 'LazyLibrarian took it back',
  not_added: 'LazyLibrarian refused it',
  deferred: 'Waiting for the next quota day',
};

/** The Landed Truth's and the re-identify's causes. */
const CAUSE_LABEL: Record<string, string> = {
  ll_not_held: 'LazyLibrarian does not hold it',
  ll_not_snatched: 'LazyLibrarian has not grabbed it',
  ll_book_mismatch: 'LazyLibrarian holds a different book',
  identity: 'The library title changed',
  volume: 'LazyLibrarian holds another volume',
  work: 'LazyLibrarian holds another work',
};

const ID_DETAIL_KEYS = new Set(['llBookId', 'toLlBookId', 'fromLlBookId']);
const FORMAT_DETAIL_KEYS = new Set(['formats', 'format', 'land', 'request', 'statusReset']);

export interface EventDetailPart {
  label: string;
  value: EventValue;
}

/**
 * The writer's context in words: known keys by name in a fixed order, then any other key humanized. Nothing empty or
 * repeated.
 */
export function requestEventDetail(e: RequestEventLike): EventDetailPart[] {
  const d = e.detail;
  if (!d) return [];
  const out: EventDetailPart[] = [];
  const keys = Object.keys(d);
  const ordered = [
    ...DETAIL_ORDER.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !DETAIL_ORDER.includes(k)).sort(),
  ];
  for (const key of ordered) {
    const raw = d[key];
    if (raw === null || raw === undefined || raw === '') continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    // The re-request names its book twice when it stayed on the same one.
    if (key === 'toLlBookId' && raw === d.llBookId) continue;
    const label = DETAIL_LABEL[key] ?? humanize(key);
    if (key === 'viaAdd') {
      if (raw === true) out.push({ label, value: { text: 'Yes' } });
      continue;
    }
    if (key === 'outcome') {
      out.push({ label, value: { text: OUTCOME_LABEL[String(raw)] ?? humanize(String(raw)) } });
    } else if (key === 'cause') {
      out.push({ label, value: { text: CAUSE_LABEL[String(raw)] ?? humanize(String(raw)) } });
    } else if (ID_DETAIL_KEYS.has(key)) {
      out.push({ label, value: { text: String(raw), mono: true } });
    } else if (FORMAT_DETAIL_KEYS.has(key)) {
      const list = Array.isArray(raw) ? raw : [raw];
      out.push({
        label,
        value: { text: list.map((f) => FORMAT_WORD[String(f)] ?? String(f)).join(', ') },
      });
    } else if (typeof raw === 'boolean') {
      out.push({ label, value: { text: raw ? 'Yes' : 'No' } });
    } else if (Array.isArray(raw)) {
      out.push({ label, value: { text: raw.map(String).join(', ') } });
    } else if (typeof raw === 'object') {
      out.push({ label, value: { text: JSON.stringify(raw), mono: true } });
    } else {
      out.push({ label, value: { text: String(raw) } });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Who and where.
// ---------------------------------------------------------------------------

const JOB_LABEL: Record<string, string> = {
  'goodreads-sync': 'Goodreads sync',
  'format-pairing': 'Format pairing',
  'books-collections-sync': 'Collections sync',
  'collection-force-search': 'Collection search',
  'wrong-volume-requests-repair': 'Wrong-volume repair',
  'search-again': 'Search again',
  'll-orphan-unqueue': 'LazyLibrarian cleanup',
};

const LEG_LABEL: Record<string, string> = {
  rerequest: 're-request',
  reconcile: 'reconcile',
  'landed-check': 'held check',
  'mint-push': 'push',
  push: 'push',
  release: 'release',
  'skipped-sweep': 'skipped sweep',
  comics: 'comics',
  'recent-search': 'recent search',
  'first-sync': 'first sync',
  find_missing_cron: 'scheduled',
  collection_force_search: 'Force Search',
};

/** The job and leg in words: `format-pairing.rerequest` → "Format pairing, re-request". */
export function requestEventSiteLabel(site: string | null): string | null {
  if (!site) return null;
  const dot = site.indexOf('.');
  const job = dot === -1 ? site : site.slice(0, dot);
  const leg = dot === -1 ? null : site.slice(dot + 1);
  const jobText = JOB_LABEL[job] ?? humanize(job);
  if (!leg) return jobText;
  return `${jobText}, ${LEG_LABEL[leg] ?? humanize(leg).toLowerCase()}`;
}

/** Who made the write: the sync, a repair script, or the person (by display name). */
export function requestEventActorLabel(e: Pick<RequestEventLike, 'actor' | 'actorName'>): string {
  if (e.actor === 'user') return e.actorName ?? 'A removed account';
  if (e.actor === 'repair') return 'Repair script';
  return 'Sync';
}
