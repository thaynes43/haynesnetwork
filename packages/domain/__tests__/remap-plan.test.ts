// DESIGN-055 D-04 (PLAN-077 P4) — the Episode Re-map's plan, pure. Case A (Regular Show: The Lost Tapes S01, Seerr
// issue 4) is the fixture: the season as Sonarr held it on 2026-10-12 before the hand fix, with a BiOMA pack filed one
// slot low from "Secret Menu Item" on and a Disney+ "All You Can Fit" (E23) filed on E24.
import { describe, expect, it } from 'vitest';
import { REMAP_MAX_MOVES, buildRemapPlan, suggestRemap, type RemapEpisode, type RemapFile } from '../src/remap-plan';
import { remapRefusalText } from '../src/remap-flow';
import fixture from './fixtures/remap-lost-tapes-s01.json';

const episodes: RemapEpisode[] = fixture.episodes.map((e) => ({
  id: e.id,
  seasonNumber: e.seasonNumber,
  episodeNumber: e.episodeNumber,
  title: e.title,
  episodeFileId: e.hasFile && e.episodeFileId ? e.episodeFileId : null,
}));
const files: RemapFile[] = fixture.files.map((f) => ({
  id: f.id,
  seasonNumber: f.seasonNumber,
  relativePath: f.relativePath,
  size: f.size,
  releaseGroup: f.releaseGroup,
  qualityName: f.quality.quality.name,
  sourceName: f.sceneName,
}));
const ep = (n: number) => episodes.find((e) => e.episodeNumber === n)!;

function plan(claim: Parameters<typeof buildRemapPlan>[0]['claim'], over: Partial<Parameters<typeof buildRemapPlan>[0]> = {}) {
  return buildRemapPlan({ seasonNumber: 1, claim, episodes, files, queueBusy: false, ...over });
}

describe('buildRemapPlan: Case A', () => {
  it('shifts the BiOMA files one slot later, highest first, losing nothing', () => {
    const p = plan({ kind: 'shift', fromEpisodeNumber: 11, throughEpisodeNumber: 18, by: 1 });
    expect(p.refusal).toBeNull();
    expect(p.moves.map((m) => [m.from[0]!.episodeNumber, m.to[0]!.episodeNumber])).toEqual([
      [18, 19],
      [17, 18],
      [16, 17],
      [15, 16],
      [14, 15],
      [13, 14],
      [11, 12],
    ]);
    // Each move lands on a slot that is empty or was vacated by a move before it.
    const occupied = new Set(episodes.filter((e) => e.episodeFileId != null).map((e) => e.episodeNumber));
    for (const m of p.moves) {
      expect(occupied.has(m.to[0]!.episodeNumber)).toBe(false);
      occupied.delete(m.from[0]!.episodeNumber);
      occupied.add(m.to[0]!.episodeNumber);
    }
    // E11 and E13 are left without a file: each is offered a search.
    expect(p.vacated.map((e) => e.episodeNumber)).toEqual([11, 13]);
    expect(p.vacated[0]!.label).toBe('S01E11 · Spice It Up');
    // Seven files of one group moved by a shift: the Mislabel Block is offered.
    expect(p.mislabelGroups).toEqual([{ releaseGroup: 'BiOMA', fileCount: 7 }]);
    // BiOMA names carry no episode title: the name says nothing either way.
    expect(p.moves.every((m) => m.nameSays === null || m.nameSays.verdict === 'silent')).toBe(true);
  });

  it('moves the Disney+ file from E24 to E23, which its name agrees with', () => {
    const p = plan({ kind: 'single', fromEpisodeId: ep(24).id, toEpisodeId: ep(23).id });
    expect(p.refusal).toBeNull();
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0]!.fileName).toContain('S01E24 - All You Can Fit');
    expect(p.moves[0]!.nameSays).toMatchObject({ verdict: 'agrees', best: { episodeNumber: 23 } });
    expect(p.vacated.map((e) => e.episodeNumber)).toEqual([24]);
    // A single move never offers the Mislabel Block (D-04 rule 10: shifts only).
    expect(p.mislabelGroups).toEqual([]);
  });

  it('reads a shift with no last episode as running to the last episode with a file', () => {
    const p = plan({ kind: 'shift', fromEpisodeNumber: 11, by: 1 });
    expect(p.claim).toEqual({ kind: 'shift', fromEpisodeNumber: 11, throughEpisodeNumber: 24, by: 1 });
    expect(p.moves[0]!.from[0]!.episodeNumber).toBe(24);
  });

  it('refuses a move onto an episode that keeps its own file (no implicit displacement)', () => {
    const p = plan({ kind: 'shift', fromEpisodeNumber: 10, throughEpisodeNumber: 10, by: 1 });
    expect(p.refusal).toBe('occupied');
    expect(p.blocker?.episode.episodeNumber).toBe(11);
    expect(remapRefusalText(p)).toBe(
      'S01E11 · Spice It Up has its own file, which this would not move. Fix that episode first, or ask staff for help.',
    );
    const single = plan({ kind: 'single', fromEpisodeId: ep(24).id, toEpisodeId: ep(1).id });
    expect(single.refusal).toBe('occupied');
  });

  it('refuses the obvious mistakes', () => {
    expect(plan({ kind: 'single', fromEpisodeId: ep(12).id, toEpisodeId: ep(13).id }).refusal).toBe('nothing_to_move');
    expect(plan({ kind: 'single', fromEpisodeId: ep(24).id, toEpisodeId: ep(24).id }).refusal).toBe('same_episode');
    expect(plan({ kind: 'single', fromEpisodeId: ep(24).id, toEpisodeId: 999 }).refusal).toBe('no_such_episode');
    expect(plan({ kind: 'shift', fromEpisodeNumber: 30, throughEpisodeNumber: 35, by: 1 }).refusal).toBe('nothing_to_move');
    // E1 moved one earlier has nowhere to go.
    expect(plan({ kind: 'shift', fromEpisodeNumber: 1, throughEpisodeNumber: 1, by: -1 }).refusal).toBe('no_such_episode');
  });

  it('refuses while a download for the season is in the queue', () => {
    const p = plan({ kind: 'single', fromEpisodeId: ep(24).id, toEpisodeId: ep(23).id }, { queueBusy: true });
    expect(p.refusal).toBe('queue_busy');
    expect(p.moves).toHaveLength(1);
  });

  it('digests what the run will do, and a changed file changes it (rule 6)', () => {
    const claim = { kind: 'shift', fromEpisodeNumber: 11, throughEpisodeNumber: 18, by: 1 } as const;
    const a = plan(claim);
    expect(plan(claim).digest).toBe(a.digest);
    const changed = files.map((f) => (f.id === ep(13).episodeFileId ? { ...f, size: (f.size ?? 0) + 1 } : f));
    expect(plan(claim, { files: changed }).digest).not.toBe(a.digest);
  });
});

