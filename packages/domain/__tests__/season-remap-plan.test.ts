// DESIGN-055 P4 decisions 18-21 (issue #916) — the Season Re-map's plan, pure: every file goes where its own name (or a
// staff placement) says; a cycle passes through a parking episode; nothing is displaced.
import { describe, expect, it } from 'vitest';
import {
  SEASON_REMAP_MAX_STEPS,
  buildSeasonRemapPlan,
  type SeasonRemapFile,
  type SeasonRemapInput,
  type SeasonRemapPlan,
} from '../src/season-remap-plan';
import { checkSeasonPlex, sameEpisodeTitle } from '../src/season-remap-flow';
import type { RemapEpisode } from '../src/remap-plan';

const TITLES = ['Alpha Run', 'Bravo Night', 'Charlie Comes Home', 'Delta Force Five', 'Echo Lake', 'Foxtrot Finale'];

/** Season 1 with six episodes, specials with `specials` episodes; `on[i]` is the episode the file named TITLES[i] sits on. */
function season(opts: {
  on: Array<number | null>;
  names?: Array<string | null | undefined>;
  specials?: number;
  specialsWithFiles?: boolean;
}): { episodes: RemapEpisode[]; files: SeasonRemapFile[] } {
  const episodes: RemapEpisode[] = TITLES.map((title, i) => ({ id: 100 + i + 1, seasonNumber: 1, episodeNumber: i + 1, title, episodeFileId: null }));
  for (let n = 1; n <= (opts.specials ?? 1); n += 1) {
    episodes.push({ id: 900 + n, seasonNumber: 0, episodeNumber: n, title: `Special ${n}`, episodeFileId: null });
  }
  const files: SeasonRemapFile[] = [];
  opts.on.forEach((n, i) => {
    if (n === null) return;
    const id = 5000 + i;
    episodes.find((e) => e.seasonNumber === 1 && e.episodeNumber === n)!.episodeFileId = id;
    const name = opts.names?.[i] === undefined ? `Show.S01E${String(n).padStart(2, '0')}.${TITLES[i]!.replace(/ /g, '.')}.1080p.WEB-DL-GRP` : opts.names[i];
    files.push({
      id,
      seasonNumber: 1,
      relativePath: `Season 1/Show - S01E${String(n).padStart(2, '0')} - ${episodes.find((e) => e.episodeNumber === n && e.seasonNumber === 1)!.title}.mkv`,
      size: 1000 + i,
      releaseGroup: 'GRP',
      qualityName: 'WEBDL-1080p',
      sourceName: name ?? null,
      sourceNames: name ? [name] : [],
    });
  });
  if (opts.specialsWithFiles) {
    for (const e of episodes.filter((x) => x.seasonNumber === 0)) {
      e.episodeFileId = 7000 + e.episodeNumber;
      files.push({ id: e.episodeFileId, seasonNumber: 0, relativePath: `Specials/S00E0${e.episodeNumber}.mkv`, size: 1, releaseGroup: null, qualityName: null, sourceName: null, sourceNames: [] });
    }
  }
  return { episodes, files };
}

function plan(s: { episodes: RemapEpisode[]; files: SeasonRemapFile[] }, over: Partial<SeasonRemapInput> = {}): SeasonRemapPlan {
  return buildSeasonRemapPlan({ seasonNumber: 1, episodes: s.episodes, files: s.files, queueBusy: false, ...over });
}

/** Replay the steps: every step must land on episodes free at that moment; returns where each file ends. */
function replay(s: { episodes: RemapEpisode[] }, p: SeasonRemapPlan): Map<number, number[]> {
  const occupant = new Map<number, number>();
  for (const e of s.episodes) if (e.episodeFileId != null) occupant.set(e.id, e.episodeFileId);
  const at = new Map<number, number[]>();
  for (const step of p.steps) {
    for (const t of step.to) {
      const occ = occupant.get(t.id);
      expect(occ === undefined || occ === step.fileId, `step ${step.kind} of file ${step.fileId} onto ${t.label} is free`).toBe(true);
    }
    for (const f of step.from) if (occupant.get(f.id) === step.fileId) occupant.delete(f.id);
    for (const t of step.to) occupant.set(t.id, step.fileId);
    at.set(step.fileId, step.to.map((e) => e.id));
  }
  return at;
}

