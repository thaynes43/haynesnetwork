// ADR-055 / DESIGN-028 (PLAN-044) — the ACL zod schemas for the LazyLibrarian JSON responses we read.
// Kept tolerant (passthrough + optional) because LL's API shapes vary by build; we only depend on the two
// per-format status fields. The RAW LL status strings are returned to the domain, which owns the mapping
// LL-status → per-format request-status (books_items-mirror precedent: the ACL parses, the domain decides).
import { z } from 'zod';

/**
 * One LL book row (as served inside `cmd=getAllBooks`). LL uses capitalized keys; `Status` is the EBOOK
 * status and `AudioStatus` the AUDIOBOOK status (both from the LL vocabulary: Wanted / Skipped / Open /
 * Have / Snatched / Ignored / Matched).
 *
 * ADR-055 amendment (2026-09-22 — the push guard): `BookLibrary` / `AudioLibrary` ride through too. They
 * are LL's per-format IMPORT DATES (set when LL's post-processor files a copy into its library, ISO'd by
 * LL's own `_dic_from_query`), i.e. the "LL holds this format on disk" signal — the field the push guard
 * needs, because a status alone lies: LL's `books` table holds rows that are `Skipped` (39 of them on
 * 2026-09-22) or `Snatched` (29) with a library date and a real file. `BookFile` / `AudioFile` (the on-disk
 * paths) are accepted when a build serves them — this build's `getAllBooks` projection does NOT include
 * them, so they are optional and the guard ORs every held-signal it is given.
 */
export const llBookSchema = z
  .object({
    BookID: z.union([z.string(), z.number()]).optional(),
    BookName: z.string().optional(),
    Status: z.string().nullish(),
    AudioStatus: z.string().nullish(),
    BookLibrary: z.string().nullish(),
    AudioLibrary: z.string().nullish(),
    BookFile: z.string().nullish(),
    AudioFile: z.string().nullish(),
  })
  .passthrough();

export type LlBook = z.infer<typeof llBookSchema>;

/**
 * `cmd=getAllBooks` — every book LL tracks, one row per book with the two per-format statuses. This is the
 * reconcile source of truth: the deployed LL build (`version-40a389ea`) has NO `getBook` command (its API
 * answers `Unknown command: getBook` — found 2026-07-15, the reconcile had been a silent no-op since
 * PLAN-044 shipped), so per-book status reads are impossible — the sync fetches the full list once per run
 * instead (~100s of rows; cheaper than N per-book calls anyway, and immune to per-call 503 bursts).
 * RE-VERIFIED against the live pod 2026-09-22: `api.py` DOES define a `_getbook` method, but `getBook` is
 * absent from its `cmd_dict`, and the dispatcher rejects any command missing from that dict BEFORE the
 * lookup (`if kwargs['cmd'].lower() not in self.lower_cmds: … Unknown command`). So `getBook&id=` is still
 * unreachable on this build and this full-list read remains the only per-book status source.
 * Array / `{ data }` / error-string shapes all tolerated (→ empty map in the read client).
 */
export const llGetAllBooksResponseSchema = z.union([
  z.array(llBookSchema),
  z.object({ data: z.array(llBookSchema) }).passthrough(),
  z.string(),
  z.null(),
  // An error object (e.g. `{ Success: false, Error: {...} }` — the unknown-command shape) → empty map.
  z.object({}).passthrough(),
]);

export type LlGetAllBooksResponse = z.infer<typeof llGetAllBooksResponseSchema>;

/**
 * ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — a LazyLibrarian WANTED-TABLE row (`cmd=getWanted`).
 * The wanted table is the acquisition worklist: one row per grab attempt, carrying the per-grab `Status`
 * (Wanted / Snatched / Processed / Failed), the download `Source` (SABNZBD / NZB / TORRENT / DIRECT) + the
 * `DownloadID` (the SAB `nzo_id` / torrent hash — the join key to SAB), the `AuxInfo` format tag, the
 * `DLResult` failure text, and `NZBtitle`/`NZBdate` (display + staleness). Kept tolerant (LL's shapes vary
 * by build); the domain owns the status → stage mapping (the mapLlStatus precedent). Capitalized keys.
 */
export const llWantedRowSchema = z
  .object({
    BookID: z.union([z.string(), z.number()]).optional(),
    NZBtitle: z.string().nullish(),
    Status: z.string().nullish(),
    Source: z.string().nullish(),
    DownloadID: z.union([z.string(), z.number()]).nullish(),
    AuxInfo: z.string().nullish(),
    DLResult: z.string().nullish(),
    NZBdate: z.string().nullish(),
  })
  .passthrough();

export type LlWantedRow = z.infer<typeof llWantedRowSchema>;

/** `getWanted` returns an array, `{ data: [...] }`, or an error string/empty — all tolerated. */
export const llGetWantedResponseSchema = z.union([
  z.array(llWantedRowSchema),
  z.object({ data: z.array(llWantedRowSchema) }).passthrough(),
  z.string(),
  z.null(),
]);

export type LlGetWantedResponse = z.infer<typeof llGetWantedResponseSchema>;
