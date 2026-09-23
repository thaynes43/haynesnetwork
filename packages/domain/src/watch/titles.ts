// ADR-088 / DESIGN-049 D-07 / D-08 / D-09 step 5 — the single writer of `watch_titles`, the Title State
// snapshot. Three callers: the `watch` sync (bulk), live revalidation (D-11) and the Watch Mark
// write-through (D-14 step 6 / D-15). Rules:
//   • changed rows only — an input identical to its stored row is not written (refreshed_at stays);
//   • never delete — a title gone from Plex keeps its row (and its event facts) with `on_plex = []`;
//   • re-key in place (D-08) — an input that matches a stored row by ANY identity key updates that row, and
//     moves its `title_key` to a STRONGER key when it learned one, so marks keep pointing at it.
// Derived, rebuildable state (the media_plex_matches class): no audit row.
import {
  watchTitles,
  type DbClient,
  type WatchOnPlexEntry,
  type WatchPlexCounts,
  type WatchShowStatus,
  type WatchTitleInsert,
  type WatchTitleRow,
} from '@hnet/db';
import { keysOf, titleKeyRank, type TitleProgressFields, type WatchKind } from '@hnet/watch';
import { eq, inArray } from 'drizzle-orm';
import { inTransaction } from '../db-client';

/** One Title State as a writer caller computed it. */
export interface WatchTitleWrite extends TitleProgressFields {
  /** The stored row this is known to be (revalidation, the mark write-through); absent ⇒ matched by keys. */
  id?: number;
  kind: WatchKind;
  /** The D-08 key the caller computed (the writer keeps a stored key that is at least as strong). */
  titleKey: string;
  plexGuid: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  mediaItemId: string | null;
  title: string;
  year: number | null;
  genres: string[];
  contentRating: string | null;
  isKids: boolean;
  onPlex: WatchOnPlexEntry[];
  plexCounts: WatchPlexCounts;
  showStatus: WatchShowStatus | null;
}

export interface UpsertWatchTitlesReport {
  inserted: number;
  updated: number;
  /** Updated rows whose `title_key` moved to a stronger key (D-08). */
  rekeyed: number;
  unchanged: number;
  /** Inputs dropped because an earlier input of the same batch already claimed their row. */
  conflicts: number;
  /**
   * The row each input landed on, in input order; a conflicting input maps to the row that claimed its
   * identity when this batch wrote it, else null.
   */
  rows: Array<WatchTitleRow | null>;
}

type Light = Pick<
  WatchTitleRow,
  'id' | 'kind' | 'titleKey' | 'plexGuid' | 'tmdbId' | 'tvdbId' | 'imdbId' | 'title' | 'year'
>;

function scopedKeys(r: {
  kind: WatchKind;
  titleKey?: string | null;
  plexGuid: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  title: string;
  year: number | null;
}): string[] {
  return keysOf(r).map((k) => `${r.kind}|${k}`);
}

/** Recursively key-sorted JSON — Postgres jsonb reorders object keys, so a plain stringify would lie. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v instanceof Date) return v.toISOString();
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const FIELDS = [
  'titleKey',
  'plexGuid',
  'tmdbId',
  'tvdbId',
  'imdbId',
  'mediaItemId',
  'title',
  'year',
  'genres',
  'contentRating',
  'isKids',
  'onPlex',
  'plexCounts',
  'episodeMap',
  'episodesTotal',
  'episodesWatched',
  'furthestSeason',
  'furthestEpisode',
  'nextSeason',
  'nextEpisode',
  'nextTitle',
  'nextServer',
  'nextRatingKey',
  'nextResume',
  'resumePercent',
  'plexWatched',
  'plexLastViewedAt',
  'eventPlays',
  'eventWatchedEpisodes',
  'firstWatchedAt',
  'lastWatchedAt',
  'rewatch',
  'showStatus',
] as const satisfies ReadonlyArray<keyof WatchTitleRow & keyof WatchTitleWrite>;

type Field = (typeof FIELDS)[number];

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : a;
    const tb = b instanceof Date ? b.getTime() : b;
    return ta === tb;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return canonicalJson(a) === canonicalJson(b);
  }
  return (a ?? null) === (b ?? null);
}

/** The column values of an input, with the final title key. */
function values(w: WatchTitleWrite, titleKey: string): Pick<WatchTitleInsert, Field> {
  const out = {} as Record<Field, unknown>;
  for (const f of FIELDS) out[f] = w[f];
  out.titleKey = titleKey;
  return out as Pick<WatchTitleInsert, Field>;
}

/**
 * Upsert Title States for one account (see the module header). All-or-nothing in one transaction. An input
 * with an `id` updates that row; otherwise it updates the stored row it shares an identity key with (an
 * exact `title_key` match first, else the strongest-keyed, else the oldest), or inserts a new row.
 */
