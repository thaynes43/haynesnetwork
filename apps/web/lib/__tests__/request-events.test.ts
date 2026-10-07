// Issue #792 (DESIGN-028 amendment 2026-10-07) — the words of a want's Request Event history. Pins that every recorded
// field and every reason has words (no raw column name or reason code reaches the screen), how each kind of value
// reads, and the who/where line.
import { describe, expect, it } from 'vitest';
import { BOOK_REQUEST_EVENT_REASONS, type BookRequestRow } from '@hnet/db';
import { REQUEST_EVENT_FIELDS, requestEventSnapshot } from '@hnet/domain';
import {
  REQUEST_EVENT_FIELD_LABEL,
  REQUEST_EVENT_REASON_LABEL,
  humanize,
  requestEventActorLabel,
  requestEventChanges,
  requestEventDetail,
  requestEventReasonLabel,
  requestEventSiteLabel,
  type RequestEventLike,
  type RequestEventRefsLike,
} from '../request-events';

const NO_REFS: RequestEventRefsLike = { items: {}, collections: {} };

function ev(overrides: Partial<RequestEventLike>): RequestEventLike {
  return {
    kind: 'update',
    reason: 'll_reconciled',
    site: 'format-pairing',
    actor: 'sync',
    actorName: null,
    before: {},
    after: {},
    detail: null,
    ...overrides,
  };
}

/** The column names an event keys its fields by: the domain's own snapshot of a row with every field set. */
function recordedColumns(): string[] {
  const row = Object.fromEntries(
    REQUEST_EVENT_FIELDS.map((f) => [f, null]),
  ) as unknown as BookRequestRow;
  return Object.keys(requestEventSnapshot(row));
}

const NO_EM_DASH = /—/;

describe('every recorded field and every reason has words', () => {
  it('labels every field a Request Event records, and nothing it does not', () => {
    const columns = recordedColumns();
    expect(columns.length).toBe(REQUEST_EVENT_FIELDS.length);
    expect(Object.keys(REQUEST_EVENT_FIELD_LABEL).sort()).toEqual([...columns].sort());
  });

  it('words every reason a writer records, with no em-dash', () => {
    expect(Object.keys(REQUEST_EVENT_REASON_LABEL).sort()).toEqual(
      [...BOOK_REQUEST_EVENT_REASONS].sort(),
    );
    for (const words of Object.values(REQUEST_EVENT_REASON_LABEL)) {
      expect(words).not.toMatch(NO_EM_DASH);
      expect(words).not.toMatch(/_/);
    }
    for (const words of Object.values(REQUEST_EVENT_FIELD_LABEL))
      expect(words).not.toMatch(NO_EM_DASH);
  });

  it('humanizes a reason or field it does not know yet instead of hiding it', () => {
    expect(requestEventReasonLabel('ll_pushed')).toBe('Sent to LazyLibrarian');
    expect(requestEventReasonLabel('some_new_reason')).toBe('Some new reason');
    expect(humanize('toLlBookId')).toBe('To ll book id');
  });
});

