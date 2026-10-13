// DESIGN-005 test strategy — stub *arr HTTP server for e2e (mirrors the stub-OIDC
// pattern; extracted from the packages/sync fetch-stub approach into a real HTTP
// server because the Next dev server calls the *arrs over the network). Serves the
// fixture-shaped READ endpoints the fix flow resolves against and accepts the two
// sanctioned WRITE endpoints (history/failed, command), RECORDING every mutating
// call so specs can assert AC-07's blocklist+search happened with the right ids.
//
// One server stands in for all four services (SONARR_URL etc. all point here) —
// the suite only drives the Sonarr fix journey; the others just need parseable
// endpoints if ever touched.
//
// Control endpoints:
//   GET  /_stub/calls  → { calls: [{method, path, query, body}] } (writes only)
//   POST /_stub/reset  → 204 (clears recorded calls + the staged queue)
//   POST /_stub/queue  → 204 (stage the scriptable download queue: { records: [...] })
//                        PLAN-015 / D-20 — drives the Action Feedback progress derivation
//                        deterministically (queued → downloading with a shrinking sizeleft →
//                        importing → empty-after-import). GET /queue serves the staged records,
//                        server-side filtered by seriesIds/movieIds/artistIds like the real *arrs.
//   POST /_stub/seerr-watchlist → 204; body { userId, results? } — ADR-093: that Seerr user's watchlist
//                        (Seerr result rows: ratingKey, title, mediaType, tmdbId); no `results` restores the default.
//   GET  /_stub/import-list-exclusions → { radarr: [...], sonarr: [...] } — ADR-097: the exclusion lists the Trash
//                        delete paths write (Radarr `/exclusions`, Sonarr `/importlistexclusion`; cleared by reset).
//   POST /_stub/repair-guide → 204; body { on } — ADR-109 / DESIGN-055 D-09 (PLAN-077 P1): serve the Repair Guide's
//                        fixtures (cleared by reset, so no other spec sees them): Stub Runner's file and a release list
//                        whose only acceptable row is that same release (Case C, AC-42), and Breaking Prod's series
//                        history with S01E01..E03 grabbed as ONE pack and E04..E09 one download each (the season guard).
//   POST /_stub/import-check → 204; body { on } — ADR-109 / DESIGN-055 D-07 (PLAN-077 P2): serve the queue-aware Force
//                        Search fixtures (cleared by reset): Breaking Prod S01E10 is titled "125 Years Young" (Case B's
//                        title), and `GET /manualimport?downloadId=` answers the Case B candidate of
//                        importCheckQueueFixture()'s blocked download. Stage that queue with POST /_stub/queue.
//   POST /_stub/seerr-issues → 204; body { issues } — ADR-111 / DESIGN-055 D-10 (PLAN-077 P3): the Seerr issues
//                        `GET /issue`, `GET /issue/{id}` and `GET /issue/count` serve (Seerr 3.5.0's shapes). No body
//                        (or `issues: null`) restores seerrIssueFixture(); `issues: []` serves none. Cleared by reset.
//   POST /_stub/remap → 204; body { on } — ADR-109 C-02 / DESIGN-055 D-04, D-05 (PLAN-077 P4): Breaking Prod gains a
//                        Season 3 whose library files can move (remapSeasonFixture(), Case A's shape: seven BiOMA files
//                        one slot low from E11, E12 and E19 free, plus a FLUX file on E02 whose name says it is E01). While
//                        on, the season follows Sonarr 4.0.20.3012's library-file semantics: `GET /manualimport?seriesId=
//                        &seasonNumber=&filterExistingFiles=false` lists its files as candidates; `ManualImport` with
//                        importMode `move` re-links the file at that path to the given episodes under a NEW episode-file
//                        id (the old record goes, the file keeps its path, an episode that still had another file leaves
//                        it orphaned); `RenameFiles` renames in id order and skips a name another file holds; `GET
//                        /rename` lists stale names; `GET /history/since` serves the season's import records for the
//                        Title Check. Cleared by reset. `GET /_stub/remap` reads the season back for specs.
//   POST /_stub/release-pick → 204; body { on } — ADR-109 C-02, C-06 / DESIGN-055 D-06 (PLAN-077 P5): serve the Release Pick
//                        fixtures (cleared by reset). Breaking Prod gains Season 4 (releasePickEpisodeRows()): E03 "Rollback
//                        Rodeo" (target A) and E05 "Hotfix Hootenanny" (target B) are missing, E04 "Cache Me Outside" is
//                        B's neighbour, and `GET /release?seriesId=501&seasonNumber=4` serves the season list
//                        (releasePickSeasonList(): a Grab row for A; for B an Override with a custom-format score, one with
//                        a quality not wanted, a mislabeled one numbered E04, a blocklisted and a wrong-title Not allowed
//                        row, and an Override whose grab 409s). `POST /release` records its body (404 for an unknown guid,
//                        409 for guid `stub-rp-b-409`, else 200 echo); `GET /_stub/release-grabs` reads the bodies back; a
//                        grabbed release then shows in `GET /queue` as a downloading record for its episode.
//   Always: `POST /command` `ManualImport` is recorded like any write, and afterwards its files' episodes (or movie)
//   report `hasFile: true` and the download's queue records are gone; `GET /command/{id}` answers `completed`.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { clearStubArrDeleted, stubArrDeleted } from './stub-arr-state';

export interface RecordedArrWrite {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface StubArrServer {
  baseUrl: string;
  port: number;
  /** Recorded mutating calls (POST/DELETE) — the spec-facing audit trail. */
  calls: RecordedArrWrite[];
  stop: () => Promise<void>;
}

/** The seeded Sonarr series the e2e ledger row mirrors (see seed-ledger.ts). */
export const STUB_SERIES_ID = 501;
export const STUB_SERIES_TVDB_ID = 990001;
/** The seeded Lidarr artist + its one on-disk album (ADR-016 / D-19 no-subtitle-radio assertion). */
export const STUB_ARTIST_ID = 701;
export const STUB_ALBUM_ID = 7011;
/** Grab-history ids are derived so specs can predict them: 700000 + episodeId. */
export const grabHistoryIdFor = (episodeId: number) => 700_000 + episodeId;

const EPISODE_COUNT = 10;

/**
 * ADR-109 / DESIGN-055 D-09 — Stub Runner (no grab history): the Case C stand-in for the Replacement Preview. Seeded as
 * Radarr id 602, but ledger.spec's Monitor-&-search re-adds it (the stub answers every `POST /movie` with id 9701), so
 * the fixtures below serve ANY movie but The Fixture while they are on.
 */
export const STUB_SAME_RELEASE_MOVIE_ID = 602;
const isSameReleaseMovie = (movieId: number) => Number.isFinite(movieId) && movieId !== STUB_MOVIE_ID;
/** The Breaking Prod S01 episodes one pack download backs (the season guard's held-back pack). */
export const STUB_PACK_EPISODES = [50101, 50102, 50103] as const;
/** The grab record id of an episode in the repair-guide series history (pack episodes share one download). */
export const repairGuideGrabIdFor = (episodeId: number) => 800_000 + episodeId;

/**
 * ADR-109 / DESIGN-055 D-07 (PLAN-077 P2) — Case B (The Paper 2x06, Seerr issue 3) on the stub series. The real download
 * was `The_Paper_2025_S02E06_125_Years_Young_…-FLUX`: Sonarr read `S02E06_125` as 2x06 to 2x125, blocked the import as
 * "unexpected considering the … folder name", and a Force Search could only search again. Here the missing S01E10 plays
 * 2x06 (titled "125 Years Young" while the import-check fixtures are on) and the name carries Breaking Prod and its own
 * year, so only the folder-name rejection stands between the file and the episode.
 */
export const IMPORT_CHECK_EPISODE_ID = 50110;
export const IMPORT_CHECK_EPISODE_TITLE = '125 Years Young';
export const IMPORT_CHECK_DOWNLOAD_ID = 'SABnzbd_nzo_stub_case_b';
export const IMPORT_CHECK_FOLDER = 'Breaking_Prod_2019_S01E10_125_Years_Young_2160p_PCOK_WEB-DL_DDP5_1_Atmos_DV_HDR_H_265-FLUX';
export const IMPORT_CHECK_FILE = `${IMPORT_CHECK_FOLDER}.mkv`;
const IMPORT_CHECK_REJECTION =
  'Episodes 1x11, 1x12, 1x13 were unexpected considering the Breaking_Prod_2019_S01E10_125_Years_Young folder name';
/** S02E02 · Reckoning, which is on its way (downloading) in the same staged queue. */
export const ON_ITS_WAY_EPISODE_ID = 50302;

// ---------------------------------------------------------------------------------------------------------------------
// ADR-109 C-02 / DESIGN-055 D-04, D-05 (PLAN-077 P4) — the Episode Re-map season (POST /_stub/remap)
// ---------------------------------------------------------------------------------------------------------------------

/** Breaking Prod's library folder (seriesResource().path); a library file's path is this plus its relativePath. */
export const STUB_SERIES_PATH = '/data/haynestower/Media/TV Shows/Breaking Prod';
/** The re-map season and its episode ids (50400 + episode number). */
export const REMAP_SEASON = 3;
export const remapEpisodeIdFor = (episodeNumber: number) => STUB_SERIES_ID * 100 + 300 + episodeNumber;
/** The release group that filed Case A's files one slot low (the Mislabel offer's group). */
export const REMAP_MISLABEL_GROUP = 'BiOMA';

/** Season 3's episodes: E01 and E02 (the single move), E10..E19 (Case A). */
export const REMAP_TITLES: Readonly<Record<number, string>> = {
  1: 'All You Can Fit',
  2: 'Disney Plus',
  10: 'Spice It Up',
  11: 'Prank Callers',
  12: 'Secret Menu Item',
  13: 'Time Out',
  14: 'Rap It Up',
  15: 'Night Shift',
  16: 'Bad Signal',
  17: 'Lost Remote',
  18: 'Thats Funny',
  19: 'Cool Boss',
};

export interface RemapStubFile {
  id: number;
  relativePath: string;
  size: number;
  releaseGroup: string;
  sceneName: string | null;
}

export interface RemapStubState {
  /** Episode id → the episode-file id on it (0: none). */
  episodeFile: Map<number, number>;
  files: Map<number, RemapStubFile>;
  nextFileId: number;
  /** Files left on disk with no record (what an import onto an occupied slot causes; a plan must never cause it). */
  orphaned: string[];
}

const remapCode = (numbers: number[]) =>
  numbers.map((n) => `S0${REMAP_SEASON}E${String(n).padStart(2, '0')}`).join('-');
/** Sonarr's naming format for the stub series, enough to tell a renamed file from a stale one. */
const remapNameFor = (numbers: number[], title: string, group: string) =>
  `Season ${REMAP_SEASON}/Breaking Prod - ${remapCode(numbers)} - ${title} [WEBDL-1080p]-${group}.mkv`;
const dotted = (title: string) => title.replace(/\s+/g, '.');

/**
 * The season as it starts. Case A (AC-40): the BiOMA files on E11 and E13..E18 each hold the NEXT episode (their names
 * say so; Sonarr named each file for the slot it sits on), E12 and E19 are free, so "from E11, one later, to the end"
 * moves seven files highest first and leaves E11 and E13 empty. And the Title Check's single move: the FLUX file on E02
 * is really E01 (free). E10's file is where it belongs.
 */
export function remapSeasonFixture(): RemapStubState {
  const episodeFile = new Map<number, number>();
  const files = new Map<number, RemapStubFile>();
  for (const n of Object.keys(REMAP_TITLES).map(Number)) episodeFile.set(remapEpisodeIdFor(n), 0);
  const add = (slot: number, really: number, group: string, size: number) => {
    const id = 3400 + slot;
    const scene = `Breaking.Prod.S0${REMAP_SEASON}E${String(slot).padStart(2, '0')}.${dotted(REMAP_TITLES[really]!)}.1080p.WEB-DL.DDP5.1.H.264-${group}`;
    files.set(id, { id, relativePath: remapNameFor([slot], REMAP_TITLES[slot]!, group), size, releaseGroup: group, sceneName: scene });
    episodeFile.set(remapEpisodeIdFor(slot), id);
  };
  add(2, 1, 'FLUX', 1_610_612_736);
  add(10, 10, 'STUB', 1_073_741_824);
  add(11, 12, REMAP_MISLABEL_GROUP, 1_073_741_811);
  for (const slot of [13, 14, 15, 16, 17, 18]) add(slot, slot + 1, REMAP_MISLABEL_GROUP, 1_073_741_800 + slot);
  return { episodeFile, files, nextFileId: 95_000, orphaned: [] };
}

const remapQuality = {
  quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 },
  revision: { version: 1, real: 0, isRepack: false },
};