export async function upsertWatchTitles(input: {
  db?: DbClient;
  plexAccountId: number;
  titles: readonly WatchTitleWrite[];
  now?: Date;
}): Promise<UpsertWatchTitlesReport> {
  const now = input.now ?? new Date();
  const report: UpsertWatchTitlesReport = {
    inserted: 0,
    updated: 0,
    rekeyed: 0,
    unchanged: 0,
    conflicts: 0,
    rows: [],
  };
  if (input.titles.length === 0) return report;

  return inTransaction(input.db, async (tx) => {
    // Every row's identity (a light projection — a few thousand rows at most): matching needs them all,
    // and so does the re-key collision check on the unique (account, title_key).
    const light: Light[] = await tx
      .select({
        id: watchTitles.id,
        kind: watchTitles.kind,
        titleKey: watchTitles.titleKey,
        plexGuid: watchTitles.plexGuid,
        tmdbId: watchTitles.tmdbId,
        tvdbId: watchTitles.tvdbId,
        imdbId: watchTitles.imdbId,
        title: watchTitles.title,
        year: watchTitles.year,
      })
      .from(watchTitles)
      .where(eq(watchTitles.plexAccountId, input.plexAccountId));
    const byId = new Map(light.map((r) => [r.id, r]));
    const index = new Map<string, number[]>();
    const keyOwner = new Map<string, number>(); // title_key → row id (the unique column)
    for (const r of light) {
      keyOwner.set(r.titleKey, r.id);
      for (const k of scopedKeys(r)) {
        const list = index.get(k);
        if (list) list.push(r.id);
        else index.set(k, [r.id]);
      }
    }

    // Plan: target row (or insert) and the final key for each input.
    type Plan = { input: WatchTitleWrite; targetId: number | null; titleKey: string };
    const plans: Array<Plan | { conflictWith: number }> = [];
    const claimed = new Set<number>();
    const insertKeys = new Set<string>();
    for (const w of input.titles) {
      let target: Light | undefined;
      if (w.id !== undefined) {
        target = byId.get(w.id);
      } else {
        const hits = new Set<number>();
        for (const k of scopedKeys(w)) for (const id of index.get(k) ?? []) hits.add(id);
        const candidates = [...hits].map((id) => byId.get(id)).filter((r): r is Light => r !== undefined);
        target =
          candidates.find((r) => r.titleKey === w.titleKey) ??
          candidates.sort(
            (a, b) => titleKeyRank(a.titleKey) - titleKeyRank(b.titleKey) || a.id - b.id,
          )[0];
      }
      if (target && claimed.has(target.id)) {
        report.conflicts += 1;
        plans.push({ conflictWith: target.id });
        continue;
      }
      if (target) {
        claimed.add(target.id);
        const stronger = titleKeyRank(w.titleKey) < titleKeyRank(target.titleKey);
        const holder = keyOwner.get(w.titleKey);
        const free = holder === undefined || holder === target.id;
        const titleKey = stronger && free ? w.titleKey : target.titleKey;
        if (titleKey !== target.titleKey) {
          keyOwner.delete(target.titleKey);
          keyOwner.set(titleKey, target.id);
        }
        plans.push({ input: w, targetId: target.id, titleKey });
      } else {
        if (keyOwner.has(w.titleKey) || insertKeys.has(w.titleKey)) {
          report.conflicts += 1;
          const owner = keyOwner.get(w.titleKey);
          plans.push({ conflictWith: owner ?? -1 });
          continue;
        }
        insertKeys.add(w.titleKey);
        plans.push({ input: w, targetId: null, titleKey: w.titleKey });
      }
    }

    // Diff against the full stored rows.
    const targetIds = plans.flatMap((p) => ('input' in p && p.targetId !== null ? [p.targetId] : []));
    const stored = new Map<number, WatchTitleRow>();
    for (let i = 0; i < targetIds.length; i += 500) {
      const chunk = targetIds.slice(i, i + 500);
      const rows = await tx.select().from(watchTitles).where(inArray(watchTitles.id, chunk));
      for (const r of rows) stored.set(r.id, r);
    }

    const result = new Map<number, WatchTitleRow>(); // plan index → landed row
    const inserts: Array<{ planIndex: number; row: WatchTitleInsert }> = [];
    for (const [i, p] of plans.entries()) {
      if (!('input' in p)) continue;
      const next = values(p.input, p.titleKey);
      if (p.targetId === null) {
        inserts.push({
          planIndex: i,
          row: { ...next, plexAccountId: input.plexAccountId, kind: p.input.kind, refreshedAt: now },
        });
        continue;
      }
      const current = stored.get(p.targetId);
      if (!current) throw new Error(`watch title ${p.targetId} vanished mid-upsert`);
      const changed = FIELDS.some((f) => !sameValue(current[f], next[f]));
      if (!changed) {
        report.unchanged += 1;
        result.set(i, current);
        continue;
      }
      const [row] = await tx
        .update(watchTitles)
        .set({ ...next, refreshedAt: now })
        .where(eq(watchTitles.id, p.targetId))
        .returning();
      if (!row) throw new Error(`watch title ${p.targetId} update returned no row`);
      report.updated += 1;
      if (row.titleKey !== current.titleKey) report.rekeyed += 1;
      result.set(i, row);
    }
    for (let i = 0; i < inserts.length; i += 200) {
      const chunk = inserts.slice(i, i + 200);
      const rows = await tx
        .insert(watchTitles)
        .values(chunk.map((c) => c.row))
        .returning();
      const byTitleKey = new Map(rows.map((r) => [r.titleKey, r]));
      for (const c of chunk) {
        const row = byTitleKey.get(c.row.titleKey);
        if (row) result.set(c.planIndex, row);
      }
      report.inserted += rows.length;
    }

    const landedById = new Map<number, WatchTitleRow>();
    for (const row of result.values()) landedById.set(row.id, row);
    for (const [i, p] of plans.entries()) {
      const row = 'input' in p ? result.get(i) : landedById.get(p.conflictWith);
      report.rows.push(row ?? null);
    }
    return report;
  });
}
