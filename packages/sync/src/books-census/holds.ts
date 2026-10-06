// DESIGN-028 amendment 2026-10-06 (the Books Census) — the Census Hold (glossary T-291): a finding a person has looked at
// and declared fine for now (a title the Held File Check misreads, a foreign book the owner keeps on purpose). A held
// finding is still logged, with `held: true` and the reason, and never counts toward an alert. Holds live in
// `.agents/books-census-holds.yaml`; the CronJob reads it from main on GitHub, so a docs PR sets or lifts one without a
// release. A hold names a finding's key and, optionally, the file it was declared for: if LazyLibrarian later links
// another file, the hold no longer covers it. An expired hold (`until`) covers nothing.
import { parse } from 'yaml';
import { z } from 'zod';

const KEY =
  /^(wrong_file|missing_file|foreign_held):[^:\s]+:(ebook|audiobook)$|^foreign_wanted:[^:\s]+$|^foreign_item:[a-z]+:\S+$/;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a YYYY-MM-DD date');

const holdSchema = z
  .object({
    key: z
      .string()
      .regex(
        KEY,
        'a finding key: <kind>:<llBookId>:<format>, foreign_wanted:<llBookId> or foreign_item:<source>:<id>',
      ),
    /** The held file, relative to the books root, as the finding reports it. */
    path: z.string().min(1).optional(),
    title: z.string().min(1),
    reason: z.string().min(1),
    opened: day,
    until: day.optional(),
    links: z.array(z.string()).optional(),
  })
  .strict();

const fileSchema = z
  .object({
    version: z.literal(1),
    holds: z.array(holdSchema).default([]),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.holds.forEach((h, i) => {
      const id = `${h.key}@${h.path ?? ''}`;
      if (seen.has(id))
        ctx.addIssue({ code: 'custom', message: `duplicate hold ${h.key}`, path: ['holds', i] });
      seen.add(id);
    });
  });

export type CensusHold = z.infer<typeof holdSchema>;

/** Parse the holds file (YAML). Throws with every schema problem listed. */
export function parseHolds(text: string): CensusHold[] {
  const result = fileSchema.safeParse(parse(text) ?? {});
  if (!result.success) {
    throw new Error(
      result.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`).join('; '),
    );
  }
  return result.data.holds;
}

/** The hold covering a finding, or null: same key, same file when the hold names one, not expired. */
export function matchHold(
  holds: readonly CensusHold[],
  key: string,
  path: string | undefined,
  now: Date,
): CensusHold | null {
  const today = now.toISOString().slice(0, 10);
  return (
    holds.find(
      (h) =>
        h.key === key &&
        (h.path === undefined || h.path === path) &&
        (h.until === undefined || h.until >= today),
    ) ?? null
  );
}