const remapEpisodesOf = (state: RemapStubState, fileId: number) =>
  Object.keys(REMAP_TITLES)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((n) => state.episodeFile.get(remapEpisodeIdFor(n)) === fileId);

/** The name the naming format gives a file where it sits now (its old name when it sits nowhere). */
function remapExpectedName(state: RemapStubState, f: RemapStubFile): string {
  const on = remapEpisodesOf(state, f.id);
  return on.length === 0 ? f.relativePath : remapNameFor(on, REMAP_TITLES[on[0]!]!, f.releaseGroup);
}

/** Season 3's episodes as `GET /episode` reports them. */
function remapEpisodeRows(state: RemapStubState) {
  return Object.keys(REMAP_TITLES)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => {
      const fileId = state.episodeFile.get(remapEpisodeIdFor(n)) ?? 0;
      return {
        id: remapEpisodeIdFor(n),
        seriesId: STUB_SERIES_ID,
        seasonNumber: REMAP_SEASON,
        episodeNumber: n,
        title: REMAP_TITLES[n],
        airDateUtc: `2023-04-${String(n).padStart(2, '0')}T01:00:00Z`,
        hasFile: fileId > 0,
        monitored: true,
        ...(fileId > 0 ? { episodeFileId: fileId } : {}),
      };
    });
}

/** Season 3's files as `GET /episodefile` reports them. */
function remapFileRows(state: RemapStubState) {
  return [...state.files.values()].map((f) => ({
    id: f.id,
    seriesId: STUB_SERIES_ID,
    seasonNumber: REMAP_SEASON,
    relativePath: f.relativePath,
    sceneName: f.sceneName,
    releaseGroup: f.releaseGroup,
    size: f.size,
    quality: remapQuality,
  }));
}

/** Sonarr's manual-import view of the season's library files (`filterExistingFiles=false`). */
function remapCandidates(state: RemapStubState) {
  return [...state.files.values()].map((f) => ({
    id: f.id * 10,
    path: `${STUB_SERIES_PATH}/${f.relativePath}`,
    relativePath: f.relativePath,
    folderName: 'Breaking Prod',
    name: f.relativePath.split('/').pop()!.replace(/\.mkv$/, ''),
    size: f.size,
    series: { id: STUB_SERIES_ID, title: 'Breaking Prod', year: 2019 },
    seasonNumber: REMAP_SEASON,
    episodes: remapEpisodesOf(state, f.id).map((n) => ({
      id: remapEpisodeIdFor(n),
      seriesId: STUB_SERIES_ID,
      seasonNumber: REMAP_SEASON,
      episodeNumber: n,
      title: REMAP_TITLES[n],
      hasFile: true,
      episodeFileId: f.id,
    })),
    episodeFileId: f.id,
    releaseGroup: f.releaseGroup,
    quality: remapQuality,
    languages: [{ id: 1, name: 'English' }],
    indexerFlags: 0,
    releaseType: 'singleEpisode',
    customFormatScore: 0,
    rejections: [],
  }));
}

/**
 * Sonarr 4.0.20.3012's library-file ManualImport (`ImportApprovedEpisodes`, newDownload false): the record for the path
 * goes (`DeleteMediaFileReason.ManualOverride`), the file stays where it is, and a new record links the chosen episodes.
 * An episode that still had another file leaves that file on disk with no record. Returns false for a path outside the
 * season (the caller handles it like any other import).
 */
function remapImport(state: RemapStubState, file: { path?: string; episodeIds?: number[] }): boolean {
  const prefix = `${STUB_SERIES_PATH}/`;
  if (!file.path?.startsWith(prefix)) return false;
  const rel = file.path.slice(prefix.length);
  const old = [...state.files.values()].find((f) => f.relativePath === rel);
  if (!old) return false;
  state.files.delete(old.id);
  for (const [ep, id] of state.episodeFile) if (id === old.id) state.episodeFile.set(ep, 0);
  for (const target of file.episodeIds ?? []) {
    const other = state.episodeFile.get(target) ?? 0;
    if (other > 0 && state.files.has(other)) state.orphaned.push(state.files.get(other)!.relativePath);
  }
  const fresh: RemapStubFile = { ...old, id: state.nextFileId++, sceneName: null };
  state.files.set(fresh.id, fresh);
  for (const target of file.episodeIds ?? []) if (state.episodeFile.has(target)) state.episodeFile.set(target, fresh.id);
  return true;
}

/** `RenameFiles`: in id order, skipping a name another file still holds (Sonarr never overwrites). */
function remapRename(state: RemapStubState, ids: number[]): void {
  for (const id of [...ids].sort((a, b) => a - b)) {
    const f = state.files.get(id);
    if (!f) continue;
    const next = remapExpectedName(state, f);
    if ([...state.files.values()].some((x) => x.id !== id && x.relativePath === next)) continue;
    f.relativePath = next;
  }
}

/** The season's `downloadFolderImported` history (the Title Check reads it): one record per file, an hour ago. */
function remapImportHistory(state: RemapStubState) {
  const date = new Date(Date.now() - 60 * 60_000).toISOString();
  return [...state.files.values()]
    .filter((f) => f.sceneName !== null)
    .flatMap((f) =>
      remapEpisodesOf(state, f.id).map((n) => ({
        id: 960_000 + f.id * 10 + (n % 10),
        eventType: 'downloadFolderImported',
        date,
        seriesId: STUB_SERIES_ID,
        episodeId: remapEpisodeIdFor(n),
        sourceTitle: f.sceneName,
        downloadId: `SABnzbd_nzo_remap_${f.id}`,
        data: { fileId: String(f.id), droppedPath: `/data/haynestower/usenet/complete-k8s/tv/${f.sceneName}/${f.sceneName}.mkv`, releaseGroup: f.releaseGroup },
      })),
    );
}

/** The queue for the D-07 journeys: Case B's finished, import-blocked download, and S02E02 still downloading. */
export function importCheckQueueFixture(): Record<string, unknown>[] {
  return [
    {
      id: 92001,
      seriesId: STUB_SERIES_ID,
      episodeId: IMPORT_CHECK_EPISODE_ID,
      seasonNumber: 1,
      downloadId: IMPORT_CHECK_DOWNLOAD_ID,
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importBlocked',
      size: 6_442_450_944,
      sizeleft: 0,
      added: '2026-09-24T00:00:00Z',
      title: 'Breaking.Prod.2019.S01E10.125.Years.Young.2160p.PCOK.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX',
      statusMessages: [{ title: IMPORT_CHECK_FILE, messages: [IMPORT_CHECK_REJECTION] }],
    },
    {
      id: 92002,
      seriesId: STUB_SERIES_ID,
      episodeId: ON_ITS_WAY_EPISODE_ID,
      seasonNumber: 2,
      downloadId: 'SABnzbd_nzo_stub_reckoning',
      status: 'downloading',
      trackedDownloadStatus: 'ok',
      trackedDownloadState: 'downloading',
      size: 2_000_000_000,
      sizeleft: 1_100_000_000,
      timeleft: '00:12:20',
      added: '2026-10-12T00:00:00Z',
      title: 'Breaking.Prod.S02E02.Reckoning.1080p.WEB-DL-STUB',
    },
  ];
}

/** The staff path (D-07 rule 6): S01E10's download left packed, which only staff can unpack for now. */
export function importCheckArchiveQueueFixture(): Record<string, unknown>[] {
  return [
    {
      id: 92003,
      seriesId: STUB_SERIES_ID,
      episodeId: IMPORT_CHECK_EPISODE_ID,
      seasonNumber: 1,
      downloadId: 'SABnzbd_nzo_stub_packed',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importBlocked',
      size: 6_442_450_944,
      sizeleft: 0,
      added: '2026-09-24T00:00:00Z',
      title: 'Breaking.Prod.2019.S01E10.2160p.WEB-DL-PACKED',
      statusMessages: [
        { title: 'Breaking.Prod.2019.S01E10.2160p.WEB-DL-PACKED', messages: ['Found archive file, might need to be extracted'] },
      ],
    },
  ];
}

/** Sonarr's manual-import view of Case B's download (`GET /manualimport?downloadId=`), shaped like Sonarr 4.0.20's. */
function importCheckCandidates(downloadId: string): Record<string, unknown>[] {
  if (downloadId !== IMPORT_CHECK_DOWNLOAD_ID) return [];
  return [
    {
      id: 1,
      path: `/data/haynestower/usenet/complete-k8s/tv/${IMPORT_CHECK_FOLDER}/${IMPORT_CHECK_FILE}`,
      relativePath: IMPORT_CHECK_FILE,
      folderName: IMPORT_CHECK_FOLDER,
      name: IMPORT_CHECK_FOLDER,
      size: 6_442_450_944,
      series: { id: STUB_SERIES_ID, title: 'Breaking Prod', year: 2019 },
      seasonNumber: 1,
      episodes: [
        {
          id: IMPORT_CHECK_EPISODE_ID,
          seriesId: STUB_SERIES_ID,
          seasonNumber: 1,
          episodeNumber: 10,
          title: IMPORT_CHECK_EPISODE_TITLE,
          hasFile: false,
        },
      ],
      releaseGroup: 'FLUX',
      quality: {
        quality: { id: 19, name: 'WEBDL-2160p', source: 'web', resolution: 2160 },
        revision: { version: 1, real: 0, isRepack: false },
      },
      languages: [{ id: 1, name: 'English' }],
      indexerFlags: 0,
      releaseType: 'singleEpisode',
      downloadId,
      customFormatScore: 0,
      rejections: [{ reason: IMPORT_CHECK_REJECTION, type: 'permanent' }],
    },
  ];
}

