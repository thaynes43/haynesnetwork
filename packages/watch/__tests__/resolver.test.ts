// DESIGN-049 D-13 — resolving a spoken title: Jaro-Winkler, the tiered match score, the history and
// year bonuses, the "different title within 0.05" rule and the kind filter.
import { describe, expect, it } from 'vitest';
import {
  RESOLVE_MIN_SCORE,
  WORD_PREFIX_SCORE,
  jaroWinkler,
  resolveTitle,
  titleMatchScore,
  type ResolverCandidate,
} from '../src/resolver';

function cand(
  title: string,
  year: number | null,
  kind: 'show' | 'movie',
  extra: Partial<ResolverCandidate> = {},
): ResolverCandidate {
  return {
    titleKey: `name:${title}|${year ?? ''}|${kind}`,
    kind,
    title,
    year,
    inHistory: false,
    ...extra,
  };
}

const dune2021 = cand('Dune', 2021, 'movie', {
  titleKey: 'tmdb:movie:438631',
  ids: { tmdbId: 438631 },
});
const dune1984 = cand('Dune', 1984, 'movie', { titleKey: 'tmdb:movie:841', ids: { tmdbId: 841 } });
const prophecy = cand('Dune: Prophecy', 2024, 'show', {
  titleKey: 'tvdb:420417',
  ids: { tvdbId: 420417 },
});
const duneShow = cand('Dune', 2000, 'show', { titleKey: 'tvdb:76911', ids: { tvdbId: 76911 } });

describe('jaroWinkler', () => {
  it('matches the textbook values', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 4);
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler('same', 'same')).toBe(1);
    expect(jaroWinkler('', 'abc')).toBe(0);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });
});

describe('titleMatchScore (the D-13 tiers)', () => {
  it('scores exact, tag-dropped, prefix and fuzzy matches', () => {
    expect(titleMatchScore('the expanse', 'The Expanse')).toBe(1);
    expect(titleMatchScore('the office us', 'The Office')).toBe(0.95);
    expect(titleMatchScore('the office', 'The Office (US)')).toBe(0.95);
    expect(titleMatchScore('dune 2021', 'Dune')).toBe(0.95);
    expect(
      titleMatchScore(
        'the lord of the rings the fellowship',
        'The Lord of the Rings: The Fellowship of the Ring',
      ),
    ).toBe(0.85);
    const fuzzy = titleMatchScore('severence', 'Severance');
    expect(fuzzy).toBeCloseTo(jaroWinkler('severence', 'severance') * 0.9, 10);
    expect(fuzzy).toBeGreaterThan(0.81);
    expect(fuzzy).toBeLessThan(0.9);
  });

  it('applies the 60% length rule and never matches two different country tags as equal', () => {
    // "dune" is 4 of 13 characters of "dune prophecy": no 0.85 prefix credit, and Jaro-Winkler is
    // 0.86 — only the Q-05 whole-word prefix (0.7) applies.
    expect(titleMatchScore('dune', 'Dune: Prophecy')).toBe(WORD_PREFIX_SCORE);
    expect(titleMatchScore('silo', 'Silos')).toBe(0.85);
    expect(titleMatchScore('the office us', 'The Office (UK)')).toBeLessThan(0.9);
    expect(titleMatchScore('', 'Dune')).toBe(0);
  });
});

