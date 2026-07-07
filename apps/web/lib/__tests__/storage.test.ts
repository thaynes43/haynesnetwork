// ADR-030 / DESIGN-013 D-05 — the /admin/storage presentation helpers. The capacity formatter is
// pinned to the owner's live cross-check numbers (ADR-030: 112.43 TB free / 529.96 TB total = 78.8%).
import { describe, expect, it } from 'vitest';
import {
  categoryResolutionLabel,
  cumulativeStepGeometry,
  formatCapacity,
  reclaimHeadline,
  sharePct,
  utilizationSummary,
  utilizationTone,
  windowDescription,
} from '../storage';

describe('formatCapacity (decimal/SI — disk-vendor convention)', () => {
  it('renders the live HaynesTower cross-check numbers', () => {
    expect(formatCapacity(112_430_400_000_000)).toBe('112.4 TB');
    expect(formatCapacity(529_960_000_000_000)).toBe('530 TB'); // ".0" dropped
  });
  it('renders the CephFS pool numbers', () => {
    // 130.45 floats as 130.4499… — toFixed lands on 130.4, which is a fine display.
    expect(formatCapacity(130_450_000_000_000)).toBe('130.4 TB');
    expect(formatCapacity(174_840_000_000_000)).toBe('174.8 TB');
  });
  it('handles small and degenerate values', () => {
    expect(formatCapacity(0)).toBe('0 B');
    expect(formatCapacity(-5)).toBe('0 B');
    expect(formatCapacity(999)).toBe('999 B');
    expect(formatCapacity(1_000)).toBe('1 KB');
    expect(formatCapacity(1_500_000_000)).toBe('1.5 GB');
  });
});

describe('utilizationTone', () => {
  it('is muted when the reading is unavailable', () => {
    expect(utilizationTone(null, 80)).toBe('muted');
  });
  it('deepens against the target: ok → warn (within 5) → danger (past)', () => {
    expect(utilizationTone(60, 80)).toBe('ok');
    expect(utilizationTone(74.9, 80)).toBe('ok');
    expect(utilizationTone(75, 80)).toBe('warn');
    expect(utilizationTone(78.8, 80)).toBe('warn'); // the live seeded pairing
    expect(utilizationTone(80, 80)).toBe('danger');
    expect(utilizationTone(92, 80)).toBe('danger');
  });
  it('falls back to absolute guardrails when no target is set', () => {
    expect(utilizationTone(25.4, null)).toBe('ok');
    expect(utilizationTone(85, null)).toBe('warn');
    expect(utilizationTone(95, null)).toBe('danger');
  });
});

describe('utilizationSummary', () => {
  it('formats the stat line', () => {
    expect(
      utilizationSummary({
        key: 'haynestower',
        label: 'HaynesTower',
        path: '/data/haynestower',
        freeSpace: 112_430_400_000_000,
        totalSpace: 529_960_000_000_000,
        usedPct: 78.8,
        target: 80,
        unavailable: false,
      }),
    ).toBe('78.8% used · 112.4 TB free of 530 TB');
  });
  it('is null for an unavailable array', () => {
    expect(
      utilizationSummary({
        key: 'cephfs',
        label: 'Music (CephFS)',
        path: null,
        freeSpace: null,
        totalSpace: null,
        usedPct: null,
        target: null,
        unavailable: true,
      }),
    ).toBeNull();
  });
});

describe('reclaim copy', () => {
  it('pluralizes the headline and keeps binary units (Trash-page agreement)', () => {
    expect(reclaimHeadline({ items: 0, reclaimedBytes: 0 })).toBe('Reclaimed 0 B across 0 items');
    expect(reclaimHeadline({ items: 1, reclaimedBytes: 1024 ** 3 })).toBe(
      'Reclaimed 1.0 GB across 1 item',
    );
  });
  it('describes windows', () => {
    expect(windowDescription('90d')).toBe('last 90 days');
    expect(windowDescription('365d')).toBe('last year');
    expect(windowDescription('all')).toBe('all time');
  });
  it('computes whole-percent shares, guarding zero totals', () => {
    expect(sharePct(90, 145)).toBe(62);
    expect(sharePct(0, 0)).toBe(0);
  });
  it('labels category × resolution rows', () => {
    expect(categoryResolutionLabel('movie', '2160p')).toBe('Movies · 2160p');
    expect(categoryResolutionLabel('tv', 'unknown')).toBe('TV · unknown');
  });
});

describe('cumulativeStepGeometry', () => {
  it('returns null when there is nothing to draw', () => {
    expect(cumulativeStepGeometry([], 600, 64)).toBeNull();
    expect(
      cumulativeStepGeometry(
        [{ day: '2026-07-01', reclaimedBytes: 0, cumulativeReclaimedBytes: 0 }],
        600,
        64,
      ),
    ).toBeNull();
  });
  it('steps from a zero baseline one day before the first sweep and holds to today', () => {
    const geo = cumulativeStepGeometry(
      [
        { day: '2026-07-01', reclaimedBytes: 100, cumulativeReclaimedBytes: 100 },
        { day: '2026-07-03', reclaimedBytes: 100, cumulativeReclaimedBytes: 200 },
      ],
      600,
      64,
      '2026-07-05',
    );
    expect(geo).not.toBeNull();
    // Domain: 06-30 → 07-05 (5 days). Baseline y = 62 (2px pad), max y = 2.
    // 07-01 = 1/5 of the span (x=120), 07-03 = 3/5 (x=360); the final H 600 holds to today.
    expect(geo!.line).toBe('M 0 62 H 120 V 32 H 360 V 2 H 600');
    expect(geo!.area).toBe('M 0 62 H 120 V 32 H 360 V 2 H 600 V 62 Z');
    expect(geo!.startDay).toBe('2026-06-30'); // the synthetic zero day — the honest axis start
  });
  it('renders a single swept day as a full-width step from the baseline', () => {
    const geo = cumulativeStepGeometry(
      [{ day: '2026-07-01', reclaimedBytes: 100, cumulativeReclaimedBytes: 100 }],
      600,
      64,
    );
    expect(geo!.line).toBe('M 0 62 H 600 V 2 H 600');
  });
});
