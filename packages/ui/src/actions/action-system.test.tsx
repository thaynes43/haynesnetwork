// @vitest-environment jsdom
//
// ADR-071 / DESIGN-004 D-24 — unit proof for the media-action system: the registry is the ONE
// label+look per verb, and the components render it faithfully (variant → class, scope qualifier,
// destructive → ConfirmButton, consume ↗ wiring, the reflow-safe slot). Plain-DOM assertions
// (the shared package has no jest-dom), matching the filter-component test convention.
import type { ReactElement } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MEDIA_ACTIONS, MEDIA_ACTION_TYPES, composeActionLabel } from './action-registry';
import { MediaAction } from './MediaAction';
import { MediaActionBar } from './MediaActionBar';
import { ConsumeLink } from './ConsumeLink';
import { ReservedActionSlot } from './ReservedActionSlot';
import { MediaHero } from './MediaHero';

afterEach(cleanup);

const wrap = (ui: ReactElement) => render(ui);

// ── the registry: one canonical label + variant per verb (the "one label per verb" lock) ──
describe('MEDIA_ACTIONS registry', () => {
  it('keys each entry by its own type (no cross-wiring)', () => {
    for (const type of MEDIA_ACTION_TYPES) {
      expect(MEDIA_ACTIONS[type].type).toBe(type);
    }
  });

  it('fixes the owner-ratified labels + looks: Fix=primary, Force Search=outline', () => {
    expect(MEDIA_ACTIONS.fix.label).toBe('Fix');
    expect(MEDIA_ACTIONS.fix.variant).toBe('primary');
    expect(MEDIA_ACTIONS.forceSearch.label).toBe('Force Search');
    expect(MEDIA_ACTIONS.forceSearch.variant).toBe('outline');
  });

  it('has exactly the five action types', () => {
    expect(MEDIA_ACTION_TYPES.sort()).toEqual(
      ['consume', 'fix', 'forceSearch', 'notOnDisk', 'retryImport'].sort(),
    );
  });

  it('never uses the retired forked labels', () => {
    const labels = MEDIA_ACTION_TYPES.map((t) => MEDIA_ACTIONS[t].label);
    for (const forked of [
      'Fix this',
      'Fix season',
      'Force Search show',
      'Force Search artist',
      'Force re-search',
    ]) {
      expect(labels).not.toContain(forked);
    }
  });

  it('composeActionLabel appends the scope qualifier with " · ", never forks the verb', () => {
    expect(composeActionLabel(MEDIA_ACTIONS.forceSearch)).toBe('Force Search');
    expect(composeActionLabel(MEDIA_ACTIONS.forceSearch, 'Season 2')).toBe(
      'Force Search · Season 2',
    );
    expect(composeActionLabel(MEDIA_ACTIONS.fix, 'Whole show')).toBe('Fix · Whole show');
    expect(composeActionLabel(MEDIA_ACTIONS.fix, null)).toBe('Fix');
  });
});

