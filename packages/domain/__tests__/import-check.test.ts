// ADR-109 C-05 / DESIGN-055 D-07 (PLAN-077 P2) — the Import Check, pure. The motivating cases (Case B: The Paper 2x06,
// issue #597's T.O.T.S. and Penguins) and the live Sonarr and Radarr queues of 2026-10-12 (packages/arr/__fixtures__:
// a Rugrats 2021 release Sonarr put on the 1991 series, a Franklin 2025 release on the 1997 one, A Woman of Substance,
// Aqua Teen's sample-indeterminate file, TurkSeeD's Spider-Man that is not an upgrade).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  radarrManualImportCandidateSchema,
  sonarrManualImportCandidateSchema,
  type RadarrManualImportCandidate,
  type SonarrManualImportCandidate,
} from '@hnet/arr';
import {
  checkRadarrImport,
  checkSonarrImport,
  checkSonarrImportOnto,
  hasIdentityRejection,
  importCheckReasonText,
  queueTexts,
  type SonarrImportCheckInput,
  type TitleEvidenceEpisode,
} from '../src/index';

const arrFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../arr/__fixtures__/${name}.json`, import.meta.url), 'utf8'));
const seasons = JSON.parse(
  readFileSync(new URL('./fixtures/title-evidence-seasons.json', import.meta.url), 'utf8'),
) as Record<string, { seriesId: number; season: number; episodes: TitleEvidenceEpisode[] }>;
const sonarrCandidates = (name: string): SonarrManualImportCandidate[] =>
  (arrFixture(name) as unknown[]).map((c) => sonarrManualImportCandidateSchema.parse(c));
const radarrCandidates = (name: string): RadarrManualImportCandidate[] =>
  (arrFixture(name) as unknown[]).map((c) => radarrManualImportCandidateSchema.parse(c));

const QUALITY = { quality: { id: 19, name: 'WEBDL-2160p', source: 'web', resolution: 2160 }, revision: { version: 1, real: 0, isRepack: false } };
const ENGLISH = [{ id: 1, name: 'English' }];
const MATCHED_BY_ID =
  'Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible. See the FAQ for details.';

/** A Sonarr candidate as the manual-import view returns it. */
function candidate(o: {
  file: string;
  seriesId: number;
  episodes: Array<{ id: number; seasonNumber: number; episodeNumber: number }>;
  rejections?: Array<{ reason: string; type?: string }>;
  downloadId?: string;
}): SonarrManualImportCandidate {
  return sonarrManualImportCandidateSchema.parse({
    path: `/data/haynestower/usenet/complete-k8s/tv/${o.file.replace(/\.mkv$/, '')}/${o.file}`,
    relativePath: o.file,
    folderName: o.file.replace(/\.mkv$/, ''),
    name: o.file.replace(/\.mkv$/, ''),
    size: 2_800_000_000,
    series: { id: o.seriesId, title: 'x', year: null },
    seasonNumber: o.episodes[0]?.seasonNumber ?? null,
    episodes: o.episodes.map((e) => ({ ...e, seriesId: o.seriesId, title: null, hasFile: false })),
    releaseGroup: 'FLUX',
    quality: QUALITY,
    languages: ENGLISH,
    indexerFlags: 0,
    releaseType: 'singleEpisode',
    downloadId: o.downloadId ?? 'dl-1',
    customFormatScore: 0,
    rejections: (o.rejections ?? []).map((r) => ({ reason: r.reason, type: r.type ?? 'permanent' })),
  });
}

function sonarrInput(o: Partial<SonarrImportCheckInput> & Pick<SonarrImportCheckInput, 'candidates' | 'episodes' | 'seriesId'>): SonarrImportCheckInput {
  return {
    downloadId: 'dl-1',
    seriesYear: null,
    targetEpisodeIds: [],
    mode: 'target',
    recordEpisodeIds: [],
    releaseTitle: null,
    queueMessages: [MATCHED_BY_ID],
    ...o,
  };
}

const paper = seasons['The Paper (2025) S2']!;
const lostTapes = seasons['Regular Show: The Lost Tapes S1']!;
const penguins = seasons['The Penguins of Madagascar S1']!;
const tots = seasons['Tiny Ones Transport Service S1']!;

describe('Case B: The Paper (2025) 2x06 (Seerr issue 3, issue #597 Part 1)', () => {
  const file = 'The_Paper_2025_S02E06_125_Years_Young_2160p_PCOK_WEB-DL_DDP5_1_Atmos_DV_HDR_H_265-FLUX.mkv';
  const folderRejection = {
    reason: 'Episodes 2x07, 2x08, 2x09, 2x10 were unexpected considering the The_Paper_2025_S02E06_125_Years_Young folder name',
  };

  it('is importable onto 2x06: the folder-name rejection is overruled and the title agrees', () => {
    const check = checkSonarrImport(
      sonarrInput({
        seriesId: 864,
        seriesYear: 2025,
        targetEpisodeIds: [85215],
        recordEpisodeIds: [85215],
        queueMessages: [folderRejection.reason],
        episodes: paper.episodes,
        candidates: [
          candidate({ file, seriesId: 864, episodes: [{ id: 85215, seasonNumber: 2, episodeNumber: 6 }], rejections: [folderRejection] }),
        ],
      }),
    );
    expect(check).toMatchObject({ verdict: 'importable', reason: 'ok', title: { verdict: 'agrees' } });
    // Exactly the UI's fields, the candidate's quality and languages echoed back.
    expect(check.files).toEqual([
      {
        path: expect.stringContaining(file),
        folderName: file.replace(/\.mkv$/, ''),
        seriesId: 864,
        episodeIds: [85215],
        releaseGroup: 'FLUX',
        quality: QUALITY,
        languages: ENGLISH,
        indexerFlags: 0,
        releaseType: 'singleEpisode',
        downloadId: 'dl-1',
      },
    ]);
    expect(check.file).toMatchObject({ fileName: file, targetIds: [85215], qualityName: 'WEBDL-2160p' });
  });

  it('the queue says 2x06 and the manual-import view says 2x07: the title picks 2x06', () => {
    const check = checkSonarrImport(
      sonarrInput({
        seriesId: 864,
        seriesYear: 2025,
        targetEpisodeIds: [85215],
        recordEpisodeIds: [85215],
        episodes: paper.episodes,
        candidates: [candidate({ file, seriesId: 864, episodes: [{ id: 85216, seasonNumber: 2, episodeNumber: 7 }] })],
      }),
    );
    expect(check.verdict).toBe('importable');
    expect(check.files[0]!.episodeIds).toEqual([85215]);
  });
});

describe('issue #597: matched by ID', () => {
  it('T.O.T.S.: a file the queue could not name, mapped and titled right, is importable', () => {
    const check = checkSonarrImport(
      sonarrInput({
        seriesId: tots.seriesId,
        seriesYear: 2019,
        targetEpisodeIds: [68385],
        recordEpisodeIds: [68385],
        episodes: tots.episodes,
        candidates: [
          candidate({
            file: 'T.O.T.S.S01E03.Panda.Excess.1080p.DSNP.WEB-DL.DDP5.1.H.264-LAZY.mkv',
            seriesId: tots.seriesId,
            episodes: [{ id: 68385, seasonNumber: 1, episodeNumber: 3 }],
            rejections: [{ reason: MATCHED_BY_ID }],
          }),
        ],
      }),
    );
    expect(check).toMatchObject({ verdict: 'importable', title: { verdict: 'agrees' } });
  });

  it('Penguins of Madagascar: a Spanish-titled MULTI file is a title mismatch, never imported', () => {
    const check = checkSonarrImport(
      sonarrInput({
        seriesId: penguins.seriesId,
        seriesYear: 2008,
        targetEpisodeIds: [85297],
        recordEpisodeIds: [85297],
        episodes: penguins.episodes,
        candidates: [
          candidate({
            file: 'Los.Pinguinos.de.Madagascar.S01E24.Cuajito.Estrellas.de.Television.MULTI.1080p.WEB-DL.AAC2.0.x264-AndreMor.mkv',
            seriesId: penguins.seriesId,
            episodes: [{ id: 85297, seasonNumber: 1, episodeNumber: 24 }],
          }),
        ],
      }),
    );
    expect(check).toMatchObject({ verdict: 'title_mismatch', reason: 'title_ambiguous', files: [] });
  });

  it('the live Rugrats (2021) release Sonarr put on the 1991 series is a mismatch (another year)', () => {
    const rugrats = seasons['Rugrats S1']!;
    const check = checkSonarrImport(
      sonarrInput({
        seriesId: 599,
        seriesYear: 1991,
        mode: 'download',
        targetEpisodeIds: [53626],
        recordEpisodeIds: [53626],
        episodes: rugrats.episodes,
        candidates: sonarrCandidates('sonarr.manualimport-rugrats-2021-e07'),
      }),
    );
    expect(check).toMatchObject({ verdict: 'title_mismatch', reason: 'year_conflict', title: { conflictingYear: 2021 } });
    expect(importCheckReasonText(check)).toMatch(/^Import Check: Release names another year: 2021/);
  });

  it('the live Franklin (2025) release on the 1997 series: a silent title does not save it', () => {
    const franklin = seasons['Franklin S1']!;
    const check = checkSonarrImport(
      sonarrInput({
        seriesId: 267,
        seriesYear: 1997,
        targetEpisodeIds: [23623],
        recordEpisodeIds: [23623],
        episodes: franklin.episodes,
        candidates: sonarrCandidates('sonarr.manualimport-franklin-2025-e05'),
      }),
    );
    expect(check).toMatchObject({ verdict: 'title_mismatch', reason: 'year_conflict' });
  });

  it('the live A Woman of Substance remux (no rejection, "Episode 3") is importable in download mode', () => {
    const check = checkSonarrImport(
      sonarrInput({
        downloadId: '8a449d45-b4c0-4b0a-80f2-7c28ddb95c5a',
        seriesId: 29,
        seriesYear: 2026,
        mode: 'download',
        targetEpisodeIds: [1305],
        recordEpisodeIds: [1305],
        episodes: [
          { id: 1303, seasonNumber: 1, episodeNumber: 1, title: 'Episode 1' },
          { id: 1304, seasonNumber: 1, episodeNumber: 2, title: 'Episode 2' },
          { id: 1305, seasonNumber: 1, episodeNumber: 3, title: 'Episode 3' },
        ],
        candidates: sonarrCandidates('sonarr.manualimport-woman-of-substance-e03'),
      }),
    );
    expect(check.verdict).toBe('importable');
    expect(check.files).toHaveLength(1);
    expect(check.files[0]).toMatchObject({ seriesId: 29, episodeIds: [1305], releaseGroup: 'HD', releaseType: 'singleEpisode' });
  });
});

describe('Case A: a file named for another episode (disagrees) and "Import this download onto..."', () => {
  const lostTapesInput = (): SonarrImportCheckInput =>
    sonarrInput({
      seriesId: lostTapes.seriesId,
      seriesYear: 2026,
      targetEpisodeIds: [118406],
      recordEpisodeIds: [118406],
      episodes: lostTapes.episodes,
      candidates: [
        candidate({
          file: 'Regular.Show.The.Lost.Tapes.S01E10.Spice.It.Up.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX.mkv',
          seriesId: lostTapes.seriesId,
          episodes: [{ id: 118406, seasonNumber: 1, episodeNumber: 10 }],
          rejections: [{ reason: MATCHED_BY_ID }],
        }),
      ],
    });

  it('the E10 file titled "Spice It Up" disagrees and names E11', () => {
    const check = checkSonarrImport(lostTapesInput());
    expect(check).toMatchObject({ verdict: 'title_mismatch', reason: 'title_disagrees', title: { bestEpisodeId: 118407 } });
    expect(check.files).toEqual([]);
  });

  it('onto the episode the title names, or the grab target; anything else is refused', () => {
    const onto = checkSonarrImportOnto(lostTapesInput(), 118407);
    expect(onto.verdict).toBe('importable');
    expect(onto.files[0]!.episodeIds).toEqual([118407]);
    expect(checkSonarrImportOnto(lostTapesInput(), 118406).files[0]!.episodeIds).toEqual([118406]);
    expect(checkSonarrImportOnto(lostTapesInput(), 118408)).toMatchObject({ verdict: 'not_importable', files: [] });
  });
});

describe('what is never imported', () => {
  const ep = { id: 85215, seasonNumber: 2, episodeNumber: 6 };
  const base = (o: Partial<SonarrImportCheckInput>) =>
    checkSonarrImport(
      sonarrInput({ seriesId: 864, seriesYear: 2025, targetEpisodeIds: [85215], recordEpisodeIds: [85215], episodes: paper.episodes, ...o, candidates: o.candidates ?? [] }),
    );
  const goodFile = 'The.Paper.2025.S02E06.125.Years.Young.1080p.WEB.mkv';

  it('a packed download is report only (DESIGN-046 D-26), from the queue or a candidate', () => {
    expect(base({ queueMessages: ['Found archive file, might need to be extracted'] }).verdict).toBe('archive');
    expect(
      base({
        candidates: [candidate({ file: goodFile, seriesId: 864, episodes: [ep], rejections: [{ reason: 'Found archive file, might need to be extracted' }] })],
      }).verdict,
    ).toBe('archive');
  });

  it('no candidate at all is for staff (it may still be packed), never a removal', () => {
    expect(base({ candidates: [] })).toMatchObject({ verdict: 'not_importable', reason: 'no_files' });
  });

  it('a sample beside the real file is ignored; a sample alone is a release defect', () => {
    const sample = candidate({ file: 'sample-the.paper.s02e06.mkv', seriesId: 864, episodes: [ep], rejections: [{ reason: 'Sample' }] });
    const real = candidate({ file: goodFile, seriesId: 864, episodes: [ep] });
    expect(base({ candidates: [sample, real] }).verdict).toBe('importable');
    expect(base({ candidates: [sample] })).toMatchObject({ verdict: 'release_defect', reason: 'only_sample' });
  });

  it('a password or unparseable rejection is a release defect', () => {
    expect(
      base({ candidates: [candidate({ file: goodFile, seriesId: 864, episodes: [ep], rejections: [{ reason: 'Password protected' }] })] }),
    ).toMatchObject({ verdict: 'release_defect', reason: 'defect', detail: 'Password protected' });
  });

  it("the live Aqua Teen file Sonarr cannot tell from a sample stays with staff, with Sonarr's words", () => {
    const aqua = seasons['Aqua Teen Hunger Force S5']!;
    const check = checkSonarrImport(
      sonarrInput({
        seriesId: 64,
        seriesYear: 2000,
        targetEpisodeIds: [4867],
        recordEpisodeIds: [4867],
        episodes: aqua.episodes,
        queueMessages: ['Unable to determine if file is a sample'],
        candidates: sonarrCandidates('sonarr.manualimport-aqua-teen-s05e05'),
      }),
    );
    expect(check).toMatchObject({ verdict: 'not_importable', reason: 'rejected', detail: 'Unable to determine if file is a sample' });
  });

  it('a temporary rejection, a file of another series, two files for one episode', () => {
    expect(
      base({ candidates: [candidate({ file: goodFile, seriesId: 864, episodes: [ep], rejections: [{ reason: 'Locked', type: 'temporary' }] })] }),
    ).toMatchObject({ verdict: 'not_importable', reason: 'temporary' });
    expect(base({ candidates: [candidate({ file: goodFile, seriesId: 999, episodes: [ep] })] })).toMatchObject({
      verdict: 'not_importable',
      reason: 'other_series',
    });
    expect(
      base({ candidates: [candidate({ file: goodFile, seriesId: 864, episodes: [ep] }), candidate({ file: 'x.' + goodFile, seriesId: 864, episodes: [ep] })] }),
    ).toMatchObject({ verdict: 'not_importable', reason: 'several_files' });
  });

  it('download mode: every file must pass and every tracked episode must be covered', () => {
    const e5 = { id: 85214, seasonNumber: 2, episodeNumber: 5 };
    const dueling = candidate({ file: 'The.Paper.2025.S02E05.Dueling.Pencils.1080p.WEB.mkv', seriesId: 864, episodes: [e5] });
    const young = candidate({ file: goodFile, seriesId: 864, episodes: [ep] });
    const pack = (cands: SonarrManualImportCandidate[], records: number[]) =>
      base({ mode: 'download', targetEpisodeIds: records, recordEpisodeIds: records, candidates: cands });
    const both = pack([dueling, young], [85214, 85215]);
    expect(both.verdict).toBe('importable');
    expect(both.files.map((f) => f.episodeIds)).toEqual([[85214], [85215]]);
    expect(pack([young], [85214, 85215])).toMatchObject({ verdict: 'not_importable', reason: 'uncovered_targets' });
  });
});

describe('Radarr (movie Title Evidence)', () => {
  const movie = arrFixture('radarr.movie-9428') as {
    id: number;
    title: string;
    originalTitle: string;
    year: number;
    alternateTitles: Array<{ title: string }>;
  };

  it("the live TurkSeeD Spider-Man is not an upgrade: staff, with Radarr's words", () => {
    const check = checkRadarrImport({
      downloadId: '59d2ffec-f4ae-4164-a8b4-3b69a95210a8',
      movie,
      releaseTitle: null,
      queueMessages: ['Found matching movie via grab history, but release was matched to movie by ID. Manual Import required.'],
      candidates: radarrCandidates('radarr.manualimport-spider-man-turkseed'),
    });
    expect(check).toMatchObject({ verdict: 'not_importable', reason: 'have_better', title: { verdict: 'agrees' } });
  });

  it('the same file, the movie missing: importable onto the movie with the UI fields', () => {
    const [c] = radarrCandidates('radarr.manualimport-spider-man-turkseed');
    const check = checkRadarrImport({
      downloadId: 'dl-r',
      movie,
      releaseTitle: null,
      queueMessages: [],
      candidates: [{ ...c!, rejections: [{ reason: 'Found matching movie via grab history, but release was matched to movie by ID. Manual Import required.', type: 'permanent' }] }],
    });
    expect(check.verdict).toBe('importable');
    expect(Object.keys(check.files[0]!).sort()).toEqual(
      ['downloadId', 'folderName', 'indexerFlags', 'languages', 'movieId', 'path', 'quality'].sort(),
    );
  });

  it("issue #597's Alatriste grabbed for A Movie of Eggs is a title mismatch", () => {
    const [c] = radarrCandidates('radarr.manualimport-spider-man-turkseed');
    const check = checkRadarrImport({
      downloadId: 'dl-a',
      movie: { id: 501, title: 'A Movie of Eggs', year: 2006 },
      releaseTitle: 'Alatriste.2006.1080p.BluRay.x264',
      queueMessages: [],
      candidates: [{ ...c!, movie: { id: 501, title: 'A Movie of Eggs', year: 2006 }, name: 'Alatriste.2006.1080p.BluRay.x264', path: '/m/Alatriste.2006.1080p.BluRay.x264/Alatriste.2006.1080p.BluRay.x264.mkv', rejections: [] }],
    });
    expect(check).toMatchObject({ verdict: 'title_mismatch', reason: 'title_ambiguous' });
  });
});

describe('queue texts', () => {
  it('collects every message and spots the identity rejections', () => {
    const records = arrFixture('sonarr.queue-blocked') as Parameters<typeof queueTexts>[0];
    const texts = queueTexts(records);
    expect(texts.length).toBeGreaterThan(0);
    expect(hasIdentityRejection([MATCHED_BY_ID])).toBe(true);
    expect(hasIdentityRejection(['Unable to determine if file is a sample'])).toBe(false);
  });
});
