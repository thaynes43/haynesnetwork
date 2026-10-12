// DESIGN-054 D-05/D-06: classification sources, safe identity recovery and unchanged response budgets.
// CPU budget: bounded serial tests only; no stress tools, load loops or wide parallel runs.
import { describe, expect, it } from 'vitest';
import {
  SPOKEN_MAX_CHARS,
  type WatchBatchCheck,
  type WatchCandidateCheck,
  type WatchPersonalCoverage,
  type WatchPersonalEvidence,
  type WatchResolvedIdentity,
} from '@hnet/watch';
import {
  formatCandidateChecks,
  formatSingleWatchCheck,
  formatViewingContext,
} from '../src/personal-format';
import { boundedWatchContent, MAX_STRUCTURED_BYTES } from '../src/structured';

const AT = '2026-10-12T00:00:00.000Z';
const coverage: WatchPersonalCoverage = {
  completeHistory: false,
  history: { status: 'snapshot', refreshedAt: AT, eventsIngestedAt: AT },
  plex: { status: 'snapshot', asOf: AT },
  watchlist: { status: 'snapshot', asOf: AT },
  personalRatings: 'unavailable',
  clipped: false,
};
const identity: WatchResolvedIdentity = {
  kind: 'movie',
  title: 'A Film',
  year: 2020,
  titleKey: 'tmdb:movie:1',
  tmdbId: 1,
  tvdbId: null,
  imdbId: null,
  plexGuid: null,
};
function evidence(extra: Partial<WatchPersonalEvidence> = {}): WatchPersonalEvidence {
  return {
    viewing: 'watched',
    viewingBasis: ['plex_watched_state'],
    everWatched: true,
    attributionAmbiguous: false,
    unattributedPlays: 0,
    plays: 0,
    completedPlays: 0,
    watchedEpisodes: 0,
    observedEpisodes: 0,
    lastPlayedAt: null,
    progress: {
      state: 'finished',
      episodesWatched: null,
      episodesTotal: null,
      resumePercent: null,
    },
    statements: [],
    statementCount: 0,
    dismissal: null,
    onPlex: true,
    onWatchlist: false,
    genres: [],
    refreshedAt: AT,
    sources: [{ source: 'title_state', asOf: AT }],
    personalRating: { status: 'unavailable', value: null },
    clipped: false,
    ...extra,
  };
}
function check(extra: Partial<WatchCandidateCheck> = {}): WatchCandidateCheck {
  return {
    input: { title: 'A Film', year: 2020, kind: 'movie' },
    resolution: 'resolved',
    identity,
    options: [],
    reason: null,
    evidence: evidence(),
    ...extra,
  };
}
const batch = (results: WatchCandidateCheck[]): WatchBatchCheck => ({
  checkedAt: AT,
  coverage,
  results,
});

describe('personal evidence speech', () => {
  it.each([
    ['explicit_watched', 'explicit watched statement'],
    ['plex_watched_state', 'Plex watched flag'],
    ['plex_episode_state', 'Plex episode state'],
    ['completed_playback', 'playback watched verdict'],
    ['historical_completion', 'retained playback watched summary'],
  ] as const)(
    'names %s without claiming liking or requiring a complete playback event',
    (basis, words) => {
      const value = check({ evidence: evidence({ viewingBasis: [basis] }) });
      expect(formatCandidateChecks(batch([value]))).toContain(words);
      const single = formatSingleWatchCheck(value);
      expect(single).toContain(words);
      expect(single).not.toMatch(/liked|enjoyed|100 percent/);
    },
  );

  it('preserves episode-scoped evidence and current progress without claiming the whole show finished', () => {
    const value = check({
      identity: { ...identity, kind: 'show', title: 'A Show' },
      evidence: evidence({
        viewingBasis: ['explicit_watched', 'plex_episode_state'],
        progress: {
          state: 'in_progress',
          episodesWatched: 1,
          episodesTotal: 8,
          resumePercent: null,
        },
        statements: [{ action: 'watched', scope: 'episode', season: 1, episode: 1, at: AT }],
        statementCount: 1,
      }),
    });
    const single = formatSingleWatchCheck(value);
    expect(single).toContain('see statement scope and episode progress');
    expect(single).toContain('1 of 8 episodes currently watched');
    expect(single).not.toMatch(/whole show|show finished|all 8/);
    expect(
      formatViewingContext({
        checkedAt: AT,
        coverage,
        section: 'viewing',
        items: [{ identity: value.identity!, evidence: value.evidence! }],
        page: { offset: 0, limit: 10, total: 1, hasMore: false },
      }),
    ).toContain('explicit watched statement');
  });

  it('uses complete provenance even when the decisive explicit statement is outside displayed metadata', () => {
    const value = check({
      evidence: evidence({
        viewingBasis: ['explicit_watched'],
        statementCount: 6,
        clipped: true,
        statements: Array.from({ length: 5 }, () => ({
          action: 'not_interested' as const,
          scope: 'movie' as const,
          season: null,
          episode: null,
          at: AT,
        })),
      }),
    });
    expect(formatSingleWatchCheck(value)).toContain('explicit watched statement');
  });

  it('speaks partial Plex resume evidence and leaves household completion out of personal watched claims', () => {
    const partial = check({
      evidence: evidence({
        viewing: 'partial',
        viewingBasis: ['plex_resume'],
        everWatched: false,
        progress: {
          state: 'in_progress',
          episodesWatched: null,
          episodesTotal: null,
          resumePercent: 13,
        },
      }),
    });
    expect(formatSingleWatchCheck(partial)).toContain('partial viewing; Plex resume evidence');
    const notMine = check({
      evidence: evidence({
        viewing: 'not_mine',
        viewingBasis: ['explicit_not_mine'],
        everWatched: false,
        completedPlays: 1,
      }),
    });
    expect(formatSingleWatchCheck(notMine)).toContain('marked not mine; other household viewing');
    expect(formatSingleWatchCheck(notMine)).not.toContain('recorded as watched');
  });
});

