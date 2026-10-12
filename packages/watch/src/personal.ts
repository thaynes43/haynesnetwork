// ADR-107 / DESIGN-054 D-02..D-03 — factual personal evidence, independent of cached recommendations.
// All source data and the optional read-only catalog lookup are supplied by the caller. No mutations.
import type { WatchEventRow, WatchMarkRow, WatchTitleRow } from '@hnet/db';
import { identityKeys, titleKeyFor } from './identity';
import { normalizeTitle } from './normalize';
import { movieState, showState } from './progress';
import { isStatementAction, type WatchlistEntry } from './watchlist';
import type { LedgerCandidate } from './queries/ledger';
import type { TitleIds, WatchKind } from './types';
import { compareText } from './util';

export interface WatchCandidateInput {
  title?: string;
  year?: number;
  kind?: WatchKind;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  plexGuid?: string;
}

export interface WatchResolvedIdentity extends TitleIds {
  year: number | null;
  titleKey: string;
  plexGuid: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

interface CatalogTitle {
  id: number;
  media_type?: string | null;
  title?: string | null;
  name?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
}

/** Structural subset: production supplies the single-attempt TMDB client, tests supply bounded fakes. */
export interface WatchTitleLookup {
  searchMulti(query: string): Promise<{ results: CatalogTitle[] }>;
  getMovieIdentity?(id: number): Promise<{
    id: number;
    title: string;
    release_date?: string | null;
    imdb_id?: string | null;
    external_ids?: { imdb_id?: string | null; tvdb_id?: number | null } | null;
  }>;
  getTvIdentity?(id: number): Promise<{
    id: number;
    name: string;
    first_air_date?: string | null;
    external_ids?: { imdb_id?: string | null; tvdb_id?: number | null } | null;
  }>;
  findByExternalId?(
    id: string | number,
    source: 'imdb_id' | 'tvdb_id',
  ): Promise<{
    movie_results?: CatalogTitle[] | null;
    tv_results?: CatalogTitle[] | null;
  }>;
}

export interface WatchPersonalCoverage {
  /** Tracked sources are evidence, never a complete lifetime viewing record. */
  completeHistory: false;
  history: {
    status: 'snapshot' | 'unknown';
    refreshedAt: string | null;
    eventsIngestedAt: string | null;
  };
  plex: { status: 'snapshot' | 'unknown'; asOf: string | null };
  watchlist: { status: 'snapshot' | 'unknown' | 'unavailable'; asOf: string | null };
  personalRatings: 'unavailable';
  clipped: boolean;
}

export interface WatchPersonalEvidence {
  viewing: 'watched' | 'partial' | 'played' | 'no_recorded_viewing' | 'not_mine' | 'unknown';
  everWatched: boolean | null;
  attributionAmbiguous: boolean;
  unattributedPlays: number;
  plays: number;
  completedPlays: number;
  watchedEpisodes: number;
  observedEpisodes: number;
  lastPlayedAt: string | null;
  progress: {
    state: string;
    episodesWatched: number | null;
    episodesTotal: number | null;
    resumePercent: number | null;
  };
  statements: Array<{
    action: 'watched' | 'not_interested' | 'not_mine';
    scope: WatchMarkRow['scope'];
    season: number | null;
    episode: number | null;
    at: string;
  }>;
  statementCount: number;
  dismissal: 'not_interested' | 'not_mine' | null;
  onPlex: boolean | null;
  onWatchlist: boolean | null;
  genres: string[];
  refreshedAt: string | null;
  sources: Array<{
    source: 'title_state' | 'tautulli_events' | 'explicit_statements' | 'arr_ledger' | 'watchlist';
    asOf: string | null;
  }>;
  personalRating: { status: 'unavailable'; value: null };
  clipped: boolean;
}

export interface WatchCandidateCheck {
  input: WatchCandidateInput;
  resolution: 'resolved' | 'ambiguous' | 'unresolved' | 'unavailable';
  identity: WatchResolvedIdentity | null;
  options: WatchResolvedIdentity[];
  reason: string | null;
  evidence: WatchPersonalEvidence | null;
}

export interface WatchBatchCheck {
  checkedAt: string;
  coverage: WatchPersonalCoverage;
  results: WatchCandidateCheck[];
}

export interface WatchViewingContext {
  checkedAt: string;
  coverage: WatchPersonalCoverage;
  section: 'all' | 'viewing' | 'feedback';
  items: Array<{ identity: WatchResolvedIdentity; evidence: WatchPersonalEvidence }>;
  page: { offset: number; limit: number; total: number; hasMore: boolean };
}

export interface WatchPersonalSnapshot {
  titles: readonly WatchTitleRow[];
  events: readonly WatchEventRow[];
  marks: readonly WatchMarkRow[];
  ledger: readonly LedgerCandidate[];
  watchlist: readonly WatchlistEntry[];
  /** Identity-only catalog hints, never evidence of viewing, preference or ownership. */
  cachedCatalog?: readonly TitleIds[];
  /** Genuine cache timestamp only, never selectWatchlist's synthetic empty-cache fallback. */
  watchlistFetchedAt: Date | null;
  ledgerRefreshedAt: Date | null;
  isOwner: boolean;
}

export interface PersonalRecord {
  identity: WatchResolvedIdentity;
  titles: WatchTitleRow[];
  events: WatchEventRow[];
  marks: WatchMarkRow[];
  ledger: LedgerCandidate[];
  watchlist: WatchlistEntry[];
}

const ID_FIELDS = ['plexGuid', 'tmdbId', 'tvdbId', 'imdbId'] as const;
const MAX_METADATA = 5;
const MAX_OPTIONS = 5;
const clip = (s: string, n = 200) => s.slice(0, n);
const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const at = new Date(d).getTime();
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
function latest(dates: readonly (Date | string | null | undefined)[]): string | null {
  return (
    dates
      .map(iso)
      .filter((d): d is string => d !== null)
      .sort()
      .at(-1) ?? null
  );
}
function asIdentity(t: TitleIds): WatchResolvedIdentity {
  const ids = {
    kind: t.kind,
    title: t.title,
    year: t.year ?? normalizeTitle(t.title).year,
    plexGuid: t.plexGuid ?? null,
    tmdbId: t.tmdbId ?? null,
    tvdbId: t.kind === 'show' ? (t.tvdbId ?? null) : null,
    imdbId: t.imdbId?.toLowerCase() ?? null,
  };
  return { ...ids, titleKey: titleKeyFor(ids) };
}
function canonicalKeys(t: TitleIds): string[] {
  return identityKeys(t)
    .filter((k) => !k.startsWith('name:'))
    .map((k) => `${t.kind}|${k}`);
}
/** Conflicting identifiers override a name/year match and also block transitive ID merges. */
export function personalIdentityConflict(a: Partial<TitleIds>, b: Partial<TitleIds>): boolean {
  if (a.kind && b.kind && a.kind !== b.kind) return true;
  return ID_FIELDS.some(
    (k) =>
      a[k] != null && b[k] != null && String(a[k]).toLowerCase() !== String(b[k]).toLowerCase(),
  );
}
function sameName(
  a: Pick<TitleIds, 'title' | 'year'>,
  b: Pick<TitleIds, 'title' | 'year'>,
): boolean {
  return (
    normalizeTitle(a.title).norm === normalizeTitle(b.title).norm &&
    (a.year == null || b.year == null || a.year === b.year)
  );
}
function sharesId(a: TitleIds, b: TitleIds): boolean {
  const wanted = new Set(canonicalKeys(a));
  return canonicalKeys(b).some((k) => wanted.has(k));
}
function emptyRecord(identity: WatchResolvedIdentity): PersonalRecord {
  return { identity, titles: [], events: [], marks: [], ledger: [], watchlist: [] };
}
function mergeInto(target: PersonalRecord, source: PersonalRecord): void {
  for (const key of ID_FIELDS) target.identity[key] ??= source.identity[key] as never;
  target.identity.year ??= source.identity.year;
  target.identity.titleKey = titleKeyFor(target.identity);
  target.titles.push(...source.titles);
  target.events.push(...source.events);
  target.marks.push(...source.marks);
  target.ledger.push(...source.ledger);
  target.watchlist.push(...source.watchlist);
}

/** Index stable IDs first; attach name-only historical evidence only when the identity is unique. */
export function personalRecords(snapshot: WatchPersonalSnapshot): PersonalRecord[] {
  const sources: PersonalRecord[] = [];
  for (const t of snapshot.titles) {
    const r = emptyRecord(asIdentity(t));
    r.titles.push(t);
    sources.push(r);
  }
  for (const m of snapshot.marks) {
    if (!isStatementAction(m.action)) {
      if (snapshot.isOwner && (m.action === 'watchlist_add' || m.action === 'watchlist_remove'))
        sources.push(emptyRecord(asIdentity(m)));
      continue;
    }
    if (m.revertedAt) continue;
    const r = emptyRecord(asIdentity(m));
    r.marks.push(m);
    sources.push(r);
  }
  for (const l of snapshot.ledger) {
    const r = emptyRecord(asIdentity({ ...l, kind: l.arrKind === 'sonarr' ? 'show' : 'movie' }));
    r.ledger.push(l);
    sources.push(r);
  }
  if (snapshot.isOwner)
    for (const w of snapshot.watchlist) {
      const r = emptyRecord(asIdentity(w));
      r.watchlist.push(w);
      sources.push(r);
    }
  for (const t of snapshot.cachedCatalog ?? []) sources.push(emptyRecord(asIdentity(t)));
  for (const e of snapshot.events) {
    if (e.kind === 'episode' && (e.season === 0 || !e.showTitle)) continue;
    const kind = e.kind === 'episode' ? 'show' : 'movie';
    const rawGuid = kind === 'show' ? e.showGuid : e.itemGuid;
    const plexGuid = rawGuid?.startsWith(`plex://${kind}/`) ? rawGuid : null;
    const r = emptyRecord(
      asIdentity({
        kind,
        title: kind === 'show' ? e.showTitle! : e.title,
        year: kind === 'show' ? null : e.year,
        plexGuid,
      }),
    );
    r.events.push(e);
    sources.push(r);
  }
  const groups = new Set<PersonalRecord>();
  const byId = new Map<string, Set<PersonalRecord>>();
  const pending: PersonalRecord[] = [];
  const index = (r: PersonalRecord) => {
    for (const k of canonicalKeys(r.identity)) {
      const set = byId.get(k) ?? new Set();
      set.add(r);
      byId.set(k, set);
    }
  };
  for (const r of sources) {
    const keys = canonicalKeys(r.identity);
    if (keys.length === 0) {
      pending.push(r);
      continue;
    }
    const hits = [...new Set(keys.flatMap((k) => [...(byId.get(k) ?? [])]))].filter(
      (g) => !personalIdentityConflict(g.identity, r.identity),
    );
    const target = hits[0] ?? r;
    if (target !== r) mergeInto(target, r);
    groups.add(target);
    for (const other of hits.slice(1)) {
      if (personalIdentityConflict(target.identity, other.identity)) continue;
      mergeInto(target, other);
      groups.delete(other);
      for (const k of canonicalKeys(other.identity)) {
        const set = byId.get(k);
        if (set?.delete(other)) set.add(target);
      }
    }
    index(target);
  }
  const byName = new Map<string, PersonalRecord[]>();
  const indexName = (r: PersonalRecord) => {
    const key = `${r.identity.kind}|${normalizeTitle(r.identity.title).norm}`;
    const list = byName.get(key) ?? [];
    list.push(r);
    byName.set(key, list);
  };
  for (const r of groups) indexName(r);
  for (const r of pending) {
    const key = `${r.identity.kind}|${normalizeTitle(r.identity.title).norm}`;
    const hits = (byName.get(key) ?? []).filter((g) => sameName(g.identity, r.identity));
    if (hits.length === 1) mergeInto(hits[0]!, r);
    else {
      groups.add(r);
      indexName(r);
    }
  }
  return [...groups];
}

export function personalCoverage(snapshot: WatchPersonalSnapshot): WatchPersonalCoverage {
  const refreshedAt = latest(snapshot.titles.map((t) => t.refreshedAt));
  const eventsIngestedAt = latest(snapshot.events.map((e) => e.ingestedAt));
  return {
    completeHistory: false,
    history: {
      status:
        snapshot.titles.length ||
        snapshot.events.length ||
        snapshot.marks.some((m) => !m.revertedAt && isStatementAction(m.action))
          ? 'snapshot'
          : 'unknown',
      refreshedAt,
      eventsIngestedAt,
    },
    plex: {
      status: snapshot.titles.length || snapshot.ledger.length ? 'snapshot' : 'unknown',
      asOf: latest([refreshedAt, snapshot.ledgerRefreshedAt]),
    },
    watchlist: {
      status: !snapshot.isOwner
        ? 'unavailable'
        : snapshot.watchlistFetchedAt
          ? 'snapshot'
          : 'unknown',
      asOf: snapshot.isOwner ? iso(snapshot.watchlistFetchedAt) : null,
    },
    personalRatings: 'unavailable',
    clipped: false,
  };
}

export function personalEvidence(
  record: PersonalRecord,
  coverage: WatchPersonalCoverage,
  now: Date,
  unattributed: readonly WatchEventRow[] = [],
): WatchPersonalEvidence {
  const rows = record.titles;
  const events = record.events;
  const marks = [...record.marks].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id,
  );
  const dismissal = marks.some((m) => m.action === 'not_mine')
    ? 'not_mine'
    : marks.some((m) => m.action === 'not_interested')
      ? 'not_interested'
      : null;
  const explicitWatched = marks.some((m) => m.action === 'watched');
  const pairs = new Set(
    events
      .filter((e) => e.kind === 'episode' && e.season != null && e.episode != null)
      .map((e) => `${e.season}:${e.episode}`),
  );
  const watchedPairs = new Set(
    events
      .filter((e) => e.kind === 'episode' && e.watched && e.season != null && e.episode != null)
      .map((e) => `${e.season}:${e.episode}`),
  );
  const statePairs = new Set<string>();
  const stateWatched = new Set<string>();
  for (const r of rows)
    for (const [season, leaves] of Object.entries(r.episodeMap ?? {})) {
      if (Number(season) < 1) continue;
      for (const leaf of leaves) {
        const k = `${season}:${leaf[0]}`;
        statePairs.add(k);
        if (leaf[1] === 1) stateWatched.add(k);
      }
    }
  const episodesWatched = Math.max(
    stateWatched.size,
    ...rows.map((r) => r.episodesWatched ?? 0),
    0,
  );
  const episodesTotal = Math.max(statePairs.size, ...rows.map((r) => r.episodesTotal ?? 0), 0);
  const watchedEpisodes = Math.max(
    new Set([...stateWatched, ...watchedPairs]).size,
    episodesWatched,
    ...rows.map((r) => r.eventWatchedEpisodes),
    0,
  );
  const plays = Math.max(events.length, ...rows.map((r) => r.eventPlays), 0);
  const completedPlays = events.filter((e) => e.watched).length;
  const lastPlayedAt = latest([
    ...events.map((e) => e.stoppedAt ?? e.startedAt),
    ...rows.map((r) => r.lastWatchedAt),
  ]);
  const newest = [...rows].sort((a, b) => b.refreshedAt.getTime() - a.refreshedAt.getTime())[0];
  const resume = record.identity.kind === 'movie' ? (newest?.resumePercent ?? null) : null;
  const partial =
    events.some((e) => !e.watched && (e.percentComplete ?? 0) > 0) ||
    rows.some((r) => r.nextResume || (r.resumePercent ?? 0) > 0);
  const everWatched =
    dismissal !== 'not_mine' &&
    (explicitWatched ||
      completedPlays > 0 ||
      watchedEpisodes > 0 ||
      rows.some((r) => r.plexWatched));
  const state = !newest
    ? 'unknown'
    : record.identity.kind === 'show'
      ? showState(
          {
            episodesWatched,
            episodesTotal,
            next:
              newest.nextSeason !== null && newest.nextEpisode !== null
                ? { season: newest.nextSeason, episode: newest.nextEpisode }
                : null,
            lastWatchedAt: lastPlayedAt ? Date.parse(lastPlayedAt) / 1000 : null,
          },
          { showStatus: newest.showStatus, now: now.getTime() / 1000 },
        )
      : movieState(
          {
            plexWatched: rows.some((r) => r.plexWatched),
            resumePercent: resume,
            lastWatchedAt: lastPlayedAt ? Date.parse(lastPlayedAt) / 1000 : null,
          },
          { now: now.getTime() / 1000 },
        );
  const genres = [
    ...new Set([...rows.flatMap((r) => r.genres), ...record.ledger.flatMap((r) => r.genres ?? [])]),
  ];
  const statements = marks
    .slice(0, MAX_METADATA)
    .map((m) => ({
      action: m.action as 'watched' | 'not_interested' | 'not_mine',
      scope: m.scope,
      season: m.season,
      episode: m.episode,
      at: m.createdAt.toISOString(),
    }));
  const sources: WatchPersonalEvidence['sources'] = [];
  if (rows.length)
    sources.push({ source: 'title_state', asOf: latest(rows.map((r) => r.refreshedAt)) });
  if (events.length)
    sources.push({ source: 'tautulli_events', asOf: latest(events.map((e) => e.ingestedAt)) });
  if (marks.length)
    sources.push({ source: 'explicit_statements', asOf: latest(marks.map((m) => m.createdAt)) });
  if (record.ledger.length) sources.push({ source: 'arr_ledger', asOf: coverage.plex.asOf });
  if (record.watchlist.length) sources.push({ source: 'watchlist', asOf: coverage.watchlist.asOf });
  return {
    viewing:
      dismissal === 'not_mine'
        ? 'not_mine'
        : everWatched
          ? 'watched'
          : partial
            ? 'partial'
            : plays > 0
              ? 'played'
              : unattributed.length > 0
                ? 'unknown'
                : 'no_recorded_viewing',
    everWatched:
      !everWatched && dismissal !== 'not_mine' && unattributed.length > 0 ? null : everWatched,
    attributionAmbiguous: unattributed.length > 0,
    unattributedPlays: unattributed.length,
    plays,
    completedPlays,
    watchedEpisodes,
    observedEpisodes: pairs.size,
    lastPlayedAt,
    progress: {
      state,
      episodesWatched: rows.length && record.identity.kind === 'show' ? episodesWatched : null,
      episodesTotal: rows.length && record.identity.kind === 'show' ? episodesTotal : null,
      resumePercent: resume,
    },
    statements,
    statementCount: marks.length,
    dismissal,
    onPlex:
      rows.some((r) => r.onPlex.length > 0) || record.ledger.some((l) => l.onPlex)
        ? true
        : coverage.plex.status === 'snapshot'
          ? false
          : null,
    onWatchlist:
      coverage.watchlist.status === 'unavailable'
        ? null
        : record.watchlist.length > 0
          ? true
          : coverage.watchlist.status === 'snapshot'
            ? false
            : null,
    genres: genres.slice(0, MAX_METADATA).map((g) => clip(g, 80)),
    refreshedAt: latest(rows.map((r) => r.refreshedAt)),
    sources,
    personalRating: { status: 'unavailable', value: null },
    clipped:
      record.identity.title.length > 200 ||
      genres.length > MAX_METADATA ||
      genres.some((g) => g.length > 80) ||
      marks.length > MAX_METADATA,
  };
}