describe('resolveTitle (D-13)', () => {
  it('resolves an exact title', () => {
    const r = resolveTitle('Severance', [
      cand('Severance', 2022, 'show'),
      cand('Silo', 2023, 'show'),
    ]);
    expect(r).toMatchObject({ status: 'resolved', score: 1, candidate: { title: 'Severance' } });
  });

  it('resolves "the office us" to the US Office — the tag drop plus the history bonus', () => {
    const us = cand('The Office', 2005, 'show', { inHistory: true, ids: { tvdbId: 73244 } });
    const uk = cand('The Office', 2001, 'show', { ids: { tvdbId: 78107 } });
    const r = resolveTitle('the office us', [uk, us]);
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.candidate.year).toBe(2005);
    expect(r.score).toBeCloseTo(1, 10);

    // With the ledger's own "The Office (US)" in the pool it is an exact match, and the Plex copy
    // that shares its TVDB id is the same title, not a rival.
    const sonarr = cand('The Office (US)', 2005, 'show', {
      titleKey: 'tvdb:73244',
      ids: { tvdbId: 73244 },
    });
    const r2 = resolveTitle('the office us', [uk, us, sonarr]);
    expect(r2.status).toBe('resolved');
    if (r2.status !== 'resolved') return;
    expect(r2.candidate).toBe(sonarr);
    expect(r2.sameTitle).toEqual([sonarr, us]);
    expect(r2.score).toBeCloseTo(1.05, 10);
  });

  it('holds a prefix match at 0.85 (ambiguous) unless the history bonus lifts it to 0.9', () => {
    const fellowship = cand('The Lord of the Rings: The Fellowship of the Ring', 2001, 'movie');
    const query = 'the lord of the rings the fellowship';
    const cold = resolveTitle(query, [fellowship]);
    expect(cold).toMatchObject({ status: 'ambiguous', options: [fellowship] });
    const warm = resolveTitle(query, [{ ...fellowship, inHistory: true }]);
    expect(warm).toMatchObject({ status: 'resolved' });
    if (warm.status === 'resolved') expect(warm.score).toBeCloseTo(0.9, 10);
  });

  it('asks between the two Dunes, newest first, then offers Dune: Prophecy (Q-05, D-21 example)', () => {
    const r = resolveTitle('dune', [prophecy, dune1984, dune2021]);
    expect(r.status).toBe('ambiguous');
    if (r.status !== 'ambiguous') return;
    expect(r.options).toEqual([dune2021, dune1984, prophecy]);
    expect(r.best).toBe(1);
  });

  it('lets a year hint resolve one Dune (a margin of exactly 0.05 resolves)', () => {
    expect(resolveTitle('dune 2021', [dune1984, dune2021, prophecy])).toMatchObject({
      status: 'resolved',
      candidate: dune2021,
    });
    expect(resolveTitle('Dune (1984)', [dune2021, dune1984])).toMatchObject({
      status: 'resolved',
      candidate: dune1984,
    });
  });

  it('lets the history bonus break a tie between same-name titles', () => {
    const r = resolveTitle('dune', [dune1984, { ...dune2021, inHistory: true }]);
    expect(r).toMatchObject({ status: 'resolved', candidate: { year: 2021 } });
  });

  it('filters the pool by kind when given', () => {
    const pool = [dune2021, dune1984, duneShow, prophecy];
    expect(resolveTitle('dune', pool, { kind: 'show' })).toMatchObject({
      status: 'resolved',
      candidate: duneShow,
    });
    expect(resolveTitle('dune', pool, { kind: 'movie' }).status).toBe('ambiguous');
  });

  it('treats pool entries that share an identity key as one title, not a tie', () => {
    const plexRow = cand('Foundation', 2021, 'show', {
      titleKey: 'plex:plex://show/5d9c0',
      inHistory: true,
      ids: { plexGuid: 'plex://show/5d9c0', tvdbId: 366972 },
    });
    const ledger = cand('Foundation', 2021, 'show', {
      titleKey: 'tvdb:366972',
      ids: { tvdbId: 366972 },
    });
    const seed = cand('Foundation', 2021, 'show', {
      titleKey: 'tmdb:show:93740',
      ids: { tmdbId: 93740 },
    });
    const r = resolveTitle('foundation', [ledger, seed, plexRow]);
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    // The in-history Title State represents the title; the name key groups the TMDB-only seed in.
    expect(r.candidate).toBe(plexRow);
    expect(r.sameTitle).toHaveLength(3);
  });

  it('resolves "Blade Runner 2049" to the sequel, not the 1982 film', () => {
    const r = resolveTitle('blade runner 2049', [
      cand('Blade Runner', 1982, 'movie'),
      cand('Blade Runner 2049', 2017, 'movie'),
    ]);
    expect(r).toMatchObject({ status: 'resolved', candidate: { year: 2017 } });
  });

  describe('Q-05 — the whole-word prefix (0.7)', () => {
    it('scores only when the query is the leading whole words of the title', () => {
      expect(titleMatchScore('star trek', 'Star Trek: Strange New Worlds')).toBe(WORD_PREFIX_SCORE);
      expect(titleMatchScore('the office', 'The Office Christmas Party')).toBe(WORD_PREFIX_SCORE);
      // Not a whole word: "dun" is a prefix of "dune" only.
      expect(titleMatchScore('dun', 'Dune: Prophecy')).toBe(0);
      // Not the leading words.
      expect(titleMatchScore('prophecy', 'Dune: Prophecy')).toBe(0);
      // The title leading the QUERY is not this rule (the ruling is one-directional).
      expect(titleMatchScore('dune prophecy', 'Dune')).toBe(0);
    });

    it('never resolves alone, even with both bonuses: "Did you mean" instead', () => {
      // 0.7 + the year bonus + the history bonus = 0.8, still under 0.9.
      for (const query of ['dune 2024', 'Dune (2024)']) {
        const alone = resolveTitle(query, [{ ...prophecy, inHistory: true }]);
        expect(alone.status).toBe('ambiguous');
        if (alone.status !== 'ambiguous') return;
        expect(alone.options).toEqual([{ ...prophecy, inHistory: true }]);
        expect(alone.best).toBeCloseTo(0.8, 10);
        expect(alone.best).toBeLessThan(RESOLVE_MIN_SCORE);
      }
      expect(resolveTitle('dune', [prophecy])).toMatchObject({
        status: 'ambiguous',
        options: [prophecy],
        best: WORD_PREFIX_SCORE,
      });
    });

    it('never outranks or blocks an exact title', () => {
      expect(resolveTitle('dune', [prophecy, dune2021])).toMatchObject({
        status: 'resolved',
        candidate: dune2021,
      });
    });
  });

  it('answers not found below 0.6, and for an empty query', () => {
    expect(resolveTitle('zzzz qqq', [dune2021, prophecy])).toEqual({
      status: 'not_found',
      best: 0,
    });
    expect(resolveTitle('   ', [dune2021])).toEqual({ status: 'not_found', best: 0 });
    expect(resolveTitle('dune', [])).toEqual({ status: 'not_found', best: 0 });
  });

  it('offers at most three distinct titles', () => {
    const pool = [2001, 2005, 2010, 2015].map((y) => cand('Home', y, 'movie'));
    const r = resolveTitle('home', pool);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.options.map((o) => o.year)).toEqual([2015, 2010, 2005]);
  });
});