/** Breaking Prod's series history for the season guard: E01..E03 one pack download, E04..E09 one download each. */
function repairGuideSeriesHistory() {
  return episodes()
    .filter((e) => e.seasonNumber === 1 && e.hasFile)
    .map((e) => {
      const inPack = (STUB_PACK_EPISODES as readonly number[]).includes(e.id);
      const code = `S01E${String(e.episodeNumber).padStart(2, '0')}`;
      return {
        id: repairGuideGrabIdFor(e.id),
        eventType: 'grabbed',
        date: '2026-07-01T10:00:00Z',
        sourceTitle: inPack ? 'Breaking.Prod.S01.1080p.WEB-DL-PACKGRP' : `Breaking.Prod.${code}.1080p.WEB-DL-STUB`,
        downloadId: inPack ? 'dl-pack-s01' : `dl-solo-${e.id}`,
        episodeId: e.id,
        seriesId: STUB_SERIES_ID,
        quality: { quality: { id: 4, name: 'WEBDL-1080p', resolution: 1080 } },
        data: { indexer: 'StubIndexer', releaseGroup: inPack ? 'PACKGRP' : 'STUB' },
      };
    });
}

/** Stub Runner's file: WEBDL-1080p from STUB, with no scene name and no grab history (as GoodFellas had). */
function sameReleaseMovieFile() {
  return {
    id: 9602,
    movieId: STUB_SAME_RELEASE_MOVIE_ID,
    relativePath: 'Stub Runner (2020) [WEBDL-1080p]-STUB.mkv',
    releaseGroup: 'STUB',
    quality: { quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080, source: 'web' }, revision: { version: 1 } },
    size: 8_589_934_592,
    customFormatScore: 50,
    edition: '',
    mediaInfo: { audioLanguages: 'eng', subtitles: 'eng' },
  };
}

/**
 * The release list for Stub Runner, in decision order: its own release again (rejected only for the file on disk,
 * a usenet post 4 percent over the file), then a CAM no one would take. The Replacement Preview must refuse.
 */
function sameReleaseList() {
  return [
    {
      guid: 'stub-runner-same',
      indexerId: 1,
      indexer: 'Stub Indexer (Prowlarr)',
      title: 'Stub.Runner.2020.1080p.WEB-DL.DDP5.1.H.264-STUB',
      size: 8_933_531_975,
      quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 }, revision: { version: 1 } },
      releaseGroup: 'STUB',
      approved: false,
      rejected: true,
      rejections: ['Existing file on disk has a equal or higher Custom Format score: 50'],
      customFormatScore: 50,
      protocol: 'usenet',
      downloadUrl: 'http://stub.invalid/getnzb?apikey=not-a-secret',
    },
    {
      guid: 'stub-runner-cam',
      indexerId: 1,
      indexer: 'Stub Indexer (Prowlarr)',
      title: 'Stub.Runner.2020.CAM-NOBODY',
      size: 1_400_000_000,
      quality: { quality: { name: 'CAM', resolution: 480 }, revision: { version: 1 } },
      releaseGroup: 'NOBODY',
      approved: false,
      rejected: true,
      rejections: ['CAM is not wanted in profile'],
      customFormatScore: 0,
      protocol: 'torrent',
    },
  ];
}

/**
 * ADR-018 / DESIGN-008 D-14 — the metadata a harvest reads off the item resources
 * (ratings/images/genres/runtime) + the poster a /api/posters proxy streams. A 1x1 PNG stands
 * in for the *arr's pre-resized MediaCover variant so the poster route runs hermetically.
 */
const POSTER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
export const STUB_MOVIE_ID = 601;
export const STUB_MOVIE_TMDB_ID = 880001;
/** DESIGN-009 (ledger e2e) — a live movie that is PRESENT but UNMONITORED with no file: the
 *  bulk Monitor-&-search's monitor-flip outcome (ADR-022 C-01). Mirrors the tombstoned
 *  'Vanished Heist' ledger row (seed-ledger.ts) by tmdbId. */
export const STUB_VANISHED_ID = 604;
export const STUB_VANISHED_TMDB_ID = 880004;

/**
 * ADR-059 / DESIGN-030 D-08 (PLAN-048 — Activity / In-Flight) — the *arr Activity queue fixtures: a
 * DOWNLOADING movie (The Fixture, ~45% → `downloading`) + a manual-import BLOCKED movie (Vanished Heist,
 * `trackedDownloadState: 'importBlocked'` with a status message → `import_blocked`). Staged via
 * `POST /_stub/queue` and served by `GET /queue` (unfiltered), these drive the live Activity tab's *arr
 * leg AND — read by the `activity-scan` seed — the durable import_blocked failure ledger row. `radarr`
 * queue records carry `movieId` so only the Radarr adapter picks them up (Sonarr/Lidarr skip them).
 */
export function arrActivityQueueFixture(): Record<string, unknown>[] {
  const size = 1_000_000_000;
  return [
    {
      id: 90001,
      movieId: STUB_MOVIE_ID,
      status: 'downloading',
      trackedDownloadStatus: 'ok',
      trackedDownloadState: 'downloading',
      size,
      sizeleft: Math.round(size * 0.55), // ~45%
      estimatedCompletionTime: '2026-07-14T13:00:00Z',
      title: 'The.Fixture.2022.1080p.WEB-DL',
    },
    {
      id: 90002,
      movieId: STUB_VANISHED_ID,
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importBlocked',
      size,
      sizeleft: 0,
      title: 'Vanished.Heist.2018.1080p.WEB-DL',
      statusMessages: [
        {
          title: 'Manual import required',
          messages: ['One or more files were not imported — the release did not match a monitored movie'],
        },
      ],
    },
  ];
}

/**
 * ADR-083 / DESIGN-046 D-09 (PLAN-065 — *arr queue janitor) — a canned ERRORED download queue spanning every
 * Action Class (have_better / bad_release / retry_import / manual_match / unknown) with realistic statusMessages, so
 * `--mode=queue-cleanup` runs end-to-end locally in census (writes arr_queue_cleanup_actions rows without
 * touching any *arr — enforcement stays off under the all-census default). `added` is deliberately old so the
 * items clear the janitor's minItemAgeHours rail. Staged via `POST /_stub/queue` (dev:local pre-stages it).
 * One stub stands in for all three *arrs, so a run observes each item once per instance — fine for a census
 * smoke; the fields the classifier reads (status / trackedDownloadState / statusMessages) are what matter.
 */
export function erroredArrQueueFixture(): Record<string, unknown>[] {
  const size = 2_000_000_000;
  const added = '2026-07-01T00:00:00Z';
  return [
    // have_better — the *arr already holds equal/better quality (remove + blocklist, no re-search).
    {
      id: 91001,
      movieId: STUB_MOVIE_ID,
      downloadId: 'dl-have-better-1',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importBlocked',
      size,
      sizeleft: 0,
      added,
      title: 'The.Fixture.2022.2160p.WEB-DL',
      statusMessages: [
        {
          title: 'Not an upgrade',
          messages: [
            'Not an upgrade for existing movie file(s). Existing quality: WEBDL-2160p. New quality WEBDL-1080p',
          ],
        },
      ],
    },
    // bad_release — an unparseable/defective grab (blocklist + re-search where still monitored).
    {
      id: 91002,
      seriesId: STUB_SERIES_ID,
      episodeId: 5001,
      downloadId: 'dl-bad-release-1',
      status: 'warning',
      trackedDownloadStatus: 'error',
      trackedDownloadState: 'importFailed',
      size,
      sizeleft: 0,
      added,
      title: 'Some.Show.S01E01.GARBLED',
      errorMessage: 'Unable to parse release title',
      statusMessages: [{ title: 'Import failed', messages: ['Unable to parse the release title'] }],
    },
    // retry_import — a stuck/transient import (bounded ProcessMonitoredDownloads).
    {
      id: 91003,
      movieId: STUB_VANISHED_ID,
      downloadId: 'dl-retry-1',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importPending',
      size,
      sizeleft: 0,
      added,
      title: 'Vanished.Heist.2018.1080p.WEB-DL',
      statusMessages: [{ title: 'Waiting', messages: ['Waiting to import...'] }],
    },
    // manual_match — Lidarr could not match the files to the album (DESIGN-046 D-12; acted on only where Lidarr's
    // manual_match cell is enforced, D-13, and dev:local stays census).
    // Lidarr's multi-file shape: the header, then one entry per rejected file.
    {
      id: 91004,
      artistId: STUB_ARTIST_ID,
      albumId: STUB_ALBUM_ID,
      downloadId: 'dl-manual-match-1',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importFailed',
      size,
      sizeleft: 0,
      added,
      title: 'Some Artist - Some Album (2019)',
      statusMessages: [
        {
          title: 'One or more tracks expected in this release were not imported or missing from the release',
          messages: [],
        },
        {
          title: '01 - Opening.flac',
          messages: ['Album match is not close enough: 75.6 % vs 80 % [album, year, missing tracks]', 'Has missing tracks'],
        },
      ],
    },
    // unknown — a message the classifier does not recognize (reported, never acted on).
    {
      id: 91005,
      artistId: STUB_ARTIST_ID,
      albumId: STUB_ALBUM_ID,
      downloadId: 'dl-unknown-1',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importPending',
      size,
      sizeleft: 0,
      added,
      title: 'Some Artist - Another Album (2021)',
      statusMessages: [
        {
          title: 'Some Artist - Another Album (2021)',
          messages: ['No files found are eligible for import in /downloads/music/Some Artist - Another Album (2021)'],
        },
      ],
    },
  ];
}

/** The metadata fields DESIGN-008 D-02 harvests off a Radarr movie / Sonarr series. */
const RADARR_META = {
  runtime: 106,
  genres: ['Comedy', 'Drama'],
  ratings: {
    imdb: { value: 7.7, votes: 12345, type: 'user' },
    tmdb: { value: 7.9, votes: 678, type: 'user' },
    rottenTomatoes: { value: 88, type: 'user' },
  },
  images: [
    {
      coverType: 'poster',
      url: '/MediaCover/601/poster.jpg?lastWrite=1',
      remoteUrl: 'https://image.tmdb.org/t/p/original/fixture.jpg',
    },
  ],
};
const SONARR_META = {
  runtime: 44,
  genres: ['Drama', 'Crime'],
  ratings: { value: 8.2, votes: 4321 },
  images: [
    {
      coverType: 'poster',
      url: '/MediaCover/501/poster.jpg?lastWrite=1',
      remoteUrl: 'https://artworks.thetvdb.com/x/poster.jpg',
    },
  ],
};

function movieResource(id: number) {
  return {
    id,
    title: 'The Fixture',
    sortTitle: 'fixture',
    year: 2022,
    tmdbId: STUB_MOVIE_TMDB_ID,
    imdbId: 'tt8800010',
    monitored: true,
    qualityProfileId: 1,
    rootFolderPath: '/data/haynestower/Media/Movies',
    path: '/data/haynestower/Media/Movies/The Fixture',
    tags: [] as number[],
    hasFile: true,
    movieFileId: 9601,
    // The on-disk file is embedded inline (DESIGN-008 D-02 resolution fix): the harvest reads
    // quality.quality.resolution (int) for the REAL per-item tier — here 1080 → '1080p'.
    movieFile: { quality: { quality: { id: 4, name: 'WEBDL-1080p', resolution: 1080 } } },
    sizeOnDisk: 4_294_967_296,
    statistics: { movieFileCount: 1 },
    minimumAvailability: 'released',
    status: 'released',
    isAvailable: true,
    added: '2025-02-02T00:00:00Z',
    ...RADARR_META,
  };
}

