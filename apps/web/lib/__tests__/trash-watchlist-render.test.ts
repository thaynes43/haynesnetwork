// ADR-093 / DESIGN-052 D-10 (AC-34) — the watchlist-protection surfaces as they RENDER, not just their string
// constants: the paused banner names its reason (and Maintainerr trouble wins, D-25v), the tile's "On a watchlist"
// note carries its tooltip and aria, and the Expedite item confirm / report say who keeps a watchlisted item.
// renderToStaticMarkup, the motd-markdown precedent: no DOM, no Next runtime.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafetyBanner, type SafetyStatus } from '@/components/trash-safety';
import { ExpediteItemConfirm, ExpediteReport } from '@/components/trash-expedite';
import { TrashCard } from '@/components/cards';
import {
  SWEEP_PAUSED_COPY,
  WATCHLIST_NOTE_DETAIL,
  WATCHLIST_NOTE_LABEL,
  type TrashSweepBannerName,
} from '../trash';

const safe: SafetyStatus = {
  safe: true,
  reachable: true,
  version: '3.29.0',
  integrations: { plex: true, radarr: true, sonarr: true, tautulli: true, seerr: true },
  armedRules: 2,
  activeCollections: 2,
};

const banner = (status: SafetyStatus) =>
  renderToStaticMarkup(createElement(SafetyBanner, { status, loading: false, failed: false }));

/** The text React renders for a string (apostrophes are escaped in markup). */
const esc = (s: string) => s.replace(/'/g, '&#x27;');

describe('the paused banner (D-10 / D-25v)', () => {
  it('names each reason in its own words, with its data-reason', () => {
    const reasons: TrashSweepBannerName[] = ['gate', 'release_block', 'media_apps'];
    for (const reason of reasons) {
      const html = banner({ ...safe, sweepPause: reason });
      expect(html).toContain('data-testid="trash-sweep-paused"');
      expect(html).toContain(`data-reason="${reason}"`);
      expect(html).toContain(esc(SWEEP_PAUSED_COPY[reason]));
      expect(html).toContain('data-state="warn"');
      for (const other of reasons.filter((r) => r !== reason)) {
        expect(html).not.toContain(esc(SWEEP_PAUSED_COPY[other]));
      }
    }
    // The three reasons read differently (a mapping that collapses them all to one would fail here).
    expect(new Set(reasons.map((r) => SWEEP_PAUSED_COPY[r])).size).toBe(3);
  });

  it('shows nothing under 6 hours (no sweepPause) and yields to a Maintainerr warning', () => {
    expect(banner({ ...safe, sweepPause: null })).not.toContain('trash-sweep-paused');
    expect(banner({ ...safe, sweepPause: null })).toContain('data-state="safe"');
    // Maintainerr's own trouble takes precedence (the unsafe audit), and so does an unreachable install.
    const unsafe = banner({ ...safe, safe: false, integrations: { ...safe.integrations, seerr: false }, sweepPause: 'gate' });
    expect(unsafe).not.toContain('trash-sweep-paused');
    expect(unsafe).toContain('Maintainerr safety check failed');
    const aging = banner({ ...safe, safe: false, agingViolations: ['Least watched: 3 days'], sweepPause: 'media_apps' });
    expect(aging).not.toContain('trash-sweep-paused');
    expect(aging).toContain('auto-delete safeguard tripped');
    const down = banner({ ...safe, reachable: false, sweepPause: 'release_block' });
    expect(down).not.toContain('trash-sweep-paused');
    expect(down).toContain('data-state="down"');
  });
});

describe('the "On a watchlist" tile note (D-10 / D-25bi)', () => {
  const card = (onWatchlist: boolean) =>
    renderToStaticMarkup(
      createElement(TrashCard, {
        glyph: 'trash',
        posterUrl: null,
        kind: 'radarr',
        title: 'Vanished Heist',
        year: 2021,
        toggle: { tappable: false, pressed: false, label: 'Slated', title: 'Slated' },
        libraryLink: null,
        metaText: '2 GB',
        requesters: ['Marge'],
        watchNote: { label: 'Watched a while ago', tone: 'muted' },
        onWatchlist,
        pwall: true,
        testId: 'trash-tile',
      }),
    );

  it('renders the bookmark with its tooltip and aria-label, and the short label for wider screens', () => {
    const html = card(true);
    expect(html).toContain('data-testid="wall-watchlisted"');
    expect(html).toContain(`title="${esc(WATCHLIST_NOTE_DETAIL)}"`);
    expect(html).toContain(`aria-label="${esc(WATCHLIST_NOTE_DETAIL)}"`);
    // The label is decoration the phone breakpoint hides (the tooltip and aria carry the words).
    expect(html).toMatch(new RegExp(`class="bwall-watchlisted__label" aria-hidden="true">${WATCHLIST_NOTE_LABEL}<`));
    expect(card(false)).not.toContain('wall-watchlisted');
  });
});

describe('the Expedite copy for a watchlisted item (D-09 / D-25av)', () => {
  const item = {
    maintainerrMediaId: 'ms-880004',
    mediaItemId: 'm-1',
    protectedByTag: false,
    recentlyWatched: false,
    requesters: [],
    onWatchlist: true,
    watchlistEvaluable: true,
    ruleEvaluationFailed: false,
    title: 'Vanished Heist',
    year: 2021,
    sizeBytes: 0,
  };
  const noop = () => undefined;

  it('the item confirm says it stays while listed and deletes nothing', () => {
    const html = renderToStaticMarkup(
      createElement(ExpediteItemConfirm, { item, busy: false, onCancel: noop, onConfirm: noop }),
    );
    expect(html).toContain('data-testid="trash-expedite-item-watchlisted"');
    expect(html).toContain('This item is on a watchlist');
    expect(html).toContain('Nothing will be deleted.');
    const cold = renderToStaticMarkup(
      createElement(ExpediteItemConfirm, {
        item: { ...item, onWatchlist: false },
        busy: false,
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(cold).not.toContain('trash-expedite-item-watchlisted');
  });

  it('the report never credits Maintainerr with the keep, and its bullets carry no dashes', () => {
    const html = renderToStaticMarkup(
      createElement(ExpediteReport, {
        outcome: { protectedCount: 1, expeditedCount: 1, skippedCount: 1, stalePending: 1 },
        onClose: noop,
      }),
    );
    const bullets = html.slice(html.indexOf('<ul'), html.indexOf('</ul>'));
    expect(bullets).toContain('watchlist');
    expect(bullets).not.toMatch(/Maintainerr keeps/);
    expect(bullets).not.toMatch(/[–—]/); // owner rule: no en or em dashes
  });
});
