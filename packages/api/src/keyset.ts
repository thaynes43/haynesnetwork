// ADR-018 / DESIGN-008 D-09 — the GENERALIZED keyset-pagination primitive: the shared
// substrate PLAN-005 (Ledger) and PLAN-006 (Trash) build their sorted/filtered lists on.
// It generalizes the DESIGN-005 (sort_title, id) cursor to (sortValue, id) over an ARBITRARY
// sortable column that MAY be NULL, with NULLS LAST in BOTH directions and a stable id
// tiebreaker (id ASC always, regardless of sort direction). This is the load-bearing algorithm
// — see keyset.test.ts for the null/numeric/string/both-direction/page-boundary coverage.
import { sql, type SQL } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';

/** A sort key value on the wire: a string (title), a number (ratings/runtime/counts), an ISO
 *  string (dates — compared with a ::timestamptz cast), or null (the row lacked the field). */
export type KeysetValue = string | number | null;

/** The SQL type of the sort column — drives the cursor-value cast in the keyset predicate. */
export type KeysetKind = 'text' | 'number' | 'date';

/** Encode the ORDER BY key of the last row of a page into an opaque cursor. */
export function encodeKeysetCursor(sortValue: KeysetValue, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id]), 'utf8').toString('base64url');
}

/** Decode a keyset cursor; a malformed/tampered cursor is rejected (never trusted input). */
export function decodeKeysetCursor(cursor: string): { sortValue: KeysetValue; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'malformed cursor' });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[1] !== 'string' ||
    !(parsed[0] === null || typeof parsed[0] === 'string' || typeof parsed[0] === 'number')
  ) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'malformed cursor' });
  }
  return { sortValue: parsed[0], id: parsed[1] };
}

/** Bind a non-null cursor value with the cast its column needs (dates ⇒ ::timestamptz). */
function bound(value: string | number, kind: KeysetKind): SQL {
  return kind === 'date' ? sql`${value}::timestamptz` : sql`${value}`;
}

/**
 * The ORDER BY clause for `(expr <dir> NULLS LAST, id ASC)` — the exact order the keyset
 * predicate steps through. The id tiebreaker is always ASC (stable) regardless of `dir`.
 */
export function keysetOrderBy(expr: SQL, dir: 'asc' | 'desc', idCol: SQL): SQL {
  return dir === 'asc'
    ? sql`${expr} asc nulls last, ${idCol} asc`
    : sql`${expr} desc nulls last, ${idCol} asc`;
}

/**
 * The WHERE condition selecting rows STRICTLY AFTER the cursor in the
 * `(expr <dir> NULLS LAST, id ASC)` ordering. Handles the null cursor position
 * (only later nulls, by id) and the non-null position (later non-nulls by dir, ties by id,
 * plus ALL nulls — nulls sort last in both directions).
 */
export function keysetAfter(params: {
  expr: SQL;
  idCol: SQL;
  kind: KeysetKind;
  dir: 'asc' | 'desc';
  value: KeysetValue;
  id: string;
}): SQL {
  const { expr, idCol, kind, dir, value, id } = params;
  const idParam = sql`${id}::uuid`;
  if (value === null) {
    // Cursor sits among the trailing nulls → only later nulls (by id) remain.
    return sql`(${expr} IS NULL AND ${idCol} > ${idParam})`;
  }
  const b = bound(value, kind);
  const cmp = dir === 'asc' ? sql`${expr} > ${b}` : sql`${expr} < ${b}`;
  // later non-nulls (by dir) OR a tie broken by id OR any null (nulls last, both directions).
  return sql`(${cmp} OR (${expr} = ${b} AND ${idCol} > ${idParam}) OR ${expr} IS NULL)`;
}