describe('buildRemapPlan: shapes beyond Case A', () => {
  // A small season: E1..E8, files on E2..E6, E5 and E6 held by one two-episode file.
  const eps = (fileOf: Record<number, number | null>): RemapEpisode[] =>
    Array.from({ length: 8 }, (_, i) => ({
      id: 100 + i + 1,
      seasonNumber: 5,
      episodeNumber: i + 1,
      title: `Title ${i + 1}`,
      episodeFileId: fileOf[i + 1] ?? null,
    }));
  const fs = (ids: number[]): RemapFile[] =>
    ids.map((id) => ({ id, seasonNumber: 5, relativePath: `Season 5/file-${id}.mkv`, size: id * 1000, releaseGroup: 'LAZY', qualityName: 'WEBDL-1080p', sourceName: null }));

  it('shifts one earlier lowest first', () => {
    const season = eps({ 3: 3, 4: 4, 5: 5 });
    const p = buildRemapPlan({ seasonNumber: 5, claim: { kind: 'shift', fromEpisodeNumber: 3, by: -1 }, episodes: season, files: fs([3, 4, 5]), queueBusy: false });
    expect(p.refusal).toBeNull();
    expect(p.moves.map((m) => [m.from[0]!.episodeNumber, m.to[0]!.episodeNumber])).toEqual([
      [3, 2],
      [4, 3],
      [5, 4],
    ]);
    expect(p.vacated.map((e) => e.episodeNumber)).toEqual([5]);
    expect(p.mislabelGroups).toEqual([{ releaseGroup: 'LAZY', fileCount: 3 }]);
  });

  it('moves a two-episode file as a set, and refuses to split it', () => {
    const season = eps({ 2: 2, 5: 56, 6: 56 });
    const whole = buildRemapPlan({ seasonNumber: 5, claim: { kind: 'shift', fromEpisodeNumber: 5, by: 1 }, episodes: season, files: fs([2, 56]), queueBusy: false });
    expect(whole.refusal).toBeNull();
    expect(whole.moves).toHaveLength(1);
    expect(whole.moves[0]!.to.map((e) => e.episodeNumber)).toEqual([6, 7]);
    const split = buildRemapPlan({ seasonNumber: 5, claim: { kind: 'shift', fromEpisodeNumber: 6, throughEpisodeNumber: 6, by: 1 }, episodes: season, files: fs([2, 56]), queueBusy: false });
    expect(split.refusal).toBe('split_multi');
    // A single move of a two-episode file moves both, by the offset chosen: "the file on S05E06 is really S05E07".
    const single = buildRemapPlan({ seasonNumber: 5, claim: { kind: 'single', fromEpisodeId: 106, toEpisodeId: 107 }, episodes: season, files: fs([2, 56]), queueBusy: false });
    expect(single.refusal).toBeNull();
    expect(single.moves[0]!.to.map((e) => e.episodeNumber)).toEqual([6, 7]);
    expect(single.vacated.map((e) => e.episodeNumber)).toEqual([5]);
    const two = buildRemapPlan({ seasonNumber: 5, claim: { kind: 'single', fromEpisodeId: 105, toEpisodeId: 107 }, episodes: season, files: fs([2, 56]), queueBusy: false });
    expect(two.moves[0]!.to.map((e) => e.episodeNumber)).toEqual([7, 8]);
    // Past the season's end, it has nowhere to go.
    const past = buildRemapPlan({ seasonNumber: 5, claim: { kind: 'single', fromEpisodeId: 105, toEpisodeId: 108 }, episodes: season, files: fs([2, 56]), queueBusy: false });
    expect(past.refusal).toBe('no_such_episode');
  });

  it(`caps a request at ${REMAP_MAX_MOVES} moves`, () => {
    const many: RemapEpisode[] = Array.from({ length: 45 }, (_, i) => ({ id: 1000 + i, seasonNumber: 2, episodeNumber: i + 1, title: null, episodeFileId: i < 41 ? 5000 + i : null }));
    const files41 = Array.from({ length: 41 }, (_, i) => ({ id: 5000 + i, seasonNumber: 2, relativePath: `f${i}`, size: 1, releaseGroup: null, qualityName: null, sourceName: null }));
    const p = buildRemapPlan({ seasonNumber: 2, claim: { kind: 'shift', fromEpisodeNumber: 1, by: 1 }, episodes: many, files: files41, queueBusy: false });
    expect(p.refusal).toBe('too_many');
  });
});

