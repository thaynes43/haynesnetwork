// ADR-055 / DESIGN-028 (PLAN-044) — the ACL zod schemas for the LazyLibrarian JSON responses we read.
// Kept tolerant (passthrough + optional) because LL's API shapes vary by build; we only depend on the two
// per-format status fields. The RAW LL status strings are returned to the domain, which owns the mapping
// LL-status → per-format request-status (books_items-mirror precedent: the ACL parses, the domain decides).
import { z } from 'zod';

/**
 * `cmd=getBook&id=<bookid>` — the LL book row. LL uses capitalized keys; `Status` is the EBOOK status and
 * `AudioStatus` the AUDIOBOOK status (both from the LL vocabulary: Wanted / Skipped / Open / Have / Snatched
 * / Ignored / Matched). Some builds nest the book under a `data`/array — we accept the flat object and let
 * the read client pick the first element of an array shape.
 */
export const llBookSchema = z
  .object({
    BookID: z.union([z.string(), z.number()]).optional(),
    BookName: z.string().optional(),
    Status: z.string().nullish(),
    AudioStatus: z.string().nullish(),
  })
  .passthrough();

export type LlBook = z.infer<typeof llBookSchema>;

/** `getBook` may return the object directly, wrapped in `{ data }`, or as a single-element array. */
export const llGetBookResponseSchema = z.union([
  llBookSchema,
  z.object({ data: z.union([llBookSchema, z.array(llBookSchema)]) }).passthrough(),
  z.array(llBookSchema),
  // An unknown-book / error response is a bare string or empty — tolerate it (→ null in the read client).
  z.string(),
  z.null(),
]);

export type LlGetBookResponse = z.infer<typeof llGetBookResponseSchema>;
