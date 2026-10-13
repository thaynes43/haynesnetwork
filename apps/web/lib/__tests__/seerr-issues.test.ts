// DESIGN-055 D-10 / D-11 (PLAN-077 P3) — the Seerr report routing table and its words (pure).
import { describe, expect, it } from 'vitest';
import {
  guideIntroText,
  issueKicker,
  parseSeerrParam,
  reasonForIssueType,
  seerrGuideEntry,
  seerrLinkPath,
  type GuideEntryChild,
} from '../seerr-issues';

const show = { arrKind: 'sonarr', title: 'The Paper (2025)', onDiskFileCount: 5 };
const movie = (onDisk: number) => ({ arrKind: 'radarr', title: 'GoodFellas', onDiskFileCount: onDisk });
const ep = (id: number, season: number, episode: number, hasFile: boolean): GuideEntryChild => ({
  arrChildId: id,
  label: `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} · Ep ${episode}`,
  hasFile,
  seasonNumber: season,
  episodeNumber: episode,
});
const children = [ep(201, 2, 1, true), ep(206, 2, 6, false), ep(207, 2, 7, true), ep(301, 3, 1, false)];
const issue = (o: Partial<Parameters<typeof seerrGuideEntry>[0]> = {}) => ({
  issueType: 1 as const,
  mediaType: 'tv' as const,
  problemSeason: 0,
  problemEpisode: 0,
  targetChildId: null,
  ...o,
});

describe('seerrGuideEntry (D-10 routing)', () => {
  it('a missing episode opens Force Search on it (Case B)', () => {
    expect(seerrGuideEntry(issue({ problemSeason: 2, problemEpisode: 6, targetChildId: 206 }), show, children)).toEqual({
      mode: 'search',
      target: { scope: 'episode', childId: 206, label: 'S02E06 · Ep 6' },
      reason: null,
      scopeLabel: 'S02E06',
    });
  });

  it('an episode with a file opens Fix on it, the reason preselected by type', () => {
    expect(seerrGuideEntry(issue({ problemSeason: 2, problemEpisode: 7 }), show, children)).toMatchObject({
      mode: 'fix',
      target: { scope: 'episode', childId: 207 },
      reason: null,
    });
    expect(seerrGuideEntry(issue({ issueType: 2, problemSeason: 2, problemEpisode: 7 }), show, children)).toMatchObject({
      mode: 'fix',
      reason: 'wrong_language',
    });
    expect(seerrGuideEntry(issue({ issueType: 3, problemSeason: 2, problemEpisode: 1 }), show, children)).toMatchObject({
      reason: 'missing_subtitles',
    });
  });

  it('a whole season opens the season: Fix with anything on disk, else Force Search', () => {
    expect(seerrGuideEntry(issue({ issueType: 4, problemSeason: 2 }), show, children)).toEqual({
      mode: 'fix',
      target: { scope: 'season', seasonNumber: 2, label: 'Season 2' },
      reason: null,
      scopeLabel: 'Season 2',
    });
    expect(seerrGuideEntry(issue({ problemSeason: 3 }), show, children)).toMatchObject({
      mode: 'search',
      target: { scope: 'season', seasonNumber: 3 },
    });
  });

  it('an episode the manager does not have falls back to its season', () => {
    expect(seerrGuideEntry(issue({ problemSeason: 2, problemEpisode: 40 }), show, children)).toMatchObject({
      target: { scope: 'season', seasonNumber: 2 },
    });
  });

  it('the whole show: the episode picker, or Force Search on the whole show when nothing is on disk', () => {
    expect(seerrGuideEntry(issue(), show, children)).toEqual({ mode: 'fix', target: null, reason: null, scopeLabel: null });
    expect(seerrGuideEntry(issue({ problemSeason: 9 }), show, [ep(301, 3, 1, false)])).toEqual({
      mode: 'search',
      target: { scope: 'show', label: 'The Paper (2025)' },
      reason: null,
      scopeLabel: 'Whole show',
    });
  });

  it('a movie: Fix with a file (Case C), Force Search without', () => {
    expect(seerrGuideEntry(issue({ mediaType: 'movie' }), movie(1), null)).toEqual({ mode: 'fix', target: null, reason: null, scopeLabel: null });
    expect(seerrGuideEntry(issue({ mediaType: 'movie', issueType: 2 }), movie(1), null)).toMatchObject({ reason: 'wrong_language' });
    expect(seerrGuideEntry(issue({ mediaType: 'movie' }), movie(0), null)).toMatchObject({ mode: 'search', target: null });
  });

  it('waits for the episodes, and never routes music', () => {
    expect(seerrGuideEntry(issue({ problemSeason: 2, problemEpisode: 6 }), show, null)).toBeNull();
    expect(seerrGuideEntry(issue(), { arrKind: 'lidarr', title: 'x', onDiskFileCount: 1 }, [])).toBeNull();
  });
});

describe('Seerr report words', () => {
  it('kicker, intro, reason, link and the ?seerr= param', () => {
    expect(issueKicker(issue({ problemSeason: 2, problemEpisode: 6 }))).toBe('Video · S02E06');
    expect(issueKicker(issue({ issueType: 4, problemSeason: 1 }))).toBe('Other · Season 1');
    expect(issueKicker(issue({ issueType: 2, mediaType: 'movie' }))).toBe('Audio');
    expect(guideIntroText(true)).toBe("You reported this in Seerr. Here's what you can try first.");
    expect(guideIntroText(false)).toMatch(/^This was reported in Seerr/);
    expect(reasonForIssueType(1)).toBeNull();
    expect(seerrLinkPath(3)).toBe('/r/seerr/3');
    expect(parseSeerrParam('3')).toBe(3);
    expect(parseSeerrParam(['12', '4'])).toBe(12);
    for (const bad of ['0', '-1', 'x', '1e3', '', undefined, null, '1234567890']) expect(parseSeerrParam(bad)).toBeNull();
    // No em dashes in any of the copy.
    expect(`${guideIntroText(true)}${guideIntroText(false)}`).not.toMatch(/—/);
  });
});
