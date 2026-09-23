// DESIGN-049 D-01 (PLAN-068 S3) — no credential survives in anything an @hnet/arr error exposes.
// Tautulli (`apikey`) and TMDB v3 (`api_key`) can only authenticate in the QUERY STRING, and every
// ArrHttpError / ArrTimeoutError / ArrParseError used to embed the full request URL — so a Tautulli 5xx or
// a TMDB 401 wrote a live key into the sync logs. These tests drive the real clients into each error path
// and search EVERY exposed surface (message, stack, url, bodySnippet, issues, JSON, util.inspect) for the key.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ArrError,
  ArrHttpError,
  ArrParseError,
  ArrTimeoutError,
  MaintainerrWriteFailedError,
} from '../src/errors';
import { REDACTED, redactSecrets, redactUrl } from '../src/redact';
import { TautulliClient } from '../src/tautulli';
import { TmdbClient } from '../src/tmdb';
import { stubFetch, stubFetchHanging, stubFetchSequence } from './helpers';

const TAUTULLI_KEY = 'taut0123456789abcdef0123456789ab';
const TMDB_KEY = 'tmdb0123456789abcdef0123456789ab';
const PLEX_TOKEN = 'plexTokenSecret-XYZ';
const WEBHOOK_TOKEN = 'webhook-secret-777';
const ALL_SECRETS = [TAUTULLI_KEY, TMDB_KEY, PLEX_TOKEN, WEBHOOK_TOKEN];

/** Every surface an error exposes to a logger, a tRPC mapper, a DB column or a test snapshot. */
function surfaces(error: unknown): string[] {
  const e = error as Record<string, unknown> & Error;
  return [
    String(e),
    e.message,
    e.stack ?? '',
    String(e.url ?? ''),
    String(e.bodySnippet ?? ''),
    JSON.stringify(e.issues ?? []),
    JSON.stringify(e),
    inspect(e, { depth: 5, showHidden: true }),
  ];
}

function expectNoSecret(error: unknown, secrets: readonly string[] = ALL_SECRETS): void {
  expect(error).toBeInstanceOf(ArrError);
  for (const surface of surfaces(error)) {
    for (const secret of secrets) {
      expect(surface, `a surface leaked ${secret.slice(0, 4)}…`).not.toContain(secret);
    }
  }
}

describe('redactUrl / redactSecrets', () => {
  it('redacts apikey, api_key, token and X-Plex-Token values, case-insensitively, keeping everything else', () => {
    const url =
      `http://tautulli.media.svc.cluster.local:8181/api/v2?APIKEY=${TAUTULLI_KEY}&cmd=get_history` +
      `&Api_Key=${TMDB_KEY}&x-plex-token=${PLEX_TOKEN}&TOKEN=${WEBHOOK_TOKEN}&user_id=12874060#frag`;
    const out = redactUrl(url);
    expect(out).toBe(
      `http://tautulli.media.svc.cluster.local:8181/api/v2?APIKEY=${REDACTED}&cmd=get_history` +
        `&Api_Key=${REDACTED}&x-plex-token=${REDACTED}&TOKEN=${REDACTED}&user_id=12874060#frag`,
    );
  });

  it('catches a percent-encoded name, repeated params, empty values and encoded values', () => {
    expect(redactUrl(`https://plex.test/x?X%2DPlex%2DToken=${PLEX_TOKEN}`)).toBe(
      `https://plex.test/x?X%2DPlex%2DToken=${REDACTED}`,
    );
    expect(redactUrl(`http://t/api?apikey=a1&apikey=${TAUTULLI_KEY}`)).toBe(
      `http://t/api?apikey=${REDACTED}&apikey=${REDACTED}`,
    );
    expect(redactUrl('http://t/api?apikey=&cmd=x')).toBe(`http://t/api?apikey=${REDACTED}&cmd=x`);
    expect(redactUrl('http://t/api?api_key=a%2Bb%3D%3D')).toBe(`http://t/api?api_key=${REDACTED}`);
  });

  it('leaves look-alike names and key-free URLs untouched', () => {
    const benign = 'http://t/api?csrf_token=1&tokens=2&api_key_id=3&apikeys=4&query=token%3Dx';
    expect(redactUrl(benign)).toBe(benign);
    expect(redactUrl('http://sonarr.test:8989/api/v3/series/1')).toBe('http://sonarr.test:8989/api/v3/series/1');
  });

  it('catches what a &-split cannot see: a ;-joined pair, colon and quoted forms, a cut-off JSON value', () => {
    expect(redactUrl(`http://t/api?cmd=x;apikey=${TAUTULLI_KEY}`)).toBe(`http://t/api?cmd=x;apikey=${REDACTED}`);
    const out = redactSecrets(
      `X-Plex-Token: ${PLEX_TOKEN} | {'apikey': '${TAUTULLI_KEY}'} | token : ${WEBHOOK_TOKEN} | {"api_key":"${TMDB_KEY.slice(0, 12)}`,
    );
    for (const secret of ALL_SECRETS) expect(out).not.toContain(secret.slice(0, 8));
    expect(out).toContain(`X-Plex-Token: ${REDACTED}`);
    expect(out).toContain(`'apikey': '${REDACTED}'`);
    expect(out.endsWith(`"api_key":"${REDACTED}`)).toBe(true);
  });

  it('redactSecrets scrubs name=value pairs and JSON fields in free text (echoed error bodies)', () => {
    const text =
      `The path '/api/v2?apikey=${TAUTULLI_KEY}&cmd=x' was not found. ` +
      `{"api_key":"${TMDB_KEY}","token": "${WEBHOOK_TOKEN}","status_code":7} X-Plex-Token=${PLEX_TOKEN}`;
    const out = redactSecrets(text);
    for (const secret of ALL_SECRETS) expect(out).not.toContain(secret);
    expect(out).toContain(`apikey=${REDACTED}&cmd=x`);
    expect(out).toContain(`"api_key":"${REDACTED}"`);
    expect(out).toContain('"status_code":7');
  });
});

