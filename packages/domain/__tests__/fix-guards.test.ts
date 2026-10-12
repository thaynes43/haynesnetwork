// ADR-109 C-03 / DESIGN-055 D-08, D-09 (PLAN-077 P1) — the Fix guards, pure. The Replacement Preview cases are the
// live reads of 2026-10-12 (packages/arr/__fixtures__): GoodFellas (Case C), whose only acceptable replacement is its own
// FraMeSToR remux again, and The Lost Tapes S01.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { arrReleaseHistoryRecordSchema, arrReleaseSchema, radarrMovieFileSchema, type ArrRelease } from '@hnet/arr';
import {
  audioLanguageName,
  backingDownloads,
  checkReplacement,
  fileHasLanguage,
  isExistingFileRejection,
  latestGrabsByEpisode,
  normalizeReleaseName,
  packCost,
  parseAudioLanguages,
  releaseCoversEpisode,
  replacementCandidate,
  sameReleaseBasis,
  sizeMatches,
  splitSeasonByDownload,
  type CurrentFileIdentity,
} from '../src/fix-guards';

const arrFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../arr/__fixtures__/${name}.json`, import.meta.url), 'utf8'));

const goodfellasReleases = (arrFixture('radarr.release-goodfellas') as unknown[]).map((r) => arrReleaseSchema.parse(r));
const [goodfellasFile] = (arrFixture('radarr.moviefile-goodfellas') as unknown[]).map((f) => radarrMovieFileSchema.parse(f));

/** GoodFellas' file as the Same Release test sees it (no scene name: Radarr kept none). */
const goodfellas: CurrentFileIdentity = {
  fileName: goodfellasFile!.relativePath ?? null,
  sceneName: goodfellasFile!.sceneName ?? null,
  releaseName: null,
  releaseGroup: goodfellasFile!.releaseGroup ?? null,
  qualityName: goodfellasFile!.quality?.quality?.name ?? null,
  resolution: goodfellasFile!.quality?.quality?.resolution ?? null,
  revision: goodfellasFile!.quality?.revision?.version ?? null,
  edition: goodfellasFile!.edition ?? null,
  size: goodfellasFile!.size ?? null,
  customFormatScore: goodfellasFile!.customFormatScore ?? null,
};

function release(overrides: Partial<ArrRelease>): ArrRelease {
  return {
    guid: 'g',
    indexerId: 1,
    indexer: 'Indexer',
    title: 'Some.Movie.2020.1080p.WEB-DL-GRP',
    size: 10_000_000_000,
    qualityName: 'WEBDL-1080p',
    resolution: 1080,
    source: 'web',
    revision: 1,
    releaseGroup: 'GRP',
    approved: false,
    temporarilyRejected: false,
    rejections: ['Existing file on disk is of equal or higher preference: WEBDL-1080p v1'],
    customFormatScore: 100,
    languages: ['English'],
    protocol: 'usenet',
    ageHours: 10,
    edition: null,
    seasonNumber: null,
    episodeNumbers: [],
    fullSeason: false,
    ...overrides,
  };
}

const file = (overrides: Partial<CurrentFileIdentity> = {}): CurrentFileIdentity => ({
  fileName: 'Some Movie (2020) [WEBDL-1080p]-GRP.mkv',
  sceneName: null,
  releaseName: null,
  releaseGroup: 'GRP',
  qualityName: 'WEBDL-1080p',
  resolution: 1080,
  revision: 1,
  edition: null,
  size: 9_500_000_000,
  customFormatScore: 100,
  ...overrides,
});

describe('Existing-File Rejections (T-315)', () => {
  it('recognises every rejection that comes only from the file on disk', () => {
    for (const reason of [
      'Existing file on disk has a equal or higher Custom Format score: 5950',
      'Existing file on disk is of equal or higher preference: Remux-2160p v1',
      'Existing file on disk has Custom Format score within Custom Format score increment: 100',
      'Existing file meets cutoff: WEBDL-1080p',
      'Quality upgrades for existing file on disk is not allowed',
    ]) {
      expect(isExistingFileRejection(reason)).toBe(true);
    }
    for (const reason of [
      'Release is blocklisted',
      'WEBDL-1080p is not wanted in profile',
      '14.3 GB is smaller than minimum allowed 14.4 GB (for GoodFellas)',
      'Contains these ignored terms: /\\bDUAL[ ._-]BiOMA\\b/i',
      'Release in queue already meets cutoff: WEBDL-1080p',
    ]) {
      expect(isExistingFileRejection(reason)).toBe(false);
    }
  });
});

describe('the Replacement Preview (DESIGN-055 D-09, Case C)', () => {
  it('GoodFellas: every release is rejected while the file is there; the first one rejected ONLY for it is next', () => {
    expect(goodfellasReleases.every((r) => !r.approved)).toBe(true);
    const next = replacementCandidate(goodfellasReleases);
    expect(next?.guid).toBe('radarr-goodfellas-0');
    expect(next?.releaseGroup).toBe('FraMeSToR');
  });

  it('GoodFellas: that release is the Same Release (group, quality, score; the usenet post runs 14 percent over)', () => {
    const check = checkReplacement(goodfellas, goodfellasReleases);
    expect(check.verdict).toBe('same_release');
    expect(check.basis).toBe('identity');
    // The four indexers list the same remux at 89.4 to 99.5 GB for an 87.6 GB file.
    for (const r of goodfellasReleases.slice(0, 4)) expect(sizeMatches(goodfellas.size!, r.size!, r.protocol)).toBe(true);
  });

  it('a release with a hard rejection is never the replacement, even first in order', () => {
    const blocked = release({ guid: 'b', rejections: ['Release is blocklisted', 'Existing file meets cutoff: X'] });
    const next = release({ guid: 'n', releaseGroup: 'OTHER' });
    expect(replacementCandidate([blocked, next])?.guid).toBe('n');
    expect(checkReplacement(file(), [blocked, next]).verdict).toBe('ok');
  });

  it('nothing acceptable: no_replacement', () => {
    const hardOnly = goodfellasReleases.filter((r) => !r.rejections.every(isExistingFileRejection));
    expect(hardOnly.length).toBeGreaterThan(0);
    expect(checkReplacement(goodfellas, hardOnly)).toMatchObject({ verdict: 'no_replacement', candidate: null });
    expect(checkReplacement(goodfellas, [])).toMatchObject({ verdict: 'no_replacement' });
  });

  it('an approved release counts (no file-dependent rejection at all)', () => {
    expect(replacementCandidate([release({ approved: true, rejections: [] })])?.guid).toBe('g');
  });

  it('a different group, quality, edition, a PROPER, or another score is a different release', () => {
    const f = file();
    expect(sameReleaseBasis(f, release({}))).toBe('identity');
    expect(sameReleaseBasis(f, release({ releaseGroup: 'grp' }))).toBe('identity'); // case-insensitive
    expect(sameReleaseBasis(f, release({ releaseGroup: 'OTHER' }))).toBeNull();
    expect(sameReleaseBasis(f, release({ qualityName: 'Bluray-1080p' }))).toBeNull();
    expect(sameReleaseBasis(f, release({ resolution: 2160 }))).toBeNull();
    expect(sameReleaseBasis(f, release({ edition: 'Extended' }))).toBeNull();
    expect(sameReleaseBasis(f, release({ revision: 2 }))).toBeNull();
    expect(sameReleaseBasis(f, release({ customFormatScore: 50 }))).toBeNull();
    expect(sameReleaseBasis(file({ releaseGroup: null }), release({}))).toBeNull();
  });

  it('size: a torrent within 2 percent; a usenet post from 2 percent under to 20 percent over', () => {
    expect(sizeMatches(100, 101.9, 'torrent')).toBe(true);
    expect(sizeMatches(100, 103, 'torrent')).toBe(false);
    expect(sizeMatches(100, 119, 'usenet')).toBe(true);
    expect(sizeMatches(100, 121, 'usenet')).toBe(false);
    expect(sizeMatches(100, 97, 'usenet')).toBe(false);
    expect(sameReleaseBasis(file({ size: 5_000_000_000 }), release({}))).toBeNull(); // twice the size
  });

  it('name: the recorded release name equals the candidate title, however it is punctuated', () => {
    const f = file({ releaseGroup: null, sceneName: 'Some.Movie.2020.1080p.WEB-DL-GRP' });
    expect(sameReleaseBasis(f, release({ title: 'Some Movie 2020 1080p WEB DL GRP' }))).toBe('name');
    expect(normalizeReleaseName('A.B-C.mkv')).toBe('a b c');
    const viaHistory = file({ releaseGroup: null, releaseName: 'Some.Movie.2020.1080p.WEB-DL-GRP' });
    expect(sameReleaseBasis(viaHistory, release({}))).toBe('name');
  });

  it('an episode: a season pack offered for it is compared without the size test', () => {
    const pack = release({ fullSeason: true, seasonNumber: 1, size: 20_000_000_000 });
    const ep = file({ size: 500_000_000 });
    expect(releaseCoversEpisode(pack, { seasonNumber: 1, episodeNumber: 5 })).toBe(true);
    expect(releaseCoversEpisode(pack, { seasonNumber: 2, episodeNumber: 5 })).toBe(false);
    expect(checkReplacement(ep, [pack], { episodeOfPack: true }).verdict).toBe('same_release');
    expect(checkReplacement(ep, [pack]).verdict).toBe('ok'); // a movie-sized comparison would not call it the same
  });

  it('a season list: each episode gets the first release that holds it', () => {
    const e1 = release({ guid: 'e1', episodeNumbers: [1], seasonNumber: 1 });
    const e2 = release({ guid: 'e2', episodeNumbers: [2], seasonNumber: 1, releaseGroup: 'NEW' });
    const covers2 = (r: ArrRelease) => releaseCoversEpisode(r, { seasonNumber: 1, episodeNumber: 2 });
    expect(replacementCandidate([e1, e2], covers2)?.guid).toBe('e2');
  });
});

describe('the season guard (DESIGN-055 D-09)', () => {
  const history = [
    // A pack (one downloadId) behind E1..E3, then E3 was re-grabbed alone; E4 has its own; E5 none.
    { id: 10, eventType: 'grabbed', date: '2026-09-01T00:00:00Z', downloadId: 'PACK', episodeId: 1, sourceTitle: 'Show.S01.1080p-PK' },
    { id: 11, eventType: 'grabbed', date: '2026-09-01T00:00:00Z', downloadId: 'PACK', episodeId: 2, sourceTitle: 'Show.S01.1080p-PK' },
    { id: 12, eventType: 'grabbed', date: '2026-09-01T00:00:00Z', downloadId: 'PACK', episodeId: 3, sourceTitle: 'Show.S01.1080p-PK' },
    { id: 20, eventType: 'grabbed', date: '2026-09-05T00:00:00Z', downloadId: 'SOLO3', episodeId: 3, sourceTitle: 'Show.S01E03.1080p-AB' },
    { id: 30, eventType: 'grabbed', date: '2026-09-02T00:00:00Z', downloadId: 'SOLO4', episodeId: 4, sourceTitle: 'Show.S01E04.1080p-CD', data: { releaseSource: 'InteractiveSearch' } },
    { id: 31, eventType: 'downloadFolderImported', date: '2026-09-02T01:00:00Z', downloadId: 'SOLO4', episodeId: 4 },
  ].map((r) => arrReleaseHistoryRecordSchema.parse(r));
  const latest = latestGrabsByEpisode(history);
  const onDisk = [1, 2, 3, 4, 5];

  it('the latest grab per episode wins (E3 is the solo re-grab, not the pack)', () => {
    expect(latest.get(3)?.downloadId).toBe('SOLO3');
    expect(latest.get(1)?.downloadKey).toBe('dl:PACK');
    expect(latest.get(4)?.releaseSource).toBe('InteractiveSearch');
    expect(latest.has(5)).toBe(false);
  });

  it('groups on-disk episodes by download', () => {
    expect(backingDownloads(latest, onDisk).map((d) => [d.downloadId, d.episodeIds])).toEqual([
      ['PACK', [1, 2]],
      ['SOLO3', [3]],
      ['SOLO4', [4]],
    ]);
  });

  it('a pack that also backs an episode marked fine is held back; a fully chosen one is markable', () => {
    const split = splitSeasonByDownload(latest, onDisk, [1, 4, 5]);
    expect(split.markable.map((d) => d.downloadId)).toEqual(['SOLO4']);
    expect(split.heldBack).toHaveLength(1);
    expect(split.heldBack[0]).toMatchObject({ downloadId: 'PACK', chosen: [1], others: [2] });
    expect(split.noRecord).toEqual([5]);
    const all = splitSeasonByDownload(latest, onDisk, [1, 2]);
    expect(all.markable.map((d) => d.downloadId)).toEqual(['PACK']);
    expect(all.heldBack).toEqual([]);
  });

  it("an episode Fix's pack cost: the other on-disk episodes of the same download", () => {
    expect(packCost(latest, onDisk, 1)).toEqual([2]);
    expect(packCost(latest, onDisk, 3)).toEqual([]);
    expect(packCost(latest, onDisk, 5)).toEqual([]);
  });
});

describe('the language check (DESIGN-055 D-08 rules 1-2)', () => {
  it('reads the *arr media info: distinct codes in track order, undetermined dropped, aliases folded', () => {
    expect(parseAudioLanguages('por/eng')).toEqual(['por', 'eng']);
    expect(parseAudioLanguages('eng/eng/eng')).toEqual(['eng']);
    expect(parseAudioLanguages('und / FRA / fre')).toEqual(['fre']);
    expect(parseAudioLanguages('')).toEqual([]);
    expect(parseAudioLanguages(null)).toEqual([]);
  });

  it('Case A: English is in the Portuguese-first file', () => {
    expect(fileHasLanguage(parseAudioLanguages('por/eng'), 'eng')).toBe(true);
    expect(fileHasLanguage(parseAudioLanguages('por'), 'eng')).toBe(false);
    expect(fileHasLanguage(parseAudioLanguages('ger'), 'deu')).toBe(true);
  });

  it('names languages for people, unknown codes in capitals', () => {
    expect(audioLanguageName('por')).toBe('Portuguese');
    expect(audioLanguageName('FRA')).toBe('French');
    expect(audioLanguageName('xyz')).toBe('XYZ');
  });
});
