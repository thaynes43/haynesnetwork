// ADR-068 / DESIGN-040 — the scoreboard's pure helpers (D-08 compact format, D-06 badge
// order, D-07 absence) + a static render of <Scoreboard/> via renderToStaticMarkup (the
// motd-markdown test idiom): aria-label, four two-segment badges, values baked, and the
// render-NOTHING contract when the estate is unavailable.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatPlays, scoreboardBadges, type ScoreboardTotals } from '../scoreboard';
import { Scoreboard } from '../../components/scoreboard';

const TOTALS: ScoreboardTotals = {
  moviePlays: 3479, // 3449 + the type-movie Home Videos 30 (ground truth 2026-07-16)
  episodePlays: 25238,
  trackPlays: 2316,
  hoursWatched: 17203,
  unavailable: false,
};

describe('formatPlays (D-08)', () => {
  it('compact-formats the shields way', () => {
    expect(formatPlays(0)).toBe('0');
    expect(formatPlays(30)).toBe('30');
    expect(formatPlays(999)).toBe('999');
    expect(formatPlays(1000)).toBe('1k');
    expect(formatPlays(2316)).toBe('2.3k');
    expect(formatPlays(3449)).toBe('3.4k');
    expect(formatPlays(25238)).toBe('25.2k');
    expect(formatPlays(999_951)).toBe('1M'); // 1000.0k promotes, never renders
    expect(formatPlays(1_500_000)).toBe('1.5M');
  });
});

describe('scoreboardBadges (D-06/D-07)', () => {
  it('fixed order: Movies · TV episodes · Music · Hours watched', () => {
    expect(scoreboardBadges(TOTALS)).toEqual([
      { label: 'Movies', value: '3.5k' },
      { label: 'TV episodes', value: '25.2k' },
      { label: 'Music', value: '2.3k' },
      { label: 'Hours watched', value: '17.2k' },
    ]);
  });

  it('unavailable ⇒ null (the component renders NOTHING)', () => {
    expect(scoreboardBadges({ ...TOTALS, unavailable: true })).toBeNull();
  });
});

describe('<Scoreboard/> (D-05 anatomy, SSR-baked)', () => {
  it('renders the labelled row of four two-segment badges with the values baked in', () => {
    const html = renderToStaticMarkup(createElement(Scoreboard, { totals: TOTALS }));
    expect(html).toContain('aria-label="Estate lifetime plays"');
    expect(html.match(/scoreboard__badge/g)).toHaveLength(4);
    expect(html.match(/scoreboard__label/g)).toHaveLength(4);
    expect(html.match(/scoreboard__value/g)).toHaveLength(4);
    expect(html.match(/scoreboard__glyph/g)).toHaveLength(4); // the play flourish, aria-hidden
    expect(html).toContain('TV episodes');
    expect(html).toContain('25.2k');
    expect(html).toContain('Hours watched');
  });

  it('renders NOTHING when the estate is unavailable — no empty chrome (D-07)', () => {
    const html = renderToStaticMarkup(
      createElement(Scoreboard, { totals: { ...TOTALS, unavailable: true } }),
    );
    expect(html).toBe('');
  });
});
