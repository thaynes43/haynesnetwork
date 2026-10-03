// ADR-093 / DESIGN-052 D-20 (PLAN-072) — an IN-MEMORY implementation of the Release Block's *arr seam
// (`ReleaseBlockArrClients`) for tests and local stubs: no network (ADR-010). It answers the identity reads (item,
// files, history), the settle GET (404 once an item is `gone`) and the release-profile list / create / update, and
// records every call in order so a test can assert the D-14 sequence. ADR-097 / D-27 / D-28: it also keeps each *arr's
// import-list exclusion list (list / add, a duplicate refused like the *arr's 400) and answers the library list the
// Title Exclusion backfill reads. The HTTP shapes themselves are covered by the @hnet/arr client tests against fetch
// stubs.
//
// By default an unknown movie or series id is SYNTHESIZED with one recordable release (a scene name, a group, 1080p),
// so a test that is not about the Release Block only has to pass `arr` and every item stays deletable.
import type {
  ArrImportListExclusion,
  ArrReleaseHistoryRecord,
  ArrReleaseProfile,
  ArrReleaseProfileInput,
  RadarrMovie,
  RadarrMovieFile,
  SonarrEpisodeFileRelease,
  SonarrSeries,
} from '@hnet/arr';
import type { RadarrClient, SonarrClient } from '@hnet/arr/read';
import type { ReleaseArrKind, ReleaseBlockArrClients } from './release-block';

export interface StaticArrMovie {
  title: string;
  year: number;
  secondaryYear?: number | null;
  tmdbId: number;
  imdbId?: string;
  /** null: the movie has no file. */
  file: Omit<RadarrMovieFile, 'id'> | null;
  history?: ArrReleaseHistoryRecord[];
}

export interface StaticArrSeries {
  title: string;
  year: number;
  tvdbId: number;
  files: Array<Omit<SonarrEpisodeFileRelease, 'id'>>;
  history?: ArrReleaseHistoryRecord[];
}

export interface StaticReleaseBlockArrFixture {
  movies: Map<number, StaticArrMovie>;
  series: Map<number, StaticArrSeries>;
  /** Synthesize a recordable movie / series for an unknown id (default true). */
  synthesize: boolean;
  /** Items the *arr no longer has (the settle GET answers 404). */
  gone: Record<ReleaseArrKind, Set<number>>;
  profiles: Record<ReleaseArrKind, ArrReleaseProfile[]>;
  /** Forced failures: `<kind>:<op>` for op in find | files | history | list | create | update | exclusions |
   *  exclusion_list | exclusion_add | library. Ops with a count (`radarr:update#1`) fail only that many times. */
  fail: Set<string>;
  /** `<kind>:update` ⇒ accept the PUT but store nothing (so the read-back fails); `<kind>:exclusion_add` likewise. */
  dropWrites: Set<string>;
  /** The import-list exclusion COUNT the Watchlists card reads (D-23); null ⇒ that read fails. */
  exclusions: Record<ReleaseArrKind, number | null>;
  /** ADR-097 / D-27 — each *arr's import-list exclusion list (`tmdbId` on Radarr, `tvdbId` on Sonarr). */
  importListExclusions: Record<ReleaseArrKind, ArrImportListExclusion[]>;
  /** Every call, in order: `<kind> <op> <id?>`. */
  calls: string[];
}

const syntheticMovie = (id: number): StaticArrMovie => ({
  title: `Stub Movie ${id}`,
  year: 2020,
  tmdbId: 0, // unknown to the stub: never disagrees with the ledger's id (D-25ci)
  file: {
    movieId: id,
    relativePath: `Stub Movie ${id} (2020) [Bluray-1080p][x264]-STUB.mkv`,
    sceneName: `Stub.Movie.${id}.2020.1080p.BluRay.x264-STUB`,
    originalFilePath: null,
    releaseGroup: 'STUB',
    quality: {
      quality: {
        id: 7,
        name: 'Bluray-1080p',
        resolution: 1080,
        source: 'bluray',
        modifier: 'none',
      },
    },
    size: 8_000_000_000,
  },
  history: [],
});

const syntheticSeries = (id: number): StaticArrSeries => ({
  title: `Stub Show ${id}`,
  year: 2020,
  tvdbId: 0, // unknown to the stub (D-25ci)
  files: [
    {
      seriesId: id,
      seasonNumber: 1,
      relativePath: `Season 01/Stub Show ${id} - S01E01 [WEBDL-1080p]-STUB.mkv`,
      sceneName: `Stub.Show.${id}.S01E01.1080p.WEB-DL.x264-STUB`,
      originalFilePath: null,
      releaseGroup: 'STUB',
      quality: {
        quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080, source: 'web', modifier: 'none' },
      },
      size: 1_000_000_000,
    },
  ],
  history: [],
});

