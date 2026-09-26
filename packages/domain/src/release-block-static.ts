// ADR-093 / DESIGN-052 D-20 (PLAN-072) — an IN-MEMORY implementation of the Release Block's *arr seam
// (`ReleaseBlockArrClients`) for tests and local stubs: no network (ADR-010). It answers the identity reads (item,
// files, history), the settle GET (404 once an item is `gone`) and the release-profile list / create / update, and
// records every call in order so a test can assert the D-14 sequence. The HTTP shapes themselves are covered by the
// @hnet/arr client tests against fetch stubs.
//
// By default an unknown movie or series id is SYNTHESIZED with one recordable release (a scene name, a group, 1080p),
// so a test that is not about the Release Block only has to pass `arr` and every item stays deletable.
import type {
  ArrReleaseHistoryRecord,
  ArrReleaseProfile,
  ArrReleaseProfileInput,
  RadarrMovie,
  RadarrMovieFile,
  SonarrEpisodeFileRelease,
  SonarrSeries,
} from '@hnet/arr';
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
  /** Forced failures: `<kind>:<op>` for op in find | files | history | list | create | update | exclusions. Ops with
   *  a count (`radarr:update#1`) fail only that many times. */
  fail: Set<string>;
  /** `<kind>:update` ⇒ accept the PUT but store nothing (so the read-back fails). */
  dropWrites: Set<string>;
  exclusions: Record<ReleaseArrKind, number | null>;
  /** Every call, in order: `<kind> <op> <id?>`. */
  calls: string[];
}

const syntheticMovie = (id: number): StaticArrMovie => ({
  title: `Stub Movie ${id}`,
  year: 2020,
  tmdbId: 700_000 + id,
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
  tvdbId: 800_000 + id,
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

export function createStaticReleaseBlockArr(
  overrides: Partial<Omit<StaticReleaseBlockArrFixture, 'calls'>> = {},
): { arr: ReleaseBlockArrClients; fixture: StaticReleaseBlockArrFixture } {
  const fixture: StaticReleaseBlockArrFixture = {
    movies: overrides.movies ?? new Map(),
    series: overrides.series ?? new Map(),
    synthesize: overrides.synthesize ?? true,
    gone: overrides.gone ?? { radarr: new Set(), sonarr: new Set() },
    profiles: overrides.profiles ?? { radarr: [], sonarr: [] },
    fail: overrides.fail ?? new Set(),
    dropWrites: overrides.dropWrites ?? new Set(),
    exclusions: overrides.exclusions ?? { radarr: 0, sonarr: 0 },
    calls: [],
  };
  let nextProfileId = 1;

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

  const arr: ReleaseBlockArrClients = {
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
      },
    },
    write: { radarr: profileClient('radarr'), sonarr: profileClient('sonarr') },
  };
  return { arr, fixture };
}