describe('buildSeasonRemapPlan', () => {
  it('moves a chain into a free episode without parking', () => {
    // E2 is empty; "Bravo Night" (E2) sits on E3 and "Charlie Comes Home" (E3) on E4.
    const t = season({ on: [1, 3, 4, null, null, null] });
    const p = plan(t);
    expect(p.refusal).toBeNull();
    expect(p.parking).toBeNull();
    expect(p.steps.map((x) => [x.kind, x.from[0]!.episodeNumber, x.to[0]!.episodeNumber])).toEqual([
      ['move', 3, 2],
      ['move', 4, 3],
    ]);
    expect(p.vacated.map((e) => e.episodeNumber)).toEqual([4]);
    replay(t, p);
  });

  it('breaks a swap through the parking episode and lands both files', () => {
    // "Bravo Night" sits on E3 and "Charlie Comes Home" on E2.
    const s = season({ on: [1, 3, 2, 4, 5, 6] });
    const p = plan(s);
    expect(p.refusal).toBeNull();
    expect(p.parking).toMatchObject({ seasonNumber: 0, episodeNumber: 1 });
    expect(p.steps.map((x) => x.kind)).toEqual(['park', 'move', 'unpark']);
    expect(p.moved).toBe(2);
    const at = replay(s, p);
    expect(at.get(5001)).toEqual([102]);
    expect(at.get(5002)).toEqual([103]);
    expect(p.vacated).toEqual([]);
  });

  it('turns a three-file rotation with one parking, and prefers a free episode of the season', () => {
    // E6 is empty; D on E5, E on E4... a rotation of E2, E3, E4: Bravo on E3, Charlie on E4, Delta on E2.
    const s = season({ on: [1, 3, 4, 2, 5, null] });
    const p = plan(s);
    expect(p.refusal).toBeNull();
    expect(p.parking).toMatchObject({ seasonNumber: 1, episodeNumber: 6 });
    expect(p.steps.filter((x) => x.kind === 'park')).toHaveLength(1);
    const at = replay(s, p);
    expect(at.get(5001)).toEqual([102]);
    expect(at.get(5002)).toEqual([103]);
    expect(at.get(5003)).toEqual([104]);
  });

  it('passes two separate swaps through the same parking episode, one after the other', () => {
    // Alpha and Bravo trade places, and so do Delta and Echo.
    const s = season({ on: [2, 1, 3, 5, 4, 6] });
    const p = plan(s);
    expect(p.refusal).toBeNull();
    expect(p.steps.map((x) => x.kind)).toEqual(['park', 'move', 'unpark', 'park', 'move', 'unpark']);
    const at = replay(s, p);
    expect(at.get(5000)).toEqual([101]);
    expect(at.get(5001)).toEqual([102]);
    expect(at.get(5003)).toEqual([104]);
    expect(at.get(5004)).toEqual([105]);
  });

  it('refuses a cycle when the series has no free episode', () => {
    const s = season({ on: [1, 3, 2, 4, 5, 6], specials: 1, specialsWithFiles: true });
    const p = plan(s);
    expect(p.refusal).toBe('no_parking');
    expect(p.steps).toEqual([]);
  });

  it('holds a second copy: its name names an episode whose own file agrees', () => {
    // E2 holds a second "Alpha Run"; E1 holds "Alpha Run" too and agrees.
    const s = season({
      on: [1, 2, 3, 4, 5, 6],
      names: [undefined, 'Show.S01E02.Alpha.Run.1080p.WEB-DL-GRP', undefined, undefined, undefined, undefined],
    });
    const p = plan(s);
    expect(p.refusal).toBe('nothing_to_move');
    expect(p.held).toEqual([expect.objectContaining({ reason: 'duplicate', names: expect.objectContaining({ episodeNumber: 1 }) })]);
  });

  it('holds two files that name the same episode', () => {
    // E2 is empty; the files on E3 and E4 both say "Bravo Night".
    const s = season({
      on: [1, null, 3, 4, 5, 6],
      names: [undefined, undefined, 'Show.S01E03.Bravo.Night.1080p-GRP', 'Show.S01E04.Bravo.Night.1080p-GRP', undefined, undefined],
    });
    const p = plan(s);
    expect(p.refusal).toBe('nothing_to_move');
    expect(p.held.map((h) => h.reason)).toEqual(['collision', 'collision']);
  });

  it('a file whose name says nothing blocks the move onto its episode and is listed with the one episode left over', () => {
    // Bravo on E3, Charlie on E4, and a silent file on E2 (really Delta, E4).
    const s = season({ on: [1, 3, 4, 2, 5, 6], names: [undefined, undefined, undefined, 'Show.S01E02.1080p.WEB-DL-GRP', undefined, undefined] });
    const p = plan(s);
    expect(p.refusal).toBe('nothing_to_move');
    expect(p.held.map((h) => [h.on[0]!.episodeNumber, h.reason])).toEqual([
      [3, 'blocked'],
      [4, 'blocked'],
    ]);
    expect(p.unplaced).toEqual([
      expect.objectContaining({ on: [expect.objectContaining({ episodeNumber: 2 })], verdict: 'silent', suggestion: expect.objectContaining({ episodeNumber: 4 }) }),
    ]);
    expect(p.open.map((e) => e.episodeNumber)).toEqual([4]);
    // Staff place it by evidence: the rotation then runs.
    const placed = plan(s, { placements: [{ from: [2], to: [4] }] });
    expect(placed.refusal).toBeNull();
    const at = replay(s, placed);
    expect(at.get(5003)).toEqual([104]);
    expect(placed.steps.find((x) => x.fileId === 5003 && x.kind !== 'park')!.why).toBe('placed');
  });

  it('holds a two-episode file whose name disagrees until staff place it', () => {
    const s = season({ on: [1, null, 3, 4, 5, 6] });
    // The file on E3 holds E3 and E4 (a two-segment file) and its name says "Bravo Night" (E2).
    const f = s.files.find((x) => x.id === 5002)!;
    s.episodes.find((e) => e.seasonNumber === 1 && e.episodeNumber === 4)!.episodeFileId = 5002;
    s.files.splice(s.files.indexOf(s.files.find((x) => x.id === 5003)!), 1);
    f.sourceNames = ['Show.S01E03E04.Bravo.Night.1080p-GRP'];
    const p = plan(s);
    expect(p.held).toEqual([expect.objectContaining({ reason: 'multi_episode' })]);
    const placed = plan(s, { placements: [{ from: [3, 4], to: [2, 3] }] });
    expect(placed.refusal).toBeNull();
    expect(placed.steps).toEqual([expect.objectContaining({ kind: 'move', why: 'placed', to: [expect.objectContaining({ episodeNumber: 2 }), expect.objectContaining({ episodeNumber: 3 })] })]);
    replay(s, placed);
  });

  it('refuses a placement that names no one file or an episode the season lacks', () => {
    const s = season({ on: [1, 3, 2, 4, 5, 6] });
    expect(plan(s, { placements: [{ from: [9], to: [2] }] }).refusal).toBe('bad_placement');
    expect(plan(s, { placements: [{ from: [2, 3], to: [3, 4] }] }).refusal).toBe('bad_placement');
    expect(plan(s, { placements: [{ from: [2], to: [5] }, { from: [3], to: [5] }] }).refusal).toBe('bad_placement');
  });

  it('keeps what staff keep, and a kept file blocks the move onto its episode', () => {
    const s = season({ on: [1, 3, 2, 4, 5, 6] });
    const p = plan(s, { keep: [2] });
    expect(p.refusal).toBe('nothing_to_move');
    expect(p.held.map((h) => [h.on[0]!.episodeNumber, h.reason])).toEqual([
      [2, 'kept'],
      [3, 'blocked'],
    ]);
  });

  it('refuses while the queue or Sonarr is busy, and over the step limit', () => {
    const s = season({ on: [1, 3, 2, 4, 5, 6] });
    expect(plan(s, { queueBusy: true }).refusal).toBe('queue_busy');
    expect(plan(s, { sonarrBusy: true }).refusal).toBe('sonarr_busy');
    expect(SEASON_REMAP_MAX_STEPS).toBeGreaterThanOrEqual(100);
  });

  it('a changed file changes the digest', () => {
    const s = season({ on: [1, 3, 2, 4, 5, 6] });
    const a = plan(s);
    s.files.find((f) => f.id === 5001)!.size = 1;
    expect(plan(s).digest).not.toBe(a.digest);
  });
});

