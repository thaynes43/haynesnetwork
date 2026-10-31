import { describe, expect, it } from 'vitest';
import {
  QbittorrentClient,
  ProwlarrReadClient,
  computeUnsatisfied,
  MAM_SEED_OBLIGATION_SECONDS,
} from '../src/read';
import { ProwlarrWriteClient } from '../src/write';
import { assertGovernorClientsEnv } from '../src/config';
import { DownloadsConfigError, DownloadsHttpError } from '../src/errors';

// ADR-054 / DESIGN-027 (PLAN-039) — the downloads-stack clients the MAM governor drives. Pure fetch-stub
// tests (ADR-010: no live-API tests in CI). The counting is the compliance-critical piece — the live
// 2026-07-11 snapshot (13 complete `books-mam` torrents, all seeding_time well under 72h → 13 unsatisfied)
// is reproduced as the acceptance fixture. The gate seam is Prowlarr's indexer `enable` flag (GET-then-PUT).

const under72 = MAM_SEED_OBLIGATION_SECONDS - 1;
const over72 = MAM_SEED_OBLIGATION_SECONDS + 1;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('computeUnsatisfied (pure)', () => {
  it('counts a complete torrent under 72h seed as unsatisfied, at/over 72h as satisfied', () => {
    const c = computeUnsatisfied([
      { progress: 1, seeding_time: under72 },
      { progress: 1, seeding_time: over72 },
      { progress: 1, seeding_time: MAM_SEED_OBLIGATION_SECONDS }, // exactly 72h ⇒ satisfied
    ]);
    expect(c).toEqual({ total: 3, downloading: 0, seedingUnder72: 1, unsatisfied: 1 });
  });

  it('counts still-downloading (progress < 1) as unsatisfied regardless of seed time', () => {
    const c = computeUnsatisfied([
      { progress: 0.5, seeding_time: 0 },
      { progress: 0.99, seeding_time: over72 },
    ]);
    expect(c).toEqual({ total: 2, downloading: 2, seedingUnder72: 0, unsatisfied: 2 });
  });

  it('defaults a missing progress/seeding_time to the conservative (unsatisfied) side', () => {
    const c = computeUnsatisfied([{}, { seeding_time: over72 }]);
    // {} ⇒ progress 0 ⇒ downloading; {seeding_time:over72} ⇒ progress 0 ⇒ downloading.
    expect(c).toEqual({ total: 2, downloading: 2, seedingUnder72: 0, unsatisfied: 2 });
  });

  it('reproduces the live 2026-07-11 snapshot: 13 complete, all under 72h ⇒ 13 unsatisfied', () => {
    const torrents = Array.from({ length: 13 }, () => ({ progress: 1, seeding_time: 2000 }));
    const c = computeUnsatisfied(torrents);
    expect(c.unsatisfied).toBe(13);
    expect(c.seedingUnder72).toBe(13);
    expect(c.downloading).toBe(0);
  });
});

describe('QbittorrentClient.countUnsatisfied', () => {
  it('GETs torrents/info for the category (no auth header) and folds the array', async () => {
    let seenUrl = '';
    const client = new QbittorrentClient({
      baseUrl: 'http://qb:8080/',
      fetchImpl: async (input) => {
        seenUrl = String(input);
        return jsonResponse([
          { state: 'stalledUP', progress: 1, seeding_time: 700 },
          { state: 'stalledUP', progress: 1, seeding_time: over72 },
          { state: 'downloading', progress: 0.2, seeding_time: 0 },
        ]);
      },
    });
    const c = await client.countUnsatisfied('books-mam');
    expect(seenUrl).toBe('http://qb:8080/api/v2/torrents/info?category=books-mam');
    expect(c).toEqual({ total: 3, downloading: 1, seedingUnder72: 1, unsatisfied: 2 });
  });

  it('throws DownloadsHttpError on a non-2xx (so the governor fails closed)', async () => {
    const client = new QbittorrentClient({
      baseUrl: 'http://qb:8080',
      fetchImpl: async () => jsonResponse({}, 403),
    });
    await expect(client.countUnsatisfied('books-mam')).rejects.toBeInstanceOf(DownloadsHttpError);
  });

  it('throws on a malformed body', async () => {
    const client = new QbittorrentClient({
      baseUrl: 'http://qb:8080',
      fetchImpl: async () => jsonResponse({ not: 'an array' }),
    });
    await expect(client.countUnsatisfied('books-mam')).rejects.toBeInstanceOf(DownloadsHttpError);
  });
});