// ── <MediaAction> ──
describe('MediaAction', () => {
  it('renders Fix as a green-primary pill off the registry (no literal label at the call site)', () => {
    wrap(<MediaAction action="fix" onFire={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Fix' });
    expect(btn.className.split(' ')).toContain('btn');
    expect(btn.className.split(' ')).toContain('primary');
    expect(btn.getAttribute('data-action-type')).toBe('fix');
  });

  it('renders Force Search as an outline pill (NOT primary) — even standalone', () => {
    wrap(<MediaAction action="forceSearch" onFire={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Force Search' });
    expect(btn.className.split(' ')).toContain('btn');
    expect(btn.className.split(' ')).not.toContain('primary');
  });

  it('applies the scope qualifier + the sm size (layout, not identity)', () => {
    wrap(<MediaAction action="forceSearch" onFire={() => {}} scopeLabel="Season 2" size="sm" />);
    const btn = screen.getByRole('button', { name: 'Force Search · Season 2' });
    expect(btn.className.split(' ')).toContain('sm');
  });

  it('fires onFire on click and honors disabled', () => {
    const onFire = vi.fn();
    const { rerender } = wrap(<MediaAction action="fix" onFire={onFire} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
    expect(onFire).toHaveBeenCalledTimes(1);
    rerender(<MediaAction action="fix" onFire={onFire} disabled />);
    expect(screen.getByRole('button', { name: 'Fix' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders the corner BADGE presentation as an icon-only .action-badge off the same registry action', () => {
    const onFire = vi.fn();
    wrap(
      <MediaAction
        action="forceSearch"
        presentation="badge"
        onFire={onFire}
        ariaLabel="Force search Franchise A"
        testId="fs-badge"
      />,
    );
    const btn = screen.getByRole('button', { name: 'Force search Franchise A' });
    // Same registry action (data-action-type), a DIFFERENT look: the round puck class, NOT a `.btn`.
    expect(btn.getAttribute('data-action-type')).toBe('forceSearch');
    expect(btn.className.split(' ')).toContain('action-badge');
    expect(btn.className.split(' ')).not.toContain('btn');
    // Icon-only: no visible label text, an inline currentColor SVG magnifier instead.
    expect(btn.textContent).toBe('');
    expect(btn.querySelector('svg')).toBeTruthy();
    // Still the sanctioned fire path.
    fireEvent.click(btn);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('the badge honors disabled and falls back to the composed label when no ariaLabel is given', () => {
    const { rerender } = wrap(
      <MediaAction action="forceSearch" presentation="badge" onFire={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Force Search' })).toBeTruthy();
    rerender(<MediaAction action="forceSearch" presentation="badge" onFire={() => {}} disabled />);
    expect(screen.getByRole('button', { name: 'Force Search' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('renders notOnDisk as an inert, disabled missing pill', () => {
    wrap(<MediaAction action="notOnDisk" />);
    const btn = screen.getByRole('button', { name: 'Not on Disk' });
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.className.split(' ')).toContain('btn--missing');
  });

  it('renders a destructive spec through the two-step ConfirmButton (arms, does not fire on first click)', () => {
    // Temporarily flip a spec to destructive to prove the path (no live action is destructive today).
    const original = MEDIA_ACTIONS.retryImport.destructive;
    MEDIA_ACTIONS.retryImport.destructive = true;
    try {
      const onFire = vi.fn();
      wrap(<MediaAction action="retryImport" onFire={onFire} />);
      const btn = screen.getByRole('button', { name: /Retry import/ });
      expect(btn.className.split(' ')).toContain('confirm-btn');
      fireEvent.click(btn); // first click ARMS, must not fire
      expect(onFire).not.toHaveBeenCalled();
      expect(btn.getAttribute('data-armed')).toBe('true');
    } finally {
      MEDIA_ACTIONS.retryImport.destructive = original;
    }
  });
});

// ── <ConsumeLink> ──
describe('ConsumeLink', () => {
  it('renders the primary external ↗ pill with safe target/rel', () => {
    wrap(<ConsumeLink label="Watch on Plex — Movies" url="https://app.plex.tv/x" />);
    const link = screen.getByRole('link', { name: /Watch on Plex — Movies/ });
    expect(link.getAttribute('href')).toBe('https://app.plex.tv/x');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.className.split(' ')).toContain('primary');
    expect(link.querySelector('.btn__ext')?.textContent).toContain('↗');
  });

  it('renders a paired-second consume as outline (no primary)', () => {
    wrap(<ConsumeLink label="Listen on Audiobookshelf" url="https://abs/x" variant="outline" />);
    const link = screen.getByRole('link', { name: /Listen on Audiobookshelf/ });
    expect(link.className.split(' ')).not.toContain('primary');
  });
});

// ── <ReservedActionSlot> ──
describe('ReservedActionSlot', () => {
  it('shows the resting children when there is no live node', () => {
    wrap(
      <ReservedActionSlot testId="slot">
        <MediaAction action="fix" onFire={() => {}} />
      </ReservedActionSlot>,
    );
    expect(screen.getByTestId('slot').className.split(' ')).toContain('action-slot');
    expect(screen.getByRole('button', { name: 'Fix' })).toBeTruthy();
  });

  it('swaps the resting content for the live node IN PLACE (buttons gone while live)', () => {
    wrap(
      <ReservedActionSlot testId="slot" reserve="head" live={<span data-testid="chip">live</span>}>
        <MediaAction action="fix" onFire={() => {}} />
      </ReservedActionSlot>,
    );
    expect(screen.getByTestId('chip')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fix' })).toBeNull();
    expect(screen.getByTestId('slot').className.split(' ')).toContain('action-slot--head');
  });
});

// ── <MediaActionBar> ──
describe('MediaActionBar', () => {
  it('owns the .detail-head__actions token in head placement', () => {
    wrap(
      <MediaActionBar placement="head" testId="bar">
        <MediaAction action="fix" onFire={() => {}} />
        <MediaAction action="forceSearch" onFire={() => {}} />
      </MediaActionBar>,
    );
    const bar = screen.getByTestId('bar');
    expect(bar.className.split(' ')).toContain('detail-head__actions');
    // ordering preserved: Fix before Force Search
    const labels = Array.from(bar.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Fix', 'Force Search']);
  });

  it('uses .media-action-bar for row placement', () => {
    wrap(
      <MediaActionBar placement="row" testId="bar">
        <MediaAction action="forceSearch" onFire={() => {}} />
      </MediaActionBar>,
    );
    expect(screen.getByTestId('bar').className.split(' ')).toContain('media-action-bar');
  });
});

// ── <MediaHero> ──
describe('MediaHero', () => {
  it('renders the shared detail-head scaffold with badges, consume and actions slots', () => {
    wrap(
      <MediaHero
        testId="hero"
        poster={<span data-testid="poster" />}
        title="The Thing"
        year={1982}
        badges={[
          { label: 'Movie', tone: 'muted' },
          { label: 'On disk', tone: 'ok', testId: 'disk-badge' },
        ]}
        meta="1h 49m · 4K"
        consume={<ConsumeLink label="Watch on Plex" url="https://p/x" />}
        actions={
          <MediaActionBar placement="head">
            <MediaAction action="fix" onFire={() => {}} />
          </MediaActionBar>
        }
      />,
    );
    const hero = screen.getByTestId('hero');
    expect(hero.className.split(' ')).toContain('detail-head');
    expect(hero.querySelector('.detail-head__title')?.textContent).toContain('The Thing');
    expect(hero.querySelector('.detail-head__title')?.textContent).toContain('1982');
    expect(screen.getByTestId('poster')).toBeTruthy();
    expect(screen.getByTestId('disk-badge').className.split(' ')).toContain('badge--ok');
    expect(hero.querySelector('.detail-head__play')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Watch on Plex/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fix' })).toBeTruthy();
  });

  it('omits the play row when there is no consume', () => {
    wrap(<MediaHero testId="hero" poster={null} title="X" />);
    expect(screen.getByTestId('hero').querySelector('.detail-head__play')).toBeNull();
  });
});
