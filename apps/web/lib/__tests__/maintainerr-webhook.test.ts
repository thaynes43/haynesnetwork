import { describe, expect, it } from 'vitest';
import {
  MAX_WEBHOOK_BODY_BYTES,
  parseMaintainerrWebhook,
  secretsMatch,
} from '../maintainerr-webhook';

describe('secretsMatch (constant-time shared-secret compare, ADR-023 webhook hardening)', () => {
  it('matches an identical secret', () => {
    expect(secretsMatch('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('rejects a wrong secret of the SAME length (no early bail)', () => {
    expect(secretsMatch('s3cr3t-tokeX', 's3cr3t-token')).toBe(false);
  });

  it('rejects a wrong secret of a DIFFERENT length without throwing (length guarded via hashing)', () => {
    expect(secretsMatch('short', 's3cr3t-token-much-longer')).toBe(false);
    expect(secretsMatch('s3cr3t-token-much-longer', 'short')).toBe(false);
  });

  it('rejects an absent/empty provided secret', () => {
    expect(secretsMatch(null, 'expected')).toBe(false);
    expect(secretsMatch(undefined, 'expected')).toBe(false);
    expect(secretsMatch('', 'expected')).toBe(false);
    expect(secretsMatch('provided', '')).toBe(false);
  });
});

describe('parseMaintainerrWebhook (validate + strip + cap, ADR-023 webhook hardening)', () => {
  it('maps the Overseerr-style keys to type/title/body', () => {
    const parsed = parseMaintainerrWebhook({
      notification_type: 'MEDIA_DELETED',
      subject: 'Cleaned up',
      message: '2 items removed',
    });
    expect(parsed).toMatchObject({ type: 'MEDIA_DELETED', title: 'Cleaned up', body: '2 items removed' });
  });

  it('falls back to media.title and sensible defaults', () => {
    const parsed = parseMaintainerrWebhook({ media: { title: 'The Movie' } });
    expect(parsed).toMatchObject({ type: 'event', title: 'The Movie', body: '' });
  });

  it('rejects a non-object body (returns null → the route answers 400)', () => {
    expect(parseMaintainerrWebhook('nope')).toBeNull();
    expect(parseMaintainerrWebhook(42)).toBeNull();
    expect(parseMaintainerrWebhook(['a', 'b'])).toBeNull();
    expect(parseMaintainerrWebhook(null)).toBeNull();
  });

  it('STRIPS arbitrary + prototype-polluting keys from the persisted payload', () => {
    const parsed = parseMaintainerrWebhook(
      JSON.parse(
        '{"subject":"ok","evil":"drop me","__proto__":{"polluted":true},"constructor":"x","nested":{"a":1}}',
      ),
    );
    expect(parsed).not.toBeNull();
    const payload = parsed!.payload;
    expect(Object.hasOwn(payload, 'evil')).toBe(false);
    expect(Object.hasOwn(payload, 'nested')).toBe(false);
    expect(Object.hasOwn(payload, 'constructor')).toBe(false);
    expect(Object.hasOwn(payload, '__proto__')).toBe(false);
    // ...and no global prototype pollution occurred.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(payload.subject).toBe('ok');
  });

  it('CAPS an oversized title and body so we never store unbounded strings', () => {
    const parsed = parseMaintainerrWebhook({
      subject: 'T'.repeat(5_000),
      message: 'B'.repeat(50_000),
    });
    expect(parsed!.title.length).toBeLessThanOrEqual(500);
    expect(parsed!.body.length).toBeLessThanOrEqual(4_000);
    expect((parsed!.payload.subject as string).length).toBeLessThanOrEqual(4_000);
  });

  it('exposes a body-size cap constant (~64KB) for the route to enforce pre-parse', () => {
    expect(MAX_WEBHOOK_BODY_BYTES).toBe(64 * 1024);
  });
});