/** The stub's clients: the Release Block seam plus the library lists the Title Exclusion backfill reads (D-28). */
export type StaticReleaseBlockArrClients = ReleaseBlockArrClients & {
  read: {
    radarr: Pick<RadarrClient, 'listMovies'>;
    sonarr: Pick<SonarrClient, 'listSeries'>;
  };
};

export function createStaticReleaseBlockArr(
  overrides: Partial<Omit<StaticReleaseBlockArrFixture, 'calls'>> = {},
): { arr: StaticReleaseBlockArrClients; fixture: StaticReleaseBlockArrFixture } {
  const fixture: StaticReleaseBlockArrFixture = {
    movies: overrides.movies ?? new Map(),
    series: overrides.series ?? new Map(),
    synthesize: overrides.synthesize ?? true,
    gone: overrides.gone ?? { radarr: new Set(), sonarr: new Set() },
    profiles: overrides.profiles ?? { radarr: [], sonarr: [] },
    fail: overrides.fail ?? new Set(),
    dropWrites: overrides.dropWrites ?? new Set(),
    exclusions: overrides.exclusions ?? { radarr: 0, sonarr: 0 },
    importListExclusions: overrides.importListExclusions ?? { radarr: [], sonarr: [] },
    calls: [],
  };
  let nextProfileId = 1;
  let nextExclusionId =
    1 +
    Math.max(
      0,
      ...fixture.importListExclusions.radarr.map((e) => e.id),
      ...fixture.importListExclusions.sonarr.map((e) => e.id),
    );

  const check = (kind: ReleaseArrKind, op: string, id?: number) => {
    fixture.calls.push(`${kind} ${op}${id === undefined ? '' : ` ${id}`}`);
    if (fixture.fail.has(`${kind}:${op}`)) throw new Error(`stub ${kind} ${op} failed`);
    for (const key of fixture.fail) {
      const m = /^(\w+):(\w+)#(\d+)$/.exec(key);
      if (m && m[1] === kind && m[2] === op) {
        fixture.fail.delete(key);
        const left = Number(m[3]) - 1;
        if (left > 0) fixture.fail.add(`${kind}:${op}#${left}`);
        throw new Error(`stub ${kind} ${op} failed`);
      }
    }
  };
  const movie = (id: number): StaticArrMovie | null => {
    if (fixture.gone.radarr.has(id)) return null;
    const known = fixture.movies.get(id);
    if (known) return known;
    if (!fixture.synthesize) return null;
    const m = syntheticMovie(id);
    fixture.movies.set(id, m);
    return m;
  };
  const show = (id: number): StaticArrSeries | null => {
    if (fixture.gone.sonarr.has(id)) return null;
    const known = fixture.series.get(id);
    if (known) return known;
    if (!fixture.synthesize) return null;
    const s = syntheticSeries(id);
    fixture.series.set(id, s);
    return s;
  };
  const toMovie = (id: number, m: StaticArrMovie): RadarrMovie =>
    ({
      id,
      title: m.title,
      sortTitle: m.title.toLowerCase(),
      year: m.year,
      secondaryYear: m.secondaryYear ?? null,
      tmdbId: m.tmdbId,
      imdbId: m.imdbId,
      monitored: true,
      qualityProfileId: 1,
      path: `/movies/${m.title}`,
      tags: [],
      hasFile: m.file !== null,
      movieFileId: m.file ? id * 10 : 0,
      sizeOnDisk: m.file?.size ?? 0,
      statistics: { movieFileCount: m.file ? 1 : 0 },
      minimumAvailability: 'released',
      status: 'released',
      isAvailable: true,
      added: '2026-01-01T00:00:00Z',
    }) as RadarrMovie;
  const toSeries = (id: number, s: StaticArrSeries): SonarrSeries =>
    ({
      id,
      title: s.title,
      sortTitle: s.title.toLowerCase(),
      year: s.year,
      tvdbId: s.tvdbId,
      monitored: true,
      monitorNewItems: 'all',
      qualityProfileId: 1,
      rootFolderPath: '/tv',
      path: `/tv/${s.title}`,
      tags: [],
      statistics: {
        episodeFileCount: s.files.length,
        episodeCount: 1,
        totalEpisodeCount: 1,
        sizeOnDisk: 0,
      },
      seriesType: 'standard',
      seasonFolder: true,
      status: 'ended',
      ended: true,
      added: '2026-01-01T00:00:00Z',
    }) as SonarrSeries;

  const profileClient = (kind: ReleaseArrKind) => ({
    async listReleaseProfiles(): Promise<ArrReleaseProfile[]> {
      check(kind, 'list');
      return fixture.profiles[kind].map((p) => ({
        ...p,
        ignored: [...p.ignored],
        required: [...p.required],
      }));
    },
    async createReleaseProfile(p: ArrReleaseProfileInput): Promise<ArrReleaseProfile> {
      check(kind, 'create');
      const created: ArrReleaseProfile = {
        id: nextProfileId++,
        name: p.name,
        enabled: p.enabled,
        required: [...p.required],
        ignored: [...p.ignored],
        indexerId: p.indexerId,
        tags: [...p.tags],
      };
      if (!fixture.dropWrites.has(`${kind}:create`)) fixture.profiles[kind].push(created);
      return created;
    },
    async updateReleaseProfile(
      p: ArrReleaseProfileInput & { id: number },
    ): Promise<ArrReleaseProfile> {
      check(kind, 'update', p.id);
      const updated: ArrReleaseProfile = {
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        required: [...p.required],
        ignored: [...p.ignored],
        indexerId: p.indexerId,
        tags: [...p.tags],
      };
      if (!fixture.dropWrites.has(`${kind}:update`)) {
        fixture.profiles[kind] = fixture.profiles[kind].map((x) => (x.id === p.id ? updated : x));
      }
      return updated;
    },
  });

  const exclusionClient = (kind: ReleaseArrKind) => ({
    async listImportListExclusions(): Promise<ArrImportListExclusion[]> {
      check(kind, 'exclusion_list');
      return fixture.importListExclusions[kind].map((e) => ({ ...e }));
    },
    async add(key: number, title: string, year: number | null): Promise<ArrImportListExclusion> {
      check(kind, 'exclusion_add', key);
      const list = fixture.importListExclusions[kind];
      // The *arr's validator: "This exclusion has already been added." (400).
      if (list.some((e) => (kind === 'radarr' ? e.tmdbId : e.tvdbId) === key)) {
        throw new Error(`stub ${kind} exclusion ${key} already added`);
      }
      const created: ArrImportListExclusion = {
        id: nextExclusionId++,
        tmdbId: kind === 'radarr' ? key : null,
        tvdbId: kind === 'sonarr' ? key : null,
        title,
        year: kind === 'radarr' ? (year ?? 0) : null,
      };
      if (!fixture.dropWrites.has(`${kind}:exclusion_add`)) list.push(created);
      return created;
    },
  });
  const radarrExclusions = exclusionClient('radarr');
  const sonarrExclusions = exclusionClient('sonarr');

  const arr: StaticReleaseBlockArrClients = {
    read: {
      radarr: {
        async findMovie(id: number) {
          check('radarr', 'find', id);
          const m = movie(id);
          return m ? toMovie(id, m) : null;
        },
        async listMovieFiles(id: number) {
          check('radarr', 'files', id);
          const m = movie(id);
          return m?.file ? [{ ...m.file, id: id * 10 }] : [];
        },
        async getMovieReleaseHistory(id: number) {
          check('radarr', 'history', id);
          return movie(id)?.history ?? fixture.movies.get(id)?.history ?? [];
        },
        async countImportListExclusions() {
          check('radarr', 'exclusions');
          if (fixture.exclusions.radarr === null)
            throw new Error('stub radarr exclusions unavailable');
          return fixture.exclusions.radarr;
        },
        listImportListExclusions: () => radarrExclusions.listImportListExclusions(),
        async listMovies() {
          check('radarr', 'library');
          return [...fixture.movies.entries()]
            .filter(([id]) => !fixture.gone.radarr.has(id))
            .map(([id, m]) => toMovie(id, m));
        },
      },
      sonarr: {
        async findSeries(id: number) {
          check('sonarr', 'find', id);
          const s = show(id);
          return s ? toSeries(id, s) : null;
        },
        async listEpisodeFileReleases(id: number) {
          check('sonarr', 'files', id);
          return (show(id)?.files ?? []).map((f, i) => ({ ...f, id: id * 100 + i }));
        },
        async getSeriesReleaseHistory(id: number) {
          check('sonarr', 'history', id);
          return show(id)?.history ?? fixture.series.get(id)?.history ?? [];
        },
        async countImportListExclusions() {
          check('sonarr', 'exclusions');
          if (fixture.exclusions.sonarr === null)
            throw new Error('stub sonarr exclusions unavailable');
          return fixture.exclusions.sonarr;
        },
        listImportListExclusions: () => sonarrExclusions.listImportListExclusions(),
        async listSeries() {
          check('sonarr', 'library');
          return [...fixture.series.entries()]
            .filter(([id]) => !fixture.gone.sonarr.has(id))
            .map(([id, sr]) => toSeries(id, sr));
        },
      },
    },
    write: {
      radarr: {
        ...profileClient('radarr'),
        addImportListExclusion: ({ tmdbId, title, year }) => radarrExclusions.add(tmdbId, title, year),
      },
      sonarr: {
        ...profileClient('sonarr'),
        addImportListExclusion: ({ tvdbId, title }) => sonarrExclusions.add(tvdbId, title, null),
      },
    },
  };
  return { arr, fixture };
}