/** The present-but-unmonitored, fileless live movie (see STUB_VANISHED_ID above). */
function vanishedMovieResource() {
  return {
    id: STUB_VANISHED_ID,
    title: 'Vanished Heist',
    sortTitle: 'vanished heist',
    year: 2018,
    tmdbId: STUB_VANISHED_TMDB_ID,
    monitored: false,
    qualityProfileId: 1,
    rootFolderPath: '/data/haynestower/Media/Movies',
    path: '/data/haynestower/Media/Movies/Vanished Heist',
    tags: [] as number[],
    hasFile: false,
    movieFileId: 0, // Radarr sends 0 (not absent) for fileless movies
    sizeOnDisk: 0,
    statistics: { movieFileCount: 0 },
    minimumAvailability: 'released',
    status: 'released',
    isAvailable: true,
    added: '2025-03-03T00:00:00Z',
  };
}

/** ADR-022 D-02 — a minimal Lidarr artist resource for `POST /artist` (Ledger add path). */
function artistResource(id: number) {
  return {
    id,
    artistName: 'Ledger Band',
    sortName: 'ledger band',
    foreignArtistId: `11111111-2222-3333-4444-${String(id).padStart(12, '0')}`,
    monitored: true,
    monitorNewItems: 'all',
    qualityProfileId: 1,
    metadataProfileId: 1,
    rootFolderPath: '/data/media/music',
    path: `/data/media/music/Ledger Band ${id}`,
    tags: [] as number[],
    status: 'continuing',
    added: '2025-01-01T00:00:00Z',
  };
}

/**
 * The `grabbed` value for the paged `GET /history?eventType=` filter. That real *arr
 * endpoint binds `eventType` to the INTEGER `*HistoryEventType` enum (grabbed === 1;
 * see @hnet/arr SONARR_GRABBED_EVENT_TYPE) — the lowercase string it RETURNS in bodies
 * is rejected there with HTTP 400. The stub enforces the same so the prod bug
 * (fix/history-eventtype-enum) can never pass CI again.
 */
const GRABBED_EVENT_TYPE = 1;

/**
 * The real ASP.NET ValidationProblemDetails body the paged /history endpoint returns for
 * a non-integer `eventType` (captured live 2026-07-03). Mirrored so ArrHttpError sees the
 * exact shape production does.
 */
