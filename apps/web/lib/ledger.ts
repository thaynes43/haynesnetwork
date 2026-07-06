// Pure helpers for the Ledger section UI (DESIGN-009 D-08). Framework-free so the
// classification and export-URL contracts get cheap unit coverage (ADR-010 unit layer).

export type SectionLevel = 'edit' | 'read_only' | 'disabled';

/**
 * One persisted per-item entry off a ledgerAdmin.run report (restore_runs.results — the
 * RestoreResultItem jsonb rows). Fields beyond ok/mediaItemId ride the row's index signature,
 * so everything optional is re-narrowed here.
 */
export interface RunResultEntry {
  mediaItemId: string;
  ok: boolean;
  outcome?: unknown;
  searched?: unknown;
  searchError?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export type RunItemKind = 'added' | 'monitored' | 'skipped' | 'failed';

export interface ClassifiedRunItem {
  kind: RunItemKind;
  /** A search command reached the *arr for this item. */
  searched: boolean;
  /** ADR-022 (best-effort search): the item SUCCEEDED but its follow-on search failed —
   *  surfaced as a caution, never as an item failure (DESIGN-009 D-05). */
  searchFailed: boolean;
  /** The failure or skip reason (skip entries persist as ok:false + a 'skipped: …' error). */
  note: string | null;
}

/**
 * DESIGN-009 D-05 / ADR-022 — classify one persisted run entry. Success keys off `ok` and the
 * search badge off `searched`; error TEXT is never treated as failure on its own (an
 * added-but-search-throttled item stays a success). Skips are persisted as ok:false with a
 * 'skipped:'-prefixed reason (executeArrAdd's skip record), distinct from real failures.
 */
export function classifyRunItem(entry: RunResultEntry): ClassifiedRunItem {
  const errorText = typeof entry.error === 'string' ? entry.error : null;
  const searchErrorText = typeof entry.searchError === 'string' ? entry.searchError : null;
  const searched = entry.searched === true;
  if (entry.ok) {
    return {
      kind: entry.outcome === 'monitored' ? 'monitored' : 'added',
      searched,
      searchFailed: searchErrorText !== null || (!searched && errorText !== null),
      note: searchErrorText ?? errorText,
    };
  }
  if (errorText !== null && errorText.startsWith('skipped:')) {
    return {
      kind: 'skipped',
      searched: false,
      searchFailed: false,
      note: errorText.replace(/^skipped:\s*/, ''),
    };
  }
  return { kind: 'failed', searched: false, searchFailed: false, note: errorText };
}

/** Roll a run's entries up into the report's count summary. */
export function summarizeRun(entries: RunResultEntry[]): Record<RunItemKind, number> & {
  searched: number;
} {
  const out = { added: 0, monitored: 0, skipped: 0, failed: 0, searched: 0 };
  for (const entry of entries) {
    const c = classifyRunItem(entry);
    out[c.kind] += 1;
    if (c.searched) out.searched += 1;
  }
  return out;
}

/** The filter state the /ledger browse holds (URL-derived) that the export must mirror. */
export interface LedgerExportFilter {
  arrKind: 'radarr' | 'sonarr' | 'lidarr';
  query?: string;
  monitored?: boolean;
  hasFile?: 'any' | 'none' | 'some' | 'all';
  genres?: string[];
  resolutions?: string[];
  requesters?: string[];
  sourceCollections?: string[];
  ratingMin?: number;
  ratingMax?: number;
}

/**
 * ADR-022 C-03 / DESIGN-009 D-06 — the /api/ledger/export query string for the CURRENT filter
 * set (the export mirrors the filter, never the selection). Matches the route's lenient parser:
 * comma-joined lists, `monitored=true|false`, `hasFile` only when narrowing.
 */
export function ledgerExportQuery(filter: LedgerExportFilter): string {
  const params = new URLSearchParams();
  params.set('arrKind', filter.arrKind);
  if (filter.query !== undefined && filter.query.trim() !== '') {
    params.set('query', filter.query.trim());
  }
  if (filter.monitored !== undefined) params.set('monitored', String(filter.monitored));
  if (filter.hasFile !== undefined && filter.hasFile !== 'any') {
    params.set('hasFile', filter.hasFile);
  }
  const list = (key: string, values: string[] | undefined) => {
    if (values !== undefined && values.length > 0) params.set(key, values.join(','));
  };
  list('genres', filter.genres);
  list('resolutions', filter.resolutions);
  list('requesters', filter.requesters);
  list('sourceCollections', filter.sourceCollections);
  if (filter.ratingMin !== undefined) params.set('ratingMin', String(filter.ratingMin));
  if (filter.ratingMax !== undefined) params.set('ratingMax', String(filter.ratingMax));
  return params.toString();
}