describe('what changed', () => {
  it('an update lists each changed field before and after, statuses and parks in words', () => {
    const changes = requestEventChanges(
      ev({
        reason: 'parked',
        before: { unroutable_reason: null, ebook_status: 'wanted', ll_book_id: 'gb-a' },
        after: {
          unroutable_reason: 'no_english_edition',
          ebook_status: 'landed',
          ll_book_id: null,
        },
      }),
      NO_REFS,
    );
    expect(changes.map((c) => [c.label, c.from?.text, c.to?.text])).toEqual([
      ['Ebook', 'Wanted', 'Have it'],
      ['Park', 'Not parked', 'No English edition'],
      ['LazyLibrarian book', 'gb-a', 'None'],
    ]);
    expect(changes[2]!.from).toMatchObject({ mono: true });
    expect(changes[2]!.to).toMatchObject({ none: true });
  });

  it('a mint lists only what it set; a delete only what the want held', () => {
    const snapshot = {
      origin: 'pairing',
      title: 'Mistborn',
      author: null,
      ebook_status: 'landed',
      audio_status: 'requested',
      ll_rerequest_failures: 0,
      unroutable_reason: null,
    };
    const mint = requestEventChanges(ev({ kind: 'mint', before: {}, after: snapshot }), NO_REFS);
    expect(mint.map((c) => [c.label, c.from, c.to?.text])).toEqual([
      ['Ebook', null, 'Have it'],
      ['Audiobook', null, 'Requested'],
      ['Title', null, 'Mistborn'],
      ['Origin', null, 'Format pairing'],
    ]);
    const del = requestEventChanges(ev({ kind: 'delete', before: snapshot, after: {} }), NO_REFS);
    expect(del.map((c) => [c.label, c.from?.text, c.to])).toEqual([
      ['Ebook', 'Have it', null],
      ['Audiobook', 'Requested', null],
      ['Title', 'Mistborn', null],
      ['Origin', 'Format pairing', null],
    ]);
  });

  it('names library titles and collections, links a live title, and shortens the app’s own row ids', () => {
    const live = '162f8e3e-b0da-4bfc-ab38-718d93419630';
    const gone = 'a3782d07-2528-4335-b152-fd4de9ba3acf';
    const unknown = 'bbbbbbbb-2528-4335-b152-fd4de9ba3acf';
    const refs: RequestEventRefsLike = {
      items: {
        [live]: { title: 'Hyperion', live: true },
        [gone]: { title: 'Hyperion (old copy)', live: false },
      },
      collections: { c1: 'The Stormlight Archive' },
    };
    const [match] = requestEventChanges(
      ev({ before: { matched_books_item_id: gone }, after: { matched_books_item_id: live } }),
      refs,
    );
    expect(match!.label).toBe('In the library as');
    expect(match!.from).toEqual({ text: 'Hyperion (old copy) (no longer in the library)' });
    expect(match!.to).toEqual({ text: 'Hyperion', href: `/library/books/${live}` });

    const [pairedUnknown, collection, shelfItem] = requestEventChanges(
      ev({
        kind: 'mint',
        after: { pairing_books_item_id: unknown, collection_id: 'c1', shelf_item_id: unknown },
      }),
      refs,
    );
    expect(pairedUnknown!.to).toEqual({ text: 'bbbbbbbb', mono: true, title: unknown });
    expect(collection!.to).toEqual({ text: 'The Stormlight Archive' });
    expect(shelfItem!.to).toEqual({ text: 'bbbbbbbb', mono: true, title: unknown });
  });

  it('a field it does not know is listed last, humanized', () => {
    const changes = requestEventChanges(
      ev({
        before: { new_column: 'a', ebook_status: 'wanted' },
        after: { new_column: 'b', ebook_status: 'missing' },
      }),
      NO_REFS,
    );
    expect(changes.map((c) => c.label)).toEqual(['Ebook', 'New column']);
  });
});

describe('the writer’s context', () => {
  it('words the re-request in a fixed order and leaves out what repeats or is empty', () => {
    // The key order Postgres jsonb hands back (shortest key first), not the writer's.
    const parts = requestEventDetail(
      ev({
        reason: 'll_rerequest',
        detail: {
          land: [],
          viaAdd: true,
          outcome: 'not_added',
          request: ['audiobook'],
          llBookId: 'gb-1',
          toLlBookId: 'gb-1',
        },
      }),
    );
    expect(parts.map((p) => [p.label, p.value.text])).toEqual([
      ['Outcome', 'LazyLibrarian refused it'],
      ['Asked for', 'Audiobook'],
      ['Added back to LazyLibrarian', 'Yes'],
      ['LazyLibrarian book', 'gb-1'],
    ]);
    expect(parts[3]!.value.mono).toBe(true);
  });

  it('words a cause, a format list and a flag; shows an unknown key by name', () => {
    expect(
      requestEventDetail(
        ev({ detail: { cause: 'll_not_held', formats: ['ebook', 'audiobook'], viaAdd: true } }),
      ).map((p) => [p.label, p.value.text]),
    ).toEqual([
      ['Cause', 'LazyLibrarian does not hold it'],
      ['Formats', 'Ebook, Audiobook'],
      ['Added back to LazyLibrarian', 'Yes'],
    ]);
    expect(requestEventDetail(ev({ detail: { somethingNew: 3 } }))).toEqual([
      { label: 'Something new', value: { text: '3' } },
    ]);
    expect(requestEventDetail(ev({ detail: null }))).toEqual([]);
  });
});

describe('who and where', () => {
  it('reads the job and its leg', () => {
    expect(requestEventSiteLabel('format-pairing.rerequest')).toBe('Format pairing, re-request');
    expect(requestEventSiteLabel('collection-force-search.find_missing_cron')).toBe(
      'Collection search, scheduled',
    );
    expect(requestEventSiteLabel('wrong-volume-requests-repair')).toBe('Wrong-volume repair');
    expect(requestEventSiteLabel('goodreads-sync.first-sync')).toBe('Goodreads sync, first sync');
    expect(requestEventSiteLabel('brand-new-job.some-leg')).toBe('Brand new job, some leg');
    expect(requestEventSiteLabel(null)).toBeNull();
  });

  it('names the sync, a repair script, or the person', () => {
    expect(requestEventActorLabel({ actor: 'sync', actorName: null })).toBe('Sync');
    expect(requestEventActorLabel({ actor: 'repair', actorName: null })).toBe('Repair script');
    expect(requestEventActorLabel({ actor: 'user', actorName: 'Reader Rae' })).toBe('Reader Rae');
    expect(requestEventActorLabel({ actor: 'user', actorName: null })).toBe('A removed account');
  });
});
