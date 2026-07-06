// DESIGN-007 D-03/D-11 — network-error taxonomy + retry semantics for the shared Plex fetch
// wrapper. A DNS/connection failure (undici's raw `TypeError: fetch failed`) must be wrapped in
// a typed PlexNetworkError (host named, token never echoed, original as `cause`) so it stays
// inside the PlexError taxonomy instead of leaking bare — the live 2026-07-06 haynestower defect.
import { describe, expect, it } from 'vitest';
import { PlexNetworkError, PlexTimeoutError } from '../src/errors';
import { PlexReadClient } from '../src/read';
import { PlexWriteClient } from '../src/write';
import { TEST_CLIENT_OPTIONS } from './helpers';

/** A fetchImpl that always rejects network-style (undici's TypeError), counting attempts. */
function rejectingFetch(error: unknown): { fetchImpl: typeof fetch; count: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw error;
  }) as unknown as typeof fetch;
  return { fetchImpl, count: () => calls };
}

describe('PlexNetworkError (network-level failure wrapping)', () => {
  it('wraps a raw `TypeError: fetch failed` into PlexNetworkError, host named, token never echoed', async () => {
    const cause = new TypeError('fetch failed');
    const { fetchImpl } = rejectingFetch(cause);
    const client = new PlexReadClient({ ...TEST_CLIENT_OPTIONS, fetchImpl });

    const error = await client.listSections().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlexNetworkError);
    const net = error as PlexNetworkError;
    expect(net.message).toContain('plexops.test'); // names the failed host
    expect(net.message).not.toContain(TEST_CLIENT_OPTIONS.token); // never the token
    expect(net.cause).toBe(cause); // original preserved for logs
    expect(net.code).toBe('PLEX_NETWORK_ERROR');
  });

  it('wraps ENOTFOUND / ECONNREFUSED style errors the same way', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND haynestower.media.svc'), {
      code: 'ENOTFOUND',
    });
    const { fetchImpl } = rejectingFetch(cause);
    const client = new PlexReadClient({ ...TEST_CLIENT_OPTIONS, fetchImpl });
    await expect(client.getIdentity()).rejects.toBeInstanceOf(PlexNetworkError);
  });

  it('retries a network failure on a GET (idempotent) — 3 attempts before giving up', async () => {
    const { fetchImpl, count } = rejectingFetch(new TypeError('fetch failed'));
    const client = new PlexReadClient({ ...TEST_CLIENT_OPTIONS, fetchImpl });
    await expect(client.listSections()).rejects.toBeInstanceOf(PlexNetworkError);
    expect(count()).toBe(3); // 1 + GET_RETRIES(2)
  });

  it('NEVER retries a network failure on a write — a POST is attempted exactly once', async () => {
    const { fetchImpl, count } = rejectingFetch(new TypeError('fetch failed'));
    const client = new PlexWriteClient({ ...TEST_CLIENT_OPTIONS, fetchImpl });
    await expect(
      client.createSharedServer({ invitedUserId: 42, librarySectionIds: [1] }),
    ).rejects.toBeInstanceOf(PlexNetworkError);
    expect(count()).toBe(1);
  });

  it('an aborted request is still a PlexTimeoutError, not a PlexNetworkError', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          // Mirror undici: an aborted fetch rejects with an AbortError DOMException/TypeError.
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const client = new PlexReadClient({ ...TEST_CLIENT_OPTIONS, fetchImpl, timeoutMs: 10 });
    const error = await client.listSections().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlexTimeoutError);
    expect(error).not.toBeInstanceOf(PlexNetworkError);
  });
});
