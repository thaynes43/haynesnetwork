// ADR-109 / DESIGN-055 D-07 (PLAN-077 P2) — the prefilled Helpdesk ticket link (lib/ticket-compose-link.ts): a link
// round-trips, and anything malformed or oversized is dropped or capped, never trusted.
import { describe, expect, it } from 'vitest';
import {
  COMPOSE_NOTE_MAX,
  COMPOSE_SUBJECT_MAX,
  parseComposeLink,
  ticketComposeHref,
} from '../ticket-compose-link';

const ID = '3f1c2b9a-1d2e-4f5a-8b6c-7d8e9f0a1b2c';
const parse = (href: string) => parseComposeLink(new URL(href, 'http://localhost').searchParams);

describe('ticketComposeHref and parseComposeLink', () => {
  it('round-trips a Repair Guide staff link', () => {
    const href = ticketComposeHref({
      mediaItemId: ID,
      episodeId: 50110,
      subject: 'Stuck download: S01E10 · Chapter 10',
      note: 'Force Search found a download.\n\nIt has to be unpacked.',
      category: 'missing',
    });
    expect(href.startsWith('/bulletin?tab=helpdesk&compose=1&')).toBe(true);
    expect(parse(href)).toEqual({
      mediaItemId: ID,
      episodeId: 50110,
      subject: 'Stuck download: S01E10 · Chapter 10',
      note: 'Force Search found a download.\n\nIt has to be unpacked.',
      category: 'missing',
    });
  });

  it('is not a compose link without compose=1', () => {
    expect(parseComposeLink(new URLSearchParams('tab=helpdesk&about=' + ID))).toBeNull();
    expect(parseComposeLink(new URLSearchParams(''))).toBeNull();
  });

  it('drops a malformed media id, and an episode without a title', () => {
    expect(parse(`/bulletin?compose=1&about=not-a-uuid&episode=5`)).toMatchObject({ mediaItemId: null, episodeId: null });
    expect(parse(`/bulletin?compose=1&about=${ID}&episode=-3`)).toMatchObject({ mediaItemId: ID, episodeId: null });
    expect(parse(`/bulletin?compose=1&about=${ID}&episode=1e3`)).toMatchObject({ episodeId: null });
    expect(parse(`/bulletin?compose=1&about=${ID.toUpperCase()}`)).toMatchObject({ mediaItemId: ID });
  });

  it('caps the subject and the note, folds the subject to one line and strips control characters', () => {
    const p = parse(
      `/bulletin?compose=1&subject=${encodeURIComponent('a\nb' + 'x'.repeat(500))}&note=${encodeURIComponent('line\u0007\r\n' + 'y'.repeat(5000))}`,
    )!;
    expect(p.subject.startsWith('a b')).toBe(true);
    expect(p.subject.length).toBe(COMPOSE_SUBJECT_MAX);
    expect(p.note.startsWith('line\ny')).toBe(true);
    expect(p.note.length).toBe(COMPOSE_NOTE_MAX);
    expect(ticketComposeHref({ subject: 'x'.repeat(500), note: '' })).toContain(`subject=${'x'.repeat(COMPOSE_SUBJECT_MAX)}`);
  });

  it('accepts only a known ticket category', () => {
    expect(parse('/bulletin?compose=1&category=missing')?.category).toBe('missing');
    expect(parse('/bulletin?compose=1&category=collection_override')?.category).toBe('other');
    expect(parse('/bulletin?compose=1')?.category).toBe('other');
  });
});
