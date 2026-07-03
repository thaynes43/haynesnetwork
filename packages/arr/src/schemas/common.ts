// DESIGN-005 D-02 — shared zod shapes. All object schemas are default (strip) mode:
// they tolerate any extra upstream fields but never let unknown fields past the
// BC-03 ACL boundary (unknown *arr fields never enter the app).
import { z } from 'zod';

/** `GET /system/status` — only the identity fields the app consumes (D-01 probe). */
export const systemStatusSchema = z.object({
  appName: z.string().optional(),
  instanceName: z.string().optional(),
  version: z.string(),
});
export type ArrSystemStatus = z.infer<typeof systemStatusSchema>;

/** `GET /qualityprofile` element — id→name map source (D-14 step 1, D-16 remap-by-name). */
export const qualityProfileSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type ArrQualityProfile = z.infer<typeof qualityProfileSchema>;

/** `GET /rootfolder` element. */
export const rootFolderSchema = z.object({
  id: z.number().int(),
  path: z.string(),
  accessible: z.boolean().optional(),
  freeSpace: z.number().optional(),
});
export type ArrRootFolder = z.infer<typeof rootFolderSchema>;

/** `GET /tag` element — int ids → labels (D-02); Restore recreates tags by label (D-03). */
export const tagSchema = z.object({
  id: z.number().int(),
  label: z.string(),
});
export type ArrTag = z.infer<typeof tagSchema>;

/** Paged *arr envelope (`/history`, `/wanted/missing`, …). */
export const pagedSchema = <T extends z.ZodType>(record: T) =>
  z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    sortKey: z.string().optional(),
    sortDirection: z.string().optional(),
    totalRecords: z.number().int(),
    records: z.array(record),
  });
export interface ArrPage<T> {
  page: number;
  pageSize: number;
  sortKey?: string;
  sortDirection?: string;
  totalRecords: number;
  records: T[];
}

/** Release quality on history records — nested name/id only (D-02). */
export const historyQualitySchema = z.object({
  quality: z.object({ id: z.number().int(), name: z.string() }),
});

/**
 * History record fields common to all three *arrs (D-02): per-kind target ids are added
 * in sonarr.ts/radarr.ts/lidarr.ts. `eventType` stays a plain string here — the full
 * per-kind enums live in each kind's schema; normalization is the domain's job (D-07).
 */
export const historyRecordBaseSchema = z.object({
  id: z.number().int(),
  eventType: z.string(),
  date: z.string(),
  sourceTitle: z.string().nullish(),
  downloadId: z.string().nullish(),
  quality: historyQualitySchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/** `POST /command` acknowledgement (write surface — search triggers, D-15). */
export const commandResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type ArrCommandResponse = z.infer<typeof commandResponseSchema>;
