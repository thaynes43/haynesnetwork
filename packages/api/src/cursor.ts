// DESIGN-005 D-17 — opaque keyset cursors for the paginated ledger/fix lists (the
// documented deviation from DESIGN-003 D-03: the ledger is 15k+ rows, not
// household-scale). Cursors are base64url-encoded JSON tuples of the ORDER BY key;
// a malformed/tampered cursor simply restarts the page walk from the top.
import { TRPCError } from '@trpc/server';

/** Encode an order-key tuple into an opaque cursor string. */
export function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/**
 * Decode a cursor produced by encodeCursor. `shape` gives the expected runtime type
 * of each tuple slot; mismatches throw BAD_REQUEST (a cursor is client-supplied
 * input, never trusted).
 */
export function decodeCursor(
  cursor: string,
  shape: readonly ('string' | 'number')[],
): (string | number)[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'malformed cursor' });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== shape.length ||
    parsed.some((value, i) => typeof value !== shape[i])
  ) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'malformed cursor' });
  }
  return parsed as (string | number)[];
}
