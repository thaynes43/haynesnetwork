// ADR-103 — the harness flag is honoured only on a localhost BETTER_AUTH_URL; anywhere else it is ignored (production
// behaviour stays on) and the process warns once.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetE2eHarnessWarningForTests, e2eHarnessActive } from '../src/e2e-harness';

describe('e2eHarnessActive (ADR-103)', () => {
  beforeEach(() => __resetE2eHarnessWarningForTests());

  it('is off when the flag is unset or not exactly 1, and says nothing', () => {
    const warn = vi.fn();
    expect(e2eHarnessActive({ BETTER_AUTH_URL: 'http://localhost:3100' }, warn)).toBe(false);
    expect(
      e2eHarnessActive(
        { HNET_E2E_HARNESS: 'true', BETTER_AUTH_URL: 'http://localhost:3100' },
        warn,
      ),
    ).toBe(false);
    expect(
      e2eHarnessActive({ HNET_E2E_HARNESS: '0', BETTER_AUTH_URL: 'http://localhost:3100' }, warn),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is on for localhost and 127.0.0.1, whatever the port or path', () => {
    const warn = vi.fn();
    for (const url of [
      'http://localhost:3100',
      'http://localhost:3000/',
      'http://127.0.0.1:3100/api/auth',
      'https://localhost',
    ]) {
      expect(e2eHarnessActive({ HNET_E2E_HARNESS: '1', BETTER_AUTH_URL: url }, warn), url).toBe(
        true,
      );
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('is ignored for any other host, and for hosts that only look local', () => {
    const warn = vi.fn();
    for (const url of [
      'https://haynesnetwork.com',
      'https://haynesnetwork.haynesops.com',
      'http://localhost.evil.example',
      'http://localhost@evil.example',
      'http://evil.example/?host=localhost',
      'http://127.0.0.2:3100',
      'http://[::1]:3100',
      'not a url',
      '',
    ]) {
      expect(e2eHarnessActive({ HNET_E2E_HARNESS: '1', BETTER_AUTH_URL: url }, warn), url).toBe(
        false,
      );
    }
    expect(e2eHarnessActive({ HNET_E2E_HARNESS: '1' }, warn)).toBe(false);
  });

  it('warns once per process when the flag is set but ignored, naming the host', () => {
    const warn = vi.fn();
    e2eHarnessActive(
      { HNET_E2E_HARNESS: '1', BETTER_AUTH_URL: 'https://haynesnetwork.com/' },
      warn,
    );
    e2eHarnessActive(
      { HNET_E2E_HARNESS: '1', BETTER_AUTH_URL: 'https://haynesnetwork.com/' },
      warn,
    );
    e2eHarnessActive({ HNET_E2E_HARNESS: '1' }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('haynesnetwork.com');
    expect(warn.mock.calls[0]![0]).toContain('ignored');
  });

  it('reads process.env by default', () => {
    vi.stubEnv('HNET_E2E_HARNESS', '1');
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3100');
    try {
      expect(e2eHarnessActive()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