describe('canonical year recovery speech and bounds', () => {
  const mismatch = check({
    input: { title: 'A Film', year: 2019, kind: 'movie' },
    resolution: 'unresolved',
    identity: null,
    evidence: null,
    reason: 'year_mismatch',
    options: [identity],
  });

  it('offers a canonical year in batch speech and asks for confirmation before any viewing conclusion', () => {
    expect(formatCandidateChecks(batch([mismatch]))).toContain(
      'release year differs; confirm A Film, 2020 before checking viewing',
    );
    const single = formatSingleWatchCheck(mismatch);
    expect(single).toContain('confirm a canonical option before checking viewing');
    expect(single.match(/A Film, 2020/g)).toHaveLength(1);
    expect(single).not.toContain('recorded as watched');
  });

  it('keeps viewing unknown when a mismatched identity cannot safely offer an option', () => {
    expect(formatCandidateChecks(batch([{ ...mismatch, options: [] }]))).toContain(
      'release year differs; identity unresolved and viewing unknown',
    );
  });

  it('keeps ten fully populated provenance results under the unchanged text and structured budgets', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      check({
        input: { title: 'T'.repeat(200), year: 2020, kind: 'show' },
        identity: { ...identity, kind: 'show', title: 'T'.repeat(200), tmdbId: i + 1 },
        evidence: evidence({
          viewingBasis: [
            'explicit_watched',
            'plex_watched_state',
            'plex_episode_state',
            'completed_playback',
            'historical_completion',
          ],
          statements: Array.from({ length: 5 }, () => ({
            action: 'watched' as const,
            scope: 'episode' as const,
            season: 1,
            episode: 1,
            at: AT,
          })),
          genres: Array.from({ length: 5 }, () => 'G'.repeat(80)),
        }),
      }),
    );
    const value = batch(results);
    expect(formatCandidateChecks(value).length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    const content = boundedWatchContent(value);
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(MAX_STRUCTURED_BYTES);
    expect((content.results as WatchCandidateCheck[]).map((r) => r.evidence?.viewingBasis)).toEqual(
      results.map((r) => r.evidence?.viewingBasis),
    );
  });

  it('retains ten unresolved results and all five canonical alternatives within the response budgets', () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      ...mismatch,
      options: Array.from({ length: 5 }, (_, j) => ({
        ...identity,
        title: 'T'.repeat(200),
        tmdbId: i * 5 + j + 1,
      })),
    }));
    const value = batch(results);
    expect(formatCandidateChecks(value).length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    const content = boundedWatchContent(value);
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(MAX_STRUCTURED_BYTES);
    expect(content.results).toHaveLength(10);
    expect(
      (content.results as WatchCandidateCheck[]).every(
        (r) => r.options.length === 5 && r.evidence === null,
      ),
    ).toBe(true);
  });
});
