// ADR-014 — the inline two-step confirm mechanism. The arm/fire/auto-revert state machine is
// a pure controller (no React, no DOM) so it is tested directly here; the resting DOM is
// checked with react-dom/server (no DOM package needed, matching the repo convention). The
// full click-through interaction is covered by the e2e suite in a real browser.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmButton, createConfirmController } from '../src/controls/ConfirmButton';

describe('createConfirmController (arm-to-confirm state machine)', () => {
  it('first trigger arms and fires nothing; second trigger (after the arm guard) fires once and disarms', () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      const armedLog: boolean[] = [];
      const c = createConfirmController({ onConfirm, onArmedChange: (a) => armedLog.push(a) });

      expect(c.armed).toBe(false);
      c.trigger();
      expect(c.armed).toBe(true);
      expect(onConfirm).not.toHaveBeenCalled();
      // Past the MIN_ARM_MS double-click guard, the second trigger fires.
      vi.advanceTimersByTime(500);
      c.trigger();
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(c.armed).toBe(false);
      expect(armedLog).toEqual([true, false]);
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a fire attempt within MIN_ARM_MS of arming (double-click / held Enter) — stays armed', () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      const c = createConfirmController({ onConfirm });
      c.trigger(); // arm
      expect(c.armed).toBe(true);
      vi.advanceTimersByTime(200); // < 400ms guard
      c.trigger(); // too soon → ignored
      expect(onConfirm).not.toHaveBeenCalled();
      expect(c.armed).toBe(true);
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-reverts after confirmMs without firing', () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      const c = createConfirmController({ onConfirm, confirmMs: 3000 });
      c.trigger();
      expect(c.armed).toBe(true);
      vi.advanceTimersByTime(3100);
      expect(c.armed).toBe(false);
      expect(onConfirm).not.toHaveBeenCalled();
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reArmOnFailure re-arms when the async action resolves "failed"', async () => {
    vi.useFakeTimers();
    try {
      const c = createConfirmController({
        onConfirm: () => Promise.resolve('failed'),
        reArmOnFailure: true,
      });
      c.trigger(); // arm
      vi.advanceTimersByTime(500); // clear the arm guard
      c.trigger(); // fire → resolves 'failed'
      await Promise.resolve();
      await Promise.resolve();
      expect(c.armed).toBe(true);
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays disarmed when the async action resolves "ok", or when reArmOnFailure is off', async () => {
    vi.useFakeTimers();
    try {
      const ok = createConfirmController({
        onConfirm: () => Promise.resolve('ok'),
        reArmOnFailure: true,
      });
      ok.trigger();
      vi.advanceTimersByTime(500);
      ok.trigger();
      await Promise.resolve();
      await Promise.resolve();
      expect(ok.armed).toBe(false);
      ok.dispose();

      const off = createConfirmController({ onConfirm: () => Promise.resolve('failed') });
      off.trigger();
      vi.advanceTimersByTime(500);
      off.trigger();
      await Promise.resolve();
      await Promise.resolve();
      expect(off.armed).toBe(false);
      off.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ConfirmButton resting render', () => {
  it('renders the resting label + confirm-btn class + resting aria-label, and no armed state', () => {
    const html = renderToStaticMarkup(
      <ConfirmButton
        className="btn sm danger"
        label="Delete"
        restingAriaLabel="Delete X — click twice to confirm"
        confirmAriaLabel="Confirm delete X"
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain('class="confirm-btn btn sm danger"');
    expect(html).toContain('aria-label="Delete X — click twice to confirm"');
    expect(html).toMatch(/>Delete<\/button>/);
    expect(html).not.toContain('data-armed');
    expect(html).not.toContain('confirming');
  });
});
