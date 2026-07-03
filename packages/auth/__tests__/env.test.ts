import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OIDC_DISCOVERY_URL,
  DEV_FALLBACK_SECRET,
  assertAuthEnv,
  authEnv,
  parseBootstrapAdminEmails,
} from '../src/env';

// Pure env parsing — tests pass explicit env objects; nothing reads .env.local.

describe('parseBootstrapAdminEmails (DESIGN-002 D-05/D-08)', () => {
  it('splits on commas, trims whitespace, lowercases, drops empty segments', () => {
    expect(parseBootstrapAdminEmails(' Manofoz@Gmail.com , t.haynes43@GMAIL.COM ,, ')).toEqual([
      'manofoz@gmail.com',
      't.haynes43@gmail.com',
    ]);
  });

  it('returns [] for unset or empty input', () => {
    expect(parseBootstrapAdminEmails(undefined)).toEqual([]);
    expect(parseBootstrapAdminEmails('')).toEqual([]);
    expect(parseBootstrapAdminEmails(' , ')).toEqual([]);
  });
});

describe('authEnv (DESIGN-002 D-08)', () => {
  it('applies the documented defaults when optional vars are unset', () => {
    const env = authEnv({} as NodeJS.ProcessEnv);
    expect(env.baseUrl).toBe('http://localhost:3000');
    expect(env.secret).toBe(DEV_FALLBACK_SECRET);
    expect(env.oidcDiscoveryUrl).toBe(DEFAULT_OIDC_DISCOVERY_URL);
    expect(env.oidcEnabled).toBe(false);
    expect(env.bootstrapAdminEmails).toEqual([]);
  });

  it('enables OIDC only when both client id and secret are present', () => {
    expect(authEnv({ OIDC_CLIENT_ID: 'id' } as NodeJS.ProcessEnv).oidcEnabled).toBe(false);
    expect(authEnv({ OIDC_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv).oidcEnabled).toBe(false);
    const env = authEnv({
      OIDC_CLIENT_ID: 'id',
      OIDC_CLIENT_SECRET: 's',
      OIDC_DISCOVERY_URL: 'https://stub.local/.well-known/openid-configuration',
    } as NodeJS.ProcessEnv);
    expect(env.oidcEnabled).toBe(true);
    expect(env.oidcDiscoveryUrl).toBe('https://stub.local/.well-known/openid-configuration');
  });
});

describe('assertAuthEnv (startup validation)', () => {
  const complete = {
    BETTER_AUTH_SECRET: 'a-real-32-char-secret-value-here!!',
    BETTER_AUTH_URL: 'https://haynesnetwork.com',
    OIDC_CLIENT_ID: 'client-id',
    OIDC_CLIENT_SECRET: 'client-secret',
    BOOTSTRAP_ADMIN_EMAILS: 'manofoz@gmail.com,t.haynes43@gmail.com',
  } as NodeJS.ProcessEnv;

  it('returns the parsed env when everything required is set', () => {
    const env = assertAuthEnv(complete);
    expect(env.oidcEnabled).toBe(true);
    expect(env.bootstrapAdminEmails).toHaveLength(2);
  });

  it('throws naming every missing required variable at once', () => {
    expect(() => assertAuthEnv({} as NodeJS.ProcessEnv)).toThrow(
      /BETTER_AUTH_SECRET, BETTER_AUTH_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, BOOTSTRAP_ADMIN_EMAILS/,
    );
    expect(() =>
      assertAuthEnv({ ...complete, OIDC_CLIENT_SECRET: undefined } as NodeJS.ProcessEnv),
    ).toThrow(/OIDC_CLIENT_SECRET/);
  });

  it('refuses the dev fallback secret in a validated environment', () => {
    expect(() =>
      assertAuthEnv({ ...complete, BETTER_AUTH_SECRET: DEV_FALLBACK_SECRET } as NodeJS.ProcessEnv),
    ).toThrow(/dev fallback/);
  });
});
