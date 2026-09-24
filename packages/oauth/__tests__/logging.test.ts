// ADR-091 / DESIGN-050 D-06 — the `[auth]` log: one `[auth] <event> {json}` line per event, masked
// fingerprints (the first 6 hex characters of the SHA-256), and NEVER a token, code, client secret or verifier.
// The domain suite runs the same regex over a whole flow; this one covers every line the pure package emits.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthError,
  authEvent,
  decideBearer,
  decideCodeExchange,
  decideRefresh,
  fingerprint,
  hashToken,
  loggableResource,
  randomToken,
  redirectHost,
  validateAuthorizationParams,
  type AuthEventName,
} from '../src/index';
import { ENV, NOW, RESOURCE, captureLogs, pkcePair, secondsAfter } from './helpers';

afterEach(() => vi.restoreAllMocks());

/** Every D-06 event name (plus `refresh_rejected`) — the Loki alerts (D-11) count on these exact strings. */
const EVENTS: AuthEventName[] = [
  'client_registered',
  'authorize_started',
  'authorize_rejected',
  'consent_shown',
  'consent_granted',
  'consent_denied',
  'token_issued',
  'token_refreshed',
  'refresh_reuse_detected',
  'refresh_rejected',
  'token_revoked',
  'code_replayed',
  'audience_mismatch',
  'rate_limited',
];

export const LINE = /^\[auth\] [a-z_]+ \{.*\}$/;

describe('D-06 — the [auth] line format', () => {
  it('every event is one line: `[auth] <event> {json}` (an empty object when there is no data)', () => {
    const logs = captureLogs();
    for (const e of EVENTS) authEvent(e, { client_id: 'x' });
    authEvent('rate_limited');
    expect(logs.lines).toHaveLength(EVENTS.length + 1);
    for (const line of logs.lines) expect(line).toMatch(LINE);
    expect(logs.lines.at(-1)).toBe('[auth] rate_limited {}');
    // One call, one argument — the line survives Loki's line-oriented ingestion intact.
    expect(logs.spy.mock.calls.every((c) => c.length === 1)).toBe(true);
  });

  it('a newline or quote inside data cannot break the line (JSON-escaped)', () => {
    const logs = captureLogs();
    authEvent('client_registered', { client_name: 'evil\n[auth] consent_granted {"x":1}' });
    expect(logs.lines).toHaveLength(1);
    expect(logs.lines[0]!.split('\n')).toHaveLength(1);
  });

  it('fingerprints are the first 6 hex characters of the SHA-256 — never part of the credential', () => {
    const token = randomToken();
    expect(fingerprint(token)).toBe(hashToken(token).slice(0, 6));
    expect(fingerprint(token)).toMatch(/^[0-9a-f]{6}$/);
    expect(token).not.toContain(fingerprint(token));
    expect(redirectHost('https://chatgpt.com/connector/oauth/abc')).toBe('chatgpt.com');
    expect(redirectHost('not a url')).toBe('?');
  });

  it('a client-supplied resource is logged as origin + path, capped, with token-like runs masked', () => {
    expect(loggableResource('https://haynesnetwork.com/api/mcp?x=1#y')).toBe(
      'https://haynesnetwork.com/api/mcp',
    );
    const token = randomToken();
    expect(loggableResource(`https://evil.example/${token}`)).toBe('https://evil.example/…');
    expect(loggableResource('x'.repeat(500)).length).toBeLessThanOrEqual(120);
    expect(loggableResource(`not a url ${token}`)).not.toContain(token);
  });
});

describe('D-06 — no credential ever reaches a log line', () => {
  it('the pure package logs (replay, audience mismatch) carry no code, token or verifier', () => {
    const { verifier, challenge } = pkcePair(randomToken() + randomToken().slice(0, 10));
    const code = randomToken();
    const refresh = randomToken();
    const logs = captureLogs();
    const client = {
      clientId: 'a'.repeat(32),
      grantTypes: ['authorization_code', 'refresh_token'],
    };
    const rec = {
      id: 'c',
      clientId: client.clientId,
      userId: 'u',
      redirectUri: 'https://c.example/cb',
      scopes: ['watch:read' as const],
      resource: RESOURCE,
      codeChallenge: challenge,
      expiresAt: secondsAfter(NOW, 30),
      consumedAt: NOW,
    };
    const attempts = [
      () => decideCodeExchange(rec, client, { code, codeVerifier: verifier }, NOW),
      () =>
        decideCodeExchange(
          { ...rec, consumedAt: null },
          client,
          { code, codeVerifier: verifier, resource: 'https://evil.example/mcp' },
          NOW,
        ),
      () =>
        decideRefresh(
          {
            id: 'r',
            familyId: 'f',
            clientId: client.clientId,
            userId: 'u',
            scopes: ['offline_access'],
            resource: RESOURCE,
            expiresAt: secondsAfter(NOW, 99),
            rotatedAt: null,
            revokedAt: null,
          },
          client,
          { resource: `https://evil.example/${refresh}` },
          NOW,
        ),
      () =>
        validateAuthorizationParams(
          {
            responseType: 'code',
            state: 's',
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
            resources: ['https://x.example/mcp'],
          },
          { env: ENV },
        ),
      () =>
        decideBearer(
          {
            scopes: ['watch:read'],
            resource: 'https://old.example/mcp',
            expiresAt: secondsAfter(NOW, 9),
            revokedAt: null,
            clientId: client.clientId,
          },
          { now: NOW, env: ENV },
        ),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (e) {
        if (!(e instanceof OAuthError)) throw e;
      }
    }
    expect(logs.lines.length).toBeGreaterThanOrEqual(5);
    const secrets = [code, verifier, challenge];
    const all = logs.lines.join('\n');
    for (const line of logs.lines) expect(line).toMatch(LINE);
    for (const s of secrets)
      expect(all, 'a credential leaked into the [auth] log').not.toContain(s);
    // A 43-character base64url run is exactly the shape of our tokens, codes and challenges: none may appear.
    expect(all).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});