describe('buildRemapPlan: a file in the way that is misplaced too', () => {
  it('says the two would have to trade places (staff), not "Fix that episode first"', () => {
    const season: RemapEpisode[] = [
      { id: 1, seasonNumber: 1, episodeNumber: 8, title: 'Work Family', episodeFileId: 18 },
      { id: 2, seasonNumber: 1, episodeNumber: 9, title: 'Step Class', episodeFileId: 19 },
    ];
    const file = (id: number, name: string): RemapFile => ({ id, seasonNumber: 1, relativePath: `f${id}`, size: 1, releaseGroup: 'FUZEER', qualityName: null, sourceName: name });
    // Abbott Elementary S01E08 and E09, each file named for the other episode (the live census, 2026-10-13).
    const p = buildRemapPlan({
      seasonNumber: 1,
      claim: { kind: 'single', fromEpisodeId: 1, toEpisodeId: 2 },
      episodes: season,
      files: [
        file(18, 'Abbott.Elementary.2021.S01E08.Step.Class.1080p.HMAX.WEB-DL.DDP5.1.H.264-FUZEER'),
        file(19, 'Abbott.Elementary.2021.S01E09.Work.Family.1080p.HMAX.WEB-DL.DDP5.1.H.264-FUZEER'),
      ],
      queueBusy: false,
    });
    expect(p.refusal).toBe('occupied');
    expect(p.blocker).toMatchObject({ misplaced: true });
    expect(remapRefusalText(p)).toBe(
      'The file on S01E09 · Step Class seems to be on the wrong episode too, so the two would have to trade places. That needs staff for now.',
    );
  });
});

describe('suggestRemap (D-04 rule 2)', () => {
  it('suggests the single move Case A\'s Disney+ file names, and nothing from the silent BiOMA names', () => {
    const s = suggestRemap({ seasonNumber: 1, episodes, files });
    expect(s.flagged.map((f) => [f.on[0]!.episodeNumber, f.best.episodeNumber])).toEqual([[24, 23]]);
    expect(s.claim).toEqual({ kind: 'single', fromEpisodeId: ep(24).id, toEpisodeId: ep(23).id });
  });

  it('suggests a shift when two or more names each point one slot the same way', () => {
    const season: RemapEpisode[] = [
      { id: 1, seasonNumber: 5, episodeNumber: 1, title: 'Lynner Takes All', episodeFileId: 11 },
      { id: 2, seasonNumber: 5, episodeNumber: 2, title: 'Recipe for Disaster', episodeFileId: 12 },
      { id: 3, seasonNumber: 5, episodeNumber: 3, title: 'Coming Up Roses', episodeFileId: 13 },
      { id: 4, seasonNumber: 5, episodeNumber: 4, title: 'Cooked Up', episodeFileId: null },
    ];
    const named = (id: number, name: string): RemapFile => ({ id, seasonNumber: 5, relativePath: `x${id}`, size: 1, releaseGroup: 'LAZY', qualityName: null, sourceName: name });
    const s = suggestRemap({
      seasonNumber: 5,
      episodes: season,
      files: [
        named(11, 'The.Loud.House.S05E01.Lynner.Takes.All.1080p.AMZN.WEB-DL.DDP2.0.H.264-LAZY'),
        named(12, 'The.Loud.House.S05E02.Coming.Up.Roses.1080p.AMZN.WEB-DL.DDP2.0.H.264-LAZY'),
        named(13, 'The.Loud.House.S05E03.Cooked.Up.1080p.AMZN.WEB-DL.DDP2.0.H.264-LAZY'),
      ],
    });
    expect(s.claim).toEqual({ kind: 'shift', fromEpisodeNumber: 2, throughEpisodeNumber: 3, by: 1 });
  });
});