function inputKind(input: WatchCandidateInput): WatchKind | undefined {
  return (
    input.kind ??
    (input.tvdbId
      ? 'show'
      : (/^plex:\/\/(show|movie)\//.exec(input.plexGuid ?? '')?.[1] as WatchKind | undefined))
  );
}
function candidateYear(input: WatchCandidateInput): number | null {
  return input.year ?? normalizeTitle(input.title ?? '').year;
}
function namedTitle(input: WatchCandidateInput): string {
  const title = input.title ?? '';
  return title.replace(/\s+((?:19|20)\d{2})$/, '').trim() || title;
}
function fitsInput(input: WatchCandidateInput, identity: WatchResolvedIdentity): boolean {
  const kind = inputKind(input);
  const year = candidateYear(input);
  // A literal title word (Blade Runner 2049) is not a release-year constraint.
  const literalYearWord =
    input.year === undefined &&
    !!input.title &&
    !/\(\s*\d{4}\s*\)/.test(input.title) &&
    normalizeTitle(input.title).norm === normalizeTitle(identity.title).norm;
  return (
    (!kind || identity.kind === kind) &&
    !personalIdentityConflict(input, identity) &&
    (year === null || literalYearWord || identity.year === year)
  );
}
interface PersonalRecordIndex {
  byId: Map<string, Set<PersonalRecord>>;
  byName: Map<string, PersonalRecord[]>;
}
function indexPersonalRecords(records: readonly PersonalRecord[]): PersonalRecordIndex {
  const byId = new Map<string, Set<PersonalRecord>>();
  const byName = new Map<string, PersonalRecord[]>();
  for (const r of records) {
    for (const key of canonicalKeys(r.identity)) {
      const set = byId.get(key) ?? new Set();
      set.add(r);
      byId.set(key, set);
    }
    const key = `${r.identity.kind}|${normalizeTitle(r.identity.title).norm}`;
    const list = byName.get(key) ?? [];
    list.push(r);
    byName.set(key, list);
  }
  return { byId, byName };
}
function recordsFor(
  identity: WatchResolvedIdentity,
  records: readonly PersonalRecord[],
  index = indexPersonalRecords(records),
): { matched: PersonalRecord[]; unattributed: WatchEventRow[] } {
  const matched: PersonalRecord[] = [];
  const unattributed: WatchEventRow[] = [];
  const named = index.byName.get(`${identity.kind}|${normalizeTitle(identity.title).norm}`) ?? [];
  const candidates = new Set([
    ...canonicalKeys(identity).flatMap((k) => [...(index.byId.get(k) ?? [])]),
    ...named,
  ]);
  for (const r of candidates) {
    if (r.identity.kind !== identity.kind || personalIdentityConflict(identity, r.identity))
      continue;
    if (sharesId(identity, r.identity) || r.identity === identity) {
      matched.push(r);
      continue;
    }
    if (canonicalKeys(r.identity).length > 0 || !sameName(identity, r.identity)) continue;
    const contenders = named.filter(
      (other) => canonicalKeys(other.identity).length > 0 && sameName(other.identity, r.identity),
    );
    if (contenders.length > 1) unattributed.push(...r.events);
    else matched.push(r);
  }
  return { matched, unattributed };
}
function aggregate(
  identity: WatchResolvedIdentity,
  records: readonly PersonalRecord[],
): PersonalRecord {
  const out = emptyRecord({ ...identity });
  for (const r of records) mergeInto(out, r);
  return out;
}
function fail(
  input: WatchCandidateInput,
  resolution: WatchCandidateCheck['resolution'],
  reason: string,
  options: WatchResolvedIdentity[] = [],
): WatchCandidateCheck {
  return {
    input,
    resolution,
    reason,
    options: options.slice(0, MAX_OPTIONS),
    identity: null,
    evidence: null,
  };
}
function catalogIdentity(t: CatalogTitle, kind: WatchKind): WatchResolvedIdentity | null {
  const title = kind === 'show' ? t.name : t.title;
  if (!title) return null;
  const date = kind === 'show' ? t.first_air_date : t.release_date;
  const year = /^(\d{4})-/.exec(date ?? '')?.[1];
  return asIdentity({ kind, title, year: year ? Number(year) : null, tmdbId: t.id });
}

async function hydrateIdentity(
  identity: WatchResolvedIdentity,
  lookup: WatchTitleLookup,
): Promise<WatchResolvedIdentity> {
  if (identity.tmdbId == null) return identity;
  if (identity.kind === 'movie' && lookup.getMovieIdentity) {
    const t = await lookup.getMovieIdentity(identity.tmdbId);
    return asIdentity({
      ...identity,
      title: t.title,
      year: Number(t.release_date?.slice(0, 4)) || identity.year,
      tmdbId: t.id,
      imdbId: t.external_ids?.imdb_id ?? t.imdb_id ?? identity.imdbId,
    });
  }
  if (identity.kind === 'show' && lookup.getTvIdentity) {
    const t = await lookup.getTvIdentity(identity.tmdbId);
    return asIdentity({
      ...identity,
      title: t.name,
      year: Number(t.first_air_date?.slice(0, 4)) || identity.year,
      tmdbId: t.id,
      tvdbId: t.external_ids?.tvdb_id ?? identity.tvdbId,
      imdbId: t.external_ids?.imdb_id ?? identity.imdbId,
    });
  }
  return identity;
}

/** Literal search first, then a year-hint fallback and optional identity hydration, all under the shared deadline. */
export async function resolvePersonalCandidate(
  input: WatchCandidateInput,
  records: readonly PersonalRecord[],
  coverage: WatchPersonalCoverage,
  now: Date,
  lookup: WatchTitleLookup | null = null,
  index = indexPersonalRecords(records),
): Promise<WatchCandidateCheck> {
  const kind = inputKind(input);
  const canonical = ID_FIELDS.some((k) => input[k] != null);
  const wanted = { ...input, kind };
  const exactMatches = records.filter(
    (r) =>
      (!kind || r.identity.kind === kind) &&
      (canonical
        ? ID_FIELDS.some(
            (k) =>
              input[k] != null &&
              String(input[k]).toLowerCase() === String(r.identity[k]).toLowerCase(),
          )
        : !!input.title &&
          (normalizeTitle(input.title).norm === normalizeTitle(r.identity.title).norm ||
            normalizeTitle(namedTitle(input)).norm === normalizeTitle(r.identity.title).norm)),
  );
  if (canonical && exactMatches.some((r) => personalIdentityConflict(wanted, r.identity)))
    return fail(input, 'unresolved', 'conflicting_ids');
  const matches = exactMatches.filter((r) => fitsInput(input, r.identity));
  const result = (identity: WatchResolvedIdentity): WatchCandidateCheck => {
    const known = recordsFor(identity, records, index);
    const record = aggregate(identity, known.matched);
    return {
      input,
      resolution: 'resolved',
      identity: record.identity,
      reason: null,
      options: [],
      evidence: personalEvidence(record, coverage, now, known.unattributed),
    };
  };
  // With multiple supplied IDs, unknown fields are not confirmation of their consistency.
  const confirmsEveryId = (r: PersonalRecord) =>
    ID_FIELDS.every(
      (k) =>
        input[k] == null || String(input[k]).toLowerCase() === String(r.identity[k]).toLowerCase(),
    );
  if (matches.length === 1 && confirmsEveryId(matches[0]!)) return result(matches[0]!.identity);
  if (matches.length > 1)
    return fail(
      input,
      'ambiguous',
      'multiple_personal_matches',
      matches.map((m) => m.identity),
    );
  if (!lookup) return fail(input, 'unavailable', 'catalog_unavailable');
  let identities: WatchResolvedIdentity[] = [];
  try {
    if (input.tmdbId != null) {
      if (!kind || (kind === 'movie' ? !lookup.getMovieIdentity : !lookup.getTvIdentity))
        return fail(input, 'unavailable', 'canonical_lookup_unavailable');
      if (kind === 'movie') {
        const t = await lookup.getMovieIdentity!(input.tmdbId);
        identities = [
          asIdentity({
            kind,
            title: t.title,
            year: Number(t.release_date?.slice(0, 4)) || null,
            tmdbId: t.id,
            imdbId: t.external_ids?.imdb_id ?? t.imdb_id,
          }),
        ];
      } else {
        const t = await lookup.getTvIdentity!(input.tmdbId);
        identities = [
          asIdentity({
            kind,
            title: t.name,
            year: Number(t.first_air_date?.slice(0, 4)) || null,
            tmdbId: t.id,
            tvdbId: t.external_ids?.tvdb_id,
            imdbId: t.external_ids?.imdb_id,
          }),
        ];
      }
    } else if (input.tvdbId != null || input.imdbId) {
      if (!lookup.findByExternalId)
        return fail(input, 'unavailable', 'canonical_lookup_unavailable');
      const found = await lookup.findByExternalId(
        input.tvdbId ?? input.imdbId!,
        input.tvdbId ? 'tvdb_id' : 'imdb_id',
      );
      identities = [
        ...(found.movie_results ?? []).map((t) => catalogIdentity(t, 'movie')),
        ...(found.tv_results ?? []).map((t) => catalogIdentity(t, 'show')),
      ].filter((t): t is WatchResolvedIdentity => t !== null);
      // An external-id lookup is the bridge to otherwise disjoint personal TMDB identities.
      identities = identities.map((t) =>
        asIdentity({
          ...t,
          tvdbId: input.tvdbId ?? t.tvdbId,
          imdbId: input.tvdbId ? t.imdbId : (input.imdbId ?? t.imdbId),
        }),
      );
    } else if (input.plexGuid) {
      return fail(input, 'unavailable', 'canonical_lookup_unavailable');
    } else if (input.title) {
      const norm = normalizeTitle(input.title).norm;
      const stripped = namedTitle({
        ...input,
        title: input.title.replace(/\s*\(\s*(?:19|20)\d{2}\s*\)\s*$/, '').trim() || input.title,
      });
      const parse = (page: { results: CatalogTitle[] }) =>
        page.results
          .filter((t) => t.media_type === 'movie' || t.media_type === 'tv')
          .map((t) => catalogIdentity(t, t.media_type === 'tv' ? 'show' : 'movie'))
          .filter((t): t is WatchResolvedIdentity => t !== null);
      const first = parse(await lookup.searchMulti(input.title));
      const literal = first.filter(
        (t) => normalizeTitle(t.title).norm === norm && fitsInput(input, t),
      );
      identities = first.filter((t) => normalizeTitle(t.title).norm === norm);
      if (literal.length === 0 && stripped !== input.title && candidateYear(input) !== null) {
        const fallback = parse(await lookup.searchMulti(stripped)).filter(
          (t) => normalizeTitle(t.title).norm === normalizeTitle(stripped).norm,
        );
        identities.push(...fallback);
      }
    }
  } catch (error) {
    return fail(
      input,
      typeof error === 'object' && error !== null && 'status' in error && error.status === 404
        ? 'unresolved'
        : 'unavailable',
      typeof error === 'object' && error !== null && 'status' in error && error.status === 404
        ? 'catalog_not_found'
        : 'catalog_lookup_failed',
    );
  }
  identities = identities.filter((t) => !kind || t.kind === kind);
  if (identities.some((t) => personalIdentityConflict(wanted, t)))
    return fail(input, 'unresolved', 'conflicting_ids');
  const fits = identities.filter((t) => fitsInput(input, t));
  const distinct = [...new Map(fits.map((t) => [`${t.kind}:${t.tmdbId}`, t])).values()];
  if (distinct.length > 1) return fail(input, 'ambiguous', 'multiple_catalog_matches', distinct);
  let identity = distinct[0];
  if (!identity)
    return fail(
      input,
      'unresolved',
      identities.length > 0 && candidateYear(input) !== null
        ? 'year_mismatch'
        : 'catalog_not_found',
    );
  // Search and find results may need one detail read to bridge IMDb/TVDB-only personal evidence.
  const needsBridge = records.some(
    (r) =>
      r.identity.kind === identity!.kind &&
      (r.identity.imdbId !== null || r.identity.tvdbId !== null) &&
      !sharesId(identity!, r.identity),
  );
  if (input.tmdbId === undefined && (canonical || needsBridge)) {
    try {
      identity = await hydrateIdentity(identity, lookup);
    } catch {
      return fail(input, 'unavailable', 'catalog_lookup_failed');
    }
  }
  if (personalIdentityConflict(wanted, identity))
    return fail(input, 'unresolved', 'conflicting_ids');
  if (!fitsInput(input, identity)) return fail(input, 'unresolved', 'year_mismatch');
  if (
    ID_FIELDS.some(
      (k) =>
        input[k] != null && String(input[k]).toLowerCase() !== String(identity[k]).toLowerCase(),
    )
  )
    return fail(input, 'unavailable', 'canonical_ids_unverified');
  // Check every record sharing an ID before conflict filtering; a contradictory cross-ID bridge fails closed.
  if (
    records.some(
      (r) => sharesId(identity, r.identity) && personalIdentityConflict(identity, r.identity),
    )
  )
    return fail(input, 'unresolved', 'conflicting_ids');
  return result(identity);
}

/** Shared lookup deadline: a slow provider cannot discard successful or local checks in the same batch. */
export async function checkPersonalSnapshot(
  snapshot: WatchPersonalSnapshot,
  opts: {
    titles: readonly WatchCandidateInput[];
    lookup?: WatchTitleLookup | null;
    now: Date;
    lookupBudgetMs?: number;
  },
): Promise<WatchBatchCheck> {
  if (opts.titles.length < 1 || opts.titles.length > 10)
    throw new RangeError('one to ten candidate titles required');
  const coverage = personalCoverage(snapshot);
  const records = personalRecords(snapshot);
  const index = indexPersonalRecords(records);
  const deadline = Date.now() + Math.max(0, opts.lookupBudgetMs ?? 6000);
  const bounded = async <T>(run: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('catalog budget exhausted');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('catalog budget exhausted')), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const lookup = opts.lookup
    ? ({
        searchMulti: (q: string) => bounded(() => opts.lookup!.searchMulti(q)),
        ...(opts.lookup.getMovieIdentity
          ? { getMovieIdentity: (id: number) => bounded(() => opts.lookup!.getMovieIdentity!(id)) }
          : {}),
        ...(opts.lookup.getTvIdentity
          ? { getTvIdentity: (id: number) => bounded(() => opts.lookup!.getTvIdentity!(id)) }
          : {}),
        ...(opts.lookup.findByExternalId
          ? {
              findByExternalId: (id: string | number, source: 'imdb_id' | 'tvdb_id') =>
                bounded(() => opts.lookup!.findByExternalId!(id, source)),
            }
          : {}),
      } satisfies WatchTitleLookup)
    : null;
  const results: WatchCandidateCheck[] = [];
  for (let i = 0; i < opts.titles.length; i += 2) {
    results.push(
      ...(await Promise.all(
        opts.titles
          .slice(i, i + 2)
          .map((candidate) =>
            resolvePersonalCandidate(candidate, records, coverage, opts.now, lookup, index),
          ),
      )),
    );
  }
  coverage.clipped =
    results.some((r) => r.evidence?.clipped) ||
    results.some((r) => r.options.length >= MAX_OPTIONS);
  return { checkedAt: opts.now.toISOString(), coverage, results };
}

export function viewingContextFromSnapshot(
  snapshot: WatchPersonalSnapshot,
  opts: {
    kind?: WatchKind | 'any';
    section?: 'viewing' | 'feedback';
    limit?: number;
    offset?: number;
    now: Date;
  },
): WatchViewingContext {
  const coverage = personalCoverage(snapshot);
  const section = opts.section ?? 'all';
  const limit = Math.min(20, Math.max(1, opts.limit ?? 10));
  const offset = Math.max(0, Math.min(2000, opts.offset ?? 0));
  const records = personalRecords(snapshot);
  const index = indexPersonalRecords(records);
  // Catalog-only records are useful for identity checks, but are never personal context entries.
  const personal = records.filter(
    (r) =>
      r.marks.length > 0 ||
      r.events.length > 0 ||
      r.titles.some(
        (t) =>
          t.plexWatched ||
          t.eventPlays > 0 ||
          t.eventWatchedEpisodes > 0 ||
          (t.episodesWatched ?? 0) > 0 ||
          t.nextResume ||
          (t.resumePercent ?? 0) > 0,
      ),
  );
  const all = personal
    .map((r) => {
      const related = recordsFor(r.identity, records, index);
      return {
        identity: r.identity,
        evidence: personalEvidence(
          aggregate(r.identity, related.matched),
          coverage,
          opts.now,
          related.unattributed,
        ),
      };
    })
    .filter((r) => {
      if (opts.kind && opts.kind !== 'any' && r.identity.kind !== opts.kind) return false;
      const feedback = r.evidence.statementCount > 0;
      const viewing =
        r.evidence.viewing !== 'not_mine' &&
        (r.evidence.plays > 0 || r.evidence.everWatched || r.evidence.viewing === 'partial');
      return section === 'feedback'
        ? feedback
        : section === 'viewing'
          ? viewing
          : feedback || viewing;
    })
    .sort((a, b) => {
      const touched = (r: typeof a) =>
        latest([r.evidence.lastPlayedAt, ...r.evidence.statements.map((s) => s.at)]) ?? '';
      return (
        compareText(touched(b), touched(a)) ||
        compareText(a.identity.title, b.identity.title) ||
        compareText(a.identity.titleKey, b.identity.titleKey)
      );
    });
  const items = all.slice(offset, offset + limit);
  coverage.clipped = items.some((i) => i.evidence.clipped);
  return {
    checkedAt: opts.now.toISOString(),
    coverage,
    section,
    items,
    page: { offset, limit, total: all.length, hasMore: offset + items.length < all.length },
  };
}