describe('ArrError subclasses never expose a credential', () => {
  const keyUrl =
    `http://tautulli.test:8181/api/v2?apikey=${TAUTULLI_KEY}&cmd=get_history&api_key=${TMDB_KEY}` +
    `&X-Plex-Token=${PLEX_TOKEN}&token=${WEBHOOK_TOKEN}`;

  it('ArrHttpError — message, url and an echoed body snippet', () => {
    const error = new ArrHttpError(500, 'GET', keyUrl, `upstream said: GET ${keyUrl} failed`);
    expectNoSecret(error);
    expect(error.status).toBe(500);
    expect(error.url).toContain(`apikey=${REDACTED}&cmd=get_history`);
    expect(error.message).toContain('→ HTTP 500');
    expect(error.bodySnippet).toContain('upstream said');
  });

  it('ArrTimeoutError, ArrParseError and MaintainerrWriteFailedError', () => {
    expectNoSecret(new ArrTimeoutError('GET', keyUrl, 1000));
    const parse = new ArrParseError('GET', keyUrl, ['response.data: expected object']);
    expectNoSecret(parse);
    expect(parse.issues).toEqual(['response.data: expected object']);
    expectNoSecret(new MaintainerrWriteFailedError('POST', keyUrl, 'Failed - no metadata'));
  });

  it('the stored issues and upstream message are redacted too, not only the message', () => {
    const parse = new ArrParseError('GET', 'http://t/x', [`response.data: got token=${WEBHOOK_TOKEN}`]);
    expect(parse.issues).toEqual([`response.data: got token=${REDACTED}`]);
    expectNoSecret(parse);
    const failed = new MaintainerrWriteFailedError('POST', 'http://m/x', `bad apikey=${TAUTULLI_KEY}`);
    expect(failed.upstreamMessage).toBe(`bad apikey=${REDACTED}`);
    expectNoSecret(failed);
  });
});

describe('the real clients, driven into each error path', () => {
  const TAUT = { baseUrl: 'http://tautulli.test:8181', apiKey: TAUTULLI_KEY, retryDelayMs: 0 } as const;

  it('Tautulli HTTP 500 whose body echoes the request URL → ArrHttpError without the key', async () => {
    const { fetchImpl } = stubFetchSequence([
      { status: 500, body: { message: `boom for /api/v2?apikey=${TAUTULLI_KEY}&cmd=get_history` } },
    ]);
    const error = await new TautulliClient({ ...TAUT, fetchImpl })
      .getHistory({ length: 5 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArrHttpError);
    expectNoSecret(error);
    expect((error as ArrHttpError).url).toContain('cmd=get_history'); // still diagnosable
  });

  it('a key straddling the 300-character body-snippet limit leaves no prefix behind', async () => {
    // The limit lands inside the JSON value; redacting before cutting keeps even a prefix out.
    const body = { message: 'x'.repeat(264), apikey: TAUTULLI_KEY }; // the key starts at char 288
    const { fetchImpl } = stubFetchSequence([{ status: 400, body }]);
    const error = await new TautulliClient({ ...TAUT, fetchImpl }).getHistory().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArrHttpError);
    for (const surface of surfaces(error)) expect(surface).not.toContain(TAUTULLI_KEY.slice(0, 8));
  });

  it('Tautulli timeout → ArrTimeoutError without the key', async () => {
    const { fetchImpl } = stubFetchHanging();
    const error = await new TautulliClient({ ...TAUT, fetchImpl, timeoutMs: 5 })
      .getLibrariesTable()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArrTimeoutError);
    expectNoSecret(error);
  });

  it('Tautulli schema drift → ArrParseError without the key', async () => {
    const { fetchImpl } = stubFetch([
      { path: '/api/v2', body: { response: { result: 'success', data: { data: 'not-an-array' } } } },
    ]);
    const error = await new TautulliClient({ ...TAUT, fetchImpl }).getHistory().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArrParseError);
    expectNoSecret(error);
  });

  it('TMDB v3 (api_key in the query) 401 → ArrHttpError without the key', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        path: /\/3\/movie\/\d+$/,
        status: 401,
        body: { status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.', success: false },
      },
    ]);
    const error = await new TmdbClient({ apiKey: TMDB_KEY, retryDelayMs: 0, fetchImpl })
      .getMovie(603)
      .catch((e: unknown) => e);
    expect(calls[0]!.url.searchParams.get('api_key')).toBe(TMDB_KEY); // the key really rode the query
    expect(error).toBeInstanceOf(ArrHttpError);
    expectNoSecret(error);
  });
});