describe('ProwlarrReadClient.getIndexerEnabled', () => {
  it('GETs the indexer with X-Api-Key and returns its enable flag', async () => {
    let seenUrl = '';
    let seenKey = '';
    const client = new ProwlarrReadClient({
      baseUrl: 'http://prowlarr:9696',
      apiKey: 'PK',
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        seenKey = String((init?.headers as Record<string, string>)['X-Api-Key']);
        return jsonResponse({
          id: 17,
          name: 'MyAnonaMouse',
          enable: true,
          priority: 50,
          fields: [],
        });
      },
    });
    expect(await client.getIndexerEnabled(17)).toBe(true);
    expect(seenUrl).toBe('http://prowlarr:9696/api/v1/indexer/17');
    expect(seenKey).toBe('PK');
  });

  it('throws (state unknown) on a non-2xx', async () => {
    const client = new ProwlarrReadClient({
      baseUrl: 'http://prowlarr:9696',
      apiKey: 'PK',
      fetchImpl: async () => jsonResponse({}, 401),
    });
    await expect(client.getIndexerEnabled(17)).rejects.toBeInstanceOf(DownloadsHttpError);
  });

  it('throws when the indexer body lacks a boolean enable', async () => {
    const client = new ProwlarrReadClient({
      baseUrl: 'http://prowlarr:9696',
      apiKey: 'PK',
      fetchImpl: async () => jsonResponse({ id: 17, name: 'MyAnonaMouse' }),
    });
    await expect(client.getIndexerEnabled(17)).rejects.toBeInstanceOf(DownloadsHttpError);
  });
});