function invalidEventTypeBody(value: string) {
  return {
    type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1',
    title: 'One or more validation errors occurred.',
    status: 400,
    traceId: '00-stubarr0000000000000000000000-0000000000000000-00',
    errors: { eventType: [`The value '${value}' is not valid.`] },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// ADR-109 C-02, C-06 / DESIGN-055 D-06 (PLAN-077 P5) — the Release Pick season (POST /_stub/release-pick)
// ---------------------------------------------------------------------------------------------------------------------

/** The Release Pick season and its episode ids (50500 + episode number); a season no other spec relies on. */
export const RELEASE_PICK_SEASON = 4;
export const releasePickEpisodeIdFor = (episodeNumber: number) => STUB_SERIES_ID * 100 + 400 + episodeNumber;
/** Target A (Grab row) and target B (the Override rows), both missing and monitored; B-1 is B's on-disk neighbour. */
export const RELEASE_PICK_A_EPISODE = 3;
export const RELEASE_PICK_B_EPISODE = 5;
export const RELEASE_PICK_B_PREVIOUS_EPISODE = 4;
export const RELEASE_PICK_A_EPISODE_ID = releasePickEpisodeIdFor(RELEASE_PICK_A_EPISODE);
export const RELEASE_PICK_B_EPISODE_ID = releasePickEpisodeIdFor(RELEASE_PICK_B_EPISODE);
export const RELEASE_PICK_TITLES: Readonly<Record<number, string>> = {
  1: 'Pilot Light',
  2: 'Legacy Code',
  3: 'Rollback Rodeo',
  4: 'Cache Me Outside',
  5: 'Hotfix Hootenanny',
  6: 'Standup Showdown',
};
/** Season 4's on-disk episodes (the rest are missing). */
const RELEASE_PICK_ON_DISK = new Set([1, 2, 4, 6]);
/** The guid whose grab the stub answers 409 (the site would not hand the file over). */
export const RELEASE_PICK_REFUSED_GUID = 'stub-rp-b-409';

function releasePickEpisodeRows() {
  return Object.keys(RELEASE_PICK_TITLES)
    .map(Number)
    .map((n) => ({
      id: releasePickEpisodeIdFor(n),
      seriesId: STUB_SERIES_ID,
      seasonNumber: RELEASE_PICK_SEASON,
      episodeNumber: n,
      title: RELEASE_PICK_TITLES[n],
      airDateUtc: `2024-05-${String(n).padStart(2, '0')}T01:00:00Z`,
      hasFile: RELEASE_PICK_ON_DISK.has(n),
      monitored: true,
      ...(RELEASE_PICK_ON_DISK.has(n) ? { episodeFileId: 3400 + n } : {}),
    }));
}

function releasePickFileRows() {
  return [...RELEASE_PICK_ON_DISK].map((n) => ({
    id: 3400 + n,
    seriesId: STUB_SERIES_ID,
    quality: { quality: { id: 4, name: 'WEBDL-1080p', resolution: 1080 } },
    seasonNumber: RELEASE_PICK_SEASON,
    relativePath: `Season ${RELEASE_PICK_SEASON}/Breaking Prod - S04E${String(n).padStart(2, '0')} [WEBDL-1080p]-STUB.mkv`,
    sceneName: `Breaking.Prod.S04E${String(n).padStart(2, '0')}.1080p.WEB-DL.DDP5.1.H.264-STUB`,
    releaseGroup: 'STUB',
    size: 1_073_741_824,
  }));
}

const rpQuality = (id: number, name: string, resolution: number) => ({
  quality: { id, name, source: 'web', resolution, modifier: 'none' },
  revision: { version: 1, real: 0, isRepack: false },
});
const RP_ENGLISH = [{ id: 1, name: 'English' }];
const RP_CF_REJECTION = 'Custom Formats HMAX, x265 (HD) have score -9925 below Series profile minimum 0';
const rpCode = (episode: number) => `S0${RELEASE_PICK_SEASON}E${String(episode).padStart(2, '0')}`;

/** One row of the Sonarr season release list, with the fields the live shape carries. */
function rpRow(r: {
  guid: string;
  indexerId: number;
  title: string;
  size: number;
  quality: ReturnType<typeof rpQuality>;
  releaseGroup: string;
  episode: number;
  approved: boolean;
  rejections: string[];
  customFormatScore: number;
}) {
  return {
    guid: r.guid,
    quality: r.quality,
    ageHours: 120.5,
    size: r.size,
    indexerId: r.indexerId,
    indexer: 'StubIndexer (Prowlarr)',
    releaseGroup: r.releaseGroup,
    title: r.title,
    fullSeason: false,
    seasonNumber: RELEASE_PICK_SEASON,
    languages: RP_ENGLISH,
    episodeNumbers: [r.episode],
    mappedSeasonNumber: RELEASE_PICK_SEASON,
    mappedEpisodeNumbers: [r.episode],
    approved: r.approved,
    temporarilyRejected: false,
    rejected: !r.approved,
    rejections: r.rejections,
    customFormatScore: r.customFormatScore,
    protocol: 'usenet',
    downloadAllowed: true,
    indexerFlags: 0,
  };
}

/** `GET /release?seriesId=501&seasonNumber=4`, in the *arr's decision order. */
function releasePickSeasonList() {
  const a = RELEASE_PICK_A_EPISODE;
  const b = RELEASE_PICK_B_EPISODE;
  const bPrev = RELEASE_PICK_B_PREVIOUS_EPISODE;
  const aTitle = dotted(RELEASE_PICK_TITLES[a]!);
  const bTitle = dotted(RELEASE_PICK_TITLES[b]!);
  const otherTitle = dotted(RELEASE_PICK_TITLES[2]!);
  const unrelated = 6;
  return [
    rpRow({
      guid: 'stub-rp-a1',
      indexerId: 1,
      title: `Breaking.Prod.${rpCode(a)}.${aTitle}.1080p.WEB-DL.DDP5.1.H.264-GOOD`,
      size: 612_000_000,
      quality: rpQuality(3, 'WEBDL-1080p', 1080),
      releaseGroup: 'GOOD',
      episode: a,
      approved: true,
      rejections: [],
      customFormatScore: 100,
    }),
    rpRow({
      guid: 'stub-rp-b1',
      indexerId: 1,
      title: `Breaking.Prod.${rpCode(b)}.${bTitle}.1080p.HMAX.WEB-DL.DDP2.0.H.265-OldT`,
      size: 689_000_000,
      quality: rpQuality(3, 'WEBDL-1080p', 1080),
      releaseGroup: 'OldT',
      episode: b,
      approved: false,
      rejections: [RP_CF_REJECTION],
      customFormatScore: -9925,
    }),
    rpRow({
      guid: 'stub-rp-b2',
      indexerId: 2,
      title: `Breaking.Prod.${rpCode(b)}.720p.WEB.h264-WvF`,
      size: 310_000_000,
      quality: rpQuality(5, 'WEBDL-720p', 720),
      releaseGroup: 'WvF',
      episode: b,
      approved: false,
      rejections: ['WEBDL-720p is not wanted in profile'],
      customFormatScore: 0,
    }),
    rpRow({
      guid: 'stub-rp-b3',
      indexerId: 2,
      title: `Breaking.Prod.${rpCode(bPrev)}.${bTitle}.1080p.HMAX.WEB-DL-OldT`,
      size: 655_000_000,
      quality: rpQuality(3, 'WEBDL-1080p', 1080),
      releaseGroup: 'OldT',
      episode: bPrev,
      approved: false,
      rejections: [RP_CF_REJECTION],
      customFormatScore: -9925,
    }),
    rpRow({
      guid: 'stub-rp-b4',
      indexerId: 1,
      title: `Breaking.Prod.${rpCode(b)}.1080p.AMZN.WEB-DL.DDP5.1.H.264.DUAL-BiOMA`,
      size: 598_000_000,
      quality: rpQuality(3, 'WEBDL-1080p', 1080),
      releaseGroup: 'BiOMA',
      episode: b,
      approved: false,
      rejections: ['Release is blocklisted'],
      customFormatScore: 50,
    }),
    rpRow({
      guid: 'stub-rp-b5',
      indexerId: 2,
      title: `Breaking.Prod.${rpCode(b)}.${otherTitle}.1080p.WEB-DL-OldT`,
      size: 640_000_000,
      quality: rpQuality(3, 'WEBDL-1080p', 1080),
      releaseGroup: 'OldT',
      episode: b,
      approved: false,
      rejections: [RP_CF_REJECTION],
      customFormatScore: -9925,
    }),
    rpRow({
      guid: RELEASE_PICK_REFUSED_GUID,
      indexerId: 1,
      title: `Breaking.Prod.${rpCode(b)}.480p.WEB.h264-NOPE`,
      size: 305_000_000,
      quality: rpQuality(8, 'WEBDL-480p', 480),
      releaseGroup: 'NOPE',
      episode: b,
      approved: false,
      rejections: ['WEBDL-480p is not wanted in profile'],
      customFormatScore: 0,
    }),
    // An unrelated episode with its own, non-matching title: the app drops it from both targets' lists.
    rpRow({
      guid: 'stub-rp-u1',
      indexerId: 2,
      title: `Breaking.Prod.${rpCode(unrelated)}.${dotted(RELEASE_PICK_TITLES[unrelated]!)}.1080p.WEB-DL.DDP5.1.H.264-GOOD`,
      size: 570_000_000,
      quality: rpQuality(3, 'WEBDL-1080p', 1080),
      releaseGroup: 'GOOD',
      episode: unrelated,
      approved: true,
      rejections: [],
      customFormatScore: 100,
    }),
  ];
}

/** The downloading queue record a successful Release Pick grab leaves behind (the shape of the staged queue's records). */
function releasePickQueueRecord(guid: string, title: string, episodeId: number, seq: number): Record<string, unknown> {
  return {
    id: 93000 + seq,
    seriesId: STUB_SERIES_ID,
    episodeId,
    seasonNumber: RELEASE_PICK_SEASON,
    downloadId: `stub-rp-dl-${guid}`,
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    size: 1_000_000_000,
    sizeleft: 500_000_000,
    timeleft: '00:08:20',
    added: '2026-10-13T00:00:00Z',
    title,
  };
}

function episodes() {
  // Season 1: 10 episodes, E10 missing (the seeded ledger row mirrors this as 9/10).
  const season1 = Array.from({ length: EPISODE_COUNT }, (_, i) => {
    const n = i + 1;
    const hasFile = n !== 10; // E10 missing
    return {
      id: STUB_SERIES_ID * 100 + n, // 50101..50110
      seriesId: STUB_SERIES_ID,
      seasonNumber: 1,
      episodeNumber: n,
      title: `Chapter ${n}`,
      airDateUtc: `2021-03-${String(n).padStart(2, '0')}T01:00:00Z`,
      hasFile,
      monitored: true,
      ...(hasFile ? { episodeFileId: 3000 + n } : {}),
    };
  });
  // Season 2: gives the detail view a second collapsible season (roll-up actions). One
  // episode on disk (so the season shows a Fix button), one missing.
  const season2 = [
    {
      id: STUB_SERIES_ID * 100 + 201, // 50301
      seriesId: STUB_SERIES_ID,
      seasonNumber: 2,
      episodeNumber: 1,
      title: 'Return',
      airDateUtc: '2022-03-01T01:00:00Z',
      hasFile: true,
      monitored: true,
      episodeFileId: 3201,
    },
    {
      id: STUB_SERIES_ID * 100 + 202, // 50302
      seriesId: STUB_SERIES_ID,
      seasonNumber: 2,
      episodeNumber: 2,
      title: 'Reckoning',
      airDateUtc: '2022-03-08T01:00:00Z',
      hasFile: false,
      monitored: true,
    },
  ];
  return [...season1, ...season2];
}

function seriesResource(id: number) {
  return {
    id,
    title: 'Breaking Prod',
    sortTitle: 'breaking prod',
    year: 2019,
    tvdbId: STUB_SERIES_TVDB_ID,
    monitored: true,
    monitorNewItems: 'all',
    qualityProfileId: 7,
    rootFolderPath: '/data/haynestower/Media/TV Shows',
    path: '/data/haynestower/Media/TV Shows/Breaking Prod',
    tags: [1],
    statistics: {
      episodeFileCount: 9,
      episodeCount: 10,
      totalEpisodeCount: 10,
      sizeOnDisk: 21_474_836_480,
    },
    seriesType: 'standard',
    seasonFolder: true,
    status: 'ended',
    ended: true,
    added: '2025-01-01T00:00:00Z',
    ...SONARR_META,
  };
}

function grabRecord(episodeId: number) {
  return {
    id: grabHistoryIdFor(episodeId),
    eventType: 'grabbed',
    date: '2026-07-01T10:00:00Z',
    sourceTitle: `Breaking.Prod.S01E${String(episodeId % 100).padStart(2, '0')}.MULTi.1080p.WEB-DL`,
    downloadId: `dl-${episodeId}`,
    quality: { quality: { id: 4, name: 'WEBDL-1080p' } },
    data: { indexer: 'StubIndexer', releaseGroup: 'STUB' },
    episodeId,
    seriesId: STUB_SERIES_ID,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/**
 * ADR-111 / DESIGN-055 D-10, D-11 (PLAN-077 P3) — the stub Seerr issues, in Seerr 3.5.0's `GET /issue` shape:
 *   • 901 (open, Video): Breaking Prod S01E10, which is missing, so its link opens Force Search on it. Reported by the
 *     fresh-member persona, who may have no account yet (the D-11 first-visit path).
 *   • 902 (open, Audio): The Fixture, on disk, so its link opens Fix with Wrong language preselected. Reported by the
 *     member persona.
 *   • 903 (resolved, Other): Stub Runner.
 *   • 904 (open, Video): a movie the ledger does not have.
 */
export const SEERR_ISSUE_MISSING_EPISODE = 901;
export const SEERR_ISSUE_AUDIO_MOVIE = 902;
export const SEERR_ISSUE_RESOLVED = 903;
export const SEERR_ISSUE_NOT_IN_LIBRARY = 904;

export function seerrIssueFixture(): Array<Record<string, unknown>> {
  const user = (id: number, name: string, email: string) => ({
    id,
    email,
    plexUsername: name,
    username: null,
    displayName: name,
    userType: 1,
    permissions: 277872800,
    avatar: '/avatar.png',
  });
  const issue = (
    id: number,
    o: { issueType: number; status: number; season: number; episode: number; media: Record<string, unknown>; by: Record<string, unknown>; message: string; at: string },
  ) => ({
    id,
    issueType: o.issueType,
    status: o.status,
    problemSeason: o.season,
    problemEpisode: o.episode,
    createdAt: o.at,
    updatedAt: o.at,
    createdBy: o.by,
    modifiedBy: null,
    media: { id: 9000 + id, downloadStatus: [], status: 5, ...o.media },
    comments: [{ id: 9100 + id, message: o.message, createdAt: o.at, updatedAt: o.at }],
  });
  const fresh = user(3, 'stubfresh', 'fresh-member@example.test');
  const member = user(2, 'stubmember', 'member@example.test');
  return [
    issue(SEERR_ISSUE_NOT_IN_LIBRARY, { issueType: 1, status: 1, season: 0, episode: 0, media: { mediaType: 'movie', tmdbId: 889999, tvdbId: null }, by: member, message: 'It never finished downloading.', at: '2026-10-12T12:30:00.000Z' }),
    issue(SEERR_ISSUE_RESOLVED, { issueType: 4, status: 2, season: 0, episode: 0, media: { mediaType: 'movie', tmdbId: 880002, tvdbId: null }, by: member, message: 'The poster is wrong.', at: '2026-10-11T08:00:00.000Z' }),
    issue(SEERR_ISSUE_AUDIO_MOVIE, { issueType: 2, status: 1, season: 0, episode: 0, media: { mediaType: 'movie', tmdbId: 880001, tvdbId: null }, by: member, message: 'The audio is in the wrong language.', at: '2026-10-12T10:00:00.000Z' }),
    issue(SEERR_ISSUE_MISSING_EPISODE, { issueType: 1, status: 1, season: 1, episode: 10, media: { mediaType: 'tv', tmdbId: 770001, tvdbId: STUB_SERIES_TVDB_ID }, by: fresh, message: 'Missing episode 10', at: '2026-10-12T09:00:00.000Z' }),
  ];
}

/**
 * DESIGN-052 D-25da — Radarr's and Sonarr's own stub keys. One stub serves both, and the Release Block keeps one
 * app-owned profile per *arr, so the stub keeps a profile list per `X-Api-Key` (env.ts gives the two their own keys): a
 * shared list would make each *arr's upkeep read the other's terms as drift and rewrite them away on every run.
 */
export const STUB_RADARR_API_KEY = 'stub-radarr-key';
export const STUB_SONARR_API_KEY = 'stub-sonarr-key';

export async function startStubArr(): Promise<StubArrServer> {
  const calls: RecordedArrWrite[] = [];
  // PLAN-015 / D-20 — the scriptable download queue (staged via POST /_stub/queue). Empty by
  // default so a target with no download derives `searching`/`nothing_found`.
  let queueRecords: Record<string, unknown>[] = [];
  // PLAN-048 (fix/activity-robustness) — a scriptable FAULT toggle: when on, the Activity read
  // endpoints (`GET /queue`, `GET /history`) answer 500 so the *arr activity adapter's `list()`
  // throws. Exercises per-source failure isolation (one source down → the OTHERS still flow + a
  // per-source `unavailable` marker). Toggled via `POST /_stub/fault {on}`; cleared by reset.
  let faultReads = false;
  // ADR-093 / DESIGN-052 D-20 — Seerr's watchlist error switch: when on, every `/user/{id}/watchlist` page answers
  // Seerr 3.4.1's failed-read body (HTTP 200, `totalPages: 0`, `totalResults: 0`, no results). Cleared by reset.
  let seerrWatchlistError = false;
  // ADR-093 / DESIGN-052 D-10 — a spec-set Seerr watchlist per user id (`POST /_stub/seerr-watchlist`), in place of the
  // default (the member's Stub Dune). Cleared by reset, or per user by posting no `results`.
  const seerrWatchlistOverride = new Map<string, Array<Record<string, unknown>>>();
  // ADR-093 / DESIGN-052 D-13 / D-20 / D-25da — the app-owned "must not contain" release profile, one list per *arr as
  // the real ones keep it: this one stub serves Radarr AND Sonarr, told apart by the request's `X-Api-Key` (a key the
  // stub does not know gets a list of its own).
  const releaseProfiles = new Map<string, Array<Record<string, unknown> & { id: number }>>();
  const profilesOf = (req: IncomingMessage) => {
    const key = String(req.headers['x-api-key'] ?? '');
    let list = releaseProfiles.get(key);
    if (list === undefined) {
      list = [];
      releaseProfiles.set(key, list);
    }
    return list;
  };
  let nextReleaseProfileId = 1;
  // ADR-097 / DESIGN-052 D-27 — each *arr's import-list exclusion list (Radarr `/exclusions`, Sonarr
  // `/importlistexclusion`; the paths tell them apart). Kept out of the recorded `calls`; a key already excluded is
  // refused with 400, as the *arr's validator does.
  let importListExclusions: Record<'radarr' | 'sonarr', Array<Record<string, unknown> & { id: number }>> = {
    radarr: [],
    sonarr: [],
  };
  let nextExclusionId = 1;
  // DESIGN-052 D-17 / D-20 — each Seerr user's watchlist sync flags (settings/main), and the Sonarr server's tags.
  let seerrSyncFlags = new Map<number, { movies: boolean; tv: boolean }>([[1, { movies: true, tv: true }]]);
  // ADR-109 / DESIGN-055 D-09 — the Repair Guide fixtures (POST /_stub/repair-guide); off until a spec turns them on.
  let repairGuideFixtures = false;
  let seerrAnimeTags: number[] = [];
  // ADR-109 / DESIGN-055 D-07 — the queue-aware Force Search fixtures (POST /_stub/import-check), and what a recorded
  // ManualImport put on disk (cleared by reset).
  let importCheckFixtures = false;
  // ADR-111 / DESIGN-055 D-10 — the served Seerr issues (null: seerrIssueFixture()); POST /_stub/seerr-issues sets them.
  let seerrIssuesOverride: Array<Record<string, unknown>> | null = null;
  // ADR-109 C-02 / DESIGN-055 D-04 — the Episode Re-map season (POST /_stub/remap); null while off.
  let remapState: RemapStubState | null = null;
  // ADR-109 / DESIGN-055 D-06 — the Release Pick fixtures (POST /_stub/release-pick), the bodies of the `POST /release`
  // grabs this stub accepted, and the download each one left in the queue (all cleared by reset).
  let releasePickFixtures = false;
  let releaseGrabs: unknown[] = [];
  let releaseGrabQueue: Record<string, unknown>[] = [];
  // Every command this stub accepted (`GET /command` lists them; each is completed at once).
  let commandLog: Array<{ id: number; name: string; status: string }> = [];
  let nextCommandId = 4242;
  const importedEpisodeIds = new Set<number>();
  const importedMovieIds = new Set<number>();
  let lastCommandName = 'UnknownCommand';

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      // Normalize the API base away: /api/v3/... and /api/v1/... share handlers.
      const path = url.pathname.replace(/^\/api\/v[13]/, '');
      const query = Object.fromEntries(url.searchParams.entries());

      // ---- control surface ----
      if (url.pathname === '/_stub/calls') {
        return json(res, 200, { calls });
      }
      if (url.pathname === '/_stub/reset' && method === 'POST') {
        calls.length = 0;
        queueRecords = [];
        faultReads = false;
        seerrWatchlistError = false;
        seerrWatchlistOverride.clear();
        releaseProfiles.clear();
        nextReleaseProfileId = 1;
        importListExclusions = { radarr: [], sonarr: [] };
        nextExclusionId = 1;
        seerrSyncFlags = new Map([[1, { movies: true, tv: true }]]);
        seerrAnimeTags = [];
        repairGuideFixtures = false;
        releasePickFixtures = false;
        releaseGrabs = [];
        releaseGrabQueue = [];
        importCheckFixtures = false;
        seerrIssuesOverride = null;
        remapState = null;
        commandLog = [];
        nextCommandId = 4242;
        importedEpisodeIds.clear();
        importedMovieIds.clear();
        lastCommandName = 'UnknownCommand';
        clearStubArrDeleted();
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/seerr-watchlist-error' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw === '' ? {} : (JSON.parse(raw) as { on?: boolean });
        seerrWatchlistError = parsed.on !== false;
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/seerr-issues' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw === '' ? {} : (JSON.parse(raw) as { issues?: Array<Record<string, unknown>> | null });
        seerrIssuesOverride = Array.isArray(parsed.issues) ? parsed.issues : null;
        res.writeHead(204);
        return res.end();
      }
      // ADR-111 / DESIGN-055 D-10 — Seerr's issue reads (the mirror's sync, the webhook's and the link's fresh read).
      if (method === 'GET' && (path === '/issue' || path === '/issue/count' || /^\/issue\/\d+$/.test(path))) {
        const all = (seerrIssuesOverride ?? seerrIssueFixture())
          .slice()
          .sort((a, b) => Number(b.id) - Number(a.id));
        if (path === '/issue/count') {
          const open = all.filter((i) => i.status === 1).length;
          return json(res, 200, { total: all.length, open, closed: all.length - open });
        }
        const one = /^\/issue\/(\d+)$/.exec(path);
        if (one) {
          const found = all.find((i) => Number(i.id) === Number(one[1]));
          return found ? json(res, 200, found) : json(res, 404, { message: 'Issue not found.' });
        }
        const filter = query.filter ?? 'open';
        const listed = all.filter((i) => (filter === 'all' ? true : filter === 'resolved' ? i.status === 2 : i.status === 1));
        const take = Math.max(1, Number(query.take ?? 10));
        const skip = Math.max(0, Number(query.skip ?? 0));
        return json(res, 200, {
          pageInfo: { pages: Math.ceil(listed.length / take), pageSize: take, results: listed.length, page: Math.floor(skip / take) + 1 },
          results: listed.slice(skip, skip + take),
        });
      }
      if (url.pathname === '/_stub/seerr-watchlist' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw === '' ? {} : (JSON.parse(raw) as { userId?: number; results?: Array<Record<string, unknown>> | null });
        const key = String(parsed.userId ?? 2);
        if (Array.isArray(parsed.results)) seerrWatchlistOverride.set(key, parsed.results);
        else seerrWatchlistOverride.delete(key);
        res.writeHead(204);
        return res.end();
      }
      // ADR-093 / DESIGN-052 D-02 / D-20 — Seerr's users and each user's watchlist (SEERR_URL points here; the path is
      // normalized, so `/api/v1/user` is `/user`). Seerr user 1 is the owner, user 2 the member (a friend); the
      // member's list holds Stub Dune, a title that is NOT in the Trash pool.
      if (method === 'GET' && path === '/user') {
        return json(res, 200, {
          pageInfo: { pages: 1, pageSize: 100, results: 2, page: 1 },
          results: [
            { id: 1, plexId: 12874060, userType: 1 },
            { id: 2, plexId: 77, userType: 1 },
          ],
        });
      }
      const seerrWatchlist = /^\/user\/(\d+)\/watchlist$/.exec(path);
      if (method === 'GET' && seerrWatchlist) {
        const page = Number(query.page ?? 1);
        if (seerrWatchlistError) return json(res, 200, { page, totalPages: 0, totalResults: 0, results: [] });
        const override = seerrWatchlistOverride.get(seerrWatchlist[1]!);
        const results = override
          ? override
          : seerrWatchlist[1] === '2'
            ? [{ id: 11, ratingKey: '5d776d1b0000000000000002', title: 'Stub Dune', mediaType: 'movie', tmdbId: 880020 }]
            : [];
        return json(res, 200, { page, totalPages: results.length > 0 ? 1 : 0, totalResults: results.length, results });
      }
      // ADR-093 / DESIGN-052 D-13 / D-20 — the release profile surface (kept out of the recorded `calls`, which other
      // specs assert on), plus a read of it for specs.
      if (url.pathname === '/_stub/release-profiles') {
        return json(res, 200, {
          radarr: releaseProfiles.get(STUB_RADARR_API_KEY) ?? [],
          sonarr: releaseProfiles.get(STUB_SONARR_API_KEY) ?? [],
        });
      }
      if (path === '/releaseprofile' && method === 'GET') return json(res, 200, profilesOf(req));
      if (path === '/releaseprofile' && method === 'POST') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const created = { ...body, id: nextReleaseProfileId++ };
        profilesOf(req).push(created);
        return json(res, 201, created);
      }
      const profilePut = /^\/releaseprofile\/(\d+)$/.exec(path);
      if (profilePut && method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const id = Number(profilePut[1]);
        const list = profilesOf(req);
        const at = list.findIndex((p) => p.id === id);
        if (at >= 0) list[at] = { ...body, id };
        return json(res, 202, { ...body, id });
      }
      // DESIGN-052 D-17 / D-20 — Seerr settings/main (the watchlist sync flags; POST echoes) and the Sonarr server list
      // the anime-tags preflight reads and PUTs.
      const seerrSettings = /^\/user\/(\d+)\/settings\/main$/.exec(path);
      if (seerrSettings) {
        const id = Number(seerrSettings[1]);
        if (method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { watchlistSyncMovies?: boolean; watchlistSyncTv?: boolean };
          seerrSyncFlags.set(id, { movies: body.watchlistSyncMovies === true, tv: body.watchlistSyncTv === true });
        }
        const flags = seerrSyncFlags.get(id) ?? { movies: false, tv: false };
        return json(res, 200, {
          username: `Stub User ${id}`,
          locale: 'en',
          discoverRegion: 'US',
          streamingRegion: 'US',
          watchlistSyncMovies: flags.movies,
          watchlistSyncTv: flags.tv,
        });
      }
      const seerrSonarr = { id: 0, name: 'Stub Sonarr', is4k: false, isDefault: true, tags: [1], animeTags: seerrAnimeTags };
      if (path === '/settings/sonarr' && method === 'GET') return json(res, 200, [seerrSonarr]);
      if (path === '/settings/sonarr/0' && method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as { animeTags?: number[] };
        seerrAnimeTags = Array.isArray(body.animeTags) ? body.animeTags : [];
        return json(res, 200, { ...seerrSonarr, animeTags: seerrAnimeTags });
      }
      // ADR-097 / DESIGN-052 D-27 — the exclusion lists (paged GET, POST), plus a read of both for specs.
      if (url.pathname === '/_stub/import-list-exclusions') return json(res, 200, importListExclusions);
      const exclusionKind =
        path === '/exclusions' || path === '/exclusions/paged'
          ? 'radarr'
          : path === '/importlistexclusion' || path === '/importlistexclusion/paged'
            ? 'sonarr'
            : null;
      if (exclusionKind !== null && path.endsWith('/paged') && method === 'GET') {
        const list = importListExclusions[exclusionKind];
        const page = Math.max(1, Number(query.page ?? 1));
        const pageSize = Math.max(1, Number(query.pageSize ?? 10));
        const records = list.slice((page - 1) * pageSize, page * pageSize);
        return json(res, 200, { page, pageSize, totalRecords: list.length, records });
      }
      if (exclusionKind !== null && !path.endsWith('/paged') && method === 'POST') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const keyField = exclusionKind === 'radarr' ? 'tmdbId' : 'tvdbId';
        const list = importListExclusions[exclusionKind];
        if (list.some((e) => e[keyField] === body[keyField])) {
          return json(res, 400, [{ propertyName: keyField, errorMessage: 'This exclusion has already been added.' }]);
        }
        const created = { ...body, id: nextExclusionId++ };
        list.push(created);
        return json(res, 201, created);
      }
      // PLAN-015 / D-20 — stage the download queue for the Action Feedback progress derivation.
      if (url.pathname === '/_stub/repair-guide' && method === 'POST') {
        const raw = await readBody(req);
        repairGuideFixtures = raw !== '' && (JSON.parse(raw) as { on?: unknown }).on === true;
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/release-pick' && method === 'POST') {
        const raw = await readBody(req);
        releasePickFixtures = raw !== '' && (JSON.parse(raw) as { on?: unknown }).on === true;
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/release-grabs' && method === 'GET') {
        return json(res, 200, releaseGrabs);
      }
      if (url.pathname === '/_stub/remap' && method === 'POST') {
        const raw = await readBody(req);
        remapState = raw !== '' && (JSON.parse(raw) as { on?: unknown }).on === true ? remapSeasonFixture() : null;
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/remap' && method === 'GET') {
        if (!remapState) return json(res, 200, { on: false, episodes: [], files: [], orphaned: [] });
        return json(res, 200, {
          on: true,
          episodes: remapEpisodeRows(remapState),
          files: remapFileRows(remapState),
          orphaned: remapState.orphaned,
        });
      }
      if (url.pathname === '/_stub/import-check' && method === 'POST') {
        const raw = await readBody(req);
        importCheckFixtures = raw !== '' && (JSON.parse(raw) as { on?: unknown }).on === true;
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/queue' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw === '' ? {} : (JSON.parse(raw) as { records?: Record<string, unknown>[] });
        queueRecords = Array.isArray(parsed.records) ? parsed.records : [];
        res.writeHead(204);
        return res.end();
      }
      // PLAN-048 (fix/activity-robustness) — toggle the Activity-read fault (500 on /queue + /history).
      if (url.pathname === '/_stub/fault' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw === '' ? {} : (JSON.parse(raw) as { on?: boolean });
        faultReads = parsed.on !== false;
        res.writeHead(204);
        return res.end();
      }
      // When faulted, the *arr Activity reads answer 500 so the adapter degrades (per-source isolation).
      if (faultReads && method === 'GET' && (path === '/queue' || path.startsWith('/history'))) {
        return json(res, 500, { error: 'stub fault: *arr Activity read unavailable' });
      }

      if (method === 'POST' || method === 'DELETE' || method === 'PUT') {
        const raw = await readBody(req);
        const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
        calls.push({ method, path, query, body });

        // POST /history/failed/{id} — the AC-07 blocklist write. No response body.
        if (method === 'POST' && /^\/history\/failed\/\d+$/.test(path)) {
          return json(res, 200, {});
        }
        // POST /command — search trigger; echo the command name back with an id.
        if (method === 'POST' && path === '/command') {
          const name =
            typeof body === 'object' && body !== null && 'name' in body
              ? String((body as { name: unknown }).name)
              : 'UnknownCommand';
          lastCommandName = name;
          // DESIGN-055 D-07 — a ManualImport lands at once: its episodes (or movie) have a file, its download leaves.
          // D-04 — a library file of the re-map season is re-linked instead (Sonarr's library-file semantics).
          if (name === 'ManualImport') {
            const files = ((body as { files?: unknown }).files ?? []) as Array<{
              path?: string;
              episodeIds?: number[];
              movieId?: number;
              downloadId?: string;
            }>;
            const done = new Set<string>();
            for (const f of files) {
              if (remapState && remapImport(remapState, f)) continue;
              for (const id of f.episodeIds ?? []) importedEpisodeIds.add(id);
              if (typeof f.movieId === 'number') importedMovieIds.add(f.movieId);
              if (f.downloadId) done.add(f.downloadId);
            }
            queueRecords = queueRecords.filter((r) => !done.has(String(r.downloadId ?? '')));
          }
          if (name === 'RenameFiles' && remapState) {
            remapRename(remapState, ((body as { files?: unknown }).files ?? []) as number[]);
          }
          const id = nextCommandId++;
          commandLog.push({ id, name, status: 'completed' });
          return json(res, 201, { id, name });
        }
        // DESIGN-055 D-06 — the Release Pick's grab (`POST /release`), only while its fixtures are on.
        if (method === 'POST' && path === '/release' && releasePickFixtures) {
          const grab = (body ?? {}) as { guid?: unknown; episodeIds?: unknown };
          const guid = typeof grab.guid === 'string' ? grab.guid : '';
          const row = releasePickSeasonList().find((r) => r.guid === guid);
          if (!row) return json(res, 404, { message: "Couldn't find requested release in cache, try searching again" });
          if (guid === RELEASE_PICK_REFUSED_GUID) return json(res, 409, { message: 'Getting release from indexer failed' });
          releaseGrabs.push(body);
          const target = Array.isArray(grab.episodeIds) && typeof grab.episodeIds[0] === 'number'
            ? grab.episodeIds[0]
            : releasePickEpisodeIdFor(row.episodeNumbers[0]!);
          releaseGrabQueue.push(releasePickQueueRecord(guid, row.title, target, releaseGrabQueue.length + 1));
          return json(res, 200, body ?? {});
        }
        // File deletes (AC-08 fallback) — accepted, recorded.
        if (method === 'DELETE' && /^\/(episodefile|moviefile|trackfile)\/\d+$/.test(path)) {
          return json(res, 200, {});
        }
        // ADR-022 D-02 — the bulk-editor monitor flip (Ledger Add-&-search, present-but-
        // unmonitored path). Echo the updated resource list (the write client drains it).
        if (method === 'PUT' && /^\/(series|movie|artist)\/editor$/.test(path)) {
          return json(res, 200, []);
        }
        // POST /series|/movie|/artist|/tag (restore + Ledger add surface) — echo resources.
        if (method === 'POST' && path === '/tag') {
          return json(res, 201, {
            id: 99,
            label: String((body as { label?: unknown })?.label ?? ''),
          });
        }
        if (method === 'POST' && path === '/series') {
          return json(res, 201, seriesResource(9001));
        }
        if (method === 'POST' && path === '/movie') {
          return json(res, 201, movieResource(9701));
        }
        if (method === 'POST' && path === '/artist') {
          return json(res, 201, artistResource(9801));
        }
        return json(res, 404, { message: `stub-arr: no write handler for ${method} ${path}` });
      }

      // ---- MediaCover poster proxy (ADR-019 / D-14): serve the fixture PNG for any variant.
      // Matches radarr/sonarr `/mediacover/{id}/poster-250.jpg` + lidarr `/mediacover/artist/{id}/…`.
      if (method === 'GET' && /^\/mediacover\//.test(path)) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(POSTER_PNG);
      }

      // ---- GET /movie/{id} — the radarr fix flow's pre-read before its delete fallback
      // (getMovieById → movieFileId). PLAN-015's movie-fix journey is the first spec to
      // exercise a non-subtitle movie Fix, so this by-id read joined late.
      if (method === 'GET') {
        const movieById = /^\/movie\/(\d+)$/.exec(path);
        if (movieById) {
          const id = Number(movieById[1]);
          // ADR-093 / DESIGN-052 D-14 — after a stub Maintainerr delete the movie is gone (404).
          if (id === STUB_MOVIE_ID && stubArrDeleted.tmdb.has(STUB_MOVIE_TMDB_ID)) {
            return json(res, 404, { message: `stub-arr: movie ${id} was deleted` });
          }
          if (id === STUB_MOVIE_ID) return json(res, 200, movieResource(STUB_MOVIE_ID));
          if (id === STUB_VANISHED_ID && stubArrDeleted.tmdb.has(STUB_VANISHED_TMDB_ID)) {
            return json(res, 404, { message: `stub-arr: movie ${id} was deleted` });
          }
          if (id === STUB_VANISHED_ID) {
            return json(res, 200, { ...vanishedMovieResource(), ...(importedMovieIds.has(id) ? { hasFile: true } : {}) });
          }
          return json(res, 404, { message: `stub-arr: no movie ${id}` });
        }
        // DESIGN-055 D-07 — the queue-aware Force Search reads its ManualImport back: every command has finished.
        const commandById = /^\/command\/(\d+)$/.exec(path);
        if (commandById) {
          const logged = commandLog.find((c) => c.id === Number(commandById[1]));
          return json(res, 200, { id: Number(commandById[1]), name: logged?.name ?? lastCommandName, status: 'completed' });
        }
        // DESIGN-055 D-04 rule 11 — the *arr's commands (the re-map refuses while a move or rename is still running).
        if (path === '/command') return json(res, 200, commandLog);
        // DESIGN-055 D-07 — the *arr's manual-import view of one download (Sonarr and Radarr share the path); D-04 — or
        // of a season's library files.
        if (path === '/manualimport') {
          if (remapState && Number(query.seriesId) === STUB_SERIES_ID && Number(query.seasonNumber) === REMAP_SEASON) {
            return json(res, 200, remapCandidates(remapState));
          }
          return json(res, 200, importCheckFixtures ? importCheckCandidates(String(query.downloadId ?? '')) : []);
        }
        // DESIGN-055 D-04 rule 8 — Sonarr's rename preview: the season's files whose name is stale.
        if (path === '/rename') {
          if (!remapState || Number(query.seriesId) !== STUB_SERIES_ID || Number(query.seasonNumber) !== REMAP_SEASON) {
            return json(res, 200, []);
          }
          const state = remapState;
          return json(
            res,
            200,
            [...state.files.values()]
              .filter((f) => f.relativePath !== remapExpectedName(state, f))
              .map((f) => ({
                seriesId: STUB_SERIES_ID,
                seasonNumber: REMAP_SEASON,
                episodeNumbers: remapEpisodesOf(state, f.id),
                episodeFileId: f.id,
                existingPath: f.relativePath,
                newPath: remapExpectedName(state, f),
              })),
          );
        }
        // DESIGN-055 D-05 — the Title Check's import history (`downloadFolderImported` since a date).
        if (path === '/history/since') {
          return json(res, 200, remapState ? remapImportHistory(remapState) : []);
        }
        const seriesById = /^\/series\/(\d+)$/.exec(path);
        if (seriesById) {
          const id = Number(seriesById[1]);
          if (id === STUB_SERIES_ID && !stubArrDeleted.tvdb.has(STUB_SERIES_TVDB_ID)) {
            return json(res, 200, seriesResource(STUB_SERIES_ID));
          }
          return json(res, 404, { message: `stub-arr: no series ${id}` });
        }
      }

      // ---- reads ----
      switch (path) {
        case '/system/status':
          return json(res, 200, { appName: 'StubArr', version: '0.0.0-e2e' });
        case '/series':
          return json(res, 200, [seriesResource(STUB_SERIES_ID)]);
        case '/movie':
          // The Fixture (monitored, on disk) + Vanished Heist (unmonitored, fileless) — the
          // skip and monitor-flip halves of the Ledger bulk action's outcome matrix.
          return json(res, 200, [movieResource(STUB_MOVIE_ID), vanishedMovieResource()]);
        case '/collection':
          // DESIGN-044 D-05 (owner poster + caught-em-all redesign) — one TMDb franchise (id 990001) with two
          // films: The Fixture (tmdbId 880001, HELD in the seeded ledger → its tile renders the /api/posters
          // proxy) and a Sequel the estate does NOT hold (MISSING → the collection member's provider image).
          return json(res, 200, [
            {
              id: 5001,
              title: 'The Fixture Collection',
              tmdbId: 990001,
              movies: [
                {
                  tmdbId: STUB_MOVIE_TMDB_ID,
                  title: 'The Fixture',
                  images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/t/p/original/fixture.jpg' }],
                },
                {
                  tmdbId: 880002,
                  title: 'The Fixture II: Reticketed',
                  images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/t/p/original/fixture2.jpg' }],
                },
              ],
            },
          ]);
        case '/artist':
          return json(res, 200, []);
        // DESIGN-008 D-05 — the /lookup endpoints (tombstoned-row metadata, no add).
        case '/movie/lookup':
          return json(res, 200, [
            {
              title: 'The Fixture',
              year: 2022,
              tmdbId: STUB_MOVIE_TMDB_ID,
              imdbId: 'tt8800010',
              remotePoster: 'https://image.tmdb.org/t/p/original/lookup.jpg',
              // DESIGN-044 D-04/D-05 — the movie's TMDb franchise, so the "movie franchise" ref search yields a
              // pickable franchise (id 990001, previewed via the /collection handler above).
              collection: { title: 'The Fixture Collection', tmdbId: 990001 },
              ...RADARR_META,
            },
          ]);
        case '/series/lookup':
          return json(res, 200, [
            {
              title: 'Breaking Prod',
              year: 2019,
              tvdbId: STUB_SERIES_TVDB_ID,
              remotePoster: 'https://artworks.thetvdb.com/x/lookup.jpg',
              ...SONARR_META,
            },
          ]);
        case '/artist/lookup':
          return json(res, 200, [
            {
              artistName: 'The Stub Band',
              foreignArtistId: '11111111-2222-3333-4444-555555550701',
              genres: ['Rock'],
              ratings: { value: 7.0, votes: 3 },
            },
          ]);
        case '/episode': {
          if (Number(query.seriesId) !== STUB_SERIES_ID) return json(res, 200, []);
          // DESIGN-055 D-07 — Case B's title while the import-check fixtures are on; a ManualImport's episodes have a file.
          return json(
            res,
            200,
            [
              ...episodes().map((e) => ({
                ...e,
                ...(importCheckFixtures && e.id === IMPORT_CHECK_EPISODE_ID ? { title: IMPORT_CHECK_EPISODE_TITLE } : {}),
                ...(importedEpisodeIds.has(e.id) ? { hasFile: true } : {}),
              })),
              // D-04 — the re-map season, while its fixtures are on.
              ...(remapState ? remapEpisodeRows(remapState) : []),
              // DESIGN-055 D-06 — the Release Pick season, while its fixtures are on.
              ...(releasePickFixtures ? releasePickEpisodeRows() : []),
            ],
          );
        }
        case '/episodefile': {
          // DESIGN-008 D-02 resolution fix — one file per on-disk episode, each carrying the
          // normalized `quality.quality.resolution` int the harvest derives the dominant tier
          // from (all 1080 → '1080p' for the stub series).
          if (Number(query.seriesId) !== STUB_SERIES_ID) return json(res, 200, []);
          const files = episodes()
            .filter((e) => e.hasFile)
            .map((e) => ({
              id: e.episodeFileId,
              seriesId: STUB_SERIES_ID,
              quality: { quality: { id: 4, name: 'WEBDL-1080p', resolution: 1080 } },
              // ADR-093 / DESIGN-052 D-11 — the identity fields the Release Block records before a delete.
              seasonNumber: e.seasonNumber,
              relativePath: `Season ${e.seasonNumber}/Breaking Prod - S0${e.seasonNumber}E${String(e.episodeNumber).padStart(2, '0')} [WEBDL-1080p]-STUB.mkv`,
              sceneName: `Breaking.Prod.S0${e.seasonNumber}E${String(e.episodeNumber).padStart(2, '0')}.1080p.WEB-DL.DDP5.1.H.264-STUB`,
              releaseGroup: 'STUB',
              size: 1_073_741_824,
            }));
          return json(res, 200, [
            ...files,
            ...(remapState ? remapFileRows(remapState) : []),
            ...(releasePickFixtures ? releasePickFileRows() : []),
          ]);
        }
        case '/release': {
          // ADR-109 / DESIGN-055 D-09 — the interactive release list, only while the repair-guide fixtures are on.
          if (repairGuideFixtures && isSameReleaseMovie(Number(query.movieId))) {
            return json(res, 200, sameReleaseList());
          }
          // DESIGN-055 D-06 — the Release Pick's Sonarr season list.
          if (
            releasePickFixtures &&
            Number(query.seriesId) === STUB_SERIES_ID &&
            Number(query.seasonNumber) === RELEASE_PICK_SEASON
          ) {
            return json(res, 200, releasePickSeasonList());
          }
          return json(res, 200, []);
        }
        case '/moviefile': {
          if (repairGuideFixtures && isSameReleaseMovie(Number(query.movieId))) {
            return json(res, 200, [{ ...sameReleaseMovieFile(), movieId: Number(query.movieId) }]);
          }
          // ADR-093 / DESIGN-052 D-11 — The Fixture's file, with the identity the Release Block records.
          if (Number(query.movieId) !== STUB_MOVIE_ID) return json(res, 200, []);
          return json(res, 200, [
            {
              id: 9601,
              movieId: STUB_MOVIE_ID,
              relativePath: 'The Fixture (2022) {imdb-tt8800010} [WEBDL-1080p][EAC3 5.1][h264]-STUB.mkv',
              sceneName: 'The.Fixture.2022.1080p.WEB-DL.DDP5.1.H.264-STUB',
              releaseGroup: 'STUB',
              quality: { quality: { id: 4, name: 'WEBDL-1080p', resolution: 1080, source: 'web', modifier: 'none' } },
              size: 4_294_967_296,
            },
          ]);
        }
        case '/history/series':
          // ADR-109 / DESIGN-055 D-09 — the season guard's pack, only while the repair-guide fixtures are on.
          if (repairGuideFixtures && Number(query.seriesId) === STUB_SERIES_ID) {
            return json(res, 200, repairGuideSeriesHistory());
          }
          return json(res, 200, []);
        case '/album': {
          // Lidarr album picker (D-06): the seeded artist 701 has one on-disk album so its
          // detail offers Fix — used to assert Music offers no 'Missing subtitles' radio
          // (ADR-016 / D-19). Mirrors seed-ledger.ts's lidarr row.
          if (Number(query.artistId) !== STUB_ARTIST_ID) return json(res, 200, []);
          return json(res, 200, [
            {
              id: STUB_ALBUM_ID,
              artistId: STUB_ARTIST_ID,
              foreignAlbumId: '11111111-2222-3333-4444-666666660701',
              title: 'Stub Sessions',
              albumType: 'Album',
              monitored: true,
              anyReleaseOk: true,
              releaseDate: '2020-01-01T00:00:00Z',
              statistics: {
                trackFileCount: 10,
                trackCount: 10,
                totalTrackCount: 10,
                sizeOnDisk: 1_073_741_824,
              },
            },
          ]);
        }
        case '/history': {
          // STRICT: the real paged /history binds eventType to the INTEGER enum — a
          // lowercase string 400s (the fix/history-eventtype-enum prod bug). Reject any
          // non-integer eventType with the real error shape so a regression fails CI.
          if (query.eventType !== undefined && !/^\d+$/.test(query.eventType)) {
            return json(res, 400, invalidEventTypeBody(query.eventType));
          }
          // Latest-grab lookup: ?episodeId=&eventType=1 (paged envelope; 1 === grabbed).
          const episodeId = Number(query.episodeId ?? Number.NaN);
          const records =
            Number(query.eventType) === GRABBED_EVENT_TYPE && Number.isFinite(episodeId)
              ? [grabRecord(episodeId)]
              : [];
          return json(res, 200, {
            page: 1,
            pageSize: 20,
            sortKey: 'date',
            sortDirection: 'descending',
            totalRecords: records.length,
            records,
          });
        }
        case '/queue': {
          // PLAN-015 / D-20 — serve the staged queue, server-side filtered by the parent id
          // (seriesIds/movieIds/artistIds), exactly like the real *arrs (verified live 2026-07-07).
          const parentParam =
            query.seriesIds ?? query.movieIds ?? query.artistIds ?? undefined;
          const parentId = parentParam !== undefined ? Number(parentParam) : undefined;
          const served = releasePickFixtures ? [...queueRecords, ...releaseGrabQueue] : queueRecords;
          const records =
            parentId === undefined
              ? served
              : served.filter(
                  (r) =>
                    r.seriesId === parentId || r.movieId === parentId || r.artistId === parentId,
                );
          return json(res, 200, {
            page: 1,
            pageSize: 200,
            sortKey: 'timeleft',
            sortDirection: 'ascending',
            totalRecords: records.length,
            records,
          });
        }
        case '/history/movie': {
          // ADR-093 / DESIGN-052 D-20 / D-25cp — The Fixture's grab and its import, linked by `downloadId` and the
          // import's `data.fileId` (its file 9601), so the dev:local walk records the `arr_grab_history` identity (the
          // grab's release name), not only the file's scene name. Every other movie has no history.
          if (Number(query.movieId) !== STUB_MOVIE_ID) return json(res, 200, []);
          const release = 'The.Fixture.2022.1080p.WEB-DL.DDP5.1.H.264-STUB';
          const quality = { quality: { id: 4, name: 'WEBDL-1080p', resolution: 1080 } };
          return json(res, 200, [
            {
              id: 96011,
              movieId: STUB_MOVIE_ID,
              eventType: 'grabbed',
              date: '2026-01-01T00:00:00Z',
              sourceTitle: release,
              downloadId: 'STUBDL9601',
              quality,
              data: { releaseGroup: 'STUB', indexer: 'Stub Indexer (Prowlarr)' },
            },
            {
              id: 96012,
              movieId: STUB_MOVIE_ID,
              eventType: 'downloadFolderImported',
              date: '2026-01-01T01:00:00Z',
              sourceTitle: release,
              downloadId: 'STUBDL9601',
              quality,
              data: {
                fileId: '9601',
                importedPath: '/data/haynestower/Media/Movies/The Fixture/The Fixture (2022) {imdb-tt8800010} [WEBDL-1080p][EAC3 5.1][h264]-STUB.mkv',
                releaseGroup: 'STUB',
              },
            },
          ]);
        }
        case '/qualityprofile':
          return json(res, 200, [
            { id: 7, name: 'HD-1080p' },
            { id: 1, name: 'Any' },
          ]);
        case '/metadataprofile':
          return json(res, 200, [{ id: 1, name: 'Standard' }]);
        case '/rootfolder':
          // One stub stands in for all three *arrs, so it advertises every seeded root —
          // the Ledger add path validates the recorded root against this list.
          return json(res, 200, [
            { id: 1, path: '/data/haynestower/Media/TV Shows' },
            { id: 2, path: '/data/haynestower/Media/Movies' },
            { id: 3, path: '/data/media/music' },
          ]);
        case '/diskspace':
          // ADR-030 / DESIGN-013 (PLAN-013) — the utilization source of record. One stub serves all
          // three *arrs, so it advertises BOTH physical media arrays (the domain's getUtilization picks
          // each array's disk by path): the HaynesTower NFS array at ~78.8% used (the owner's
          // cross-check number) and the CephFS music pool at ~25.4%, live-shaped 2026-07-07.
          return json(res, 200, [
            {
              path: '/data/haynestower',
              label: 'haynestower',
              freeSpace: 112_430_400_000_000,
              totalSpace: 529_960_000_000_000,
            },
            {
              path: '/data/cephfs-hdd',
              label: 'cephfs',
              freeSpace: 130_450_000_000_000,
              totalSpace: 174_840_000_000_000,
            },
          ]);
        case '/tag':
          return json(res, 200, [{ id: 1, label: 'mediarequests' }]);
        case '/config/downloadclient':
          // DESIGN-005 D-25 / ADR-098 — Redownload Failed off, so a Fix sends its own one search.
          return json(res, 200, { autoRedownloadFailed: false, autoRedownloadFailedFromInteractiveSearch: true });
        case '/trackfile':
          return json(res, 200, []);
        default:
          return json(res, 404, { message: `stub-arr: no read handler for GET ${path}` });
      }
    })().catch((err: unknown) => {
      json(res, 500, { message: `stub-arr error: ${String(err)}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-arr failed to bind a port');
  }
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
