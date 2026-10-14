// ADR-109 C-02, C-07 / DESIGN-055 D-08 (PLAN-077 P6) — the language-aware Wrong language: the Audio Preference (the
// file has the wanted audio: set the show's preferred audio language in Plex when it is the original language, Q-03
// ruling) and the Language Replace (the file lacks it: replace the file with a release in that language).
//
// Fixtures follow the live reads of 2026-10-13: Regular Show: The Lost Tapes (Sonarr series 1061, original language
// English) S01E12 carries "por/eng" with Portuguese the file's default; HaynesTower already prefers en-US for the show
// (the hand fix of 2026-10-12) while HaynesOps is set back to "Account default" here so the writer has work to do; a
// movie (Radarr "Winner Takes the Cake", original language Spanish) has no Plex audio-language setting (Q-08).
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { arrReleaseSchema, type ArrRelease } from '@hnet/arr';
import { fixRequests, ledgerEvents, plexLibraries, repairRequests } from '@hnet/db/schema';
import {
  FixPlanChangedError,
  FixRefusedError,
  buildArrClientBundle,
  buildPlexClientBundle,
  canonicalLanguageCode,
  decideAudioPreference,
  effectiveDefaultLanguage,
  householdTarget,
  languageCodeFromArrName,
  languageOfPlexLocale,
  pickLanguageRelease,
  plexLocaleFor,
  previewAudioPreference,
  previewRepairPlan,
  readLanguagePlan,
  releaseKey,
  resetReleaseSearchState,
  runFixRequest,
  scanAudioDefaults,
  setAudioPreference,
  setRepairGuideRemedies,
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertPlexLibraries,
  type AudioPreferenceServer,
  type PlexClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const PLEX_OPTIONS = ':Account default|en-US:English|pt-BR:Português|en-US:English|en-GB:English (UK)|es-ES:Español|es-MX:Español (México)|bg-BG:български|ja-JP:日本語';

// ---------------------------------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------------------------------

describe('language names and Plex locales', () => {
  it('maps the *arrs’ language names to ISO 639-2 codes, and names none for Unknown or Original', () => {
    expect(languageCodeFromArrName('English')).toBe('eng');
    expect(languageCodeFromArrName('Portuguese (Brazil)')).toBe('por');
    expect(languageCodeFromArrName('Spanish (Latino)')).toBe('spa');
    expect(languageCodeFromArrName('German')).toBe('ger');
    expect(languageCodeFromArrName('Flemish')).toBe('dut');
    expect(languageCodeFromArrName('Unknown')).toBeNull();
    expect(languageCodeFromArrName('Original')).toBeNull();
    expect(languageCodeFromArrName(null)).toBeNull();
  });

  it('reads the language a Plex locale names, and picks Plex’s own first locale for a language', () => {
    expect(languageOfPlexLocale('en-US')).toBe('eng');
    expect(languageOfPlexLocale('pt-BR')).toBe('por');
    expect(languageOfPlexLocale('nb-NO')).toBe('nor');
    expect(languageOfPlexLocale('')).toBeNull();
    const options = PLEX_OPTIONS.split('|').map((p) => ({ value: p.split(':')[0]! }));
    expect(plexLocaleFor('eng', options)).toBe('en-US');
    expect(plexLocaleFor('spa', options)).toBe('es-ES');
    expect(plexLocaleFor('jpn', options)).toBe('ja-JP');
    expect(plexLocaleFor('tam', options)).toBeNull();
  });

  it('a play starts in the track the file flags as default, else its first', () => {
    expect(
      effectiveDefaultLanguage([
        { position: 1, languageCode: 'por', displayTitle: 'Português (EAC3 5.1)', isDefault: true },
        { position: 2, languageCode: 'eng', displayTitle: 'English (EAC3 5.1)', isDefault: false },
      ]),
    ).toBe('por');
    expect(
      effectiveDefaultLanguage([
        { position: 1, languageCode: 'deu', displayTitle: 'Deutsch', isDefault: false },
        { position: 2, languageCode: 'eng', displayTitle: 'English', isDefault: false },
      ]),
    ).toBe('ger');
    expect(canonicalLanguageCode('ces')).toBe('cze');
  });
});

describe('decideAudioPreference (D-08 rule 3, the Q-03 ruling)', () => {
  const server = (over: Partial<AudioPreferenceServer>): AudioPreferenceServer => ({
    slug: 'haynesops',
    name: 'HaynesOps',
    ratingKey: '106050',
    unreachable: false,
    offered: true,
    current: '',
    currentLanguage: null,
    target: 'en-US',
    ...over,
  });
  const base = { isShow: true, verdict: 'present' as const, wanted: 'eng', original: 'eng' };

  it('sets it when the wanted language is the show’s original one, on the servers not set yet', () => {
    const towerSet = server({ slug: 'haynestower', name: 'HaynesTower', current: 'en-US', currentLanguage: 'eng' });
    expect(decideAudioPreference({ ...base, servers: [towerSet, server({})] })).toEqual({
      action: 'set',
      reason: null,
      toWrite: ['haynesops'],
    });
  });

  it('is a no-op when every server already prefers it (Lost Tapes and Butterbean’s Cafe after the hand fix)', () => {
    const set = (slug: 'haynestower' | 'haynesops') => server({ slug, current: 'en-US', currentLanguage: 'eng' });
    expect(decideAudioPreference({ ...base, servers: [set('haynestower'), set('haynesops')] }).action).toBe('already_set');
    // An English variant (en-GB) already prefers English too.
    expect(decideAudioPreference({ ...base, servers: [server({ current: 'en-GB', currentLanguage: 'eng' })] }).action).toBe(
      'already_set',
    );
  });

  it('the household default (#955, staff only) also allows English on a show whose original is another language', () => {
    const one = [server({})];
    expect(decideAudioPreference({ ...base, original: 'jpn', servers: one, rule: 'household' })).toMatchObject({ action: 'set' });
    expect(decideAudioPreference({ ...base, wanted: 'jpn', original: 'jpn', servers: [server({ target: 'ja-JP' })], rule: 'household' })).toMatchObject({
      action: 'set',
    });
    expect(decideAudioPreference({ ...base, wanted: 'por', original: 'jpn', servers: one, rule: 'household' })).toMatchObject({
      reason: 'not_original',
    });
    // A person's report keeps the Q-03 rule.
    expect(decideAudioPreference({ ...base, original: 'jpn', servers: one })).toMatchObject({ reason: 'not_original' });
  });

  it('householdTarget: English where the files carry it, else the original; a show already starting in it is a no-op', () => {
    const finding = (over: Record<string, unknown>) =>
      ({
        tvdbId: 1, seriesId: 1, mediaItemId: 'm', title: 't', original: 'jpn', filesWithOriginal: 10, filesFirstOther: 5,
        leadingLanguages: ['ger'], sample: { episodeId: 7, label: 'S01E07', fileName: null }, plexDefault: 'ger', plex: [],
        preferenceSet: false, english: { files: 0, leadOther: 0, sample: null }, ...over,
      }) as Parameters<typeof householdTarget>[0];
    // Dragon Ball: no English track, German first: the original.
    expect(householdTarget(finding({}))).toEqual({ language: 'jpn', scope: { episodeId: 7, label: 'S01E07' }, noop: false });
    // JUJUTSU KAISEN: some files carry English, some start in Portuguese: English.
    expect(householdTarget(finding({ english: { files: 40, leadOther: 14, sample: { episodeId: 9, label: 'S02E01' } } }))).toEqual({
      language: 'eng',
      scope: { episodeId: 9, label: 'S02E01' },
      noop: false,
    });
    // Boruto: every file with English already starts in it.
    const boruto = { english: { files: 291, leadOther: 0, sample: { episodeId: 3, label: 'S01E01' } } };
    expect(householdTarget(finding(boruto)).noop).toBe(true);
    // ...unless a server stores another language (an earlier report set ja-JP): Plex plays Japanese, so English is set.
    expect(
      householdTarget(finding({ ...boruto, plex: [{ server: 'HaynesOps', current: 'ja-JP', unreachable: false }] })).noop,
    ).toBe(false);
    expect(householdTarget(finding({ ...boruto, plex: [{ server: 'HaynesOps', current: 'en', unreachable: false }] })).noop).toBe(true);
  });

  it('gives guidance only for anything else', () => {
    const one = [server({})];
    expect(decideAudioPreference({ ...base, original: 'jpn', servers: one })).toMatchObject({ action: 'guidance', reason: 'not_original' });
    expect(decideAudioPreference({ ...base, isShow: false, servers: one })).toMatchObject({ action: 'guidance', reason: 'movie' });
    expect(decideAudioPreference({ ...base, verdict: 'missing', servers: one })).toMatchObject({ reason: 'not_present' });
    expect(decideAudioPreference({ ...base, original: null, servers: one })).toMatchObject({ reason: 'unknown_original' });
    expect(decideAudioPreference({ ...base, servers: [] })).toMatchObject({ reason: 'no_plex' });
    expect(decideAudioPreference({ ...base, servers: [server({ unreachable: true })] })).toMatchObject({ reason: 'no_plex' });
    expect(decideAudioPreference({ ...base, wanted: 'tam', original: 'tam', servers: [server({ target: null })] })).toMatchObject({
      reason: 'no_plex_value',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Stub *arr and Plex
// ---------------------------------------------------------------------------------------------------------------------

const SERIES = 1061;
const E05 = { id: 9105, seasonNumber: 1, episodeNumber: 5, title: 'Gumball Machine', fileId: 75705 };
const E06 = { id: 9106, seasonNumber: 1, episodeNumber: 6, title: 'Boba or Bo-Bust', fileId: 75706 };
const E12 = { id: 9112, seasonNumber: 1, episodeNumber: 12, title: 'Secret Menu Item', fileId: 75712 };
const EPISODES = [E05, E06, E12];

const release = (over: Record<string, unknown>): Record<string, unknown> => ({
  guid: `guid-${String(over.title)}`,
  indexerId: 1,
  indexer: 'NZBgeek',
  size: 400_000_000,
  quality: { quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 }, revision: { version: 1 } },
  approved: false,
  rejections: [],
  languages: [{ id: 1, name: 'English' }],
  protocol: 'usenet',
  seasonNumber: 1,
  episodeNumbers: [5],
  mappedEpisodeNumbers: [5],
  fullSeason: false,
  downloadAllowed: true,
  ...over,
});

/** The season list Sonarr returns, in its own decision order (the Release Pick's read). */
const SEASON_RELEASES = [
  // The file's own release again (Portuguese only): approved, but the language is wrong.
  release({ title: 'Regular.Show.The.Lost.Tapes.S01E05.1080p.WEB-DL.DUBLADO-PTGroup', languages: [{ id: 18, name: 'Portuguese' }], approved: true, releaseGroup: 'PTGroup' }),
  // English, but blocklisted: a hard refusal.
  release({ title: 'Regular.Show.The.Lost.Tapes.S01E05.1080p.AMZN.WEB-DL-Blocked', rejections: ['Release is blocklisted'], releaseGroup: 'Blocked' }),
  // English, a whole-season pack: never taken for one episode.
  release({ title: 'Regular.Show.The.Lost.Tapes.S01.1080p.WEB-DL-Packers', fullSeason: true, episodeNumbers: [], mappedEpisodeNumbers: [], approved: true, releaseGroup: 'Packers' }),
  // English, rejected only because a file is on disk: the one to take.
  release({
    title: 'Regular.Show.The.Lost.Tapes.S01E05.Gumball.Machine.1080p.AMZN.WEB-DL.DDP5.1.H.264-Kitsune',
    rejections: ['Existing file on disk has a equal or higher Custom Format score: 1780'],
    releaseGroup: 'Kitsune',
    indexerId: 3,
  }),
  // English, approved, but for another episode.
  release({ title: 'Regular.Show.The.Lost.Tapes.S01E06.1080p.WEB-DL-Other', episodeNumbers: [6], mappedEpisodeNumbers: [6], approved: true }),
];

function stubArr(
  over: {
    e05Audio?: string;
    releases?: Array<Record<string, unknown>>;
    grabStatus?: number;
    redownloadFailed?: boolean;
    deleteStatus?: number;
    episodes?: typeof EPISODES;
    series?: ReturnType<typeof seriesBody>;
    fileGroup?: string;
    fileSceneName?: string;
    files?: Array<Record<string, unknown>>;
  } = {},
) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const series = over.series ?? seriesBody();
  const episodes = over.episodes ?? EPISODES;
  const first = episodes[0]!;
  const sceneName = over.fileSceneName ?? 'Regular.Show.The.Lost.Tapes.S01E05.1080p.WEB-DL.DUBLADO-PTGroup';
  const files = over.files ?? episodes.map((e, index) => ({
    id: e.fileId, seriesId: series.id, seasonNumber: e.seasonNumber,
    relativePath: `Season ${e.seasonNumber}/S01E${String(e.episodeNumber).padStart(2, '0')}.mkv`,
    ...(index === 0 ? { sceneName } : {}),
    releaseGroup: index === 0 ? over.fileGroup ?? 'PTGroup' : index === 1 ? 'Kitsune' : 'BiOMA',
    size: index === 0 ? 420_000_000 : index === 1 ? 445_000_000 : 500_000_000,
    quality: { quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080 }, revision: { version: index === 1 ? 2 : 1 } },
    mediaInfo: { audioLanguages: index === 0 ? over.e05Audio ?? 'por' : index === 1 ? 'eng' : 'por/eng' },
  }));
  const json = (body: unknown, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const p = url.pathname;
    const sonarr = url.host.startsWith('sonarr');
    if (sonarr && method === 'GET' && p === '/api/v3/series') {
      return json([series]);
    }
    if (sonarr && method === 'GET' && p === `/api/v3/series/${series.id}`) return json(series);
    if (sonarr && method === 'GET' && p === '/api/v3/episode') {
      return json(episodes.map((e) => ({ id: e.id, seriesId: series.id, seasonNumber: 1, episodeNumber: e.episodeNumber, title: e.title, hasFile: true, monitored: true, episodeFileId: e.fileId })));
    }
    if (sonarr && method === 'GET' && p === '/api/v3/episodefile') return json(files);
    if (sonarr && method === 'GET' && p === '/api/v3/history/series') {
      return json([
        { id: 501, episodeId: first.id, eventType: 'grabbed', date: '2026-10-01T00:00:00Z', sourceTitle: sceneName, downloadId: 'dl-pt', data: { releaseSource: 'Rss' } },
      ]);
    }
    if (method === 'GET' && p === '/api/v3/queue') return json({ page: 1, pageSize: 200, totalRecords: 0, records: [] });
    if (sonarr && method === 'GET' && p === '/api/v3/history') {
      const records = url.searchParams.get('episodeId') === String(first.id)
        ? [{ id: 501, seriesId: series.id, episodeId: first.id, eventType: 'grabbed', date: '2026-10-01T00:00:00Z', sourceTitle: sceneName, data: { releaseSource: 'Rss' } }]
        : [];
      return json({ page: 1, pageSize: 10, totalRecords: records.length, records });
    }
    if (method === 'GET' && p === '/api/v3/config/downloadclient') {
      return json({ id: 1, autoRedownloadFailed: over.redownloadFailed ?? false, autoRedownloadFailedFromInteractiveSearch: true });
    }
    if (sonarr && method === 'GET' && p === '/api/v3/release') return json(over.releases ?? SEASON_RELEASES);
    if (method === 'POST' && p === '/api/v3/history/failed/501') return json({});
    if (method === 'DELETE' && p === `/api/v3/episodefile/${first.fileId}`) {
      return over.deleteStatus ? json({ message: 'disk error' }, over.deleteStatus) : json({});
    }
    if (method === 'POST' && p === '/api/v3/release') {
      if ((over.grabStatus ?? 200) !== 200) return json({ message: "Couldn't find requested release in cache, try searching again" }, over.grabStatus);
      return json(body);
    }
    if (method === 'POST' && p === '/api/v3/command') return json({ id: 77, name: (body as { name: string }).name });
    if (!sonarr && method === 'GET' && p === '/api/v3/movie/1') {
      return json({ id: 1, title: 'Winner Takes the Cake', sortTitle: 'winner', year: 2025, tmdbId: 1233620, monitored: true, qualityProfileId: 1, path: '/m', tags: [], hasFile: true, movieFileId: 3, sizeOnDisk: 1, statistics: { movieFileCount: 1 }, minimumAvailability: 'released', status: 'released', isAvailable: true, added: '2026-01-01T00:00:00Z', originalLanguage: { id: 3, name: 'Spanish' } });
    }
    if (!sonarr && method === 'GET' && p === '/api/v3/moviefile') {
      return json([{ id: 3, movieId: 1, relativePath: 'Winner.mkv', size: 1, quality: { quality: { id: 7, name: 'Bluray-1080p', resolution: 1080 } }, mediaInfo: { audioLanguages: 'spa/eng' } }]);
    }
    return json({ message: `no stub for ${method} ${p}` }, 404);
  }) as typeof fetch;
  const opts = { apiKey: 'k', retryDelayMs: 0, fetchImpl } as const;
  const bundle = buildArrClientBundle({
    sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
    radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
    lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
    bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
  });
  const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
  return { bundle, calls, writes };
}

function seriesBody() {
  return {
    id: SERIES, title: 'Regular Show: The Lost Tapes', sortTitle: 'regular show the lost tapes', year: 2026, tvdbId: 475718,
    monitored: true, monitorNewItems: 'all', qualityProfileId: 1, rootFolderPath: '/tv', path: '/tv/rs', tags: [],
    statistics: { episodeFileCount: 3, episodeCount: 3, totalEpisodeCount: 3, sizeOnDisk: 1 },
    seriesType: 'standard', seasonFolder: true, status: 'continuing', ended: false, added: '2026-09-01T00:00:00Z',
    originalLanguage: { id: 1, name: 'English' },
  };
}

/** Plex as the three servers answer: a show's prefs and its S01E12 tracks; a movie offers no audio language. */
function stubPlex(initial: {
  tower?: string;
  ops?: string;
  readBack?: string;
  leaves?: Array<Record<string, unknown>>;
  metadata?: Record<string, Record<string, unknown>>;
} = {}) {
  const prefs = new Map<string, string>([
    ['tower:552877', initial.tower ?? 'en-US'],
    ['ops:106050', initial.ops ?? ''],
  ]);
  const writes: string[] = [];
  const calls: Array<{ method: string; path: string }> = [];
  const streams = [
    { streamType: 1, displayTitle: '1080p' },
    { streamType: 2, languageCode: 'por', default: true, displayTitle: 'Português (EAC3 5.1)' },
    { streamType: 2, languageCode: 'eng', displayTitle: 'English (EAC3 5.1)' },
  ];
  const leaves = initial.leaves ?? EPISODES.map((e, index) => ({
    ratingKey: `episode-${e.id}`, type: 'episode', title: e.title, index: e.episodeNumber, parentIndex: e.seasonNumber,
    Media: [{ Part: [{ file: `/tv/Season ${e.seasonNumber}/S01E${String(e.episodeNumber).padStart(2, '0')}.mkv`, size: index === 0 ? 420_000_000 : index === 1 ? 445_000_000 : 500_000_000, Stream: streams }] }],
  }));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, path: url.pathname });
    const host = url.host.startsWith('tower') ? 'tower' : url.host.startsWith('ops') ? 'ops' : 'kube';
    const m = /^\/library\/metadata\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return json({ message: 'no stub' }, 404);
    const rk = m[1]!;
    const rest = m[2];
    if (method === 'PUT' && rest === '/prefs') {
      writes.push(`${host}:${rk}=${url.searchParams.get('audioLanguage')}`);
      prefs.set(`${host}:${rk}`, initial.readBack ?? url.searchParams.get('audioLanguage') ?? '');
      return new Response('', { status: 200 });
    }
    if (method === 'GET' && rest === undefined && url.searchParams.get('includePreferences') === '1') {
      if (rk === '8452') {
        return json({ MediaContainer: { Metadata: [{ ratingKey: '8452', type: 'movie', title: 'Winner', Preferences: { Setting: [{ id: 'languageOverride', value: '' }] } }] } });
      }
      const value = prefs.get(`${host}:${rk}`);
      if (value === undefined) return json({ message: 'missing' }, 404);
      return json({ MediaContainer: { Metadata: [{ ratingKey: rk, type: 'show', title: 'Regular Show: The Lost Tapes', Preferences: { Setting: [{ id: 'audioLanguage', type: 'text', value, default: '', enumValues: PLEX_OPTIONS }] } }] } });
    }
    if (method === 'GET' && rest === '/children') {
      if (rk === '552877' || rk === '106050') return json({ MediaContainer: { Metadata: [{ ratingKey: `${rk}-s1`, type: 'season', title: 'Season 1', index: 1 }] } });
      if (rk.endsWith('-s1')) {
        return json({ MediaContainer: { Metadata: EPISODES.map((e) => ({ ratingKey: `${rk}-e${e.episodeNumber}`, type: 'episode', title: e.title, index: e.episodeNumber })) } });
      }
    }
    if (method === 'GET' && rest === '/allLeaves' && (rk === '552877' || rk === '106050')) {
      return json({ MediaContainer: { totalSize: leaves.length, Metadata: leaves } });
    }
    if (method === 'GET' && rest === undefined) {
      const item = initial.metadata?.[rk] ?? leaves.find((e) => e.ratingKey === rk);
      if (item) return json({ MediaContainer: { Metadata: [item] } });
      return json({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: rk,
              type: 'episode',
              Media: [
                {
                  Part: [
                    {
                      Stream: streams,
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    }
    return json({ message: 'no stub' }, 404);
  }) as typeof fetch;
  const opt = (host: string, mid: string) => ({ baseUrl: `http://${host}.test:32400`, token: 't', machineIdentifier: mid, retryDelayMs: 0, getRetries: 0, fetchImpl });
  const bundle: PlexClientBundle = buildPlexClientBundle({
    haynestower: opt('tower', 'a5ec8cb29c425667637eabdb6a0615d6ccf68cc3'),
    haynesops: opt('ops', '80b33acb1d207508990637ec151fe9abad8d3d7a'),
    hayneskube: opt('kube', 'kube-mid'),
  });
  return { bundle, prefs, writes, calls };
}

// ---------------------------------------------------------------------------------------------------------------------
// Over embedded Postgres
// ---------------------------------------------------------------------------------------------------------------------

describe('the language-aware Wrong language over embedded Postgres (DESIGN-055 D-08)', () => {
  let t: TestDb;
  let memberId: string;
  let showId: string;
  let movieId: string;
  let benId: string;
  const e12 = () => ({ mediaItemId: showId, scope: 'episode' as const, targetChildId: E12.id });
  const e05 = () => ({ mediaItemId: showId, scope: 'episode' as const, targetChildId: E05.id });

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'tapes-lang@example.com', displayName: 'Tapes Viewer' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        { arrItemId: SERIES, tvdbId: 475718, title: 'Regular Show: The Lost Tapes', sortTitle: 'regular show the lost tapes', monitored: true, qualityProfileId: 1, qualityProfileName: 'HD', rootFolder: '/tv' },
        { arrItemId: 99, tvdbId: 318145, title: 'Ben 10 (2016)', sortTitle: 'ben 10', monitored: true, qualityProfileId: 1, qualityProfileName: 'HD', rootFolder: '/tv' },
      ],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [{ arrItemId: 1, tmdbId: 1233620, title: 'Winner Takes the Cake', sortTitle: 'winner takes the cake', monitored: true, qualityProfileId: 1, qualityProfileName: 'HD', rootFolder: '/movies' }],
    });
    showId = (await t.db.query.mediaItems.findMany({ where: (m, { and: a, eq: e }) => a(e(m.arrItemId, SERIES), e(m.arrKind, 'sonarr')) }))[0]!.id;
    benId = (await t.db.query.mediaItems.findMany({ where: (m, { and: a, eq: e }) => a(e(m.arrItemId, 99), e(m.arrKind, 'sonarr')) }))[0]!.id;
    movieId = (await t.db.query.mediaItems.findMany({ where: (m, { and: a, eq: e }) => a(e(m.arrItemId, 1), e(m.arrKind, 'radarr')) }))[0]!.id;
    await upsertPlexLibraries({ db: t.db, slug: 'haynestower', libraries: [{ sectionKey: '2', name: 'TV Shows', mediaType: 'show' }, { sectionKey: '1', name: 'Movies', mediaType: 'movie' }] });
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynesops',
      libraries: [
        { sectionKey: '2', name: 'TV Shows', mediaType: 'show' },
        { sectionKey: '1', name: 'Movies', mediaType: 'movie' },
      ],
    });
    const libs = await t.db.select().from(plexLibraries);
    const lib = (slugIndex: number, key: string) => libs.filter((l) => l.sectionKey === key)[slugIndex]!.id;
    const servers = await t.db.query.plexServers.findMany();
    const libOf = (slug: string, key: string) =>
      libs.find((l) => l.serverId === servers.find((s) => s.slug === slug)!.id && l.sectionKey === key)!.id;
    void lib;
    await syncPlexMatches({
      db: t.db,
      matches: [
        { mediaItemId: showId, plexLibraryId: libOf('haynestower', '2'), ratingKey: '552877', matchedVia: 'tvdb' as const, plexAddedAt: null },
        { mediaItemId: showId, plexLibraryId: libOf('haynesops', '2'), ratingKey: '106050', matchedVia: 'tvdb' as const, plexAddedAt: null },
        // A same-named movie in HaynesOps' movie library with a lower key (Love, Death & Robots, live): never the show's item.
        { mediaItemId: showId, plexLibraryId: libOf('haynesops', '1'), ratingKey: '10000', matchedVia: 'tmdb' as const, plexAddedAt: null },
        { mediaItemId: movieId, plexLibraryId: libOf('haynestower', '1'), ratingKey: '8452', matchedVia: 'tmdb' as const, plexAddedAt: null },
      ],
      scopedLibraryIds: [],
    });
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    resetReleaseSearchState();
    await setRepairGuideRemedies({
      db: t.db,
      remedies: { language_check: true, audio_preference: true, language_search: true, replacement_preview: true },
      actorId: null,
    });
    await t.db.delete(repairRequests);
    await t.db.delete(fixRequests);
    await t.db.delete(ledgerEvents).where(inArray(ledgerEvents.mediaItemId, [showId, benId]));
  });

  describe('the Audio Preference (rule 3)', () => {
    const pairedEpisodes = [
      { ...E05, episodeNumber: 1, fileId: 80010 },
      { ...E06, episodeNumber: 2, fileId: 80010 },
    ];
    const pairedFile = {
      id: 80010, seriesId: SERIES, seasonNumber: 1, relativePath: 'Season 1/Mickey.S01E01-E02.mkv', size: 1_476_355_129,
      quality: { quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080 } }, mediaInfo: { audioLanguages: 'por/eng' },
    };
    const pairedLeaf = (ratingKey = 'paired-first', index = 1, part: Record<string, unknown> = {}) => ({
      ratingKey, type: 'episode', title: 'Two stories', parentIndex: 1, index,
      Media: [{ Part: [{
        file: `/tv/Mickey/${pairedFile.relativePath}`, size: pairedFile.size,
        Stream: [
          { streamType: 1, displayTitle: '1080p' },
          { streamType: 2, languageCode: 'por', displayTitle: 'Português (EAC3 5.1)', default: true },
          { streamType: 2, languageCode: 'eng', displayTitle: 'English (EAC3 5.1)' },
        ],
        ...part,
      }] }],
    });
    const pairedArr = () => stubArr({ episodes: pairedEpisodes, files: [pairedFile] });
    const pairedPreview = (arr: ReturnType<typeof stubArr>, plex: ReturnType<typeof stubPlex>, targetChildId = E06.id) =>
      previewAudioPreference({ db: t.db, arr: arr.bundle, plex: plex.bundle, mediaItemId: showId, scope: 'episode', targetChildId, wantedLanguage: 'eng' });

    it('Case A: English is in the file and is the show’s original language, so the preview offers the write', async () => {
      const plex = stubPlex();
      const preview = await previewAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'eng' });
      expect(preview).toMatchObject({
        action: 'set',
        reason: null,
        wanted: { code: 'eng', name: 'English' },
        original: { code: 'eng', name: 'English' },
        isShow: true,
        verdict: 'present',
        toWrite: ['haynesops'],
        remedyOn: true,
      });
      expect(preview.servers.map((s) => [s.name, s.ratingKey, s.current])).toEqual([
        ['HaynesOps', '106050', ''],
        ['HaynesTower', '552877', 'en-US'],
      ]);
      // The guidance names the track as Plex does, and the one that plays first.
      expect(preview.tracks?.tracks.map((tr) => [tr.displayTitle, tr.isDefault])).toEqual([
        ['Português (EAC3 5.1)', true],
        ['English (EAC3 5.1)', false],
      ]);
      expect(plex.writes).toEqual([]);
    });

    it('reads both episodes of one physical file from Plex’s one first-episode item, without extra Sonarr reads or writes', async () => {
      const arr = pairedArr();
      const plex = stubPlex({ leaves: [pairedLeaf()] });
      const second = await pairedPreview(arr, plex);
      expect(second.tracks?.tracks.map((tr) => tr.displayTitle)).toEqual(['Português (EAC3 5.1)', 'English (EAC3 5.1)']);
      expect(arr.calls.filter((c) => c.path === '/api/v3/episode')).toHaveLength(1);
      expect(arr.calls.filter((c) => c.path === '/api/v3/episodefile')).toHaveLength(1);
      expect(plex.calls.filter((c) => c.path.endsWith('/allLeaves')).map((c) => c.path)).toEqual(['/library/metadata/106050/allLeaves']);
      const first = await pairedPreview(pairedArr(), plex, E05.id);
      expect(first.tracks).toEqual(second.tracks);
      expect(first.digest).toBe(second.digest);
      expect(second).toMatchObject({ action: 'set', verdict: 'present', toWrite: ['haynesops'] });
      expect(arr.writes()).toEqual([]);
      expect(plex.writes).toEqual([]);
      expect(await t.db.select().from(repairRequests)).toHaveLength(0);
    });

    it('prefers the requested episode when its exact physical file agrees, even when the first episode also lists it', async () => {
      const plex = stubPlex({ leaves: [pairedLeaf(), pairedLeaf('paired-second', 2)] });
      expect((await pairedPreview(pairedArr(), plex)).tracks).not.toBeNull();
      expect(plex.calls.some((c) => c.path === '/library/metadata/paired-second')).toBe(true);
      expect(plex.calls.some((c) => c.path === '/library/metadata/paired-first')).toBe(false);
    });

    it.each([
      ['stale exact episode with different bytes', [pairedLeaf('stale', 2, { size: pairedFile.size + 1 })]],
      ['same bytes with a different basename', [pairedLeaf('different-name', 2, { file: '/tv/Other.mkv' })]],
      ['two fallback items for the same file', [pairedLeaf(), pairedLeaf('duplicate', 1)]],
      ['two exact items for the same file', [pairedLeaf('exact-a', 2), pairedLeaf('exact-b', 2)]],
      ['a matching file outside its episode coverage', [pairedLeaf('outside', 3)]],
      ['a matching file in another season', [{ ...pairedLeaf(), parentIndex: 2 }]],
      ['a conflicting in-coverage and outside-coverage match', [pairedLeaf(), pairedLeaf('outside', 3)]],
      ['no physical-file metadata', [pairedLeaf('missing', 2, { file: undefined, size: undefined })]],
    ])('keeps generic guidance for %s', async (_name, leaves) => {
      const plex = stubPlex({ leaves });
      expect((await pairedPreview(pairedArr(), plex)).tracks).toBeNull();
      expect(plex.calls.filter((c) => !c.path.endsWith('/allLeaves') && c.path.includes('paired'))).toEqual([]);
      expect(plex.writes).toEqual([]);
    });

    it('does not guess the first episode when Sonarr says the requested episode has a different file', async () => {
      const arr = stubArr({
        episodes: [pairedEpisodes[0]!, { ...pairedEpisodes[1]!, fileId: 80011 }],
        files: [pairedFile, { ...pairedFile, id: 80011, relativePath: 'Season 1/Mickey.S01E02.mkv' }],
      });
      expect((await pairedPreview(arr, stubPlex({ leaves: [pairedLeaf()] }))).tracks).toBeNull();
    });

    it('refuses a file that changed between the show listing and stream read', async () => {
      const plex = stubPlex({ leaves: [pairedLeaf()], metadata: { 'paired-first': pairedLeaf('paired-first', 1, { size: pairedFile.size + 1 }) } });
      expect((await pairedPreview(pairedArr(), plex)).tracks).toBeNull();
    });

    it('uses the proved paired file instead of a stale different file at the exact episode number', async () => {
      const plex = stubPlex({ leaves: [pairedLeaf(), pairedLeaf('stale-second', 2, { size: 42 })] });
      expect((await pairedPreview(pairedArr(), plex)).tracks?.tracks.map((tr) => tr.languageCode)).toEqual(['por', 'eng']);
      expect(plex.calls.some((c) => c.path === '/library/metadata/stale-second')).toBe(false);
    });

    it.each([
      ['missing Sonarr basename', [{ ...pairedFile, relativePath: null }]],
      ['missing Sonarr bytes', [{ ...pairedFile, size: null }]],
      ['zero Sonarr bytes', [{ ...pairedFile, size: 0 }]],
      ['duplicate Sonarr file identity', [pairedFile, pairedFile]],
    ])('refuses to infer physical-file proof from %s', async (_name, files) => {
      const arr = stubArr({ episodes: pairedEpisodes, files });
      const plex = stubPlex({ leaves: [pairedLeaf()] });
      expect((await pairedPreview(arr, plex)).tracks).toBeNull();
      expect(plex.calls.some((c) => c.path.endsWith('/allLeaves'))).toBe(false);
    });

    it('reads the matched file’s own streams when another Plex media version comes first', async () => {
      const leaf = pairedLeaf();
      leaf.Media.unshift({ Part: [{ file: '/tv/OldVersion.mkv', size: 42, Stream: [{ streamType: 2, languageCode: 'ger', displayTitle: 'Deutsch', default: true }] }] });
      const preview = await pairedPreview(pairedArr(), stubPlex({ leaves: [leaf] }));
      expect(preview.tracks?.tracks.map((tr) => tr.languageCode)).toEqual(['por', 'eng']);
    });

    it('the scan uses the same file proof when its sample is the second episode of a one-item pair', async () => {
      const arr = stubArr({ episodes: [...pairedEpisodes].reverse(), files: [pairedFile] });
      const plex = stubPlex({ leaves: [pairedLeaf()] });
      const report = await scanAudioDefaults({ db: t.db, arr: arr.bundle, plex: plex.bundle });
      expect(report.findings[0]).toMatchObject({ sample: { episodeId: E06.id, label: 'S01E02' }, plexDefault: 'por' });
      expect(arr.calls.filter((c) => c.path === '/api/v3/episode')).toHaveLength(1);
      expect(arr.calls.filter((c) => c.path === '/api/v3/episodefile')).toHaveLength(1);
      expect(arr.writes()).toEqual([]);
      expect(plex.writes).toEqual([]);
      const stale = await scanAudioDefaults({ db: t.db, arr: arr.bundle, plex: stubPlex({ leaves: [pairedLeaf('stale', 2, { size: 42 })] }).bundle });
      expect(stale.findings[0]?.plexDefault).toBeNull();
    });

    it('preserves the movie’s first-part hints and does not read show leaves', async () => {
      const plex = stubPlex();
      const preview = await previewAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, mediaItemId: movieId, wantedLanguage: 'spa' });
      expect(preview).toMatchObject({ action: 'guidance', reason: 'movie', tracks: { server: 'HaynesTower' } });
      expect(preview.tracks?.tracks.map((tr) => tr.languageCode)).toEqual(['por', 'eng']);
      expect(plex.calls.some((c) => c.path.endsWith('/allLeaves'))).toBe(false);
      expect(plex.writes).toEqual([]);
    });

    it('sets it on the server that needs it, reads it back, and completes one audited Repair Request', async () => {
      const plex = stubPlex();
      const preview = await previewAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'eng' });
      const result = await setAudioPreference({
        db: t.db,
        arr: stubArr().bundle,
        plex: plex.bundle,
        ...e12(),
        wantedLanguage: 'eng',
        requesterId: memberId,
        digest: preview.digest,
      });
      expect(result).toMatchObject({ outcome: 'set', language: { code: 'eng' }, servers: ['HaynesTower', 'HaynesOps'], unreachable: [] });
      expect(plex.writes).toEqual(['ops:106050=en-US']);
      const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, result.repairRequestId!));
      expect(row).toMatchObject({ kind: 'audio_preference', scope: 'episode', seasonNumber: 1, targetChildIds: [E12.id], status: 'completed', reason: 'wrong_language', requesterId: memberId });
      expect(row!.actionsTaken.map((a) => [a.step, a.ok ?? null])).toEqual([
        ['created', null],
        ['plex_audio_preference', true],
        ['plex_audio_readback', true],
      ]);
      const events = await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.mediaItemId, showId));
      expect(events.map((e) => e.eventType).sort()).toEqual(['repair_completed', 'repair_requested']);
      // Now every server prefers English: a second press writes nothing and opens no row.
      const again = await setAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'eng', requesterId: memberId });
      expect(again).toMatchObject({ outcome: 'already_set', repairRequestId: null, servers: ['HaynesOps', 'HaynesTower'] });
      expect(plex.writes).toHaveLength(1);
      expect(await t.db.select().from(repairRequests)).toHaveLength(1);
    });

    it('a read-back that does not show the language fails the request, and the person is told', async () => {
      const plex = stubPlex({ readBack: '' });
      await expect(
        setAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'eng', requesterId: memberId }),
      ).rejects.toThrow(/did not take the change on HaynesOps/);
      const [row] = await t.db.select().from(repairRequests);
      expect(row!.status).toBe('failed');
      expect(row!.actionsTaken.at(-1)).toMatchObject({ step: 'plex_audio_readback', ok: false, value: '' });
    });

    it('the household rule is staff’s only: a person cannot set it, staff can', async () => {
      const plex = stubPlex();
      await expect(
        setAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'eng', requesterId: memberId, rule: 'household' }),
      ).rejects.toThrow(/staff/);
      expect(plex.writes).toEqual([]);
      const result = await setAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'eng', requesterId: null, rule: 'household' });
      expect(result).toMatchObject({ outcome: 'set' });
      const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, result.repairRequestId!));
      expect(row).toMatchObject({ requesterId: null, status: 'completed' });
      expect(row!.preview).toMatchObject({ rule: 'household' });
    });

    it('changes nothing for a language that is not the original one, for a movie, with a stale digest, or while off', async () => {
      const plex = stubPlex();
      const notOriginal = await previewAudioPreference({ db: t.db, arr: stubArr({ e05Audio: 'por/eng' }).bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'por' });
      expect(notOriginal).toMatchObject({ action: 'guidance', reason: 'not_original', original: { name: 'English' } });
      await expect(
        setAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'por', requesterId: memberId }),
      ).rejects.toBeInstanceOf(FixRefusedError);

      const movie = await previewAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, mediaItemId: movieId, wantedLanguage: 'spa' });
      expect(movie).toMatchObject({ action: 'guidance', reason: 'movie', isShow: false, original: { code: 'spa' } });

      await expect(
        setAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'eng', requesterId: memberId, digest: '0'.repeat(24) }),
      ).rejects.toBeInstanceOf(FixPlanChangedError);

      await setRepairGuideRemedies({ db: t.db, remedies: { audio_preference: false }, actorId: null });
      const off = await previewAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'eng' });
      expect(off).toMatchObject({ action: 'set', remedyOn: false });
      await expect(
        setAudioPreference({ db: t.db, arr: stubArr().bundle, plex: plex.bundle, ...e12(), wantedLanguage: 'eng', requesterId: memberId }),
      ).rejects.toThrow(/turned off/);
      expect(plex.writes).toEqual([]);
      expect(await t.db.select().from(repairRequests)).toHaveLength(0);
    });

    it('the staff scan finds the show whose files lead with Portuguese, confirmed in Plex', async () => {
      const report = await scanAudioDefaults({ db: t.db, arr: stubArr().bundle, plex: stubPlex().bundle });
      expect(report.seriesScanned).toBe(1);
      expect(report.findings).toEqual([
        expect.objectContaining({
          english: { files: 2, leadOther: 1, sample: { episodeId: E12.id, label: 'S01E12' } },
          tvdbId: 475718,
          original: 'eng',
          filesWithOriginal: 2,
          filesFirstOther: 1,
          leadingLanguages: ['por'],
          sample: { episodeId: E12.id, label: 'S01E12', fileName: 'S01E12.mkv' },
          plexDefault: 'por',
          preferenceSet: false,
        }),
      ]);
    });
  });

  describe('the Language Replace (rule 4)', () => {
    const benEpisodes = [
      { id: 8507, seasonNumber: 1, episodeNumber: 10, title: 'Animo Farm', fileId: 79991 },
      { id: 8509, seasonNumber: 1, episodeNumber: 12, title: 'Adventures in Babysitting', fileId: 79992 },
      { id: 8506, seasonNumber: 1, episodeNumber: 9, title: 'Brief Career of Lucky Girl', fileId: 79990 },
    ];
    const benArr = (releases: Array<Record<string, unknown>>, episodeNumber = 10) => {
      const target = benEpisodes.find((e) => e.episodeNumber === episodeNumber)!;
      return stubArr({
        episodes: [target, ...benEpisodes.filter((e) => e !== target)],
        series: { ...seriesBody(), id: 99, tvdbId: 318145, title: 'Ben 10 (2016)', year: 2016 },
        e05Audio: 'ara', fileGroup: 'MZABI',
        fileSceneName: `Ben.10.2016.S01E${episodeNumber}.1080p.SHAHID.WEB-DL-MZABI`,
        releases,
      });
    };
    const benRelease = (episodeNumber: number, title: string, over: Record<string, unknown> = {}) => release({
      title, seasonNumber: 1, episodeNumbers: [episodeNumber], mappedEpisodeNumbers: [episodeNumber],
      releaseGroup: title.split('-').at(-1), approved: true, ...over,
    });
    const benTarget = (episodeNumber = 10) => ({
      mediaItemId: benId, scope: 'episode' as const,
      targetChildId: benEpisodes.find((e) => e.episodeNumber === episodeNumber)!.id,
    });

    it.each([
      { episode: 10, wrong: 'Lucky.Girl', right: 'Animo.Farm' },
      { episode: 12, wrong: 'Side.Effects', right: 'Adventures.in.Babysitting' },
    ])('never chooses the approved English $wrong 2005 story for the 2016 $right target', async ({ episode, wrong, right }) => {
      const incorrect = benRelease(episode, `Ben.10.S01E${episode}.${wrong}.1080p.NF.WEB-DL.DD+2.0.H.264-playWEB`);
      const correct = benRelease(episode, `Ben.10.2016.S01E${episode}.${right}.1080p.HMAX.WEBRip.DD.2.0.H.265-EDGE2020`);
      const arr = benArr([incorrect, correct], episode);
      const { plan } = await readLanguagePlan({
        db: t.db, arr: arr.bundle, ...benTarget(episode), wantedLanguage: 'eng',
        remedies: { language_check: true, language_search: true } as never,
      });
      expect(plan).toMatchObject({ verdict: 'ok', candidate: { title: correct.title, languages: ['English'] } });
      const result = await runFixRequest({
        db: t.db, arr: arr.bundle, requesterId: memberId, ...benTarget(episode),
        reason: 'wrong_language', wantedLanguage: 'eng', planDigest: plan.digest,
      });
      expect(result.grabbedRelease).toBe(correct.title);
      const grabbed = arr.calls.find((c) => c.method === 'POST' && c.path === '/api/v3/release')!;
      expect(grabbed.body).toEqual({ guid: correct.guid, indexerId: 1 });
    });

    it('keeps the current file with no row or writes when only another show’s English story is offered', async () => {
      const wrong = benRelease(10, 'Ben.10.S01E10.Lucky.Girl.1080p.NF.WEB-DL.H.264-playWEB');
      const arr = benArr([wrong]);
      const { plan } = await readLanguagePlan({
        db: t.db, arr: arr.bundle, ...benTarget(), wantedLanguage: 'eng',
        remedies: { language_check: true, language_search: true } as never,
      });
      expect(plan).toMatchObject({ verdict: 'no_language_release', candidate: null, languageReleases: 1 });
      await expect(runFixRequest({
        db: t.db, arr: arr.bundle, requesterId: memberId, ...benTarget(), reason: 'wrong_language', wantedLanguage: 'eng',
      })).rejects.toMatchObject({ reason: 'no_language_release' });
      expect(arr.writes()).toEqual([]);
      expect(await t.db.select().from(fixRequests)).toHaveLength(0);
    });

    it('retains a silent numbered release while refusing a multi-episode candidate and the existing hard/quality guards', async () => {
      const correctTitle = 'Ben.10.2016.S01E10.Animo.Farm.1080p.HMAX.WEB-DL';
      const blocked = benRelease(10, `${correctTitle}-Blocked`, { rejections: ['Release is blocklisted'] });
      const quality = benRelease(10, `${correctTitle}-Quality`, { approved: false, rejections: ['Quality for release in profile does not meet cutoff'] });
      const ownGroup = benRelease(10, `${correctTitle}-MZABI`);
      const pair = benRelease(10, 'Ben.10.2016.S01E10E12.Animo.Farm.Adventures.in.Babysitting.1080p.WEB-DL-Pair', {
        episodeNumbers: [10, 12], mappedEpisodeNumbers: [10, 12],
      });
      const silent = benRelease(10, 'Ben.10.2016.S01E10.1080p.HMAX.WEB-DL-Other');
      const arr = benArr([blocked, quality, ownGroup, pair, silent]);
      const { plan } = await readLanguagePlan({
        db: t.db, arr: arr.bundle, ...benTarget(), wantedLanguage: 'eng',
        remedies: { language_check: true, language_search: true } as never,
      });
      expect(plan).toMatchObject({ verdict: 'ok', candidate: { title: silent.title } });
      expect(arr.writes()).toEqual([]);
    });

    it('staff uses the same guarded writer with a null requester, durable staff audit, and the open-grain guard', async () => {
      const correct = benRelease(10, 'Ben.10.2016.S01E10.Animo.Farm.1080p.HMAX.WEB-DL-English');
      const arr = benArr([correct]);
      const { plan } = await readLanguagePlan({
        db: t.db, arr: arr.bundle, ...benTarget(), wantedLanguage: 'eng', requesterId: null,
        remedies: { language_check: true, language_search: true } as never,
      });
      const result = await runFixRequest({
        db: t.db, arr: arr.bundle, requesterId: null, ...benTarget(),
        reason: 'wrong_language', wantedLanguage: 'eng', planDigest: plan.digest,
      });
      const [fix] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.id));
      expect(fix).toMatchObject({ requesterId: null, status: 'search_triggered', reason: 'wrong_language' });
      expect(fix!.actionsTaken[0]).toMatchObject({ step: 'created', requester: { staffTool: 'repair-guide.ts' } });
      expect(fix!.actionsTaken.find((a) => a.step === 'guard_plan')).toMatchObject({ digest: plan.digest, wantedLanguage: 'eng' });
      const [event] = await t.db.select().from(ledgerEvents).where(and(eq(ledgerEvents.mediaItemId, benId), eq(ledgerEvents.eventType, 'fix_requested')));
      expect(event!.payload).toMatchObject({ requesterId: null, fixRequestId: result.id });
      const writes = arr.writes();
      await expect(runFixRequest({
        db: t.db, arr: arr.bundle, requesterId: null, ...benTarget(), reason: 'wrong_language', wantedLanguage: 'eng',
      })).rejects.toMatchObject({ code: 'FIX_ALREADY_OPEN' });
      expect(arr.writes()).toEqual(writes);
    });

    it('nullable staff input does not bypass a missing authenticated requester', async () => {
      const arr = benArr([benRelease(10, 'Ben.10.2016.S01E10.Animo.Farm.1080p.HMAX.WEB-DL-English')]);
      await expect(runFixRequest({
        db: t.db, arr: arr.bundle, requesterId: '00000000-0000-0000-0000-000000000001', ...benTarget(),
        reason: 'wrong_language', wantedLanguage: 'eng',
      })).rejects.toThrow('not found');
      expect(arr.writes()).toEqual([]);
      expect(await t.db.select().from(fixRequests)).toHaveLength(0);
    });
    it('picks the first English release the *arr would take once the file is gone, never a pack or a hard refusal', () => {
      const releases: ArrRelease[] = SEASON_RELEASES.map((r) => arrReleaseSchema.parse(r));
      const allowed = new Set(releases.filter((r) => !r.rejections.includes('Release is blocklisted')).map(releaseKey));
      const single = (r: ArrRelease) => !r.fullSeason && r.episodeNumbers.length === 1 && r.episodeNumbers[0] === 5;
      expect(pickLanguageRelease({ releases, allowed, wanted: 'eng', current: null, single })?.releaseGroup).toBe('Kitsune');
      // Portuguese is the file's own release: wanted Portuguese, the Same Release is skipped.
      const current = {
        fileName: 'S01E05.mkv', sceneName: 'Regular.Show.The.Lost.Tapes.S01E05.1080p.WEB-DL.DUBLADO-PTGroup', releaseName: null,
        releaseGroup: 'PTGroup', qualityName: 'WEBDL-1080p', resolution: 1080, revision: 1, edition: null, size: 420_000_000, customFormatScore: null,
      };
      expect(pickLanguageRelease({ releases, allowed, wanted: 'por', current, single })).toBeNull();
      expect(pickLanguageRelease({ releases, allowed, wanted: 'jpn', current: null, single })).toBeNull();
    });

    it('never takes another post of the file’s own group at the same quality, whatever languages its name claims', () => {
      // Live 2026-10-13: JUJUTSU KAISEN S02E06's file is OLYMPUS WEBDL-2160p with Portuguese and Japanese only; OLYMPUS's
      // "MULTi" WEBDL-2160p post reads as eight languages, English among them.
      const multi = arrReleaseSchema.parse(
        release({
          title: 'JUJUTSU.KAISEN.S02E06.That.2160p.B-Global.WEB-DL.AAC2.0.H.264.MULTi-OLYMPUS',
          releaseGroup: 'OLYMPUS',
          quality: { quality: { id: 18, name: 'WEBDL-2160p', source: 'web', resolution: 2160 }, revision: { version: 1 } },
          size: 2_097_773_000,
          rejections: ['Existing file on disk has a equal or higher Custom Format score: 0'],
          languages: ['English', 'French', 'German', 'Japanese', 'Portuguese'].map((name, id) => ({ id, name })),
        }),
      );
      const other = arrReleaseSchema.parse(release({ title: 'Jujutsu.Kaisen.S02E06.1080p.CR.WEB-DL.DUAL-Other', releaseGroup: 'Other', approved: true }));
      const current = {
        fileName: 'Jujutsu Kaisen (2020) - S02E06 - Thats How It Is [WEBDL-2160p][AAC 2.0][h264]-OLYMPUS.mkv', sceneName: null,
        releaseName: null, releaseGroup: 'OLYMPUS', qualityName: 'WEBDL-2160p', resolution: 2160, revision: 1, edition: null,
        size: 1_642_212_847, customFormatScore: 0,
      };
      const allowed = new Set([multi, other].map(releaseKey));
      expect(pickLanguageRelease({ releases: [multi, other], allowed, wanted: 'eng', current })?.releaseGroup).toBe('Other');
      expect(pickLanguageRelease({ releases: [multi], allowed, wanted: 'eng', current })).toBeNull();
    });

    it('the preview is the Language Replace: block the Portuguese download, delete the file, take the English one', async () => {
      const arr = stubArr();
      const plan = await previewRepairPlan({
        db: t.db,
        arr: arr.bundle,
        ...e05(),
        wantedLanguage: 'eng',
        remedies: { replacement_preview: true, season_guard: false, language_check: true, playback_triage: false, import_check: false, episode_remap: false, release_pick: false, audio_preference: true, language_search: true },
        requesterId: memberId,
      });
      expect(plan).toMatchObject({
        kind: 'language',
        scope: 'episode',
        wanted: { code: 'eng', name: 'English' },
        file: { fileId: E05.fileId },
        grab: { grabId: 501 },
        packKept: [],
        verdict: 'ok',
        candidate: { title: 'Regular.Show.The.Lost.Tapes.S01E05.Gumball.Machine.1080p.AMZN.WEB-DL.DDP5.1.H.264-Kitsune', languages: ['English'] },
      });
      expect(JSON.stringify(plan)).not.toContain('guid-');
      expect(arr.writes()).toEqual([]);
    });

    it('the Fix marks, deletes, then grabs that release with the plain body; one Fix Request, audited', async () => {
      const arr = stubArr();
      const result = await runFixRequest({ db: t.db, arr: arr.bundle, requesterId: memberId, ...e05(), reason: 'wrong_language', wantedLanguage: 'eng' });
      expect(result).toMatchObject({ status: 'search_triggered', pathTaken: 'delete_search', grabbedRelease: expect.stringContaining('Kitsune') });
      expect(arr.writes()).toEqual([
        'POST /api/v3/history/failed/501',
        `DELETE /api/v3/episodefile/${E05.fileId}`,
        'POST /api/v3/release',
      ]);
      const grab = arr.calls.find((c) => c.method === 'POST' && c.path === '/api/v3/release')!;
      expect(grab.body).toEqual({ guid: 'guid-Regular.Show.The.Lost.Tapes.S01E05.Gumball.Machine.1080p.AMZN.WEB-DL.DDP5.1.H.264-Kitsune', indexerId: 3 });
      const [fix] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.id));
      expect(fix!.actionsTaken.map((a) => a.step)).toEqual(['created', 'guard_plan', 'mark_failed', 'delete_file', 'language_grab']);
    });

    it('with the *arr’s own Redownload Failed on, the download is not marked: no blind search races the grab (D-25)', async () => {
      const arr = stubArr({ redownloadFailed: true });
      const { plan } = await readLanguagePlan({ db: t.db, arr: arr.bundle, ...e05(), wantedLanguage: 'eng', remedies: { language_check: true, language_search: true } as never });
      expect(plan).toMatchObject({ grab: null, redownloadKept: true, verdict: 'ok' });
      const result = await runFixRequest({ db: t.db, arr: arr.bundle, requesterId: memberId, ...e05(), reason: 'wrong_language', wantedLanguage: 'eng' });
      expect(result).toMatchObject({ status: 'search_triggered', pathTaken: 'delete_search' });
      expect(arr.writes()).toEqual([`DELETE /api/v3/episodefile/${E05.fileId}`, 'POST /api/v3/release']);
      const [fix] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.id));
      expect(fix!.actionsTaken.find((a) => a.step === 'guard_plan')).toMatchObject({ redownloadKept: true, grabHistoryId: null });
    });

    it('a delete that fails after the mark keeps the whole trail, so the record shows the download is blocked', async () => {
      const arr = stubArr({ deleteStatus: 500 });
      await expect(
        runFixRequest({ db: t.db, arr: arr.bundle, requesterId: memberId, ...e05(), reason: 'wrong_language', wantedLanguage: 'eng' }),
      ).rejects.toThrow();
      const [fix] = await t.db.select().from(fixRequests);
      expect(fix!.status).toBe('failed');
      expect(fix!.actionsTaken.map((a) => [a.step, a.ok ?? null])).toEqual([
        ['created', null],
        ['guard_plan', true],
        ['mark_failed', true],
        ['delete_file', false],
      ]);
      expect(arr.writes()).not.toContain('POST /api/v3/release');
    });

    it('a grab the *arr refuses falls back to a search, so the episode is never left with nothing', async () => {
      const arr = stubArr({ grabStatus: 404 });
      const result = await runFixRequest({ db: t.db, arr: arr.bundle, requesterId: memberId, ...e05(), reason: 'wrong_language', wantedLanguage: 'eng' });
      expect(result).toMatchObject({ status: 'search_triggered', grabbedRelease: null });
      expect(arr.writes().at(-1)).toBe('POST /api/v3/command');
      const [fix] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.id));
      expect(fix!.actionsTaken.slice(-2).map((a) => [a.step, a.ok])).toEqual([
        ['language_grab', false],
        ['trigger_search', true],
      ]);
    });

    it('with no English release the library would take, nothing is removed and no row is written', async () => {
      const arr = stubArr({ releases: SEASON_RELEASES.slice(0, 3) });
      const { plan } = await readLanguagePlan({ db: t.db, arr: arr.bundle, ...e05(), wantedLanguage: 'eng', remedies: { language_check: true, language_search: true } as never });
      expect(plan).toMatchObject({ verdict: 'no_language_release', candidate: null, languageReleases: 2 });
      await expect(
        runFixRequest({ db: t.db, arr: arr.bundle, requesterId: memberId, ...e05(), reason: 'wrong_language', wantedLanguage: 'eng' }),
      ).rejects.toMatchObject({ reason: 'no_language_release' });
      expect(arr.writes()).toEqual([]);
      expect(await t.db.select().from(fixRequests)).toHaveLength(0);
    });

    it('a file that has the language, or a season, is refused before anything is read from the indexers', async () => {
      const arr = stubArr();
      await expect(
        runFixRequest({ db: t.db, arr: arr.bundle, requesterId: memberId, ...e12(), reason: 'wrong_language', wantedLanguage: 'eng' }),
      ).rejects.toMatchObject({ reason: 'language_present' });
      await expect(
        runFixRequest({ db: t.db, arr: arr.bundle, requesterId: memberId, mediaItemId: showId, scope: 'season', seasonNumber: 1, reason: 'wrong_language', wantedLanguage: 'eng' }),
      ).rejects.toMatchObject({ reason: 'language_by_episode', message: expect.stringContaining('S01E05') });
      expect(arr.calls.some((c) => c.path === '/api/v3/release')).toBe(false);
      expect(arr.writes()).toEqual([]);
    });

    it('with language_search off the Fix runs as before (no language grab)', async () => {
      await setRepairGuideRemedies({ db: t.db, remedies: { language_search: false, replacement_preview: false }, actorId: null });
      const arr = stubArr();
      const result = await runFixRequest({ db: t.db, arr: arr.bundle, requesterId: memberId, ...e05(), reason: 'wrong_language', wantedLanguage: 'eng' });
      expect(result.grabbedRelease).toBeUndefined();
      expect(arr.writes().includes('POST /api/v3/release')).toBe(false);
      const open = await t.db.select().from(fixRequests).where(and(eq(fixRequests.id, result.id)));
      expect(open).toHaveLength(1);
    });
  });
});
