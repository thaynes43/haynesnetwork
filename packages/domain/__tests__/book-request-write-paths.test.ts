// ADR-101 / DESIGN-028 amendment 2026-10-06 (issue #741) — the book_requests WRITE PATH, as static analysis. The
// repo-wide no-direct-state-writes guard keeps every book_requests write inside packages/domain; this narrows it
// further, INSIDE the domain: only `book-request-events.ts` may insert, update or delete a book_requests row, because
// that module is what records the Request Event in the same transaction. Every writer calls its
// `updateBookRequests` / `insertBookRequest` / `deleteBookRequests` / `stampBookRequests`. The append-only
// `book_request_events` is inserted by that module only, and never updated or deleted anywhere.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOMAIN_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WRITE_PATH = 'book-request-events.ts';

const ID = '(?:[A-Za-z_$][\\w$]*\\.)?';

/** Any write to book_requests: the SQL and Drizzle forms (`bookRequests` exactly, not `bookRequestEvents`). */
const REQUEST_WRITE = new RegExp(
  [
    'INSERT\\s+INTO\\s+book_requests\\b',
    'UPDATE\\s+book_requests\\s+SET\\b',
    'DELETE\\s+FROM\\s+book_requests\\b',
    `\\.(?:insert|update|delete)\\(\\s*${ID}bookRequests\\s*\\)`,
  ].join('|'),
  'gi',
);

/** An insert into book_request_events. */
const EVENT_INSERT = new RegExp(
  [
    `INSERT\\s+INTO\\s+book_request_events\\b`,
    `\\.insert\\(\\s*${ID}bookRequestEvents\\s*\\)`,
  ].join('|'),
  'gi',
);

/** An update or delete of book_request_events (never allowed: the history is append-only). */
const EVENT_REWRITE = new RegExp(
  [
    'UPDATE\\s+book_request_events\\s+SET\\b',
    'DELETE\\s+FROM\\s+book_request_events\\b',
    `\\.(?:update|delete)\\(\\s*${ID}bookRequestEvents\\s*\\)`,
  ].join('|'),
  'gi',
);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The 1-based lines a pattern matches in a source text. */
export function linesMatching(source: string, pattern: RegExp): number[] {
  return [...source.matchAll(pattern)].map((m) => source.slice(0, m.index).split('\n').length);
}

async function offenders(pattern: RegExp, allowed: (rel: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const file of await walk(DOMAIN_SRC)) {
    const rel = relative(DOMAIN_SRC, file).split(sep).join('/');
    if (allowed(rel)) continue;
    const source = await readFile(file, 'utf8');
    for (const line of linesMatching(source, pattern)) found.push(`${rel}:${line}`);
  }
  return found;
}

describe('book_requests write path (ADR-101)', () => {
  it('the patterns see every write form and nothing else', () => {
    const hit = (s: string) => linesMatching(s, REQUEST_WRITE).length;
    expect(hit('await tx.update(bookRequests).set({})')).toBe(1);
    expect(hit('await tx.insert(bookRequests).values({})')).toBe(1);
    expect(hit('db.delete( schema.bookRequests )')).toBe(1);
    expect(hit('sql`UPDATE book_requests SET ll_book_id = null`')).toBe(1);
    expect(hit('sql`DELETE FROM book_requests WHERE id = 1`')).toBe(1);
    expect(hit('INSERT INTO book_requests (id) VALUES (1)')).toBe(1);
    expect(hit('tx.select().from(bookRequests).for("update")')).toBe(0);
    expect(hit('tx.insert(bookRequestEvents).values([])')).toBe(0);
    expect(hit('INSERT INTO book_request_events (id) VALUES (1)')).toBe(0);
    expect(linesMatching('tx.insert(bookRequestEvents)', EVENT_INSERT)).toEqual([1]);
    expect(linesMatching('x\ntx.delete(bookRequestEvents)', EVENT_REWRITE)).toEqual([2]);
    expect(linesMatching('UPDATE book_request_events SET reason = 1', EVENT_REWRITE)).toEqual([1]);
  });

  it(`only ${WRITE_PATH} writes book_requests`, async () => {
    expect(await offenders(REQUEST_WRITE, (rel) => rel === WRITE_PATH)).toEqual([]);
  });

  it(`only ${WRITE_PATH} inserts a Request Event`, async () => {
    expect(await offenders(EVENT_INSERT, (rel) => rel === WRITE_PATH)).toEqual([]);
  });

  it('nothing updates or deletes a Request Event', async () => {
    expect(await offenders(EVENT_REWRITE, () => false)).toEqual([]);
  });

  it(`${WRITE_PATH} is where the writes are (the guard is not vacuous)`, async () => {
    const source = await readFile(join(DOMAIN_SRC, WRITE_PATH), 'utf8');
    expect(linesMatching(source, REQUEST_WRITE).length).toBeGreaterThanOrEqual(4);
    expect(linesMatching(source, EVENT_INSERT).length).toBeGreaterThanOrEqual(1);
  });
});
