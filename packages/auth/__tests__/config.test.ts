import { afterEach, describe, expect, it, vi } from 'vitest';

// Config smoke test (DESIGN-002 D-02): the Better Auth instance constructs from env
// stubs alone — no DATABASE_URL (the @hnet/db client is lazy), no network. Env is
// stubbed per test and the module graph reset so config.ts re-reads it.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('betterAuth config (DESIGN-002 D-02)', () => {
  it('constructs with stub env: handler + session API exist, OIDC enabled', async () => {
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000');
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-test-secret-test-secret');
    vi.stubEnv('OIDC_CLIENT_ID', 'stub-client-id');
    vi.stubEnv('OIDC_CLIENT_SECRET', 'stub-client-secret');
    vi.stubEnv(
      'OIDC_DISCOVERY_URL',
      'http://127.0.0.1:9/.well-known/openid-configuration', // never fetched at construction
    );

    const { auth, oidcEnabled } = await import('../src/config');

    expect(oidcEnabled).toBe(true);
    expect(typeof auth.handler).toBe('function');
    expect(typeof auth.api.getSession).toBe('function');
    // 7-day session / daily refresh (AC-01) and the users model mapping survive
    // construction.
    expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24 * 7);
    expect(auth.options.session?.updateAge).toBe(60 * 60 * 24);
    expect(auth.options.user?.modelName).toBe('users');
    // No password surface (R-01 / CLAUDE.md rule 5) — the options literal simply
    // has no emailAndPassword block.
    expect('emailAndPassword' in auth.options).toBe(false);
  });

  it('buckets rate limiting by the real client IP behind the Cloudflare Tunnel', async () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://haynesnetwork.com');
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-test-secret-test-secret');

    const { auth } = await import('../src/config');

    // CF-Connecting-IP FIRST: behind cloudflared→traefik-external, x-forwarded-for/
    // x-real-ip carry the tunnel address (one shared bucket → household 429). Cloudflare
    // puts the real end-user IP in CF-Connecting-IP; better-auth walks headers in order,
    // so it must lead. LAN staging / dev have no CF header and fall through unchanged.
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
      'cf-connecting-ip',
      'x-forwarded-for',
      'x-real-ip',
    ]);
  });

  it('trusts the apex baseURL + the www origin from TRUSTED_ORIGINS (cutover)', async () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://haynesnetwork.com');
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-test-secret-test-secret');
    vi.stubEnv('TRUSTED_ORIGINS', 'https://www.haynesnetwork.com');

    const { auth } = await import('../src/config');

    expect(auth.options.trustedOrigins).toEqual([
      'https://haynesnetwork.com',
      'https://www.haynesnetwork.com',
    ]);
  });

  it('boots with OIDC disabled when client creds are absent (CI builds)', async () => {
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;

    const { auth, oidcEnabled } = await import('../src/config');

    expect(oidcEnabled).toBe(false);
    expect(typeof auth.handler).toBe('function');
  });
});