describe('checkSeasonPlex', () => {
  const tvdb = new Map(TITLES.map((t, i) => [i + 1, t] as const));
  const s = season({ on: [1, 3, 2, 4, 5, 6] });
  const p = plan(s);

  it('passes when Plex titles the season as TVDB does', () => {
    const c = checkSeasonPlex({ plan: p, tvdbTitles: tvdb, plex: [{ server: 'haynestower', items: TITLES.map((t, i) => ({ episodeNumber: i + 1, title: t })) }] });
    expect(c.ok).toBe(true);
    expect(c.servers[0]).toMatchObject({ followsTvdb: 6, differs: 0 });
  });

  it('fails when Plex titles the episode a file moves to differently', () => {
    const items = TITLES.map((t, i) => ({ episodeNumber: i + 1, title: i === 1 ? 'Another Story' : t }));
    const c = checkSeasonPlex({ plan: p, tvdbTitles: tvdb, plex: [{ server: 'haynesops', items }] });
    expect(c.ok).toBe(false);
    expect(c.wrongAfter).toEqual([expect.objectContaining({ server: 'haynesops', plexTitle: 'Another Story' })]);
  });

  it('reads a placeholder title as saying nothing', () => {
    const items = TITLES.map((t, i) => ({ episodeNumber: i + 1, title: i === 1 ? 'Episode 2' : t }));
    expect(checkSeasonPlex({ plan: p, tvdbTitles: tvdb, plex: [{ server: 'haynesops', items }] }).ok).toBe(true);
  });

  it('compares titles by their words', () => {
    expect(sameEpisodeTitle('You Better Shop Around (1)', 'You Better Shop Around: Part 1')).toBe(true);
    expect(sameEpisodeTitle('The Godfather', 'Look Who’s Barking')).toBe(false);
  });
});