describe('ProwlarrWriteClient.setIndexerEnabled', () => {
  it.each([true, false])(
    'GET-then-PUTs the full object with ONLY enable=%s changed',
    async (enabled) => {
      const calls: Array<{ method: string; body?: unknown }> = [];
      const indexer = {
        id: 17,
        name: 'MyAnonaMouse',
        enable: true,
        priority: 50,
        fields: [{ name: 'x', value: 'y' }],
      };
      const client = new ProwlarrWriteClient({
        baseUrl: 'http://prowlarr:9696',
        apiKey: 'PK',
        fetchImpl: async (input, init) => {
          const method = init?.method ?? 'GET';
          calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
          if (method === 'GET') return jsonResponse(indexer);
          return jsonResponse({ ...JSON.parse(String(init!.body)) }, 202); // echo
        },
      });
      await client.setIndexerEnabled(17, enabled);
      expect(calls[0]!.method).toBe('GET');
      expect(calls[1]!.method).toBe('PUT');
      // ONLY enable changed; every other field preserved verbatim.
      expect(calls[1]!.body).toEqual({ ...indexer, enable: enabled });
    },
  );

  it('throws when the PUT echoes a value that did not take (phantom success guard)', async () => {
    const client = new ProwlarrWriteClient({
      baseUrl: 'http://prowlarr:9696',
      apiKey: 'PK',
      fetchImpl: async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET')
          return jsonResponse({ id: 17, enable: true, fields: [] });
        return jsonResponse({ id: 17, enable: true, fields: [] }, 202); // asked for false, still true
      },
    });
    await expect(client.setIndexerEnabled(17, false)).rejects.toBeInstanceOf(DownloadsHttpError);
  });

  it('throws on a non-2xx PUT', async () => {
    const client = new ProwlarrWriteClient({
      baseUrl: 'http://prowlarr:9696',
      apiKey: 'PK',
      fetchImpl: async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET')
          return jsonResponse({ id: 17, enable: true, fields: [] });
        return jsonResponse({}, 500);
      },
    });
    await expect(client.setIndexerEnabled(17, false)).rejects.toBeInstanceOf(DownloadsHttpError);
  });

  it('reports a fixed MAM authentication reason for a refused validation save', async () => {
    const client = new ProwlarrWriteClient({
      baseUrl: 'http://prowlarr:9696',
      apiKey: 'PK',
      fetchImpl: async (_input, init) =>
        init?.method === 'PUT'
          ? jsonResponse(
              [
                {
                  propertyName: '',
                  errorMessage: 'You are not signed in. mam_id expired or invalid',
                },
              ],
              400,
            )
          : jsonResponse({ id: 17, name: 'MyAnonaMouse', enable: false, fields: [] }),
    });
    const error = await client.setIndexerEnabled(17, true).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DownloadsHttpError);
    expect(error).toMatchObject({
      status: 400,
      url: 'http://prowlarr:9696/api/v1/indexer/17',
      message:
        'downloads request http://prowlarr:9696/api/v1/indexer/17 failed (HTTP 400): mam_auth_invalid: MAM session expired, invalid, or not signed in',
    });
  });

  async function refusedSave(response: Response, name = 'MyAnonaMouse', enabled = true) {
    const calls: string[] = [];
    const client = new ProwlarrWriteClient({
      baseUrl: 'http://prowlarr:9696',
      apiKey: 'PK',
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return init?.method === 'PUT' ? response : jsonResponse({ id: 17, name, enable: !enabled });
      },
    });
    const error = await client.setIndexerEnabled(17, enabled).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DownloadsHttpError);
    expect(calls).toEqual([
      'GET http://prowlarr:9696/api/v1/indexer/17',
      'PUT http://prowlarr:9696/api/v1/indexer/17',
    ]);
    return error as DownloadsHttpError;
  }

  const genericRefusal =
    'downloads request http://prowlarr:9696/api/v1/indexer/17 failed (HTTP 400)';
  const mamReason = 'mam_auth_invalid: MAM session expired, invalid, or not signed in';

  it.each([
    'mam_id expired or invalid',
    'mam_id invalid',
    'mam_id expired',
    'You are not signed in',
  ])('classifies a known MAM validation without leaking any remote field: %s', async (reason) => {
    // Synthetic markers only. JSON escapes, percent encoding, HTML entities and newlines must never echo.
    const marker =
      'COOKIE_MARKER\nAPIKEY_MARKER https://URL_MARKER/?key=SECRET_MARKER %43OOKIE_MARKER &#65;PIKEY_MARKER';
    const response = jsonResponse(
      [
        {
          propertyName: marker,
          errorMessage: `${reason}\n${marker}`,
          attemptedValue: marker,
          customState: { cookie: marker, apiKey: marker },
        },
      ],
      400,
    );
    const error = await refusedSave(response);
    expect(error.message).toBe(`${genericRefusal}: ${mamReason}`);
    expect(JSON.stringify(error)).not.toContain('MARKER');
  });

  it.each([
    '{malformed JSON',
    '<html>You are not signed in. mam_id expired or invalid</html>',
    JSON.stringify({ errorMessage: 'You are not signed in' }),
    JSON.stringify([{ propertyName: 'apiKey', errorMessage: 'Unknown validation SECRET_MARKER' }]),
    JSON.stringify([{ propertyName: '', errorMessage: 'mam_id expires tomorrow' }]),
    JSON.stringify([{ propertyName: '', errorMessage: 42 }]),
    JSON.stringify([{ errorMessage: 'You are not signed in' }]),
    JSON.stringify([{ propertyName: '', errorMessage: 'mam_id invalid' }, null]),
    '[]',
  ])('keeps an unrecognized body generic (case %#)', async (body) => {
    expect((await refusedSave(new Response(body, { status: 400 }))).message).toBe(genericRefusal);
  });

  it('keeps other indexers and nonvalidation HTTP statuses generic', async () => {
    const validation = [{ propertyName: '', errorMessage: 'You are not signed in' }];
    expect((await refusedSave(jsonResponse(validation, 400), 'OtherIndexer')).message).toBe(
      genericRefusal,
    );
    const response = jsonResponse(validation, 503);
    expect((await refusedSave(response)).message).toBe(genericRefusal.replace('400', '503'));
    expect(response.bodyUsed).toBe(false);
  });

  it('bounds a chunked body by bytes and cancels before reading its remaining tail', async () => {
    const prefix = JSON.stringify([{ propertyName: '', errorMessage: 'mam_id invalid' }]);
    const chunks = [prefix, 'é'.repeat(16 * 1024), 'UNREAD_SECRET_MARKER'];
    let reads = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(new TextEncoder().encode(chunks[reads++]!));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 400, headers: { 'content-length': '1' } },
    );
    expect((await refusedSave(response)).message).toBe(genericRefusal);
    expect(reads).toBe(2);
    expect(cancelled).toBe(true);
  });

  it('accepts an exactly 32 KiB validation body but rejects one byte more', async () => {
    const validation = JSON.stringify([{ propertyName: '', errorMessage: 'mam_id invalid' }]);
    const atLimit = validation.padEnd(32 * 1024, ' ');
    expect((await refusedSave(new Response(atLimit, { status: 400 }))).message).toBe(
      `${genericRefusal}: ${mamReason}`,
    );
    expect((await refusedSave(new Response(`${atLimit} `, { status: 400 }))).message).toBe(
      genericRefusal,
    );
  });

  it('preserves the refused HTTP error when its body stream fails', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('SECRET_MARKER'));
        },
      }),
      { status: 400 },
    );
    expect((await refusedSave(response)).message).toBe(genericRefusal);
  });

  it('still rejects a disable refused by MAM validation', async () => {
    const error = await refusedSave(
      jsonResponse([{ propertyName: '', errorMessage: 'mam_id invalid' }], 400),
      'MyAnonaMouse',
      false,
    );
    expect(error.status).toBe(400);
    expect(error.message).toBe(`${genericRefusal}: ${mamReason}`);
  });

  it('tolerates an empty PUT body (202 no echo)', async () => {
    const client = new ProwlarrWriteClient({
      baseUrl: 'http://prowlarr:9696',
      apiKey: 'PK',
      fetchImpl: async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET')
          return jsonResponse({ id: 17, enable: true, fields: [] });
        return new Response('', { status: 202 });
      },
    });
    await expect(client.setIndexerEnabled(17, false)).resolves.toBeUndefined();
  });
});

describe('assertGovernorClientsEnv', () => {
  it('defaults URLs/category/indexer and requires PROWLARR_API_KEY', () => {
    const cfg = assertGovernorClientsEnv({ PROWLARR_API_KEY: 'k' });
    expect(cfg.qbittorrent.baseUrl).toContain('qbittorrent.downloads.svc.cluster.local:8080');
    expect(cfg.qbittorrent.category).toBe('books-mam');
    expect(cfg.prowlarr.baseUrl).toContain('prowlarr.downloads.svc.cluster.local:9696');
    expect(cfg.prowlarr.indexerId).toBe(17);
    expect(cfg.prowlarr.apiKey).toBe('k');
  });

  it('throws DownloadsConfigError naming the missing key (never a value)', () => {
    try {
      assertGovernorClientsEnv({});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DownloadsConfigError);
      expect((e as DownloadsConfigError).missing).toEqual(['PROWLARR_API_KEY']);
    }
  });
});
